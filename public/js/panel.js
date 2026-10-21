/**
 * Panneau de détails : rempli UNIQUEMENT au clic sur un avion.
 * C'est ici (et nulle part ailleurs) qu'on appelle les APIs d'enrichissement.
 *   - fiche (/api/flight)          identité, photo, trajet, météo, horaires en cache
 *   - horaires (/api/flight/…/schedule)   à la demande, quota
 *   - trace (/api/trail)           dessinée sur la carte, vols du jour
 *   - historique (/api/history)    vols archivés, rejouables
 *   - estimations locales          progression, ETA, phase
 *   - données ADS-B                mises à jour chaque seconde
 */
import { planes, state, emit, on, setText, $, fmtClock, fmtDuration, fmtKm, haversineKm, looksAirline, toast } from './state.js';
import { map } from './map.js';
import { altColor } from './render.js';
import { setFollow } from './data.js';
import { t } from './i18n.js';

let routeLayer = null;
let trailLayer = null;
let eventLayer = null;
let trailTimer = null;
let shownLegIndex = null;
let replay = null;

const panel = $('panel');
const schedBtn = $('p-sched-btn');
const followBtn = $('p-follow');

// ════════════════════════════════════════════════════════════════════════════
// SÉLECTION
// ════════════════════════════════════════════════════════════════════════════
export async function select(hex, { pan = false } = {}) {
  const p = planes.get(hex);
  if (!p) return;
  if (state.followHex && state.followHex !== hex) setFollow(null);
  state.selectedHex = hex;
  state.details = null;
  panel.hidden = false;
  panel.scrollTop = 0;
  if (pan) map.setView([p.rLat, p.rLon], Math.max(map.getZoom(), 9));

  // 1) affichage immédiat avec ce que l'ADS-B nous donne déjà
  setText('p-callsign', p.callsign || p.reg || hex.toUpperCase());
  setText('p-airline', '');
  setText('p-hex', hex.toUpperCase());
  setText('p-type', p.desc || p.type || '—');
  setText('p-reg', p.reg || '—');
  setText('p-owner', '—');
  for (const id of ['p-route', 'p-route-unknown', 'p-photo-wrap', 'p-wx', 'p-progress', 'p-history']) $(id).hidden = true;
  resetSchedule();
  resetTrail();
  // la section « trajet réel » reste visible avec un état d'attente : la trace peut prendre quelques secondes
  $('p-trail-section').hidden = false;
  for (const id of ['t-takeoff', 't-from', 't-phase', 't-duration', 't-distance', 't-maxalt', 't-maxgs']) setText(id, '…');
  $('t-source').hidden = true;
  $('t-export').hidden = true;
  renderBadges(p, null);
  updateFollowButton();
  $('p-sources').textContent = 'Chargement des détails…';
  updateLiveFields();
  emit('select', hex);

  // la trace réelle est indépendante des autres détails : en parallèle
  loadTrail(hex);
  loadHistory(hex);
  trailTimer = setInterval(() => loadTrail(hex), 30_000);

  // 2) une seule requête d'enrichissement, mise en cache côté serveur
  try {
    const qs = new URLSearchParams({ lat: String(p.lat), lon: String(p.lon) });
    if (p.callsign) qs.set('callsign', p.callsign);
    const res = await fetch(`/api/flight/${hex}?${qs}`);
    const data = await res.json();
    if (state.selectedHex !== hex) return; // l'utilisateur a cliqué ailleurs entre-temps
    fillDetails(data, p);
  } catch {
    $('p-sources').textContent = 'Détails indisponibles.';
  }
}

export function closePanel() {
  state.selectedHex = null;
  state.details = null;
  if (state.followHex) setFollow(null);
  resetTrail();
  clearRouteLine();
  panel.hidden = true;
  emit('select', null);
}

$('panel-close').addEventListener('click', closePanel);
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closePanel(); });
on('select-request', (hex) => { if (planes.has(hex)) select(hex, { pan: true }); else emit('open-target', hex); });
on('close-plane-panel', () => { if (state.selectedHex) closePanel(); });

// ── Suivre ──────────────────────────────────────────────────────────────────
followBtn.addEventListener('click', () => {
  const hex = state.selectedHex;
  if (!hex) return;
  setFollow(state.followHex === hex ? null : hex);
  updateFollowButton();
});
function updateFollowButton() {
  const on = state.followHex && state.followHex === state.selectedHex;
  followBtn.classList.toggle('is-on', Boolean(on));
  followBtn.textContent = on ? `◉ ${t('Suivi')}` : `◎ ${t('Suivre')}`;
  followBtn.title = on ? 'Arrêter de suivre' : 'Recentrer en continu, même hors de la zone visible';
}
on('follow', updateFollowButton);

// ── Partager ────────────────────────────────────────────────────────────────
$('p-share').addEventListener('click', async () => {
  const p = planes.get(state.selectedHex);
  if (!p) return;
  const url = new URL(location.href);
  url.search = '';
  url.searchParams.set('hex', p.hex);
  if (p.callsign) url.searchParams.set('callsign', p.callsign);
  const text = url.toString();
  try {
    if (navigator.share) await navigator.share({ title: `FlightMap — ${p.callsign || p.hex}`, url: text });
    else { await navigator.clipboard.writeText(text); toast('Lien copié dans le presse-papiers.'); }
  } catch { toast(text, { duration: 8000 }); }
});

// ════════════════════════════════════════════════════════════════════════════
// FICHE
// ════════════════════════════════════════════════════════════════════════════
function renderBadges(p, notable) {
  const box = $('p-badges');
  box.textContent = '';
  const add = (text, kind) => {
    const el = document.createElement('div');
    el.className = `p-badge p-badge--${kind}`;
    el.textContent = text;
    box.appendChild(el);
  };
  if (p.emergency || ['7500', '7600', '7700'].includes(p.squawk)) add(`Urgence ${p.squawk || ''}`.trim(), 'emergency');
  if (p.military) add('Militaire', 'military');
  const label = notable?.label || p.notable;
  if (label) add(label, 'notable');
}

// ── Photos : galerie, grande image tentée d'abord puis repli sur la vignette ──
let gallery = [];
let galleryIndex = 0;

function showPhotos(ac) {
  // liste normalisée : Planespotters (plusieurs, grandes) ou adsbdb (vignette + grande image incertaine)
  gallery = (ac.photos && ac.photos.length ? ac.photos : (ac.photoThumb || ac.photo ? [{ src: ac.photoThumb || ac.photo, full: ac.photoFull, credit: ac.photoCredit, link: ac.photoLink }] : []))
    .map((ph) => ({ src: ph.src, full: ph.full && ph.full !== ph.src ? ph.full : null, credit: ph.credit || ac.photoCredit || 'Photo via adsbdb / Planespotters', link: ph.link || ac.photoLink || null }));
  galleryIndex = 0;
  const wrap = $('p-photo-wrap');
  if (!gallery.length) { wrap.hidden = true; return; }
  wrap.hidden = false;
  $('p-photo-prev').hidden = $('p-photo-next').hidden = gallery.length < 2;
  $('p-photo-count').hidden = gallery.length < 2;
  showPhoto(0);
}

function showPhoto(i) {
  const ph = gallery[i];
  if (!ph) return;
  galleryIndex = i;
  const img = $('p-photo');
  const hex = state.selectedHex;
  img.classList.add('is-loading');
  img.onload = () => img.classList.remove('is-loading');
  // 1) on tente la grande image (souvent 404 chez airport-data) ; 2) sinon la vignette
  img.onerror = () => { if (ph.full && img.src !== ph.src && state.selectedHex === hex) img.src = ph.src; else img.classList.remove('is-loading'); };
  img.src = ph.full || ph.src;
  $('p-photo-credit').textContent = ph.credit;
  const link = $('p-photo-link');
  link.href = ph.link || ph.full || ph.src;
  link.hidden = false;
  $('p-photo-open').href = ph.link || ph.full || ph.src;
  $('p-photo-count').textContent = `${i + 1} / ${gallery.length}`;
}

$('p-photo-prev').addEventListener('click', (e) => { e.preventDefault(); e.stopPropagation(); showPhoto((galleryIndex - 1 + gallery.length) % gallery.length); });
$('p-photo-next').addEventListener('click', (e) => { e.preventDefault(); e.stopPropagation(); showPhoto((galleryIndex + 1) % gallery.length); });

function fillWeather(metar) {
  const box = $('p-wx');
  if (!metar || (!metar.raw && metar.temp == null)) { box.hidden = true; return; }
  box.hidden = false;
  setText('wx-icao', metar.icao || '');
  setText('wx-temp', metar.temp != null ? `${Math.round(metar.temp)} °C` : '—');
  setText('wx-wind', metar.wind != null
    ? `vent ${Math.round(metar.wind)} kt${metar.windDir != null ? ` / ${Math.round(metar.windDir)}°` : ''}`
    : 'vent —');
  setText('wx-vis', metar.visibility != null ? `visi. ${metar.visibility}` : '');
  setText('wx-raw', metar.raw || '');
}

function fillDetails(data, p) {
  const ac = data.aircraft;
  const rt = data.route;
  state.details = data;

  renderBadges(p, data.notable);
  fillWeather(data.metar);
  if (data.airlineName) setText('p-airline', data.airlineName);

  if (ac) {
    setText('p-type', [ac.manufacturer, ac.type].filter(Boolean).join(' ') || p.desc || p.type || '—');
    setText('p-reg', ac.registration || p.reg || '—');
    setText('p-owner', ac.owner || '—');
    showPhotos(ac);
  }

  if (rt?.origin && rt?.destination) showRoute(rt, p);
  else { $('p-route-unknown').hidden = false; clearRouteLine(); }

  // fiches « jolies » (historique 30 j, ponctualité, appareils utilisés)
  const pa = $('p-page-aircraft'), pf = $('p-page-flight');
  if (pa) pa.href = `/aircraft/${encodeURIComponent(ac?.registration || p.reg || p.hex)}`;
  if (pf) {
    // adsb.lol renvoie parfois juste le numéro (« 176 ») : on préfère alors le callsign
    const num = /^(?=[A-Z0-9]{2}\d)(?=.*[A-Z])/.test(rt?.flightNumber || '') ? rt.flightNumber : (looksAirline(p.callsign) ? p.callsign : null);
    pf.hidden = !num;
    if (num) pf.href = `/flight/${encodeURIComponent(num)}`;
  }

  fillScheduleState(data);
  updateEstimates();
  renderSources();
}

function showRoute(rt, p) {
  $('p-route-unknown').hidden = true;
  $('p-route').hidden = false;
  setText('p-from-code', rt.origin.iata || rt.origin.icao || '?');
  setText('p-from-city', rt.origin.city || rt.origin.name || '');
  setText('p-to-code', rt.destination.iata || rt.destination.icao || '?');
  setText('p-to-city', rt.destination.city || rt.destination.name || '');
  if (rt.airline?.name) setText('p-airline', rt.airline.name);
  drawRouteLine(rt, p);
}

function renderSources() {
  const data = state.details;
  if (!data) return;
  const ac = data.aircraft, rt = data.route;
  const sources = [];
  if (ac?.source) sources.push(ac.source);
  if (ac?.photoCredit?.includes('Planespotters') && !ac.photoCredit.includes('adsbdb')) sources.push('Planespotters.net');
  if (rt?.source && !sources.includes(rt.source)) sources.push(rt.source);
  if (rt?.origin?.name || rt?.destination?.name) sources.push('OurAirports');
  if (data.notable) sources.push('plane-alert-db');
  if (data.metar) sources.push('NOAA');
  if (data.schedule?.source) sources.push(data.schedule.source);
  if (state.trail?.source === 'adsb.lol') sources.push('adsb.lol (trace)');
  $('p-sources').textContent = sources.length ? `Sources : ${sources.join(', ')}` : 'Aucune information complémentaire trouvée.';
}

/** Pointillé avion → arrivée + marqueurs. Le segment départ → avion est remplacé par la trace réelle. */
function drawRouteLine(rt, p) {
  clearRouteLine();
  const from = rt.origin, to = rt.destination;
  if (from?.lat == null || to?.lat == null) return;
  const parts = [
    L.polyline([[p.rLat, p.rLon], [to.lat, to.lon]], { color: '#3fb6ff', weight: 1.5, opacity: .45, dashArray: '5 6' }),
    L.circleMarker([from.lat, from.lon], { radius: 4, color: '#3fb6ff', fillColor: '#0b0f14', fillOpacity: 1, weight: 2 }),
    L.circleMarker([to.lat, to.lon], { radius: 4, color: '#3fb6ff', fillColor: '#3fb6ff', fillOpacity: 1, weight: 2 }),
  ];
  if (!trailLayer) parts.unshift(L.polyline([[from.lat, from.lon], [p.rLat, p.rLon]], { color: '#3fb6ff', weight: 1.5, opacity: .8 }));
  routeLayer = L.layerGroup(parts).addTo(map);
}

function clearRouteLine() {
  if (routeLayer) { map.removeLayer(routeLayer); routeLayer = null; }
}

// ════════════════════════════════════════════════════════════════════════════
// HORAIRES, PORTES, RETARDS (API à clé, quota limité → à la demande)
// ════════════════════════════════════════════════════════════════════════════
function resetSchedule() {
  for (const id of ['p-sched', 'p-sched-note', 'p-sched-status', 'p-sched-msg', 'p-est', 'p-est-note']) $(id).hidden = true;
  schedBtn.hidden = true;
  schedBtn.disabled = false;
  schedBtn.textContent = t('Charger les horaires et portes');
}

function fillScheduleState(data) {
  if (data.schedule) { fillSchedule(data.schedule); return; }
  const avail = data.scheduleAvailable || {};
  const msg = $('p-sched-msg');
  const p = planes.get(state.selectedHex);
  const airlineLike = data.route?.flightNumber || looksAirline(p?.callsign);
  if (avail.enabled && !airlineLike) {
    msg.textContent = 'Pas d\'horaire : ce callsign n\'est pas un vol de ligne (privé, militaire, convoyage).';
    msg.hidden = false;
  } else if (avail.enabled && data.scheduleMode === 'button') {
    schedBtn.hidden = false;
  } else if (avail.reason && avail.reason !== 'done') {
    msg.textContent = avail.reason;
    msg.hidden = false;
  } else if (data.scheduleMode === 'auto' || avail.reason === 'done') {
    msg.textContent = 'Aucun horaire trouvé pour ce vol (vol privé, cargo ou callsign non commercial).';
    msg.hidden = false;
  }
}

schedBtn.addEventListener('click', async () => {
  const hex = state.selectedHex;
  const p = planes.get(hex);
  const details = state.details;
  if (!p || !details) return;
  schedBtn.disabled = true;
  schedBtn.textContent = t('Chargement…');
  try {
    const qs = new URLSearchParams();
    if (p.callsign) qs.set('callsign', p.callsign);
    if (details.route?.flightNumber) qs.set('flight', details.route.flightNumber);
    const res = await fetch(`/api/flight/${hex}/schedule?${qs}`);
    const data = await res.json();
    if (state.selectedHex !== hex) return;
    schedBtn.hidden = true;
    if (data.schedule) {
      details.schedule = data.schedule;
      fillSchedule(data.schedule);
      renderSources();
      updateEstimates();
    } else {
      const msg = $('p-sched-msg');
      msg.textContent = data.reason || data.error || 'Horaires indisponibles.';
      msg.hidden = false;
    }
  } catch {
    schedBtn.disabled = false;
    schedBtn.textContent = 'Réessayer';
  }
});

function fmtStamp(stamp, tz) {
  if (!stamp) return null;
  if (stamp.local) return stamp.local.slice(11, 16);
  if (stamp.utc) return fmtClock(new Date(stamp.utc), tz);
  return null;
}

function delayMinutes(side) {
  if (side.delayMin != null) return side.delayMin;
  const ref = side.actual?.utc || side.estimated?.utc;
  if (!ref || !side.scheduled?.utc) return null;
  return Math.round((new Date(ref) - new Date(side.scheduled.utc)) / 60_000);
}

function fillScheduleSide(prefix, side) {
  setText(`s-${prefix}-code`, side.iata || side.icao || '');
  setText(`s-${prefix}-sched`, fmtStamp(side.scheduled, side.timezone) || '—');
  const real = side.actual || side.estimated;
  const realEl = $(`s-${prefix}-real`);
  setText(`s-${prefix}-real-label`, side.actual ? 'Réel' : 'Estimé');
  realEl.textContent = fmtStamp(real, side.timezone) || '—';
  const delay = delayMinutes(side);
  realEl.className = delay != null && delay >= 15 ? 'late' : delay != null && delay <= -5 ? 'early' : '';
  const meta = $(`s-${prefix}-meta`);
  meta.textContent = '';
  const chip = (text, cls) => { const el = document.createElement('span'); if (cls) el.className = cls; el.textContent = text; meta.appendChild(el); };
  if (side.terminal) chip(`Terminal ${side.terminal}`);
  if (side.gate) chip(`Porte ${side.gate}`);
  if (side.baggage) chip(`Tapis ${side.baggage}`);
  if (delay != null && delay >= 15) chip(`+${delay} min`, 'delay');
}

function fillSchedule(s) {
  $('p-sched-msg').hidden = true;
  schedBtn.hidden = true;
  $('p-sched').hidden = false;
  $('p-sched-note').hidden = false;
  const status = $('p-sched-status');
  status.textContent = s.statusLabel || '';
  status.className = `p-status p-status--${s.status || 'unknown'}`;
  status.hidden = !s.statusLabel;
  fillScheduleSide('dep', s.departure);
  fillScheduleSide('arr', s.arrival);
  if (s.airline?.name) setText('p-airline', s.flightNumber ? `${s.airline.name} · ${s.flightNumber}` : s.airline.name);
  // si le trajet était inconnu, l'API nous le donne
  const d = state.details;
  if (d && !(d.route?.origin && d.route?.destination) && s.departure?.iata && s.arrival?.iata) {
    d.route = { origin: s.departure, destination: s.arrival, source: s.source, flightNumber: s.flightNumber };
    const p = planes.get(state.selectedHex);
    if (p) showRoute(d.route, p);
  }
}

// ════════════════════════════════════════════════════════════════════════════
// ESTIMATIONS LOCALES (0 appel) : progression, distance restante, ETA
// ════════════════════════════════════════════════════════════════════════════
export function updateEstimates() {
  const p = planes.get(state.selectedHex);
  const details = state.details;
  if (!p || !details) return;
  const rt = details.route;
  const from = rt?.origin, to = rt?.destination;
  const hasCoords = from?.lat != null && to?.lat != null;

  const prog = $('p-progress');
  let leftKm = null;
  if (hasCoords) {
    const done = haversineKm(from.lat, from.lon, p.rLat, p.rLon);
    leftKm = haversineKm(p.rLat, p.rLon, to.lat, to.lon);
    const pct = Math.max(0, Math.min(100, (done / (done + leftKm)) * 100));
    prog.hidden = false;
    $('p-progress-fill').style.width = `${pct.toFixed(1)}%`;
    setText('p-progress-done', `${fmtKm(done)} parcourus`);
    setText('p-progress-pct', `${Math.round(pct)} %`);
    setText('p-progress-left', `${fmtKm(leftKm)} restants`);
  } else {
    prog.hidden = true;
  }

  const s = details.schedule;
  const now = Date.now();
  const trail = state.trail;
  const traceTakeoff = trail?.current?.takeoffAt && !trail.current.landedAt ? trail.current.takeoffAt : null;
  const takeoff = traceTakeoff
    || details.sighting?.takeoffAt
    || s?.departure?.actual?.utc
    || (s?.departure?.estimated?.utc && new Date(s.departure.estimated.utc) < now ? s.departure.estimated.utc : null);
  const takeoffSrc = traceTakeoff ? 'trace' : details.sighting?.takeoffAt ? 'observé' : s?.departure?.actual ? 'réel' : takeoff ? 'estimé' : null;
  const depTz = s?.departure?.timezone || null;
  const arrTz = s?.arrival?.timezone || null;

  const rows = [];
  if (takeoff) {
    rows.push(['e-takeoff', `${fmtClock(new Date(takeoff), depTz)}${depTz ? ' locale' : ''} (${takeoffSrc})`]);
    rows.push(['e-elapsed', fmtDuration(now - new Date(takeoff))]);
  } else rows.push(['e-takeoff', '—'], ['e-elapsed', '—']);

  if (leftKm != null && !p.onGround) {
    rows.push(['e-left', fmtKm(leftKm)]);
    const kmh = (p.speed || 0) * 1.852;
    if (kmh > 100) {
      // +12 min : approche, roulage, vent — c'est une estimation, pas une promesse
      const eta = new Date(now + (leftKm / kmh) * 3_600_000 + 12 * 60_000);
      rows.push(['e-eta', `~${fmtClock(eta, arrTz)}${arrTz ? ' locale' : ''} · dans ${fmtDuration(eta - now)}`]);
    } else rows.push(['e-eta', '—']);
  } else rows.push(['e-left', '—'], ['e-eta', p.onGround ? 'Au sol' : '—']);

  // prédiction sur l'historique : durée médiane des vols passés du même numéro
  const pred = details.prediction;
  if (pred?.medianMin) {
    rows.push(['e-usual', `${fmtDuration(pred.medianMin * 60_000)} (${pred.samples} vols, ${fmtDuration(pred.p25Min * 60_000)}–${fmtDuration(pred.p75Min * 60_000)})`]);
    if (takeoff && !p.onGround) {
      const likely = new Date(new Date(takeoff).getTime() + pred.medianMin * 60_000);
      rows.push(['e-likely', likely > now ? `~${fmtClock(likely, arrTz)}${arrTz ? ' locale' : ''} · ${t('dans')} ${fmtDuration(likely - now)}` : `~${fmtClock(likely, arrTz)} (dépassée)`]);
    } else rows.push(['e-likely', '—']);
  } else rows.push(['e-usual', '—'], ['e-likely', '—']);
  const predRow = $('e-usual')?.parentElement;
  if (predRow) { for (const id of ['e-usual', 'e-likely']) { const dd = $(id); if (dd) { dd.hidden = !pred?.medianMin; dd.previousElementSibling.hidden = !pred?.medianMin; } } }

  const anything = rows.some(([, v]) => v !== '—');
  $('p-est').hidden = !anything;
  const note = $('p-est-note');
  note.hidden = !anything || leftKm == null;
  note.textContent = arrTz
    ? 'Arrivée estimée : calcul local (distance restante ÷ vitesse sol), en heure locale de l\'aéroport.'
    : 'Estimation locale : distance restante ÷ vitesse sol (heure de ton fuseau).';
  for (const [id, v] of rows) setText(id, v);
}

// ════════════════════════════════════════════════════════════════════════════
// TRAJET RÉEL — trace adsb.lol : points parcourus, vols du jour
// ════════════════════════════════════════════════════════════════════════════
function resetTrail() {
  clearInterval(trailTimer);
  trailTimer = null;
  state.trail = null;
  shownLegIndex = null;
  stopReplay();
  clearTrail();
  $('t-legs').textContent = '';
  $('t-legs-title').hidden = true;
  $('h-legs').textContent = '';
}

function clearTrail() {
  if (trailLayer) { map.removeLayer(trailLayer); trailLayer = null; }
  if (eventLayer) { map.removeLayer(eventLayer); eventLayer = null; }
  const ev = $('t-events'); if (ev) { ev.textContent = ''; ev.hidden = true; }
}

// ── Événements (remise de gaz, attente, retour, déroutement) ────────────────
const EVENT_ICON = { go_around: '↺', holding: '◎', return: '↩', diverted: '⤳', emergency: '⚠' };

function renderEvents(leg) {
  const box = $('t-events');
  if (!box) return;
  if (eventLayer) { map.removeLayer(eventLayer); eventLayer = null; }
  box.textContent = '';
  const events = leg?.events || [];
  box.hidden = !events.length;
  if (!events.length) return;
  const markers = [];
  for (const e of events) {
    const el = document.createElement('div');
    el.className = `p-badge p-badge--event p-badge--${e.type}`;
    let detail = '';
    if (e.type === 'go_around') detail = `${e.airport?.iata || e.airport?.icao || ''} · ${e.minAlt} ft`;
    if (e.type === 'holding') detail = `${e.durationMin} min · ${e.turns} tours${e.altBand ? ` · ${e.altBand.toLocaleString('fr-FR')} ft` : ''}`;
    if (e.type === 'return') detail = e.airport?.iata || e.airport?.icao || '';
    if (e.type === 'diverted') detail = `${e.planned?.iata || '?'} → ${e.actual?.iata || '?'}`;
    el.textContent = `${EVENT_ICON[e.type] || '•'} ${t(e.label)} ${fmtClock(new Date(e.t))}${detail ? ` · ${detail}` : ''}`;
    el.title = t('Événements');
    el.addEventListener('click', () => map.setView([e.lat, e.lon], Math.max(map.getZoom(), 10)));
    box.appendChild(el);
    if (e.lat != null) {
      markers.push(L.circleMarker([e.lat, e.lon], { radius: 6, color: '#f0c765', fillColor: '#3a2f1c', fillOpacity: 1, weight: 2 })
        .bindTooltip(`${t(e.label)} · ${fmtClock(new Date(e.t))}`, { direction: 'top', offset: [0, -6] }));
    }
  }
  if (markers.length) eventLayer = L.layerGroup(markers).addTo(map);
}

// ── Export du vol affiché ───────────────────────────────────────────────────
function setExportLinks(hex, { legIndex = null, archivedStart = null } = {}) {
  const box = $('t-export');
  if (!box) return;
  const q = archivedStart ? `?archived=${encodeURIComponent(archivedStart)}` : legIndex != null ? `?leg=${legIndex}` : '';
  for (const a of box.querySelectorAll('a[data-fmt]')) a.href = `/api/trail/${hex}/export.${a.dataset.fmt}${q}`;
  box.hidden = false;
}

async function loadTrail(hex) {
  if (document.hidden) return;
  try {
    // le callsign étiquette le vol en cours (fiches par numéro, prédiction) et permet de détecter un déroutement
    const cs = planes.get(hex)?.callsign;
    const res = await fetch(`/api/trail/${hex}${cs ? `?callsign=${encodeURIComponent(cs)}` : ''}`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    if (state.selectedHex !== hex) return;
    state.trail = data;
    const legs = data.legs || [];
    if (!legs.length) { $('p-trail-section').hidden = true; return; }
    if (shownLegIndex == null || shownLegIndex >= legs.length) shownLegIndex = legs.length - 1;
    if (!replay) drawTrail(legs[shownLegIndex], shownLegIndex === legs.length - 1);
    fillTrail(data);
    if (shownLegIndex >= 0) { renderEvents(legs[shownLegIndex]); setExportLinks(hex, { legIndex: shownLegIndex }); }
    renderSources();
    const p = planes.get(hex);
    if (state.details?.route?.origin && p) drawRouteLine(state.details.route, p);
  } catch (err) {
    console.warn('trail:', err.message);
    if (!state.trail) for (const id of ['t-takeoff', 't-from', 't-phase', 't-duration', 't-distance', 't-maxalt', 't-maxgs']) setText(id, '—');
  }
}

/** Dessine une trace colorée par altitude (même échelle que les avions). */
export function drawTrail(leg, isCurrent, { fit = !isCurrent } = {}) {
  clearTrail();
  const pts = leg.points || [];
  if (pts.length < 2) return;
  const lines = [];
  let run = [[pts[0][1], pts[0][2]]];
  let runColor = trailColor(pts[0][3]);
  for (let i = 1; i < pts.length; i++) {
    const [, lat, lon, alt] = pts[i];
    const c = trailColor(alt);
    run.push([lat, lon]);
    if (c !== runColor || i === pts.length - 1) {
      lines.push(L.polyline(run, { color: runColor, weight: isCurrent ? 2.5 : 2, opacity: isCurrent ? .9 : .65, lineJoin: 'round' }));
      run = [[lat, lon]];
      runColor = c;
    }
  }
  const first = pts[0], last = pts[pts.length - 1];
  lines.push(L.circleMarker([first[1], first[2]], { radius: 3, color: '#e6edf3', fillColor: '#0b0f14', fillOpacity: 1, weight: 1.5 }));
  if (!isCurrent) lines.push(L.circleMarker([last[1], last[2]], { radius: 3, color: '#e6edf3', fillColor: '#e6edf3', fillOpacity: 1, weight: 1.5 }));
  trailLayer = L.layerGroup(lines).addTo(map);
  if (fit) map.fitBounds(L.latLngBounds(pts.map((q) => [q[1], q[2]])), { padding: [40, 40], maxZoom: 9 });
}

function trailColor(alt) {
  if (alt == null) return 'rgb(120,130,145)';
  if (alt === 0) return '#5b6b7f';
  return altColor(Math.round(alt / 2000) * 2000);
}

export function flightPhase(p) {
  if (p.onGround) return 'Au sol';
  const vr = p.vertRate ?? 0, alt = p.alt ?? 0;
  if (vr > 300) return alt < 10000 ? 'Montée initiale' : 'Montée';
  if (vr < -300) return alt < 10000 ? 'Approche' : 'Descente';
  return alt >= 18000 ? 'Croisière' : 'Palier';
}

function legButton(leg, { isCur = false, active = false, onClick }) {
  const el = document.createElement('button');
  el.type = 'button';
  el.className = `leg${active ? ' is-active' : ''}`;
  const t0 = leg.takeoffAt || leg.start, t1 = leg.landedAt || leg.end;
  const code = (ap) => ap?.iata || ap?.icao || '?';
  const d0 = new Date(t0);
  const sameDay = d0.toDateString() === new Date().toDateString();
  const dayPrefix = sameDay ? '' : `${d0.toLocaleDateString('fr-FR', { weekday: 'short', day: '2-digit', month: '2-digit' })} `;
  el.innerHTML = `
    <span class="leg-time">${dayPrefix}${fmtClock(d0)}–${isCur && !leg.landedAt ? '…' : fmtClock(new Date(t1))}</span>
    <span class="leg-route">${code(leg.from)} → ${code(leg.to)}</span>
    <span class="${isCur ? 'leg-now' : 'leg-meta'}">${isCur ? 'en cours' : `${fmtDuration(leg.durationMin * 60_000)} · ${fmtKm(leg.distanceKm)}`}</span>`;
  el.title = `${leg.pointCount} points · alt. max ${(leg.maxAlt || 0).toLocaleString('fr-FR')} ft`;
  el.addEventListener('click', onClick);
  return el;
}

function fillTrail(data) {
  const legs = data.legs;
  const cur = legs[legs.length - 1];
  const p = planes.get(state.selectedHex);
  $('p-trail-section').hidden = false;

  const src = $('t-source');
  src.textContent = data.source === 'adsb.lol' ? 'adsb.lol' : data.source === 'local' ? 'ce serveur' : '';
  src.hidden = !src.textContent;

  const depTz = state.details?.schedule?.departure?.timezone || null;
  setText('t-takeoff', cur.takeoffAt ? `${fmtClock(new Date(cur.takeoffAt), depTz)}${depTz ? ' locale' : ''}` : t('non observé'));
  const routeFrom = state.details?.route?.origin;
  const mismatch = cur.from && routeFrom?.iata && cur.from.iata && routeFrom.iata !== cur.from.iata;
  setText('t-from', cur.from
    ? `${cur.from.iata || cur.from.icao} · ${cur.from.city || cur.from.name || ''}${mismatch ? ` (référentiel : ${routeFrom.iata})` : ''}`
    : '—');
  setText('t-phase', p ? t(flightPhase(p)) : '—');
  setText('t-duration', cur.durationMin ? fmtDuration(cur.durationMin * 60_000) : '—');
  setText('t-distance', cur.distanceKm ? fmtKm(cur.distanceKm) : '—');
  setText('t-maxalt', cur.maxAlt ? `${cur.maxAlt.toLocaleString('fr-FR')} ft` : '—');
  setText('t-maxgs', cur.maxGs ? `${cur.maxGs} kt (${Math.round(cur.maxGs * 1.852)} km/h)` : '—');

  const box = $('t-legs');
  box.textContent = '';
  $('t-legs-title').hidden = legs.length < 2;
  if (legs.length < 2) return;
  legs.forEach((leg, i) => {
    const isCur = i === legs.length - 1;
    box.appendChild(legButton(leg, {
      isCur, active: i === shownLegIndex,
      onClick: () => {
        shownLegIndex = i;
        stopReplay();
        drawTrail(leg, isCur);
        renderEvents(leg);
        setExportLinks(state.selectedHex, { legIndex: i });
        box.querySelectorAll('.leg').forEach((b, k) => b.classList.toggle('is-active', k === i));
        $('h-legs').querySelectorAll('.leg').forEach((b) => b.classList.remove('is-active'));
      },
    }));
  });
}

// ════════════════════════════════════════════════════════════════════════════
// HISTORIQUE (vols archivés par le serveur, au-delà des 24 h) + REJOUER
// ════════════════════════════════════════════════════════════════════════════
async function loadHistory(hex) {
  try {
    const res = await fetch(`/api/history/${hex}?days=30`);
    if (!res.ok) return;
    const data = await res.json();
    if (state.selectedHex !== hex) return;
    // on ne montre que ce qui n'est pas déjà dans « vols du jour » (plus vieux que 24 h)
    const cutoff = Date.now() - 24 * 3600_000;
    const legs = (data.legs || []).filter((l) => new Date(l.end).getTime() < cutoff).reverse();
    state.historyLegs = legs;
    const box = $('h-legs');
    box.textContent = '';
    $('p-history').hidden = !legs.length;
    for (const leg of legs) {
      box.appendChild(legButton(leg, {
        onClick: (e) => {
          stopReplay();
          drawTrail(leg, false);
          renderEvents(leg);
          setExportLinks(hex, { archivedStart: leg.start });
          box.querySelectorAll('.leg').forEach((b) => b.classList.toggle('is-active', b === e.currentTarget));
          $('t-legs').querySelectorAll('.leg').forEach((b) => b.classList.remove('is-active'));
          shownLegIndex = -1;
        },
      }));
    }
  } catch { /* pas d'historique */ }
}

// Rejouer : un marqueur avance le long de la trace affichée, ×120
$('t-replay').addEventListener('click', () => {
  if (replay) { stopReplay(); return; }
  const leg = currentShownLeg();
  if (!leg || (leg.points || []).length < 2) { toast('Sélectionne d\'abord un vol dans la liste.'); return; }
  startReplay(leg);
});

function currentShownLeg() {
  if (shownLegIndex === -1) {
    const active = $('h-legs').querySelector('.leg.is-active');
    const idx = [...$('h-legs').children].indexOf(active);
    return idx >= 0 ? state.historyLegs?.[idx] : null;
  }
  return state.trail?.legs?.[shownLegIndex] || null;
}

function startReplay(leg) {
  const pts = leg.points;
  const t0 = pts[0][0], t1 = pts[pts.length - 1][0];
  const marker = L.circleMarker([pts[0][1], pts[0][2]], { radius: 6, color: '#fff', fillColor: '#3fb6ff', fillOpacity: 1, weight: 2 }).addTo(map);
  const label = $('t-replay-time');
  const btn = $('t-replay');
  btn.textContent = `■ ${t('Arrêter')}`;
  label.hidden = false;
  drawTrail(leg, false, { fit: true });
  const speed = 120;
  const startWall = performance.now();
  let i = 0;
  replay = { marker, raf: 0 };
  const step = (nowWall) => {
    const t = t0 + (nowWall - startWall) * speed;
    while (i < pts.length - 2 && pts[i + 1][0] <= t) i++;
    const a = pts[i], b = pts[i + 1];
    const f = Math.max(0, Math.min(1, (t - a[0]) / Math.max(1, b[0] - a[0])));
    const lat = a[1] + (b[1] - a[1]) * f, lon = a[2] + (b[2] - a[2]) * f;
    marker.setLatLng([lat, lon]);
    const alt = a[3] != null && b[3] != null ? Math.round(a[3] + (b[3] - a[3]) * f) : a[3];
    label.textContent = `${fmtClock(new Date(t))} · ${alt != null ? `${alt.toLocaleString('fr-FR')} ft` : ''} · ${Math.round(a[4] || 0)} kt`;
    if (t >= t1) { stopReplay(); return; }
    replay.raf = requestAnimationFrame(step);
  };
  replay.raf = requestAnimationFrame(step);
}

function stopReplay() {
  if (!replay) return;
  cancelAnimationFrame(replay.raf);
  map.removeLayer(replay.marker);
  replay = null;
  $('t-replay').textContent = `▶ ${t('Rejouer')}`;
  $('t-replay-time').hidden = true;
}

// ════════════════════════════════════════════════════════════════════════════
// DONNÉES ADS-B AVANCÉES — mises à jour chaque seconde
// ════════════════════════════════════════════════════════════════════════════
const CATEGORY_LABELS = {
  A0: 'Non renseignée', A1: 'Léger (< 7 t)', A2: 'Petit (7–34 t)', A3: 'Gros porteur (34–136 t)',
  A4: 'Fort sillage (B757)', A5: 'Très lourd (> 136 t)', A6: 'Haute performance', A7: 'Hélicoptère',
  B1: 'Planeur', B2: 'Ballon / dirigeable', B4: 'ULM', B6: 'Drone', B7: 'Spatial',
  C1: 'Véhicule d\'urgence', C2: 'Véhicule de service', C3: 'Obstacle',
};
const SIGNAL_LABELS = {
  adsb_icao: 'ADS-B', adsb_icao_nt: 'ADS-B (sans transpondeur)', adsr_icao: 'ADS-R', tisb_icao: 'TIS-B',
  tisb_other: 'TIS-B', tisb_trackfile: 'TIS-B', adsb_other: 'ADS-B (autre)', mode_s: 'Mode S', mlat: 'MLAT (multilatération)',
};

function adsbRows(p) {
  const deg = (v) => (v != null ? `${Math.round(v)}°` : null);
  return [
    ['Vitesse indiquée (IAS)', p.ias != null ? `${Math.round(p.ias)} kt` : null],
    ['Vitesse vraie (TAS)', p.tas != null ? `${Math.round(p.tas)} kt (${Math.round(p.tas * 1.852)} km/h)` : null],
    ['Mach', p.mach != null ? p.mach.toFixed(3) : null],
    ['Altitude GPS', p.altGeom != null ? `${p.altGeom.toLocaleString('fr-FR')} ft` : null],
    ['Cap vrai / magnétique', p.trueHeading != null || p.magHeading != null ? `${deg(p.trueHeading) ?? '—'} / ${deg(p.magHeading) ?? '—'}` : null],
    ['Inclinaison', p.roll != null ? `${Math.abs(p.roll).toFixed(1)}° ${p.roll < -0.5 ? 'gauche' : p.roll > 0.5 ? 'droite' : ''}`.trim() : null],
    ['Vent en altitude', p.windSpeed != null ? `${Math.round(p.windSpeed)} kt du ${deg(p.windDir) ?? '—'}` : null],
    ['Température extérieure', p.oat != null ? `${Math.round(p.oat)} °C` : null],
    ['Altitude sélectionnée', p.navAlt != null ? `${p.navAlt.toLocaleString('fr-FR')} ft (autopilote)` : null],
    ['Cap sélectionné', deg(p.navHeading)],
    ['QNH réglé', p.navQnh != null ? `${p.navQnh.toFixed(1)} hPa` : null],
    ['Modes autopilote', p.navModes ? p.navModes.join(', ') : null],
    ['Catégorie', p.category ? `${p.category} · ${CATEGORY_LABELS[p.category] || ''}`.replace(/ · $/, '') : null],
    ['Source du signal', p.signal ? SIGNAL_LABELS[p.signal] || p.signal : null],
    ['Qualité position (NIC)', p.nic != null ? `${p.nic} / 11` : null],
    ['Signal reçu', p.rssi != null ? `${p.rssi.toFixed(1)} dBFS` : null],
    ['Messages reçus', p.messages != null ? p.messages.toLocaleString('fr-FR') : null],
    ['Dernier message', p.seenAny != null ? `il y a ${Math.round(p.seenAny)} s` : null],
  ].filter(([, v]) => v != null);
}

function renderAdsb(p) {
  const dl = $('p-adsb');
  const rows = adsbRows(p);
  $('p-adsb-section').hidden = !rows.length;
  while (dl.children.length > rows.length * 2) dl.lastElementChild.remove();
  rows.forEach(([k, v], i) => {
    let dt = dl.children[i * 2], dd = dl.children[i * 2 + 1];
    if (!dt) { dt = document.createElement('dt'); dd = document.createElement('dd'); dl.append(dt, dd); }
    if (dt.textContent !== k) dt.textContent = k;
    if (dd.textContent !== v) dd.textContent = v;
  });
}

// ── Valeurs live du panneau (altitude, vitesse…) ────────────────────────────
export function updateLiveFields() {
  const p = planes.get(state.selectedHex);
  if (!p) return;
  setText('p-alt', p.onGround ? 'Au sol' : p.alt != null ? `${p.alt.toLocaleString('fr-FR')} ft` : '—');
  setText('p-speed', p.speed != null ? `${Math.round(p.speed)} kt` : '—');
  setText('p-track', p.track != null ? `${Math.round(p.track)}°` : '—');
  setText('p-vs', p.vertRate != null
    ? `${p.vertRate > 100 ? '↑' : p.vertRate < -100 ? '↓' : '→'} ${Math.abs(Math.round(p.vertRate))} ft/min`
    : '—');
  setText('p-squawk', p.squawk || '—');
  renderAdsb(p);
  if (state.trail) setText('t-phase', t(flightPhase(p)));
}

setInterval(() => {
  if (!state.selectedHex) return;
  if (!planes.has(state.selectedHex)) { $('p-sources').textContent = 'Signal perdu — plus de position reçue depuis 90 s.'; return; }
  updateLiveFields();
  updateEstimates();
}, 1000);

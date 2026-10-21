/**
 * Aéroports sur la carte + panneau « aéroport » : départs / arrivées / au sol
 * déduits des avions en vol, METAR, pistes dessinées, piste en service.
 */
import { planes, state, on, emit, $, fmtClock, toast } from './state.js';
import { map } from './map.js';
import { t } from './i18n.js';

let markersLayer = L.layerGroup().addTo(map);
let runwayLayer = null;
let current = null;        // code de l'aéroport ouvert
let refreshTimer = null;
let loadTimer = null;
const drawn = new Map();   // icao → marker

const panel = $('airport-panel');

// ── Marqueurs ───────────────────────────────────────────────────────────────
async function loadMarkers() {
  const z = map.getZoom();
  if (z < 7) { markersLayer.clearLayers(); drawn.clear(); return; }
  const b = map.getBounds();
  const qs = new URLSearchParams({ south: b.getSouth().toFixed(3), west: b.getWest().toFixed(3), north: b.getNorth().toFixed(3), east: b.getEast().toFixed(3), min: z < 9 ? 'large' : 'medium' });
  try {
    const res = await fetch(`/api/airports?${qs}`);
    if (!res.ok) return;
    const { airports } = await res.json();
    const keep = new Set();
    for (const ap of airports) {
      keep.add(ap.icao);
      if (drawn.has(ap.icao)) continue;
      const big = ap.size === 'large';
      const m = L.circleMarker([ap.lat, ap.lon], {
        radius: big ? 5 : 3.5, color: '#e6edf3', weight: 1.2, fillColor: big ? '#f0c765' : '#8b9bb0', fillOpacity: .9, pane: 'markerPane',
      }).bindTooltip(`${ap.iata || ap.icao} · ${ap.name}`, { direction: 'top', offset: [0, -6], className: 'ap-tip' });
      m.on('click', (e) => { L.DomEvent.stopPropagation(e); openAirport(ap.icao || ap.iata); });
      markersLayer.addLayer(m);
      drawn.set(ap.icao, m);
    }
    for (const [icao, m] of drawn) if (!keep.has(icao)) { markersLayer.removeLayer(m); drawn.delete(icao); }
  } catch { /* réseau : on réessaiera au prochain déplacement */ }
}

// ── Panneau ─────────────────────────────────────────────────────────────────
export async function openAirport(code) {
  current = String(code).toUpperCase();
  panel.hidden = false;
  panel.scrollTop = 0;
  $('ap-title').textContent = current;
  $('ap-sub').textContent = t('Chargement…');
  emit('airport-open', current);
  await loadBoard();
  clearInterval(refreshTimer);
  refreshTimer = setInterval(loadBoard, 60_000);
}

export function closeAirport() {
  current = null;
  clearInterval(refreshTimer);
  clearInterval(clockTimer);
  panel.hidden = true;
  if (runwayLayer) { map.removeLayer(runwayLayer); runwayLayer = null; }
}

async function loadBoard() {
  if (!current || document.hidden) return;
  try {
    const res = await fetch(`/api/airport/${current}`);
    if (!res.ok) { $('ap-sub').textContent = res.status === 404 ? 'Aéroport inconnu' : 'Tableau indisponible'; return; }
    const b = await res.json();
    render(b);
  } catch { $('ap-sub').textContent = 'Tableau indisponible'; }
}

function drawRunways(b) {
  if (runwayLayer) map.removeLayer(runwayLayer);
  const inUse = new Set([b.runwayInUse?.observed?.departures, b.runwayInUse?.observed?.arrivals, ...(b.runwayInUse?.byWind || []).slice(0, 1).map((r) => r.end)].filter(Boolean));
  const lines = [];
  for (const rw of b.runways || []) {
    const [a, c] = rw.ends;
    const active = rw.ends.some((e) => inUse.has(e.ident));
    lines.push(L.polyline([[a.lat, a.lon], [c.lat, c.lon]], { color: active ? '#3fb6ff' : '#e6edf3', weight: active ? 5 : 3, opacity: .85, lineCap: 'butt' })
      .bindTooltip(`${rw.name}${rw.lengthM ? ` · ${rw.lengthM} m` : ''}${active ? ` · ${t('Piste en service')}` : ''}`, { sticky: true }));
  }
  runwayLayer = L.layerGroup(lines).addTo(map);
}

function row(a, kind) {
  const el = document.createElement('button');
  el.type = 'button';
  el.className = 'leg';
  const other = kind === 'dep' ? a.route?.destination : a.route?.origin;
  const otherCode = other?.iata || other?.icao || '';
  const when = kind === 'dep'
    ? (a.takeoffAt ? fmtClock(new Date(a.takeoffAt)) : a.minutesAgo != null ? `${t('il y a')} ${a.minutesAgo} min` : '')
    : (a.etaAt ? `~${fmtClock(new Date(a.etaAt))}` : '');
  const meta = kind === 'ground' ? (a.type || '') : `${a.alt != null ? `${Math.round(a.alt / 100) * 100} ft` : ''}${a.distanceKm != null ? ` · ${Math.round(a.distanceKm)} km` : ''}`;
  el.innerHTML = `<span class="leg-time">${when}</span><span class="leg-route">${a.callsign || a.reg || a.hex.toUpperCase()}${otherCode ? ` <small>${kind === 'dep' ? '→' : '←'} ${otherCode}</small>` : ''}${a.route?.airline ? ` <small>· ${a.route.airline}</small>` : ''}</span><span class="leg-meta">${meta}</span>`;
  el.addEventListener('click', () => emit('select-request', a.hex));
  return el;
}

function fillList(id, list, kind) {
  const box = $(id);
  box.textContent = '';
  if (!list.length) { const p = document.createElement('div'); p.className = 'sched-note'; p.textContent = t('Aucun mouvement détecté pour le moment.'); box.appendChild(p); return; }
  for (const a of list) box.appendChild(row(a, kind));
}

let currentLatLng = null;
let lastBoard = null;

// les graphiques sont dessinés à la largeur du panneau : on les redessine si elle change
let resizeTimer = null;
window.addEventListener('resize', () => {
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(() => { if (lastBoard && !panel.hidden) { renderStats(lastBoard); sat?.invalidateSize(); } }, 250);
});

function render(b) {
  const ap = b.airport;
  currentLatLng = [ap.lat, ap.lon];
  lastBoard = b;
  $('ap-title').textContent = `${ap.iata || ''}${ap.iata && ap.icao ? ' · ' : ''}${ap.icao || ''}`;
  $('ap-sub').textContent = `${ap.name}${ap.city ? ` — ${ap.city}` : ''}`;

  const wx = $('ap-wx');
  if (b.metar?.raw || b.metar?.temp != null) {
    wx.hidden = false;
    $('ap-wx-row').textContent = [
      b.metar.temp != null ? `${Math.round(b.metar.temp)} °C` : null,
      b.metar.wind != null ? `${t('vent')} ${Math.round(b.metar.wind)} kt${b.metar.windDir != null ? ` / ${Math.round(b.metar.windDir)}°` : ''}` : null,
      b.metar.visibility != null ? `visi. ${b.metar.visibility}` : null,
    ].filter(Boolean).join(' · ');
    $('ap-wx-raw').textContent = b.metar.raw || '';
  } else wx.hidden = true;

  const ru = b.runwayInUse || {};
  const parts = [];
  if (ru.observed?.departures) parts.push(`${t('Départs')} ${ru.observed.departures} (${t('observée')})`);
  if (ru.observed?.arrivals) parts.push(`${t('Arrivées')} ${ru.observed.arrivals} (${t('observée')})`);
  if (!parts.length && ru.byWind?.length) parts.push(`${ru.byWind.map((r) => r.end).join(', ')} (${t('probable (vent)')}, ${ru.byWind[0].headwind} kt de face)`);
  $('ap-runway').textContent = parts.length ? parts.join(' · ') : (b.runways?.length ? '—' : t('Pistes') + ' : ?');
  $('ap-runways-list').textContent = (b.runways || []).map((r) => `${r.name}${r.lengthM ? ` ${r.lengthM} m` : ''}`).join(' · ');

  fillList('ap-dep', b.departures || [], 'dep');
  fillList('ap-arr', b.arrivals || [], 'arr');
  fillList('ap-ground', b.ground || [], 'ground');
  $('ap-counts').textContent = `${(b.departures || []).length} ${t('Départs').toLowerCase()} · ${(b.arrivals || []).length} ${t('Arrivées').toLowerCase()} · ${(b.ground || []).length} ${t('Au sol').toLowerCase()}`;
  drawRunways(b);

  renderFacts(b);
  renderWiki(b);
  renderStats(b);
  renderEvents(b);
  renderSatellite(b);
  if (b.metar) $('ap-wx-cond').textContent = metarConditions(b.metar);
}

// ── Heure locale, altitude, fiche ───────────────────────────────────────────
let clockTimer = null;
let clockTz = null;

function renderFacts(b) {
  const f = b.facts || {}, ap = b.airport;
  clockTz = f.timezone || null;
  const tick = () => {
    try { $('ap-local-time').textContent = new Date().toLocaleTimeString('fr-FR', { timeZone: clockTz || undefined, hour: '2-digit', minute: '2-digit' }); } catch { $('ap-local-time').textContent = f.localTime || '—'; }
  };
  clearInterval(clockTimer);
  tick();
  clockTimer = setInterval(tick, 15_000);
  $('ap-local-date').textContent = `${t('heure locale')} · ${f.localDate || ''}`;
  $('ap-elev').textContent = ap.elevFt != null ? `${t('alt.')} ${ap.elevFt} ft (${f.elevM} m)` : '';

  const rows = [
    [t('Nom'), ap.name],
    ['IATA / ICAO', `${ap.iata || '—'} / ${ap.icao || '—'}`],
    [t('Ville, pays'), [ap.city, ap.countryName || ap.country].filter(Boolean).join(', ')],
    [t('Fuseau horaire'), f.timezone ? `${f.timezone} (UTC${f.utcOffset || ''})` : '—'],
    [t('Altitude'), ap.elevFt != null ? `${ap.elevFt} ft · ${f.elevM} m` : '—'],
    [t('Lever du soleil'), f.polar === 'day' ? t('soleil de minuit') : f.polar === 'night' ? t('nuit polaire') : (f.sunriseLocal || '—')],
    [t('Coucher du soleil'), f.polar ? '—' : (f.sunsetLocal || '—')],
    [t('Taille'), { large: t('grand aéroport'), medium: t('aéroport moyen'), small: t('petit aéroport') }[ap.size] || ap.size],
    [t('Vols réguliers'), ap.scheduledService == null ? '—' : ap.scheduledService ? t('oui') : t('non')],
  ];
  const dl = $('ap-facts');
  dl.textContent = '';
  for (const [k, v] of rows) { const dt = document.createElement('dt'); dt.textContent = k; const dd = document.createElement('dd'); dd.textContent = v; dl.append(dt, dd); }
  const links = [];
  if (ap.links?.home) links.push(`<a class="link" href="${ap.links.home}" target="_blank" rel="noopener">${t('Site officiel')} ↗</a>`);
  if (ap.links?.wikipedia) links.push(`<a class="link" href="${ap.links.wikipedia}" target="_blank" rel="noopener">Wikipédia ↗</a>`);
  if (ap.icao) links.push(`<a class="link" href="/embed.html?airport=${ap.icao}" target="_blank" rel="noopener">${t('Widget')} ↗</a>`);
  if (links.length) { const dt = document.createElement('dt'); dt.textContent = t('Liens'); const dd = document.createElement('dd'); dd.innerHTML = links.join(' · '); dl.append(dt, dd); }
}

// ── Galerie : photos de l'article + Wikimedia Commons, navigables ────────────
let apGallery = [];
let apIndex = 0;

function showAirportPhoto(i) {
  const ph = apGallery[i];
  if (!ph) return;
  apIndex = i;
  const img = $('ap-photo');
  img.classList.add('is-loading');
  img.onload = () => img.classList.remove('is-loading');
  img.onerror = () => { img.classList.remove('is-loading'); if (apGallery.length > 1) { apGallery.splice(i, 1); showAirportPhoto(Math.min(i, apGallery.length - 1)); } else $('ap-photo-wrap').hidden = true; };
  img.src = ph.src;
  $('ap-photo-link').href = ph.page || ph.full || ph.src;
  const credit = [ph.author ? `© ${ph.author}` : null, ph.license || null, ph.date ? ph.date.slice(0, 4) : null].filter(Boolean).join(' · ');
  $('ap-photo-credit').textContent = `${credit ? `${credit} — ` : ''}Wikimedia Commons${ph.description ? ` · ${ph.description}` : ''}`;
  $('ap-photo-count').textContent = `${i + 1} / ${apGallery.length}`;
  $('ap-thumbs').querySelectorAll('img').forEach((el, k) => { el.classList.toggle('is-on', k === i); if (k === i) el.scrollIntoView({ block: 'nearest', inline: 'nearest' }); });
}

function renderWiki(b) {
  const w = b.wiki;
  const wrap = $('ap-photo-wrap'), ex = $('ap-extract');
  apGallery = (b.gallery || []).filter((p) => p.src);
  if (apGallery.length) {
    wrap.hidden = false;
    const many = apGallery.length > 1;
    $('ap-photo-prev').hidden = $('ap-photo-next').hidden = !many;
    $('ap-photo-count').hidden = !many;
    const strip = $('ap-thumbs');
    strip.textContent = '';
    strip.hidden = !many;
    apGallery.forEach((ph, k) => {
      const th = document.createElement('img');
      th.src = ph.src.replace(/\/960px-/, '/250px-');   // vignette 250 px (largeur autorisée par Wikimedia)
      th.alt = ph.title || '';
      th.loading = 'lazy';
      th.addEventListener('click', (e) => { e.preventDefault(); showAirportPhoto(k); });
      th.onerror = () => { th.src = ph.src; };
      strip.appendChild(th);
    });
    showAirportPhoto(0);
  } else wrap.hidden = true;
  if (w?.extract) {
    ex.hidden = false;
    ex.textContent = w.extract.length > 420 ? `${w.extract.slice(0, 420).replace(/\s+\S*$/, '')}… ` : `${w.extract} `;
    const a = document.createElement('a'); a.href = w.url; a.target = '_blank'; a.rel = 'noopener'; a.textContent = t('lire la suite') + ' ↗';
    ex.appendChild(a);
  } else ex.hidden = true;
}

/** « Ciel dégagé », « Nuageux », « Pluie »… d'après le METAR brut. */
function metarConditions(m) {
  const raw = ` ${m.raw || ''} `;
  if (/ (TS|\+?TSRA) /.test(raw)) return t('Orage');
  if (/ (\+|-)?(RA|SHRA|DZ) /.test(raw)) return t('Pluie');
  if (/ (\+|-)?(SN|SHSN|SG) /.test(raw)) return t('Neige');
  if (/ (FG|BR) /.test(raw)) return t('Brouillard / brume');
  if (/ (CAVOK|SKC|CLR|NSC|NCD) /.test(raw)) return t('Ciel dégagé');
  if (/ OVC/.test(raw)) return t('Couvert');
  if (/ BKN/.test(raw)) return t('Nuageux');
  if (/ (SCT|FEW)/.test(raw)) return t('Peu nuageux');
  return '';
}

// ── Statistiques 7 jours ────────────────────────────────────────────────────
function barChart(canvas, series, labels, colors) {
  const dpr = devicePixelRatio || 1;
  const w = canvas.clientWidth || 300, h = Number(canvas.getAttribute('height')) || 70;
  canvas.width = w * dpr; canvas.height = h * dpr; canvas.style.height = `${h}px`;
  const ctx = canvas.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, w, h);
  const css = (v) => getComputedStyle(document.documentElement).getPropertyValue(v).trim();
  const n = labels.length;
  const totals = labels.map((_, i) => series.reduce((s, arr) => s + (arr[i] || 0), 0));
  const max = Math.max(1, ...totals);
  const gap = n > 12 ? 1 : 3, pad = 2;
  const bw = (w - pad * 2) / n - gap;
  ctx.font = '9px ui-monospace, Menlo, monospace';
  for (let i = 0; i < n; i++) {
    let y = h - 12;
    series.forEach((arr, s) => {
      const bh = ((h - 16) * (arr[i] || 0)) / max;
      ctx.fillStyle = colors[s];
      ctx.fillRect(pad + i * (bw + gap), y - bh, bw, bh);
      y -= bh;
    });
    if (n <= 12 || i % 6 === 0) { ctx.fillStyle = css('--faint'); ctx.textAlign = 'center'; ctx.fillText(labels[i], pad + i * (bw + gap) + bw / 2, h - 2); }
  }
  ctx.fillStyle = css('--muted'); ctx.textAlign = 'right'; ctx.fillText(String(max), w - 2, 9);
}

function bars(id, rows, label, count, { empty } = {}) {
  const box = $(id);
  box.textContent = '';
  if (!rows.length) { const p = document.createElement('div'); p.className = 'sched-note'; p.textContent = empty || t('Pas encore de données.'); box.appendChild(p); return; }
  const max = Math.max(1, ...rows.map(count));
  for (const r of rows) {
    const el = document.createElement('div');
    el.className = 'bar';
    el.innerHTML = `<span class="k">${label(r)}</span><span class="b"><i style="width:${(count(r) / max) * 100}%"></i></span><span class="v">${count(r)}</span>`;
    box.appendChild(el);
  }
}

function renderStats(b) {
  const s = b.stats7;
  if (!s) { $('ap-stats-section').hidden = true; return; }
  $('ap-stats-section').hidden = false;
  $('ap-k-total').textContent = s.total;
  $('ap-k-takeoffs').textContent = s.takeoffs;
  $('ap-k-landings').textContent = s.landings;
  const accent = getComputedStyle(document.documentElement).getPropertyValue('--accent').trim();
  barChart($('ap-c-days'), [s.perDay.map((d) => d.takeoffs), s.perDay.map((d) => d.landings)], s.perDay.map((d) => d.day.slice(8)), [accent, '#35c18a']);
  barChart($('ap-c-hours'), [s.perHour.map((h) => h.takeoffs), s.perHour.map((h) => h.landings)], s.perHour.map((_, i) => `${i}h`), [accent, '#35c18a']);
  bars('ap-runway-use', s.runways, (r) => `${t('Piste')} ${r.runway}`, (r) => r.takeoffs + r.landings, { empty: t('Aucune piste identifiée pour l\'instant.') });
  bars('ap-routes', s.routes, (r) => `${b.airport.iata || b.airport.icao}–${r.code} <small>${r.city || r.name || ''}</small>`, (r) => r.count, { empty: t('Trajets pas encore connus.') });
  $('ap-served').textContent = `${s.airportsServed} ${t('aéroports')} · ${s.countriesServed.length} ${t('pays')}`;
  $('ap-stats-note').textContent = s.total
    ? `${t('Décollages')} ${t('en bleu')}, ${t('atterrissages')} ${t('en vert')}. ${t('Observé par ce serveur depuis')} ${new Date(s.since).toLocaleDateString('fr-FR')} — ${t('cet aéroport est surveillé automatiquement pendant 24 h après chaque consultation.')}`
    : t('Aucun mouvement enregistré encore : ce serveur commence à surveiller cet aéroport maintenant (24 h après chaque consultation). Reviens dans quelques heures.');
}

function renderEvents(b) {
  const list = b.events || [];
  $('ap-events-section').hidden = !list.length;
  const box = $('ap-events');
  box.textContent = '';
  for (const e of list) {
    const el = document.createElement('button');
    el.type = 'button';
    el.className = 'leg';
    el.innerHTML = `<span class="leg-time">${fmtClock(new Date(e.t))}</span><span class="leg-route">${t(e.label)} <small>${e.callsign || e.hex.toUpperCase()}</small></span><span class="leg-meta">${e.durationMin ? `${e.durationMin} min` : e.minAlt != null ? `${e.minAlt} ft` : ''}</span>`;
    el.addEventListener('click', () => emit('select-request', e.hex));
    box.appendChild(el);
  }
}

// ── Vue satellite (Esri World Imagery, gratuit avec attribution) ────────────
let sat = null, satLayer = null;
function renderSatellite(b) {
  const ap = b.airport;
  if (!sat) {
    sat = L.map('ap-sat', { zoomControl: false, attributionControl: false, dragging: false, scrollWheelZoom: false, doubleClickZoom: false, boxZoom: false, keyboard: false, touchZoom: false });
    L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}', { maxZoom: 17 }).addTo(sat);
    sat.on('click', () => map.setView(sat.getCenter(), 14));
  }
  if (satLayer) sat.removeLayer(satLayer);
  satLayer = L.layerGroup((b.runways || []).map((rw) => L.polyline(rw.ends.map((e) => [e.lat, e.lon]), { color: '#3fb6ff', weight: 2, opacity: .9 }))).addTo(sat);
  const bounds = (b.runways || []).flatMap((rw) => rw.ends.map((e) => [e.lat, e.lon]));
  setTimeout(() => { sat.invalidateSize(); if (bounds.length >= 2) sat.fitBounds(bounds, { padding: [14, 14], maxZoom: 15 }); else sat.setView([ap.lat, ap.lon], 13); }, 60);
}

export function initAirports() {
  $('ap-photo-prev').addEventListener('click', (e) => { e.preventDefault(); e.stopPropagation(); showAirportPhoto((apIndex - 1 + apGallery.length) % apGallery.length); });
  $('ap-photo-next').addEventListener('click', (e) => { e.preventDefault(); e.stopPropagation(); showAirportPhoto((apIndex + 1) % apGallery.length); });
  document.addEventListener('keydown', (e) => {
    if (panel.hidden || apGallery.length < 2 || e.target.matches('input, textarea, select')) return;
    // fiche aéroport ouverte : ← → font défiler les photos (et pas les avions, cf. a11y.js)
    if (e.key === 'ArrowLeft') { e.preventDefault(); e.stopPropagation(); showAirportPhoto((apIndex - 1 + apGallery.length) % apGallery.length); }
    if (e.key === 'ArrowRight') { e.preventDefault(); e.stopPropagation(); showAirportPhoto((apIndex + 1) % apGallery.length); }
  }, true);
  map.on('moveend zoomend', () => { clearTimeout(loadTimer); loadTimer = setTimeout(loadMarkers, 500); });
  loadMarkers();
  $('airport-close').addEventListener('click', closeAirport);
  // le panneau avion et le panneau aéroport se remplacent
  on('select', (hex) => { if (hex) closeAirport(); });
  on('airport-open', () => emit('close-plane-panel'));
  $('ap-center').addEventListener('click', () => {
    if (currentLatLng) map.setView(currentLatLng, Math.max(map.getZoom(), 12));
  });
  document.addEventListener('visibilitychange', () => { if (!document.hidden && current) loadBoard(); });
  const q = new URLSearchParams(location.search).get('airport');
  if (q) setTimeout(async () => {
    try {
      const res = await fetch(`/api/airport/${encodeURIComponent(q)}`);
      if (!res.ok) { toast(`Aéroport « ${q} » inconnu.`); return; }
      const b = await res.json();
      map.setView([b.airport.lat, b.airport.lon], 11);
      openAirport(q);
    } catch { /* ignore */ }
  }, 300);
}

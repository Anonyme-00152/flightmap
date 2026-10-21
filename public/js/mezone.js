/**
 * Mode « ma zone » : géolocalisation → avions au-dessus de moi (azimut, élévation
 * pour les repérer à l'œil nu) et prochains passages (point d'approche le plus
 * proche calculé à partir du cap et de la vitesse). Tout est calculé ici, 0 appel.
 */
import { planes, state, emit, $, fmtKm, haversineKm, toast } from './state.js';
import { map } from './map.js';
import { passesFilters } from './filters.js';
import { t } from './i18n.js';

const RADIUS_KM = 30;
const PASS_KM = 5;
const HORIZON_MIN = 20;

let me = null;         // { lat, lon }
let marker = null;
let circle = null;
let timer = null;
let watchId = null;
const panel = $('mezone-panel');

const toRad = (d) => (d * Math.PI) / 180;
function bearing(lat1, lon1, lat2, lon2) {
  const y = Math.sin(toRad(lon2 - lon1)) * Math.cos(toRad(lat2));
  const x = Math.cos(toRad(lat1)) * Math.sin(toRad(lat2)) - Math.sin(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.cos(toRad(lon2 - lon1));
  return (Math.atan2(y, x) * 180 / Math.PI + 360) % 360;
}
const COMPASS = ['N', 'NNE', 'NE', 'ENE', 'E', 'ESE', 'SE', 'SSE', 'S', 'SSO', 'SO', 'OSO', 'O', 'ONO', 'NO', 'NNO'];
const compass = (deg) => COMPASS[Math.round(deg / 22.5) % 16];

/** Point d'approche le plus proche d'un mobile rectiligne : temps (min) et distance (km). */
function closestApproach(p) {
  if (p.speed == null || p.track == null || p.speed < 40) return null;
  // repère local plan (km), origine = moi
  const kx = 111.2 * Math.cos(toRad(me.lat));
  const x = (p.rLon - me.lon) * kx, y = (p.rLat - me.lat) * 111.2;
  const v = p.speed * 1.852 / 60;   // km/min
  const vx = v * Math.sin(toRad(p.track)), vy = v * Math.cos(toRad(p.track));
  const tMin = -(x * vx + y * vy) / (vx * vx + vy * vy);
  if (tMin <= 0 || tMin > HORIZON_MIN) return null;
  const dx = x + vx * tMin, dy = y + vy * tMin;
  return { tMin, distKm: Math.hypot(dx, dy) };
}

function update() {
  if (!me || panel.hidden) return;
  const above = [], passes = [];
  for (const p of planes.values()) {
    if (!passesFilters(p) || p.onGround) continue;
    const d = haversineKm(me.lat, me.lon, p.rLat, p.rLon);
    if (d <= RADIUS_KM) {
      const altM = (p.alt || 0) * 0.3048;
      const elev = Math.atan2(altM, d * 1000) * 180 / Math.PI;
      above.push({ p, d, az: bearing(me.lat, me.lon, p.rLat, p.rLon), elev });
    }
    const ca = closestApproach(p);
    if (ca && ca.distKm <= PASS_KM && d > PASS_KM) passes.push({ p, ...ca });
  }
  above.sort((a, b) => a.d - b.d);
  passes.sort((a, b) => a.tMin - b.tMin);

  const fill = (id, list, fmt) => {
    const box = $(id);
    box.textContent = '';
    if (!list.length) { const e = document.createElement('div'); e.className = 'sched-note'; e.textContent = t('Rien à moins de 30 km pour l\'instant.'); box.appendChild(e); return; }
    for (const item of list.slice(0, 12)) {
      const el = document.createElement('button');
      el.type = 'button';
      el.className = 'leg';
      el.innerHTML = fmt(item);
      el.addEventListener('click', () => emit('select-request', item.p.hex));
      box.appendChild(el);
    }
  };
  fill('mz-above', above, ({ p, d, az, elev }) =>
    `<span class="leg-time">${fmtKm(d)}</span><span class="leg-route">${p.callsign || p.reg || p.hex.toUpperCase()} <small>${p.type || ''}</small></span><span class="leg-meta">${compass(az)} ${Math.round(az)}° · ${t('élévation')} ${Math.round(elev)}° · ${p.alt != null ? `${Math.round(p.alt / 100) * 100} ft` : ''}</span>`);
  fill('mz-passes', passes, ({ p, tMin, distKm }) =>
    `<span class="leg-time">${t('dans')} ${Math.max(1, Math.round(tMin))} min</span><span class="leg-route">${p.callsign || p.reg || p.hex.toUpperCase()} <small>${p.type || ''}</small></span><span class="leg-meta">${t('passe à')} ${distKm < 1 ? `${Math.round(distKm * 1000)} m` : fmtKm(distKm)} · ${p.alt != null ? `${Math.round(p.alt / 100) * 100} ft` : ''}</span>`);
  $('mz-count').textContent = `${above.length} ${t('avions')} < ${RADIUS_KM} km`;
}

function place(lat, lon) {
  me = { lat, lon };
  if (!marker) {
    marker = L.circleMarker([lat, lon], { radius: 7, color: '#fff', fillColor: '#ff7a59', fillOpacity: 1, weight: 2 }).addTo(map).bindTooltip('Moi', { permanent: false });
    circle = L.circle([lat, lon], { radius: RADIUS_KM * 1000, color: '#ff7a59', weight: 1, fill: false, dashArray: '4 6', opacity: .6 }).addTo(map);
  } else { marker.setLatLng([lat, lon]); circle.setLatLng([lat, lon]); }
  update();
}

export function openMyZone() {
  panel.hidden = false;
  emit('mezone-open');
  if (!('geolocation' in navigator)) { toast('Géolocalisation indisponible sur ce navigateur.'); return; }
  $('mz-status').textContent = 'Localisation…';
  navigator.geolocation.getCurrentPosition((pos) => {
    place(pos.coords.latitude, pos.coords.longitude);
    map.setView([pos.coords.latitude, pos.coords.longitude], Math.max(map.getZoom(), 9));
    $('mz-status').textContent = `${pos.coords.latitude.toFixed(3)}, ${pos.coords.longitude.toFixed(3)} (±${Math.round(pos.coords.accuracy)} m)`;
    watchId = navigator.geolocation.watchPosition((p2) => place(p2.coords.latitude, p2.coords.longitude), () => {}, { enableHighAccuracy: false, maximumAge: 30_000 });
  }, () => {
    $('mz-status').textContent = t('Localisation refusée.') + ' ' + 'Clique sur la carte pour placer ta position.';
    map.once('click', (e) => { place(e.latlng.lat, e.latlng.lng); $('mz-status').textContent = `${e.latlng.lat.toFixed(3)}, ${e.latlng.lng.toFixed(3)} (manuel)`; });
  }, { timeout: 10_000, maximumAge: 60_000 });
  clearInterval(timer);
  timer = setInterval(update, 3000);
}

export function closeMyZone() {
  panel.hidden = true;
  clearInterval(timer);
  if (watchId != null) { navigator.geolocation.clearWatch(watchId); watchId = null; }
  if (marker) { map.removeLayer(marker); map.removeLayer(circle); marker = circle = null; }
  me = null;
}

export function initMyZone() {
  $('mezone-btn').addEventListener('click', () => (panel.hidden ? openMyZone() : closeMyZone()));
  $('mezone-close').addEventListener('click', closeMyZone);
}

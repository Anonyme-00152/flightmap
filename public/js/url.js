/**
 * URL partageable : ?hex=392aec · ?callsign=AFR1496 · ?reg=F-GKXM
 * et la vue ?lat=48.86&lon=2.35&z=8. Mise à jour sans rechargement.
 */
import { planes, state, on, toast } from './state.js';
import { map } from './map.js';
import { select } from './panel.js';
import { searchGlobal } from './data.js';

let urlTimer;

function writeUrl() {
  clearTimeout(urlTimer);
  urlTimer = setTimeout(() => {
    const u = new URL(location.href);
    const c = map.getCenter();
    u.searchParams.set('lat', c.lat.toFixed(3));
    u.searchParams.set('lon', c.lng.toFixed(3));
    u.searchParams.set('z', String(map.getZoom()));
    u.searchParams.delete('callsign');
    u.searchParams.delete('reg');
    if (state.selectedHex) u.searchParams.set('hex', state.selectedHex); else u.searchParams.delete('hex');
    history.replaceState(null, '', u);
  }, 400);
}

export function initUrl() {
  const q = new URLSearchParams(location.search);
  const lat = Number.parseFloat(q.get('lat')), lon = Number.parseFloat(q.get('lon')), z = Number.parseInt(q.get('z') || '', 10);
  if (Number.isFinite(lat) && Number.isFinite(lon)) map.setView([lat, lon], Number.isFinite(z) ? z : map.getZoom());

  const target = q.get('hex') || q.get('callsign') || q.get('reg');
  if (target) openTarget(target.trim());

  map.on('moveend', writeUrl);
  on('select', writeUrl);
}

/** Ouvre un avion par hex/callsign/immat : dans la zone si présent, sinon recherche mondiale. */
export async function openTarget(query) {
  const q = query.toUpperCase();
  // 1) déjà chargé ?
  const tryLocal = () => {
    for (const [hex, p] of planes) {
      if (hex.toUpperCase() === q || (p.callsign || '') === q || (p.reg || '').toUpperCase() === q) return hex;
    }
    return null;
  };
  let hex = tryLocal();
  // 2) le premier lot de positions n'est peut-être pas encore arrivé
  if (!hex) { await new Promise((r) => setTimeout(r, 2500)); hex = tryLocal(); }
  // 3) recherche mondiale
  if (!hex) {
    try { hex = await searchGlobal(q); } catch { /* ci-dessous */ }
  }
  if (!hex) { toast(`« ${query} » : aucun avion en vol avec ce callsign / immat / hex.`, { duration: 6000 }); return false; }
  select(hex, { pan: true });
  return true;
}

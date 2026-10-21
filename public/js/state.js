/**
 * État partagé + bus d'événements. Les modules ne s'importent pas en
 * cercle : ils lisent/écrivent ici et s'écoutent via `on` / `emit`.
 */
export const CONFIG = {
  refreshMs: 5000,          // fréquence d'appel au backend (mode poll)
  maxAgeMs: 90_000,         // au-delà, l'avion est retiré de la carte
  maxDeadReckonMs: 60_000,  // on n'extrapole jamais plus d'1 min
  smoothing: 0.18,          // 0 = figé, 1 = saut brutal
  hitRadiusPx: 15,
  start: { lat: 48.86, lon: 2.35, zoom: 8 },
};

/** @type {Map<string, object>} hex -> avion (positions + champs ADS-B) */
export const planes = new Map();

export const state = {
  selectedHex: null,
  followHex: null,
  details: null,     // réponse /api/flight
  trail: null,       // réponse /api/trail
  theme: 'dark',
  lastUpdate: 0,
  source: '',
  filters: {
    military: false, emergency: false, notable: false, hideGround: false,
    altMin: 0, altMax: 60000, airline: '', type: '', text: '',
  },
  alerts: { emergency: false, notable: false, military: false },
};

const bus = new EventTarget();
export function emit(name, detail) { bus.dispatchEvent(new CustomEvent(name, { detail })); }
export function on(name, fn) { bus.addEventListener(name, (e) => fn(e.detail)); }

// ── Persistance légère des préférences (par navigateur) ─────────────────────
export function loadPrefs() {
  try {
    const saved = JSON.parse(localStorage.getItem('flightmap:prefs') || '{}');
    if (saved.filters) Object.assign(state.filters, saved.filters);
    if (saved.alerts) Object.assign(state.alerts, saved.alerts);
    if (saved.theme) state.theme = saved.theme;
  } catch { /* stockage indisponible : valeurs par défaut */ }
}

export function savePrefs() {
  try {
    localStorage.setItem('flightmap:prefs', JSON.stringify({ filters: state.filters, alerts: state.alerts, theme: state.theme }));
  } catch { /* ignore */ }
}

// ── Utilitaires partagés ────────────────────────────────────────────────────
export function setText(id, value) {
  const el = document.getElementById(id);
  if (el && el.textContent !== value) el.textContent = value;
}

export const $ = (id) => document.getElementById(id);

export function fmtClock(date, tz) {
  try {
    return date.toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit', timeZone: tz || undefined });
  } catch {
    return date.toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' });
  }
}

export function fmtDuration(ms) {
  const m = Math.max(0, Math.round(ms / 60_000));
  return m >= 60 ? `${Math.floor(m / 60)} h ${String(m % 60).padStart(2, '0')}` : `${m} min`;
}

export const fmtKm = (km) => `${Math.round(km).toLocaleString('fr-FR')} km`;

export function haversineKm(lat1, lon1, lat2, lon2) {
  const toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1), dLon = toRad(lon2 - lon1);
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return 2 * 6371 * Math.asin(Math.sqrt(a));
}

/** Un callsign de ligne régulière : AFR1496, BAW12A. */
export const looksAirline = (cs) => /^[A-Z]{3}\d{1,4}[A-Z]{0,2}$/.test(cs || '');

/** Toast discret en bas de l'écran. */
export function toast(message, { duration = 4000, kind = '' } = {}) {
  const box = document.getElementById('toasts');
  if (!box) return;
  const el = document.createElement('div');
  el.className = `toast${kind ? ` toast--${kind}` : ''}`;
  el.textContent = message;
  box.appendChild(el);
  requestAnimationFrame(() => el.classList.add('is-in'));
  setTimeout(() => { el.classList.remove('is-in'); setTimeout(() => el.remove(), 300); }, duration);
}

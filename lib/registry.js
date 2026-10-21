/**
 * Ce que l'archive SQLite permet de déduire, sans aucune API :
 *   - prédiction d'arrivée : durée réelle médiane des vols passés du même callsign
 *   - fiche par avion (immatriculation / hex) : vols, heures, aéroports fréquentés
 *   - fiche par vol (numéro) : ponctualité observée, durées, appareils utilisés
 */
import * as store from './store.js';
import { hexForReg, lastSeenState, aircraftCache } from './providers.js';
import { AIRLINE_NAMES, AIRLINE_IATA } from './stats.js';

const DAY = 24 * 3600_000;

/** "AF1496" → "AFR1496" ; "AFR1496" inchangé. */
export function toIcaoCallsign(number) {
  const n = String(number || '').toUpperCase().replace(/\s+/g, '');
  const m = /^([A-Z0-9]{2})(\d{1,4}[A-Z]?)$/.exec(n);
  if (m && AIRLINE_IATA.has(m[1])) return AIRLINE_IATA.get(m[1]) + m[2];
  return n;
}

function median(values) {
  if (!values.length) return null;
  const s = [...values].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : Math.round((s[mid - 1] + s[mid]) / 2);
}
const percentile = (values, p) => {
  if (!values.length) return null;
  const s = [...values].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor(p * s.length))];
};

/** Durée décollage → atterrissage des vols complets d'un callsign (30 jours). */
function completedLegs(callsign, days = 30) {
  return store.legsByCallsign(callsign, Date.now() - days * DAY)
    .filter((l) => l.complete && l.takeoffAt && l.landedAt && l.durationMin >= 10);
}

/**
 * Prédiction : « ce vol met habituellement X min ». Renvoie null si moins de 2 vols connus.
 * @returns {{samples, medianMin, p25Min, p75Min, lastLegs}|null}
 */
export function predictDuration(callsign) {
  const cs = toIcaoCallsign(callsign);
  if (!cs) return null;
  const legs = completedLegs(cs);
  const durations = legs.map((l) => Math.round((new Date(l.landedAt) - new Date(l.takeoffAt)) / 60_000));
  if (durations.length < 2) return null;
  return {
    callsign: cs,
    samples: durations.length,
    medianMin: median(durations),
    p25Min: percentile(durations, 0.25),
    p75Min: percentile(durations, 0.75),
    lastLegs: legs.slice(-5).reverse().map((l) => ({
      date: l.takeoffAt.slice(0, 10), hex: l.hex, from: l.from?.iata || null, to: l.to?.iata || null,
      durationMin: Math.round((new Date(l.landedAt) - new Date(l.takeoffAt)) / 60_000),
    })),
  };
}

// ── Fiche avion ─────────────────────────────────────────────────────────────
export function aircraftPage(query) {
  const q = String(query || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
  let hex = /^[0-9A-F]{6}$/.test(q) ? q.toLowerCase() : hexForReg(q);
  // l'immat peut aussi être connue via une fiche déjà en cache (persistante)
  if (!hex) {
    for (const [k, entry] of aircraftCache.map) {
      const reg = String(entry.value?.registration || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
      if (reg && reg === q) { hex = k; break; }
    }
  }
  if (!hex) return null;
  const legs = store.legList(hex, Date.now() - 30 * DAY);
  const seen = lastSeenState(hex);
  // fiche adsbdb si on l'a, sinon ce que l'ADS-B a diffusé (immat, type)
  const info = aircraftCache.get(hex) || (seen ? { registration: seen.reg || null, type: seen.desc || seen.type || null, icaoType: seen.type || null, source: 'ADS-B' } : null);
  const airports = new Map();
  let minutes = 0, km = 0;
  for (const l of legs) {
    minutes += l.durationMin || 0;
    km += l.distanceKm || 0;
    for (const ap of [l.from, l.to]) if (ap?.iata) airports.set(ap.iata, { ...(airports.get(ap.iata) || { iata: ap.iata, name: ap.name, city: ap.city, count: 0 }), count: (airports.get(ap.iata)?.count || 0) + 1 });
  }
  const callsigns = new Map();
  for (const l of legs) if (l.callsign) callsigns.set(l.callsign, (callsigns.get(l.callsign) || 0) + 1);
  return {
    hex,
    registration: info?.registration || null,
    info,
    totals: { flights: legs.length, hours: Math.round(minutes / 6) / 10, km: Math.round(km), days: 30 },
    airports: [...airports.values()].sort((a, b) => b.count - a.count).slice(0, 15),
    callsigns: [...callsigns.entries()].sort((a, b) => b[1] - a[1]).slice(0, 15).map(([callsign, count]) => ({ callsign, count, airline: AIRLINE_NAMES.get(callsign.slice(0, 3)) || null })),
    legs: legs.slice(-60).reverse().map(({ points, ...rest }) => ({ ...rest, pointCount: rest.pointCount })),   // sans les points (lourds)
    lastSeen: legs.length ? legs[legs.length - 1].end : null,
  };
}

// ── Fiche vol ───────────────────────────────────────────────────────────────
export function flightPage(number) {
  const cs = toIcaoCallsign(number);
  if (!cs) return null;
  const legs = store.legsByCallsign(cs, Date.now() - 30 * DAY);
  if (!legs.length) return { callsign: cs, airline: AIRLINE_NAMES.get(cs.slice(0, 3)) || null, legs: [], totals: { flights: 0 } };

  const complete = legs.filter((l) => l.complete && l.takeoffAt && l.landedAt);
  const durations = complete.map((l) => Math.round((new Date(l.landedAt) - new Date(l.takeoffAt)) / 60_000));
  const routes = new Map();
  for (const l of legs) {
    const k = `${l.from?.iata || '?'}→${l.to?.iata || '?'}`;
    routes.set(k, (routes.get(k) || 0) + 1);
  }
  const aircraft = new Map();
  for (const l of legs) {
    const info = aircraftCache.get(l.hex);
    const k = info?.registration || l.hex.toUpperCase();
    const cur = aircraft.get(k) || { registration: info?.registration || null, hex: l.hex, type: info?.type || null, count: 0 };
    cur.count++;
    aircraft.set(k, cur);
  }
  // ponctualité observée : heure de décollage réelle (locale UTC) par jour → écart-type des minutes dans la journée
  const takeoffMinutes = complete.map((l) => { const d = new Date(l.takeoffAt); return d.getUTCHours() * 60 + d.getUTCMinutes(); });
  const medTakeoff = median(takeoffMinutes);
  const spread = takeoffMinutes.length >= 2
    ? Math.round(Math.sqrt(takeoffMinutes.reduce((s, m) => s + (m - medTakeoff) ** 2, 0) / takeoffMinutes.length))
    : null;
  return {
    callsign: cs,
    airline: AIRLINE_NAMES.get(cs.slice(0, 3)) || null,
    totals: { flights: legs.length, complete: complete.length, days: 30 },
    duration: durations.length ? { medianMin: median(durations), p25Min: percentile(durations, 0.25), p75Min: percentile(durations, 0.75), minMin: Math.min(...durations), maxMin: Math.max(...durations) } : null,
    punctuality: medTakeoff != null ? {
      typicalTakeoffUtc: `${String(Math.floor(medTakeoff / 60)).padStart(2, '0')}:${String(medTakeoff % 60).padStart(2, '0')}`,
      spreadMin: spread,
      note: 'Heure de décollage réelle observée (UTC) ; l\'écart mesure la régularité, pas le retard vs l\'horaire publié.',
    } : null,
    routes: [...routes.entries()].sort((a, b) => b[1] - a[1]).map(([route, count]) => ({ route, count })),
    aircraft: [...aircraft.values()].sort((a, b) => b.count - a.count),
    events: legs.flatMap((l) => (l.events || []).map((e) => ({ ...e, hex: l.hex }))).slice(-20).reverse(),
    legs: legs.slice(-60).reverse().map(({ points, ...rest }) => rest),
  };
}

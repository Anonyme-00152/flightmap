/**
 * Détection d'événements dans une trace (0 appel réseau) :
 *   go_around  remise de gaz : descente sous 2 500 ft puis remontée franche sans toucher le sol
 *   holding    attente en hippodrome : ≥ 330° de virage cumulé en < 12 min sans s'éloigner
 *   return     retour au point de départ (atterrit là où il a décollé, après ≥ 15 min)
 *   diverted   déroutement : atterrit ailleurs que la destination annoncée (nécessite le trajet)
 *
 * Les points sont ceux de lib/trail.js : { t, lat, lon, alt (ft, 0 = sol), onGround, gs, track, vr }.
 * Un flux des événements récents (24 h) est conservé en mémoire pour /api/events et /stats.
 */
import * as ref from './refdata.js';

const LABELS = {
  go_around: 'Remise de gaz',
  holding: 'Attente en hippodrome',
  return: 'Retour au départ',
  diverted: 'Déroutement',
  emergency: 'Urgence',
};
export const EVENT_LABELS = LABELS;

const toRad = (d) => (d * Math.PI) / 180;
function distKm(a, b) {
  const dLat = toRad(b.lat - a.lat), dLon = toRad(b.lon - a.lon);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLon / 2) ** 2;
  return 2 * 6371 * Math.asin(Math.sqrt(h));
}
const headingDelta = (a, b) => (((b - a + 540) % 360) - 180);   // signé, dans [-180, 180)

function mkEvent(type, p, detail = {}) {
  return { type, label: LABELS[type], t: new Date(p.t).toISOString(), lat: p.lat, lon: p.lon, alt: p.alt ?? null, ...detail };
}

// ── Remise de gaz ───────────────────────────────────────────────────────────
export function detectGoArounds(points) {
  const events = [];
  let lastEventT = -Infinity;
  for (let i = 1; i < points.length - 1; i++) {
    const p = points[i];
    if (p.onGround || p.alt == null || p.alt > 2500) continue;
    // minimum local d'altitude : on descendait avant, on ne descend plus après
    const before = points[i - 1], after = points[i + 1];
    if (before.alt == null || before.alt < p.alt) continue;
    if (after.alt != null && after.alt < p.alt) continue;
    if (p.t - lastEventT < 10 * 60_000) continue;
    // il faut une vraie approche avant : ≥ 1 500 ft de descente dans les 6 min précédentes, sans passage au sol
    // (sinon un décollage avec altitude baro négative serait pris pour une remise de gaz)
    let maxBefore = p.alt, groundBefore = false;
    for (let k = i - 1; k >= 0 && p.t - points[k].t <= 6 * 60_000; k--) {
      if (points[k].onGround) { groundBefore = true; break; }
      if (points[k].alt != null && points[k].alt > maxBefore) maxBefore = points[k].alt;
    }
    if (groundBefore || maxBefore - p.alt < 1500) continue;
    // remontée ≥ 1 200 ft dans les 5 min qui suivent, sans passer au sol
    let climbed = false;
    for (let j = i + 1; j < points.length && points[j].t - p.t <= 5 * 60_000; j++) {
      const q = points[j];
      if (q.onGround) break;
      if (q.alt != null && q.alt - p.alt >= 1200 && (q.vr == null || q.vr > 300)) { climbed = true; break; }
    }
    if (!climbed) continue;
    // …et ça se passe près d'un aéroport (sinon c'est juste un vol bas)
    const ap = ref.nearestAirport(p.lat, p.lon, 25);
    if (!ap) continue;
    events.push(mkEvent('go_around', p, { airport: { iata: ap.iata, icao: ap.icao, name: ap.name }, minAlt: Math.round(p.alt) }));
    lastEventT = p.t;
  }
  return events;
}

// ── Attente en hippodrome ───────────────────────────────────────────────────
export function detectHolding(points) {
  const events = [];
  const WINDOW = 12 * 60_000;
  let i = 0;
  while (i < points.length) {
    const start = points[i];
    if (start.onGround || start.track == null || (start.alt != null && start.alt < 1500)) { i++; continue; }
    let turned = 0, j = i;
    let found = -1;
    for (j = i + 1; j < points.length && points[j].t - start.t <= WINDOW; j++) {
      const a = points[j - 1], b = points[j];
      if (a.track == null || b.track == null || b.onGround) break;
      turned += headingDelta(a.track, b.track);
      if (Math.abs(turned) >= 330 && distKm(start, b) < 12) { found = j; break; }
    }
    if (found < 0) { i++; continue; }
    // on prolonge tant que l'avion continue de tourner sans s'éloigner
    let end = found, total = Math.abs(turned);
    let k = found;
    while (k + 1 < points.length) {
      const a = points[k], b = points[k + 1];
      if (a.track == null || b.track == null || b.onGround || b.t - a.t > 3 * 60_000) break;
      if (distKm(start, b) > 15) break;
      total += Math.abs(headingDelta(a.track, b.track));
      end = k + 1;
      k++;
      if (b.t - points[end].t > WINDOW) break;
    }
    const durationMin = Math.round((points[end].t - start.t) / 60_000);
    if (durationMin >= 4) {
      events.push(mkEvent('holding', start, { durationMin, turns: Math.round(total / 360 * 10) / 10, altBand: start.alt != null ? Math.round(start.alt / 1000) * 1000 : null }));
    }
    i = end + 1;
  }
  return events;
}

// ── Événements d'un vol résumé (from / to connus) ───────────────────────────
export function detectLegEvents(points, summary, { destination = null } = {}) {
  const events = [...detectGoArounds(points), ...detectHolding(points)];
  const from = summary?.from, to = summary?.to;
  if (from && to && summary.complete && summary.durationMin >= 15 && (from.icao || from.iata) && (from.icao === to.icao || from.iata === to.iata)) {
    events.push(mkEvent('return', points[points.length - 1], { airport: { iata: to.iata, icao: to.icao, name: to.name } }));
  }
  if (destination && to && summary.complete && destination.iata && to.iata && destination.iata !== to.iata) {
    events.push(mkEvent('diverted', points[points.length - 1], {
      planned: { iata: destination.iata, icao: destination.icao, name: destination.name },
      actual: { iata: to.iata, icao: to.icao, name: to.name },
    }));
  }
  return events.sort((a, b) => new Date(a.t) - new Date(b.t));
}

// ── Flux des événements récents (mémoire, 24 h) ─────────────────────────────
const recent = new Map();   // clé de dédoublonnage → événement
const RECENT_TTL = 24 * 3600_000;

export function recordEvents(hex, callsign, events) {
  const now = Date.now();
  for (const e of events) {
    const key = `${hex}:${e.type}:${Math.round(new Date(e.t).getTime() / 300_000)}`;   // même événement à 5 min près
    if (now - new Date(e.t).getTime() > RECENT_TTL) continue;
    recent.set(key, { hex, callsign: callsign || null, ...e });
  }
  if (recent.size > 500) {
    for (const [k, e] of recent) if (now - new Date(e.t).getTime() > RECENT_TTL) recent.delete(k);
  }
}

/** Les plus récents d'abord. */
export function recentEvents(limit = 100) {
  const now = Date.now();
  return [...recent.values()]
    .filter((e) => now - new Date(e.t).getTime() <= RECENT_TTL)
    .sort((a, b) => new Date(b.t) - new Date(a.t))
    .slice(0, limit);
}

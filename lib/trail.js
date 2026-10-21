/**
 * 07 · TRACE RÉELLE DU VOL — les points GPS effectivement parcourus.
 *
 * adsb.lol publie gratuitement, sans clé, la trace de chaque avion sur la
 * journée (format readsb/tar1090) :
 *   https://adsb.lol/data/traces/<2 derniers hex>/trace_full_<hex>.json
 *
 * Elle contient souvent PLUSIEURS vols (l'avion enchaîne les rotations).
 * On la découpe en « legs » (un leg = un vol) et on devine les aéroports de
 * départ/arrivée à partir du premier/dernier point au sol (OurAirports, local).
 *
 * Secours si adsb.lol ne répond pas : l'historique enregistré par ce serveur
 * (lib/providers.js) — plus court, mais toujours là.
 */
import { fetchJson, createLimiter } from './limiter.js';
import { TTLCache, createDeduper } from './cache.js';
import { getLocalHistory } from './providers.js';

// Les traces sont des fichiers statiques servis par adsb.lol (pas l'API) :
// file dédiée pour ne pas attendre derrière les positions, ~1 req/s quand même.
const limitTrace = createLimiter(900);
import * as ref from './refdata.js';
import { archiveLegs } from './archive.js';
import { detectLegEvents, recordEvents } from './events.js';

const UA = process.env.USER_AGENT || 'flightmap/2.0 (projet perso de suivi de vols)';

export const trailCache = new TTLCache({ ttl: 45_000, max: 2_000, name: 'trails' });
const dedupe = createDeduper();

const LEG_GAP_MS = 20 * 60_000;      // 20 min sans signal = nouveau vol
const NEAR_AIRPORT_FT = 3000;        // sous 3 000 ft près d'un aéroport = décollage / atterrissage
const MAX_POINTS_CURRENT = 1500;
const MAX_POINTS_PREVIOUS = 400;

// ── Lecture du format tar1090 ───────────────────────────────────────────────
// point = [dt, lat, lon, alt_baro|"ground", gs, track, flags, vr, ac, source, alt_geom, geom_vr, ias, roll]
// flags : bit 1 (=2) → readsb a détecté un nouveau leg (nouveau vol)
export function parseTrace(json) {
  const base = (json?.timestamp || 0) * 1000;
  const out = [];
  for (const p of json?.trace || []) {
    if (typeof p?.[1] !== 'number' || typeof p?.[2] !== 'number') continue;
    const alt = p[3];
    out.push({
      t: base + p[0] * 1000,
      lat: p[1], lon: p[2],
      alt: alt === 'ground' ? 0 : typeof alt === 'number' ? alt : null,
      onGround: alt === 'ground',
      gs: typeof p[4] === 'number' ? p[4] : null,
      track: typeof p[5] === 'number' ? p[5] : null,
      vr: typeof p[7] === 'number' ? p[7] : null,
      newLeg: Boolean((p[6] ?? 0) & 2),
      // readsb glisse parfois l'objet avion complet : on y lit le callsign du moment
      callsign: typeof p[8]?.flight === 'string' ? p[8].flight.trim().toUpperCase() || null : null,
    });
  }
  return out;
}

// ── Découpage en vols ───────────────────────────────────────────────────────
export function splitLegs(points) {
  const legs = [];
  let cur = [];
  let airborneSeen = false;
  for (let i = 0; i < points.length; i++) {
    const p = points[i];
    const prev = points[i - 1];
    const gap = prev ? p.t - prev.t > LEG_GAP_MS : false;
    // sol → air après avoir déjà volé dans ce leg = l'avion a atterri puis redécollé
    const reTakeoff = prev?.onGround && !p.onGround && airborneSeen && cur.some((q) => q.onGround);
    if (cur.length && (gap || p.newLeg || reTakeoff)) {
      legs.push(cur);
      cur = [];
      airborneSeen = false;
    }
    cur.push(p);
    if (!p.onGround) airborneSeen = true;
  }
  if (cur.length) legs.push(cur);
  // un leg sans aucun point en l'air (roulage seul) n'intéresse personne
  return legs.filter((l) => l.some((p) => !p.onGround));
}

// ── Géométrie ───────────────────────────────────────────────────────────────
function haversineKm(a, b) {
  const toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat), dLon = toRad(b.lon - a.lon);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLon / 2) ** 2;
  return 2 * 6371 * Math.asin(Math.sqrt(h));
}

/** Garde au plus `max` points, en conservant toujours le premier et le dernier. */
function downsample(points, max) {
  if (points.length <= max) return points;
  const step = (points.length - 1) / (max - 1);
  const out = [];
  for (let i = 0; i < max; i++) out.push(points[Math.round(i * step)]);
  return out;
}

/** Aéroport près d'un point bas / au sol, sinon null. */
function airportAt(p) {
  if (!p) return null;
  if (!p.onGround && (p.alt == null || p.alt > NEAR_AIRPORT_FT)) return null;
  const ap = ref.nearestAirport(p.lat, p.lon, p.onGround ? 8 : 20);
  return ap ? { iata: ap.iata, icao: ap.icao, name: ap.name, city: ap.city, lat: ap.lat, lon: ap.lon } : null;
}

export function summarizeLeg(points, { isCurrent, now, callsign = null, destination = null }) {
  const first = points[0], last = points[points.length - 1];

  // callsign du vol : le plus fréquent dans la trace, sinon celui fourni par l'appelant
  const csCount = new Map();
  for (const p of points) if (p.callsign) csCount.set(p.callsign, (csCount.get(p.callsign) || 0) + 1);
  const legCallsign = [...csCount.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] || (isCurrent ? callsign : null);
  const airborne = points.filter((p) => !p.onGround);
  const firstAir = airborne[0] || null;
  const lastAir = airborne[airborne.length - 1] || null;

  let distanceKm = 0, maxAlt = 0, maxGs = 0;
  for (let i = 1; i < points.length; i++) distanceKm += haversineKm(points[i - 1], points[i]);
  for (const p of points) {
    if (p.alt != null && p.alt > maxAlt) maxAlt = p.alt;
    if (p.gs != null && p.gs > maxGs) maxGs = p.gs;
  }

  // décollage = premier point en l'air si on a vu le sol ou la montée initiale
  const sawStart = first.onGround || (firstAir && firstAir.alt != null && firstAir.alt < NEAR_AIRPORT_FT);
  // atterrissage = dernier point au sol / bas ET plus de signal depuis un moment
  const ended = !isCurrent || now - last.t > 10 * 60_000;
  const sawEnd = ended && (last.onGround || (last.alt != null && last.alt < NEAR_AIRPORT_FT));

  const summary = {
    start: new Date(first.t).toISOString(),
    end: new Date(last.t).toISOString(),
    callsign: legCallsign,
    takeoffAt: sawStart && firstAir ? new Date(firstAir.t).toISOString() : null,
    landedAt: sawEnd && lastAir ? new Date(lastAir.t).toISOString() : null,
    from: sawStart ? airportAt(first) || airportAt(firstAir) : null,
    to: sawEnd ? airportAt(last) || airportAt(lastAir) : null,
    complete: Boolean(sawStart && sawEnd),
    durationMin: Math.round((last.t - (firstAir?.t ?? first.t)) / 60_000),
    distanceKm: Math.round(distanceKm),
    maxAlt: Math.round(maxAlt),
    maxGs: Math.round(maxGs),
    pointCount: points.length,
    // tableau compact : [t, lat, lon, alt(ft, 0=sol), gs, track, vr]
    points: downsample(points, isCurrent ? MAX_POINTS_CURRENT : MAX_POINTS_PREVIOUS)
      .map((p) => [p.t, +p.lat.toFixed(5), +p.lon.toFixed(5), p.onGround ? 0 : p.alt, p.gs, p.track, p.vr]),
  };
  // remises de gaz, attentes, retour, déroutement (destination connue seulement pour le vol en cours)
  try { summary.events = detectLegEvents(points, summary, { destination: isCurrent ? destination : null }); } catch { summary.events = []; }
  return summary;
}

// ── Point d'entrée ──────────────────────────────────────────────────────────
/**
 * trace_full = toute la journée mais régénérée par lots (jusqu'à ~30 min de
 * retard) ; trace_recent = les dernières minutes, à jour. On fusionne les deux.
 */
async function fetchAdsbLolTrace(hex) {
  const base = `https://adsb.lol/data/traces/${hex.slice(-2)}`;
  const get = (name) => limitTrace(() => fetchJson(`${base}/${name}_${hex}.json`, { userAgent: UA, timeout: 9000 }));
  const [full, recent] = await Promise.allSettled([get('trace_full'), get('trace_recent')]);
  if (full.status === 'rejected' && recent.status === 'rejected') throw full.reason;

  const points = full.status === 'fulfilled' ? parseTrace(full.value) : [];
  if (recent.status === 'fulfilled') {
    const lastT = points.length ? points[points.length - 1].t : 0;
    for (const p of parseTrace(recent.value)) if (p.t > lastT + 500) points.push(p);
  }
  return points;
}

export async function getTrail(hex, { force = false, callsign = null, destination = null } = {}) {
  const key = String(hex).toLowerCase();
  const cached = force ? undefined : trailCache.get(key);
  if (cached) return cached;

  return dedupe(`trail:${key}`, async () => {
    const now = Date.now();
    let points = [];
    let source = 'adsb.lol';
    try {
      points = await fetchAdsbLolTrace(key);
    } catch (err) {
      if (err.status !== 404) console.warn(`[trail] ${key}: ${err.message} → historique local`);
      source = 'local';
    }

    // Complète avec ce que ce serveur a vu de plus récent (la trace publiée a un peu de retard)
    const lastT = points.length ? points[points.length - 1].t : 0;
    const local = getLocalHistory(key).filter((p) => p.t > lastT + 5_000);
    if (local.length) points = points.concat(local.map((p) => ({ ...p, newLeg: false })));
    if (!points.length) return trailCache.set(key, { hex: key, source: 'none', legs: [], current: null }, 20_000);

    const legs = splitLegs(points);
    const summaries = legs.map((l, i) => summarizeLeg(l, { isCurrent: i === legs.length - 1, now, callsign, destination }));
    if (source === 'adsb.lol') archiveLegs(key, summaries);   // historique long (SQLite)
    for (const s of summaries) if (s.events?.length) recordEvents(key, s.callsign, s.events);
    const result = {
      hex: key,
      source,
      legs: summaries,
      current: summaries[summaries.length - 1] || null,
      fetchedAt: new Date(now).toISOString(),
    };
    return trailCache.set(key, result, source === 'adsb.lol' ? 45_000 : 15_000);
  });
}

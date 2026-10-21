/**
 * Archive des vols : adsb.lol ne garde que ~24 h de trace. On stocke ce
 * qu'on a vu (SQLite) pour pouvoir montrer « cet avion cette semaine » et
 * rejouer un vol.
 *
 * Quels avions ? Uniquement ceux que quelqu'un a regardés (clic) : archiver
 * tout le trafic mondial serait irrespectueux envers adsb.lol (bénévoles,
 * ~1 req/s) et inutile. Un job rafraîchit ces avions « d'intérêt » toutes
 * les 20 min pendant 24 h après le dernier clic, 60 avions max par passage.
 */
import * as store from './store.js';

const INTEREST_TTL = 24 * 3600_000;
const REFRESH_EVERY = 20 * 60_000;
const MAX_PER_RUN = 60;
const POINTS_KEEP = 400;   // points par vol archivé : suffisant pour dessiner / rejouer

/** hex → { t: dernier clic, callsign } */
const interest = new Map();

export function markInterest(hex, callsign = null) {
  const key = String(hex).toLowerCase();
  const prev = interest.get(key);
  interest.set(key, { t: Date.now(), callsign: callsign || prev?.callsign || null });
}

/** Enregistre les vols d'une trace (appelé par lib/trail.js à chaque calcul). */
export function archiveLegs(hex, legs) {
  for (const leg of legs) {
    // un vol de 2 min sans altitude, c'est un test moteur ou du roulage
    if (leg.durationMin < 3 || leg.maxAlt < 1000) continue;
    const slim = { ...leg, points: downsample(leg.points, POINTS_KEEP) };
    try { store.legUpsert(hex, slim); } catch (err) { console.warn(`[archive] ${hex}: ${err.message}`); }
  }
}

function downsample(points, max) {
  if (!points || points.length <= max) return points || [];
  const step = (points.length - 1) / (max - 1);
  const out = [];
  for (let i = 0; i < max; i++) out.push(points[Math.round(i * step)]);
  return out;
}

/** Vols archivés d'un avion sur N jours (le plus récent en dernier). */
export function getHistory(hex, days = 7) {
  const since = Date.now() - Math.min(30, Math.max(1, days)) * 24 * 3600_000;
  return store.legList(String(hex).toLowerCase(), since);
}

/** Lance le job de rafraîchissement. `getTrail` est injecté pour éviter un import circulaire. */
export function startArchiveJob(getTrail) {
  const run = async () => {
    const now = Date.now();
    for (const [hex, v] of interest) if (now - v.t > INTEREST_TTL) interest.delete(hex);
    // les plus anciennement rafraîchis d'abord
    const hexes = [...interest.entries()].slice(0, MAX_PER_RUN);
    let ok = 0;
    for (const [hex, v] of hexes) {
      try { await getTrail(hex, { force: true, callsign: v.callsign }); ok++; } catch { /* déjà loggé */ }
    }
    if (hexes.length) console.log(`[archive] ${ok}/${hexes.length} avions rafraîchis`);
  };
  setInterval(run, REFRESH_EVERY).unref();
}

export function archiveStatus() {
  return { watching: interest.size, ...store.status() };
}

/**
 * Mouvements d'aéroport : décollages et atterrissages **observés** par ce
 * serveur, avec la piste utilisée. Zéro API : tout vient des positions déjà
 * reçues (zones regardées par les visiteurs + aéroports surveillés).
 *
 * Détection :
 *   décollage      un avion passe du sol (ou réapparaît après ≥ 10 min) à « en l'air, bas »
 *                  à moins de 12 km d'un aéroport
 *   atterrissage   un avion bas et en descente passe au sol (≤ 8 km), ou disparaît en
 *                  finale (≤ 10 km, < 2 500 ft, en descente, plus de signal depuis 4 min)
 *   piste          le cap au moment de la transition, rapproché des seuils de piste (≤ 25°)
 *
 * Statistiques (7 jours par défaut) : totaux, par jour, par heure, usage des pistes,
 * routes les plus fréquentes, aéroports et pays desservis, types d'appareils.
 */
import * as store from './store.js';
import * as ref from './refdata.js';
import { countryName } from './geo.js';

const angleDiff = (a, b) => Math.abs((((a - b) % 360) + 540) % 360 - 180);

/** Seuil de piste dont l'orientation colle au cap (≤ 25°). */
export function runwayFor(icao, track) {
  if (track == null || !icao) return null;
  let best = null;
  for (const rw of ref.getRunways(icao)) {
    for (const e of rw.ends) {
      if (e.heading == null) continue;
      const d = angleDiff(e.heading, track);
      if (d <= 25 && (!best || d < best.d)) best = { d, ident: e.ident };
    }
  }
  return best?.ident || null;
}

function record(kind, a, airport, track) {
  const icao = airport.icao || airport.iata;
  const now = Date.now();
  // pas deux fois le même mouvement pour le même avion en 20 min
  const last = store.movementLast(a.hex, kind, icao);
  if (last && now - last < 20 * 60_000) return null;
  const id = store.movementAdd({
    t: now, hex: a.hex, callsign: a.callsign || null, kind, airport: icao,
    runway: runwayFor(airport.icao, track), track, type: a.type || null,
  });
  return id;
}

/**
 * Appelé pour chaque position reçue. `prev` = état précédent (ou null), `prevT` = date de l'état précédent.
 */
export function observe(prev, cur, prevT, now = Date.now()) {
  try {
    const alt = cur.alt ?? null;
    // ── décollage
    if (!cur.onGround && alt != null && alt < 4000) {
      // vu au sol juste avant : sûr. Première apparition / réapparition : seulement s'il MONTE
      // (un avion vu pour la première fois en finale descend, ce n'est pas un décollage)
      const fromGround = Boolean(prev?.onGround) && (cur.vertRate == null || cur.vertRate > -200);
      const fresh = (!prev || (prevT && now - prevT > 10 * 60_000)) && (cur.vertRate ?? 0) > 300;
      if (fromGround || fresh) {
        const ap = ref.nearestAirport(cur.lat, cur.lon, 12);
        if (ap) record('takeoff', cur, ap, cur.track);
      }
    }
    // ── atterrissage (transition air → sol)
    if (cur.onGround && prev && !prev.onGround && (prev.alt ?? 99999) < 4000) {
      const ap = ref.nearestAirport(cur.lat, cur.lon, 8);
      if (ap) record('landing', cur, ap, prev.track ?? cur.track);
    }
  } catch { /* jamais bloquer la réception des positions */ }
}

/** Avion disparu en finale : appelé par le balayage périodique de lib/providers.js. */
export function observeVanished(last, lastT, now = Date.now()) {
  try {
    if (!last || last.onGround) return;
    const age = now - lastT;
    if (age < 4 * 60_000 || age > 15 * 60_000) return;
    if ((last.alt ?? 99999) > 2500 || (last.vertRate ?? 0) > -100) return;
    const ap = ref.nearestAirport(last.lat, last.lon, 10);
    if (!ap) return;
    const icao = ap.icao || ap.iata;
    const prevLanding = store.movementLast(last.hex, 'landing', icao);
    if (prevLanding && now - prevLanding < 20 * 60_000) return;
    store.movementAdd({ t: lastT, hex: last.hex, callsign: last.callsign || null, kind: 'landing', airport: icao, runway: runwayFor(ap.icao, last.track), track: last.track ?? null, type: last.type || null });
  } catch { /* ignore */ }
}

// ── Statistiques ────────────────────────────────────────────────────────────
export function airportStats(icao, days = 7, tz = 'UTC') {
  const since = Date.now() - days * 24 * 3600_000;
  const list = store.movementsForAirport(icao, since);
  const takeoffs = list.filter((m) => m.kind === 'takeoff'), landings = list.filter((m) => m.kind === 'landing');

  const dayKey = (t) => { try { return new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(t)); } catch { return new Date(t).toISOString().slice(0, 10); } };
  const hourKey = (t) => { try { return Number(new Intl.DateTimeFormat('en-US', { timeZone: tz, hour: '2-digit', hourCycle: 'h23' }).format(new Date(t))); } catch { return new Date(t).getUTCHours(); } };

  const perDay = new Map();
  for (let i = days - 1; i >= 0; i--) perDay.set(dayKey(Date.now() - i * 24 * 3600_000), { takeoffs: 0, landings: 0 });
  const perHour = Array.from({ length: 24 }, () => ({ takeoffs: 0, landings: 0 }));
  const runways = new Map();
  const others = new Map();
  const types = new Map();
  for (const m of list) {
    const d = perDay.get(dayKey(m.t)); if (d) d[m.kind === 'takeoff' ? 'takeoffs' : 'landings']++;
    perHour[hourKey(m.t)][m.kind === 'takeoff' ? 'takeoffs' : 'landings']++;
    if (m.runway) { const r = runways.get(m.runway) || { runway: m.runway, takeoffs: 0, landings: 0 }; r[m.kind === 'takeoff' ? 'takeoffs' : 'landings']++; runways.set(m.runway, r); }
    if (m.other && m.other !== '-') others.set(m.other, (others.get(m.other) || 0) + 1);   // « - » = trajet inconnu
    if (m.type) types.set(m.type, (types.get(m.type) || 0) + 1);
  }
  const routes = [...others.entries()].sort((a, b) => b[1] - a[1]).slice(0, 10).map(([code, count]) => {
    const ap = ref.findAirport(code);
    return { code, count, name: ap?.name || null, city: ap?.city || null, country: ap?.country || null };
  });
  const countries = new Set([...others.keys()].map((c) => ref.findAirport(c)?.country).filter(Boolean));

  return {
    days, since: new Date(since).toISOString(),
    total: list.length, takeoffs: takeoffs.length, landings: landings.length,
    perDay: [...perDay.entries()].map(([day, v]) => ({ day, ...v })),
    perHour,
    runways: [...runways.values()].sort((a, b) => (b.takeoffs + b.landings) - (a.takeoffs + a.landings)),
    routes,
    airportsServed: others.size,
    countriesServed: [...countries].map((c) => ({ code: c, name: countryName(c) })),
    types: [...types.entries()].sort((a, b) => b[1] - a[1]).slice(0, 8).map(([code, count]) => ({ code, count })),
    withRoute: list.filter((m) => m.other && m.other !== '-').length,
    latest: list.slice(0, 15).map((m) => ({ t: new Date(m.t).toISOString(), hex: m.hex, callsign: m.callsign, kind: m.kind, runway: m.runway, other: m.other === '-' ? null : m.other, type: m.type })),
  };
}

/** Mouvements sans « autre aéroport » connu (à compléter par lot via adsb.lol routeset). */
export function movementsNeedingRoute(icao, days = 7, limit = 40) {
  const since = Date.now() - days * 24 * 3600_000;
  return store.movementsForAirport(icao, since)
    .filter((m) => !m.other && /^[A-Z]{3}\d{1,4}[A-Z]{0,2}$/.test(m.callsign || ''))
    .slice(0, limit);
}

export function setMovementOther(id, other) {
  store.movementSetOther(id, other);
}

// ── Surveillance automatique des aéroports consultés ────────────────────────
// Tant qu'un aéroport a été consulté dans les 24 h, le serveur regarde autour
// de lui toutes les 90 s (≤ 12 aéroports, tournants) : les mouvements sont
// enregistrés même quand personne ne regarde la carte à cet endroit.
const watched = new Map();   // icao → { t, lat, lon }
const WATCH_TTL = 24 * 3600_000;
const WATCH_EVERY = 90_000;
const WATCH_MAX = 12;
let cursor = 0;

export function watchAirport(ap) {
  if (!ap?.icao || ap.lat == null) return;
  watched.set(ap.icao, { t: Date.now(), lat: ap.lat, lon: ap.lon });
}

export function startAirportWatch(getLiveAircraft) {
  setInterval(async () => {
    const now = Date.now();
    for (const [k, v] of watched) if (now - v.t > WATCH_TTL) watched.delete(k);
    const list = [...watched.values()];
    if (!list.length) return;
    const batch = [];
    for (let i = 0; i < Math.min(WATCH_MAX, list.length); i++) batch.push(list[(cursor + i) % list.length]);
    cursor = (cursor + batch.length) % list.length;
    for (const ap of batch) {
      try { await getLiveAircraft(ap.lat, ap.lon, 40); } catch { /* source en pause */ }
    }
  }, WATCH_EVERY).unref();
}

export function watchStatus() {
  return { watchedAirports: watched.size, movements: store.movementsCount() };
}

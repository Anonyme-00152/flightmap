/**
 * Tableau d'un aéroport, déduit de ce qui vole (aucune API à clé) :
 *   - départs : avions en montée qui s'éloignent, < 60 km
 *   - arrivées : avions en descente qui se dirigent vers l'aéroport, < 150 km, avec ETA
 *   - au sol : transpondeurs actifs sur la plateforme
 *   - trajets par lot (adsb.lol routeset, 1 requête) pour afficher l'autre extrémité
 *   - METAR + pistes (OurAirports) → piste en service probable (vent) et observée (trajectoires)
 */
import { getLiveAircraft, getRoutesBatch, getMetar, getSighting } from './providers.js';
import { TTLCache, createDeduper } from './cache.js';
import * as ref from './refdata.js';
import * as geo from './geo.js';
import * as movements from './movements.js';
import { wikiSummary, wikiGallery } from './wiki.js';
import { recentEvents } from './events.js';

export const boardCache = new TTLCache({ ttl: 60_000, max: 300, name: 'airports' });
const dedupe = createDeduper();

const toRad = (d) => (d * Math.PI) / 180;
function distKm(lat1, lon1, lat2, lon2) {
  const dLat = toRad(lat2 - lat1), dLon = toRad(lon2 - lon1);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return 2 * 6371 * Math.asin(Math.sqrt(h));
}
function bearing(lat1, lon1, lat2, lon2) {
  const y = Math.sin(toRad(lon2 - lon1)) * Math.cos(toRad(lat2));
  const x = Math.cos(toRad(lat1)) * Math.sin(toRad(lat2)) - Math.sin(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.cos(toRad(lon2 - lon1));
  return (Math.atan2(y, x) * 180 / Math.PI + 360) % 360;
}
const angleDiff = (a, b) => Math.abs((((a - b) % 360) + 540) % 360 - 180);

const sameAirport = (a, b) => Boolean(a && b && ((a.icao && a.icao === b.icao) || (a.iata && a.iata === b.iata)));

export function findAirportAny(code) {
  const c = String(code || '').toUpperCase().trim();
  return ref.findAirport(c) || null;
}

/** Piste la plus favorable au vent : pour chaque piste, le seuil avec le meilleur vent de face. */
export function runwaysByWind(runways, windDir, windSpeed) {
  if (windDir == null || !runways.length) return [];
  return runways.map((rw) => {
    const scored = rw.ends.map((e) => ({ ...e, headwind: Math.round((windSpeed || 0) * Math.cos(toRad(windDir - e.heading))) }));
    scored.sort((a, b) => b.headwind - a.headwind);
    return { runway: rw.name, end: scored[0].ident, headwind: scored[0].headwind, crosswind: Math.round(Math.abs((windSpeed || 0) * Math.sin(toRad(windDir - scored[0].heading)))) };
  }).sort((a, b) => b.headwind - a.headwind);
}

/** Seuil de piste dont l'orientation colle au cap d'un avion (≤ 20°) et proche de lui (≤ 12 km). */
function matchRunwayEnd(runways, p) {
  let best = null;
  for (const rw of runways) {
    for (const e of rw.ends) {
      if (e.heading == null || p.track == null) continue;
      const diff = angleDiff(e.heading, p.track);
      const d = distKm(p.lat, p.lon, e.lat, e.lon);
      if (diff <= 20 && d <= 12 && (!best || diff < best.diff)) best = { ident: e.ident, runway: rw.name, diff };
    }
  }
  return best;
}

export async function airportBoard(code) {
  const ap = findAirportAny(code);
  if (!ap || ap.lat == null) return null;
  const key = ap.icao || ap.iata;
  const cached = boardCache.get(key);
  if (cached) return cached;

  return dedupe(`board:${key}`, async () => {
    movements.watchAirport(ap);   // surveillé 24 h : les mouvements seront comptés même sans visiteur
    const runways = ap.icao ? ref.getRunways(ap.icao) : [];
    const [live, metar, wiki, gallery] = await Promise.all([
      getLiveAircraft(ap.lat, ap.lon, 100).catch(() => ({ aircraft: [], source: null })),
      ap.icao ? getMetar(ap.icao).catch(() => null) : Promise.resolve(null),
      ap.wiki ? wikiSummary(ap.wiki).catch(() => null) : Promise.resolve(null),
      ap.wiki ? wikiGallery(ap.wiki).catch(() => []) : Promise.resolve([]),
    ]);

    const ground = [], departures = [], arrivals = [];
    for (const a of live.aircraft) {
      const d = distKm(ap.lat, ap.lon, a.lat, a.lon);
      const brgToAp = bearing(a.lat, a.lon, ap.lat, ap.lon);
      const toward = a.track != null ? angleDiff(a.track, brgToAp) : null;
      const entry = { ...a, distanceKm: Math.round(d * 10) / 10 };
      if (a.onGround) { if (d < 6) ground.push(entry); continue; }
      const alt = a.alt ?? 0, vr = a.vertRate ?? 0, gs = a.speed ?? 0;
      if (d < 60 && alt < 12000 && vr > 150 && (toward == null || toward > 110)) {
        const sighting = getSighting(a.hex);
        entry.takeoffAt = sighting?.takeoffAt || null;
        entry.minutesAgo = gs > 60 ? Math.round((d / (gs * 1.852)) * 60) : null;
        departures.push(entry);
      } else if (d < 150 && (vr < -100 || alt < 10000) && toward != null && toward < 35 && gs > 60) {
        entry.etaMin = Math.round((d / (gs * 1.852)) * 60 + 4);
        entry.etaAt = new Date(Date.now() + entry.etaMin * 60_000).toISOString();
        arrivals.push(entry);
      }
    }

    // trajets par lot : une seule requête pour tout le tableau
    const candidates = [...departures, ...arrivals, ...ground].filter((a) => /^[A-Z]{3}\d{1,4}[A-Z]{0,2}$/.test(a.callsign || ''));
    const routes = await getRoutesBatch(candidates.map((a) => ({ callsign: a.callsign, lat: a.lat, lon: a.lon })));
    const attach = (list, side) => list.filter((a) => {
      const rt = a.callsign ? routes.get(a.callsign) : null;
      a.route = rt ? { origin: rt.origin, destination: rt.destination, airline: rt.airline?.name || null, flightNumber: rt.flightNumber } : null;
      if (!rt) return true;
      // le trajet est connu et ne concerne pas cet aéroport → simple survol, on retire
      const other = side === 'dep' ? rt.origin : side === 'arr' ? rt.destination : null;
      return !other || sameAirport(other, ap) || (rt.stops || []).some((s) => sameAirport(s, ap));
    });
    const deps = attach(departures, 'dep').sort((a, b) => (a.minutesAgo ?? 99) - (b.minutesAgo ?? 99));
    const arrs = attach(arrivals, 'arr').sort((a, b) => a.etaMin - b.etaMin);
    const grd = attach(ground, null);

    // piste en service : observée (avions bas alignés) puis probable (vent)
    const observed = { departures: null, arrivals: null };
    for (const a of deps) { if ((a.alt ?? 0) < 3500) { const m = matchRunwayEnd(runways, a); if (m) { observed.departures = m.ident; break; } } }
    for (const a of arrs) { if ((a.alt ?? 0) < 3500 && a.distanceKm < 15) { const m = matchRunwayEnd(runways, a); if (m) { observed.arrivals = m.ident; break; } } }
    const byWind = runwaysByWind(runways, metar?.windDir, metar?.wind);

    const strip = ({ hex, callsign, reg, type, desc, alt, speed, track, vertRate, onGround, lat, lon, distanceKm, minutesAgo, takeoffAt, etaMin, etaAt, route, military, notable }) =>
      ({ hex, callsign, reg, type, desc, alt, speed, track, vertRate, onGround, lat, lon, distanceKm, minutesAgo, takeoffAt, etaMin, etaAt, route, military, notable });

    // ── fiche : fuseau, heure locale, soleil, pays, liens
    const tz = geo.airportTimezone(ap);
    const tzi = geo.tzInfo(tz);
    const sun = geo.sunTimes(ap.lat, ap.lon);
    const icaoKey = ap.icao || ap.iata;

    // ── statistiques 7 jours (mouvements observés) + complément des routes par lot
    await enrichMovementRoutes(icaoKey, ap);
    const stats7 = movements.airportStats(icaoKey, 7, tz);

    // ── derniers événements autour de l'aéroport (remises de gaz, attentes, urgences…)
    const nearEvents = recentEvents(200).filter((e) => e.lat != null && distKm(ap.lat, ap.lon, e.lat, e.lon) < 40).slice(0, 10);

    const board = {
      airport: {
        icao: ap.icao, iata: ap.iata, name: ap.name, city: ap.city, country: ap.country, countryName: geo.countryName(ap.country),
        region: ap.region || null, lat: ap.lat, lon: ap.lon, size: ref.airportSize(ap), elevFt: ap.elev ?? null, scheduledService: ap.sched ?? null,
        links: { wikipedia: wiki?.urlFr || wiki?.url || ap.wiki || null, home: ap.home || null },
      },
      facts: {
        timezone: tzi.tz, utcOffset: tzi.offset, timezoneName: tzi.name,
        localTime: new Date().toLocaleTimeString('fr-FR', { timeZone: tz, hour: '2-digit', minute: '2-digit' }),
        localDate: new Date().toLocaleDateString('fr-FR', { timeZone: tz, weekday: 'long', day: 'numeric', month: 'long' }),
        sunrise: sun.sunrise, sunset: sun.sunset, polar: sun.polar,
        sunriseLocal: sun.sunrise ? new Date(sun.sunrise).toLocaleTimeString('fr-FR', { timeZone: tz, hour: '2-digit', minute: '2-digit' }) : null,
        sunsetLocal: sun.sunset ? new Date(sun.sunset).toLocaleTimeString('fr-FR', { timeZone: tz, hour: '2-digit', minute: '2-digit' }) : null,
        elevM: ap.elev != null ? Math.round(ap.elev * 0.3048) : null,
      },
      wiki: wiki ? (() => {
        const thumb = wiki.thumb && !/\.svg/i.test(wiki.thumb) ? wiki.thumb.replace(/\?utm_.*$/, '') : null;
        return { extract: wiki.extract, thumb, photo: thumb ? thumb.replace(/\/\d+px-/, '/960px-') : null, image: wiki.image, credit: wiki.credit, url: wiki.urlFr || wiki.url };
      })() : null,
      // galerie : la photo principale (article) d'abord, puis les autres (Wikimedia Commons)
      gallery: (() => {
        // l'image « principale » de l'article est parfois le logo (SVG) : dans ce cas on ne la met pas en tête
        const main = wiki?.thumb && !/\.svg/i.test(wiki.thumb) ? wiki.thumb.replace(/\?utm_.*$/, '').replace(/\/\d+px-/, '/960px-') : null;
        const rest = (gallery || []).filter((p) => !main || !p.src.includes(main.split('/').pop().replace(/^960px-/, '')));
        return [...(main ? [{ src: main, full: wiki.image, author: null, license: null, page: wiki.urlFr || wiki.url, title: wiki.title }] : []), ...rest].slice(0, 24);
      })(),
      runways,
      metar,
      runwayInUse: { observed, byWind: byWind.slice(0, 3), note: observed.departures || observed.arrivals ? 'Observé sur les trajectoires' : byWind.length ? 'Déduit du vent (METAR)' : null },
      stats7,
      events: nearEvents,
      departures: deps.slice(0, 30).map(strip),
      arrivals: arrs.slice(0, 30).map(strip),
      ground: grd.slice(0, 40).map(strip),
      source: live.source,
      fetchedAt: new Date().toISOString(),
    };
    return boardCache.set(key, board);
  });
}

/** Complète « l'autre aéroport » des mouvements récents (une requête routeset pour ≤ 40 vols). */
async function enrichMovementRoutes(icaoKey, ap) {
  const pending = movements.movementsNeedingRoute(icaoKey, 7, 40);
  if (!pending.length) return;
  try {
    const routes = await getRoutesBatch(pending.map((m) => ({ callsign: m.callsign, lat: ap.lat, lon: ap.lon })));
    for (const m of pending) {
      const rt = routes.get(m.callsign);
      if (rt === undefined) continue;
      if (!rt) { movements.setMovementOther(m.id, '-'); continue; }   // « - » = trajet inconnu, ne pas redemander
      const other = m.kind === 'takeoff' ? rt.destination : rt.origin;
      const code = other?.iata || other?.icao || null;
      // si l'autre bout est cet aéroport même (trajet retour cache), on prend l'autre extrémité
      const alt = m.kind === 'takeoff' ? rt.origin : rt.destination;
      const chosen = code && !sameAirport(other, ap) ? code : (alt?.iata || alt?.icao || null);
      movements.setMovementOther(m.id, chosen && !sameAirport(chosen === code ? other : alt, ap) ? chosen : '-');
    }
  } catch { /* prochaine ouverture */ }
}

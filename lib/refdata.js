/**
 * Référentiel local : les données qui ne bougent presque jamais et qu'on
 * charge une fois au démarrage. Chaque réponse trouvée ici est une requête
 * réseau que tu n'envoies pas.
 *
 * Fichiers produits par : npm run setup-data
 *   data/airports.json     OurAirports      (domaine public)
 *   data/notable.json      plane-alert-db   (appareils remarquables)
 *   data/aircraft-db.json  OpenSky          (immatriculations, optionnel)
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const DATA_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'data');

function load(name) {
  const file = path.join(DATA_DIR, name);
  try {
    if (!fs.existsSync(file)) return null;
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (err) {
    console.warn(`[refdata] ${name} illisible : ${err.message}`);
    return null;
  }
}

const airports = load('airports.json');
const runways = load('runways.json');
const notable = load('notable.json');
const aircraftDb = load('aircraft-db.json');

export const status = {
  airports: airports ? Object.keys(airports.byIcao || {}).length : 0,
  runways: runways ? Object.keys(runways).length : 0,
  notable: notable ? Object.keys(notable).length : 0,
  aircraftDb: aircraftDb ? Object.keys(aircraftDb).length : 0,
};

export function report() {
  if (!airports && !notable && !aircraftDb) {
    console.log('  ℹ  Référentiel local absent — lance `npm run setup-data`');
    console.log('     (noms d\'aéroports complets, badges d\'appareils remarquables, mode hors ligne)\n');
    return;
  }
  const bits = [];
  if (status.airports) bits.push(`${status.airports.toLocaleString('fr-FR')} aéroports`);
  if (status.runways) bits.push(`pistes de ${status.runways.toLocaleString('fr-FR')} aéroports`);
  if (status.notable) bits.push(`${status.notable.toLocaleString('fr-FR')} appareils remarquables`);
  if (status.aircraftDb) bits.push(`${status.aircraftDb.toLocaleString('fr-FR')} immatriculations`);
  console.log(`  📚 Référentiel local : ${bits.join(' · ')}\n`);
}

/** Aéroport par code ICAO (4 lettres) ou IATA (3 lettres). */
export function findAirport(code) {
  if (!airports || !code) return null;
  const c = String(code).toUpperCase().trim();
  if (c.length === 4) return airports.byIcao?.[c] || null;
  if (c.length === 3) return airports.byIata?.[c] || null;
  return airports.byIcao?.[c] || airports.byIata?.[c] || null;
}

/**
 * Complète une fiche aéroport partielle (souvent on n'a que le code)
 * avec le nom, la ville et les coordonnées issus d'OurAirports.
 */
export function enrichAirport(ap) {
  if (!ap) return ap;
  const local = findAirport(ap.icao) || findAirport(ap.iata);
  if (!local) return ap;
  return {
    iata: ap.iata || local.iata,
    icao: ap.icao || local.icao,
    name: ap.name || local.name,
    city: ap.city || local.city,
    country: ap.country || local.country,
    lat: ap.lat ?? local.lat,
    lon: ap.lon ?? local.lon,
  };
}

/** Construit une fiche aéroport à partir d'un simple code (ex. "EGLL"). */
export function airportFromCode(code) {
  const local = findAirport(code);
  if (local) return { ...local };
  const c = String(code || '').toUpperCase().trim();
  if (!c) return null;
  return { icao: c.length === 4 ? c : null, iata: c.length === 3 ? c : null, name: null, city: null, country: null, lat: null, lon: null };
}

/**
 * Aéroport le plus proche d'un point (pour deviner d'où un avion a décollé
 * à partir de sa trace). On ne regarde que les aéroports avec code IATA
 * (~9 000, ceux qui ont du trafic commercial) : balayage linéaire instantané.
 */
const iataAirports = airports
  ? Object.values(airports.byIcao).filter((a) => a.iata && a.lat != null && a.lon != null)
  : [];

export function nearestAirport(lat, lon, maxKm = 15) {
  if (lat == null || lon == null || !iataAirports.length) return null;
  const cosLat = Math.cos((lat * Math.PI) / 180);
  let best = null, bestD = maxKm;
  for (const a of iataAirports) {
    // distance plane approchée (suffisant à 15 km), évite 9 000 haversines
    const dLat = (a.lat - lat) * 111.2;
    const dLon = (a.lon - lon) * 111.2 * cosLat;
    const d = Math.sqrt(dLat * dLat + dLon * dLon);
    if (d < bestD) { bestD = d; best = a; }
  }
  return best ? { ...best, distanceKm: Math.round(bestD * 10) / 10 } : null;
}

/**
 * Pistes d'un aéroport (code ICAO) : [{ ident, heading, lat, lon }, …] par seuil,
 * groupées par piste physique. Vide si le référentiel des pistes n'est pas installé.
 */
export function getRunways(icao) {
  const rows = runways?.[String(icao || '').toUpperCase()];
  if (!rows) return [];
  return rows.map(([leId, heId, leHdg, heHdg, leLat, leLon, heLat, heLon, lengthFt, widthFt, surface]) => ({
    name: `${leId}/${heId}`,
    lengthM: lengthFt != null ? Math.round(lengthFt * 0.3048) : null,
    widthM: widthFt != null ? Math.round(widthFt * 0.3048) : null,
    surface,
    ends: [
      { ident: leId, heading: leHdg ?? bearing(leLat, leLon, heLat, heLon), lat: leLat, lon: leLon },
      { ident: heId, heading: heHdg ?? bearing(heLat, heLon, leLat, leLon), lat: heLat, lon: heLon },
    ],
  }));
}

function bearing(lat1, lon1, lat2, lon2) {
  const toRad = (d) => (d * Math.PI) / 180;
  const y = Math.sin(toRad(lon2 - lon1)) * Math.cos(toRad(lat2));
  const x = Math.cos(toRad(lat1)) * Math.sin(toRad(lat2)) - Math.sin(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.cos(toRad(lon2 - lon1));
  return (Math.atan2(y, x) * 180 / Math.PI + 360) % 360;
}

/** Taille d'un aéroport : 'large' | 'medium' | 'small' (déduite de l'IATA si le référentiel est ancien). */
export function airportSize(ap) {
  if (ap?.type === 'large' || ap?.type === 'medium' || ap?.type === 'small') return ap.type;
  return ap?.iata ? 'medium' : 'small';
}

/**
 * Aéroports dans un rectangle, les plus importants d'abord (pour les dessiner
 * sur la carte). Seuls les aéroports avec code IATA sont candidats.
 */
export function airportsInBounds({ south, west, north, east }, { limit = 150, minSize = 'medium' } = {}) {
  const rank = { large: 3, medium: 2, small: 1 };
  const min = rank[minSize] || 2;
  const out = [];
  for (const a of iataAirports) {
    if (a.lat < south || a.lat > north || a.lon < west || a.lon > east) continue;
    const r = rank[airportSize(a)] || 1;
    if (r < min) continue;
    out.push({ icao: a.icao, iata: a.iata, name: a.name, city: a.city, lat: a.lat, lon: a.lon, size: airportSize(a), hasRunways: Boolean(runways?.[a.icao]) });
  }
  out.sort((x, y) => (rank[y.size] - rank[x.size]) || x.name.localeCompare(y.name));
  return out.slice(0, limit);
}

/** Appareil remarquable (gouvernemental, militaire, historique, célébrité…). */
export function findNotable(hex) {
  if (!notable || !hex) return null;
  const n = notable[String(hex).toLowerCase()];
  if (!n) return null;
  const label = n.tags?.[0] || n.category || 'Appareil suivi';
  return { ...n, label };
}

/** Fiche appareil depuis la base OpenSky locale (si elle a été installée). */
export function findAircraftLocal(hex) {
  if (!aircraftDb || !hex) return null;
  const row = aircraftDb[String(hex).toLowerCase()];
  if (!row) return null;
  const [registration, icaoType, model, manufacturer, owner] = row;
  return {
    type: model || icaoType || null,
    icaoType: icaoType || null,
    manufacturer: manufacturer || null,
    registration: registration || null,
    owner: owner || null,
    ownerCountry: null,
    photo: null,
    photoThumb: null,
    source: 'base locale',
  };
}

export const hasAircraftDb = Boolean(aircraftDb);

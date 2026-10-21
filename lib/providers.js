/**
 * Toutes les APIs externes sont ici, et NULLE PART AILLEURS.
 * Le front ne parle jamais directement à ces services : il passe par notre
 * backend, qui met en cache et lisse le débit.
 *
 * ┌─ 01 POSITIONS ──── adsb.lol → adsb.fi → airplanes.live      gratuit, sans clé
 * ├─ 02 APPAREIL ───── adsbdb → hexdb.io → base locale OpenSky  gratuit, sans clé
 * ├─ 03 TRAJET ─────── adsb.lol routeset → adsbdb → hexdb.io    gratuit, sans clé
 * ├─ 04 RÉFÉRENTIEL ── OurAirports + plane-alert-db (local)     0 appel réseau
 * └─ 05 MÉTÉO ──────── aviationweather.gov (NOAA)               gratuit, sans clé
 */
import { createLimiter, fetchJson } from './limiter.js';
import { TTLCache, createDeduper } from './cache.js';
import * as ref from './refdata.js';
import * as stats from './stats.js';
import * as movements from './movements.js';

const UA = process.env.USER_AGENT || 'flightmap/2.0 (projet perso de suivi de vols)';

/**
 * Planespotters exige un contact dans le User-Agent (URL ou e-mail), sinon 403.
 * CONTACT=mailto:toi@exemple.fr ou CONTACT=https://ton-site/contact dans .env.
 * Sans contact, la source photo Planespotters est désactivée (et on le dit au démarrage).
 */
const CONTACT = (process.env.CONTACT || '').trim();
export const PLANESPOTTERS_UA = CONTACT ? `flightmap/4.0 (+${CONTACT})` : null;

/**
 * MODE COMMERCIAL — le piège à retardement.
 * adsb.fi, airplanes.live et OpenSky interdisent l'usage commercial.
 * Mets COMMERCIAL=1 le jour où ton site rapporte de l'argent (pub, abonnement) :
 * seules les sources compatibles restent actives, adsb.lol en tête (licence ODbL,
 * attribution obligatoire — garde le lien en bas de page).
 */
export const COMMERCIAL = process.env.COMMERCIAL === '1';

/** LOCAL_FIRST=1 : la base locale répond avant les APIs (0 appel, mais pas de photo). */
const LOCAL_FIRST = process.env.LOCAL_FIRST === '1';

// ── Limiteurs : un par domaine, ~1 req/s (règle communautaire) ───────────────
export const limitLol = createLimiter(1000);   // partagé avec lib/trail.js (même hôte)
const limitFi = createLimiter(1000);
const limitLive = createLimiter(1000);
const limitDb = createLimiter(250);   // adsbdb
const limitHex = createLimiter(250);  // hexdb.io
const limitWx = createLimiter(700);   // NOAA : 100 req/min maximum
const limitPs = createLimiter(600);   // planespotters.net (photos de secours)

// ── Caches (les longs sont persistés dans SQLite : survivent aux redémarrages)
export const positionCache = new TTLCache({ ttl: 4_000, max: 500, name: 'positions' });
export const aircraftCache = new TTLCache({ ttl: 30 * 24 * 3600_000, max: 50_000, name: 'aircraft', persist: 'aircraft' });
export const routeCache = new TTLCache({ ttl: 12 * 3600_000, max: 50_000, name: 'routes', persist: 'routes' });
export const metarCache = new TTLCache({ ttl: 10 * 60_000, max: 5_000, name: 'metar' });
export const searchCache = new TTLCache({ ttl: 10_000, max: 500, name: 'search' });

const dedupe = createDeduper();

// ════════════════════════════════════════════════════════════════════════════
// 01 · POSITIONS EN DIRECT
// ════════════════════════════════════════════════════════════════════════════
const ALL_LIVE_PROVIDERS = [
  {
    name: 'adsb.lol',
    limiter: limitLol,
    commercialOk: true, // licence ODbL : autorisé avec attribution visible
    url: (lat, lon, d) => `https://api.adsb.lol/v2/lat/${lat}/lon/${lon}/dist/${d}`,
    hex: (h) => `https://api.adsb.lol/v2/hex/${h}`,
    callsign: (c) => `https://api.adsb.lol/v2/callsign/${c}`,
    reg: (r) => `https://api.adsb.lol/v2/reg/${r}`,
  },
  {
    name: 'adsb.fi',
    limiter: limitFi,
    commercialOk: false,
    url: (lat, lon, d) => `https://opendata.adsb.fi/api/v2/lat/${lat}/lon/${lon}/dist/${d}`,
    hex: (h) => `https://opendata.adsb.fi/api/v2/hex/${h}`,
    callsign: (c) => `https://opendata.adsb.fi/api/v2/callsign/${c}`,
    reg: (r) => `https://opendata.adsb.fi/api/v2/registration/${r}`,
  },
  {
    name: 'airplanes.live',
    limiter: limitLive,
    commercialOk: false,
    url: (lat, lon, d) => `https://api.airplanes.live/v2/point/${lat}/${lon}/${d}`,
    hex: (h) => `https://api.airplanes.live/v2/hex/${h}`,
    callsign: (c) => `https://api.airplanes.live/v2/callsign/${c}`,
    reg: (r) => `https://api.airplanes.live/v2/reg/${r}`,
  },
];

export const LIVE_PROVIDERS = COMMERCIAL
  ? ALL_LIVE_PROVIDERS.filter((p) => p.commercialOk)
  : ALL_LIVE_PROVIDERS;

const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);

/**
 * Backoff : un fournisseur qui répond 429 (ou 5xx) est laissé tranquille
 * 30 s. Le re-solliciter à chaque requête ne ferait qu'allonger la sanction.
 */
const cooldownUntil = new Map();
const COOLDOWN_MS = 30_000;
const isCooling = (p) => (cooldownUntil.get(p.name) || 0) > Date.now();
function noteFailure(p, err) {
  if (err.status === 429 || (err.status >= 500 && err.status < 600)) {
    cooldownUntil.set(p.name, Date.now() + COOLDOWN_MS);
    console.warn(`[live] ${p.name} en pause ${COOLDOWN_MS / 1000} s (HTTP ${err.status})`);
  }
}

/** Convertit le format brut readsb/ADSBexchange en objet propre pour le front. */
function normalizeAircraft(a) {
  if (typeof a?.lat !== 'number' || typeof a?.lon !== 'number') return null;
  const altRaw = a.alt_baro ?? a.alt_geom;
  const hex = String(a.hex || '').trim().toLowerCase();
  const notable = ref.findNotable(hex);
  return {
    hex,
    callsign: String(a.flight || '').trim() || null,
    lat: a.lat,
    lon: a.lon,
    alt: altRaw === 'ground' ? 0 : num(altRaw),
    onGround: altRaw === 'ground',
    speed: num(a.gs),
    track: num(a.track ?? a.true_heading ?? a.mag_heading),
    vertRate: num(a.baro_rate ?? a.geom_rate),
    squawk: a.squawk || null,
    reg: String(a.r || '').trim() || null,
    type: String(a.t || '').trim() || null,
    desc: a.desc || null,
    military: Boolean((a.dbFlags ?? 0) & 1),
    emergency: a.emergency && a.emergency !== 'none' ? a.emergency : null,
    notable: notable ? notable.label : null,   // badge « Gouvernemental », « Air Force One »…
    notableCat: notable ? notable.category || null : null,   // « USAF », « Governments »… (vue militaire / OSINT)
    notableTags: notable?.tags?.length ? notable.tags : null,
    seen: num(a.seen_pos),
    // ── Données ADS-B avancées (affichées dans le panneau, gratuites) ──
    ...compact({
      altGeom: num(a.alt_geom),                 // altitude GPS (vs barométrique)
      ias: num(a.ias),                          // vitesse indiquée
      tas: num(a.tas),                          // vitesse vraie
      mach: num(a.mach),
      magHeading: num(a.mag_heading),
      trueHeading: num(a.true_heading),
      roll: num(a.roll),                        // inclinaison (°), négatif = gauche
      windDir: num(a.wd),                       // vent en altitude, calculé par readsb
      windSpeed: num(a.ws),
      oat: num(a.oat),                          // température extérieure (°C)
      navAlt: num(a.nav_altitude_mcp ?? a.nav_altitude_fms),   // altitude sélectionnée (autopilote)
      navHeading: num(a.nav_heading),
      navQnh: num(a.nav_qnh),
      navModes: Array.isArray(a.nav_modes) && a.nav_modes.length ? a.nav_modes : null,
      category: a.category || null,             // A3 = gros porteur, A5 = très lourd…
      signal: a.type || null,                   // adsb_icao, mlat, tisb_*…
      rssi: num(a.rssi),
      messages: num(a.messages),
      seenAny: num(a.seen),
      nic: num(a.nic),                          // qualité de la position
    }),
  };
}

/** Retire les valeurs nulles pour ne pas alourdir la liste des avions. */
function compact(obj) {
  const out = {};
  for (const [k, v] of Object.entries(obj)) if (v != null) out[k] = v;
  return out;
}

// ── Observations : première fois qu'on a vu chaque avion (gratuit, local) ────
// Si la première observation est au sol ou très bas, on tient une heure de
// décollage réelle sans aucune API. Purgé au bout de 24 h.
const sightings = new Map();
const SIGHTING_TTL = 24 * 3600_000;

// Historique local des positions : trace de secours si adsb.lol ne fournit
// pas la sienne. Un point toutes les ≥ 20 s, 1 000 points max par avion.
const HISTORY_STEP = 20_000;
const HISTORY_MAX = 1000;

/** immatriculation → hex, alimenté par tout ce qu'on voit passer (fiches /aircraft/:reg). */
const regIndex = new Map();
export function hexForReg(reg) {
  return regIndex.get(String(reg || '').toUpperCase().replace(/[^A-Z0-9]/g, '')) || null;
}

/** Dernier état ADS-B connu d'un avion (immat, type…), même hors zone visible. */
export function lastSeenState(hex) {
  return sightings.get(String(hex).toLowerCase())?.lastState || null;
}

/** Avions vus récemment (≤ maxAgeMs) : sert aux règles d'alerte et à « ma zone ». */
export function recentAircraft(maxAgeMs = 120_000) {
  const now = Date.now();
  const out = [];
  for (const [hex, s] of sightings) if (now - s.last <= maxAgeMs && s.lastState) out.push(s.lastState);
  return out;
}

function recordSightings(list, now) {
  for (const a of list) {
    if (a.reg) regIndex.set(a.reg.toUpperCase().replace(/[^A-Z0-9]/g, ''), a.hex);
    let s = sightings.get(a.hex);
    if (!s) {
      s = {
        first: now, firstAlt: a.alt, firstOnGround: a.onGround,
        last: now, takeoff: null, lastOnGround: a.onGround, points: [],
      };
      sightings.set(a.hex, s);
    } else {
      // transition sol → air observée en direct : c'est LE décollage
      if (s.lastOnGround && !a.onGround && !s.takeoff) s.takeoff = now;
      s.lastOnGround = a.onGround;
    }
    // mouvements d'aéroport (décollage / atterrissage + piste) : comparaison avec l'état précédent
    movements.observe(s.lastState || null, a, s.lastState ? s.last : null, now);
    s.last = now;
    s.vanishChecked = false;
    s.lastState = a;   // dernier état connu (règles d'alerte, « ma zone »)
    const lastPt = s.points[s.points.length - 1];
    if (!lastPt || now - lastPt.t >= HISTORY_STEP) {
      s.points.push({ t: now, lat: a.lat, lon: a.lon, alt: a.alt, onGround: a.onGround, gs: a.speed, track: a.track, vr: a.vertRate });
      if (s.points.length > HISTORY_MAX) s.points.splice(0, s.points.length - HISTORY_MAX);
    }
  }
  if (sightings.size > 5_000) {
    for (const [hex, s] of sightings) if (now - s.last > SIGHTING_TTL) sightings.delete(hex);
  }
}

// Avions disparus en finale (plus de signal sous 2 500 ft en descente) = atterrissage probable
setInterval(() => {
  const now = Date.now();
  for (const s of sightings.values()) {
    if (!s.lastState || s.vanishChecked) continue;
    const age = now - s.last;
    if (age < 4 * 60_000) continue;
    s.vanishChecked = true;   // une seule vérification par disparition
    movements.observeVanished(s.lastState, s.last, now);
  }
}, 60_000).unref();

/** Points enregistrés par ce serveur pour un avion (trace de secours). */
export function getLocalHistory(hex) {
  return sightings.get(String(hex).toLowerCase())?.points || [];
}

/** @returns {{trackedSince: string, takeoffAt: string|null}|null} */
export function getSighting(hex) {
  const s = sightings.get(String(hex).toLowerCase());
  if (!s) return null;
  // décollage vu en direct, ou première observation au sol / en montée initiale
  const takeoff = s.takeoff || ((s.firstOnGround || (s.firstAlt != null && s.firstAlt < 2500)) ? s.first : null);
  return {
    trackedSince: new Date(s.first).toISOString(),
    takeoffAt: takeoff ? new Date(takeoff).toISOString() : null,
  };
}

export async function getLiveAircraft(lat, lon, dist) {
  const gLat = Math.round(lat * 4) / 4; // grille de 0,25° : les visiteurs proches partagent le cache
  const gLon = Math.round(lon * 4) / 4;
  const gDist = Math.min(250, Math.max(25, Math.ceil(dist / 25) * 25));
  const key = `${gLat},${gLon},${gDist}`;

  const cached = positionCache.get(key);
  if (cached) return cached;

  return dedupe(`pos:${key}`, async () => {
    let lastError;
    for (const provider of LIVE_PROVIDERS) {
      if (isCooling(provider)) continue;
      try {
        const data = await provider.limiter(() =>
          fetchJson(provider.url(gLat, gLon, gDist), { timeout: 9000, userAgent: UA })
        );
        const raw = data.ac || data.aircraft || [];
        const aircraft = raw.map(normalizeAircraft).filter(Boolean);
        const now = Date.now();
        recordSightings(aircraft, now);
        stats.observe(aircraft, now);
        const result = { aircraft, source: provider.name, now: data.now || now };
        positionCache.set(key, result);
        return result;
      } catch (err) {
        lastError = err;
        noteFailure(provider, err);
        console.warn(`[live] ${provider.name} KO: ${err.message} → source suivante`);
      }
    }
    throw lastError || new Error('Aucune source de positions disponible');
  });
}

/**
 * Essaie chaque fournisseur (même format) sur une URL par avion/callsign/immat.
 * Une réponse vide n'est pas une erreur, mais on tente quand même le suivant :
 * chaque réseau a sa propre couverture.
 */
async function firstProvider(kind, arg) {
  let lastError;
  let empty = null;
  for (const provider of LIVE_PROVIDERS) {
    if (!provider[kind] || isCooling(provider)) continue;
    try {
      const data = await provider.limiter(() => fetchJson(provider[kind](arg), { timeout: 8000, userAgent: UA }));
      const raw = data.ac || data.aircraft || [];
      const aircraft = raw.map(normalizeAircraft).filter(Boolean);
      if (aircraft.length) {
        recordSightings(aircraft, Date.now());
        return { aircraft, source: provider.name };
      }
      empty ||= { aircraft: [], source: provider.name };
    } catch (err) {
      lastError = err;
      noteFailure(provider, err);
      if (err.status !== 403) console.warn(`[${kind}] ${provider.name} KO: ${err.message} → source suivante`);
    }
  }
  if (empty) return empty;
  if (lastError) throw lastError;
  return { aircraft: [], source: null };
}

/**
 * Un avion précis, où qu'il soit dans le monde (mode « suivre »).
 * Cache 4 s partagé : 10 visiteurs qui suivent le même avion = 1 requête.
 */
export async function getAircraftByHex(hex) {
  const key = `hex:${hex}`;
  const cached = positionCache.get(key);
  if (cached) return cached;
  return dedupe(key, async () => {
    const r = await firstProvider('hex', hex);
    const result = { aircraft: r.aircraft[0] || null, source: r.source, now: Date.now() };
    return positionCache.set(key, result, 4_000);
  });
}

/**
 * Recherche mondiale : hex (6 hexa), callsign ou immatriculation.
 * Ne renvoie que des avions actuellement en vol (les fournisseurs ne
 * connaissent pas les avions au parking sans transpondeur actif).
 */
export async function searchAircraft(query) {
  const q = String(query || '').trim().toUpperCase().replace(/\s+/g, '');
  if (!q || q.length > 10) return { aircraft: [], source: null, query: q };
  const cached = searchCache.get(q);
  if (cached) return cached;

  return dedupe(`search:${q}`, async () => {
    const attempts = [];
    if (/^[0-9A-F]{6}$/.test(q)) attempts.push(['hex', q.toLowerCase()]);
    attempts.push(['callsign', q]);
    if (/^[A-Z0-9]{1,2}-?[A-Z0-9]{1,5}$/.test(q)) attempts.push(['reg', q]);

    let source = null;
    const found = new Map();
    for (const [kind, arg] of attempts) {
      try {
        const r = await firstProvider(kind, arg);
        for (const a of r.aircraft) found.set(a.hex, a);
        if (r.aircraft.length) { source = r.source; break; }
      } catch { /* on tente la forme suivante */ }
    }
    return searchCache.set(q, { aircraft: [...found.values()], source, query: q });
  });
}

// ════════════════════════════════════════════════════════════════════════════
// 02 · IDENTITÉ DE L'APPAREIL (hex → modèle, immatriculation, exploitant)
// ════════════════════════════════════════════════════════════════════════════
async function aircraftFromAdsbdb(hex) {
  const data = await limitDb(() =>
    fetchJson(`https://api.adsbdb.com/v0/aircraft/${encodeURIComponent(hex)}`, { userAgent: UA })
  );
  const a = data?.response?.aircraft;
  if (!a) return null;
  return {
    type: a.type || null,
    icaoType: a.icao_type || null,
    manufacturer: a.manufacturer || null,
    registration: a.registration || null,
    owner: a.registered_owner || null,
    ownerCountry: a.registered_owner_country_name || null,
    flagCode: a.registered_owner_operator_flag_code || null,
    // adsbdb : vignette 200×133 (sûre) + « grande image » airport-data (souvent 404 :
    // le navigateur la tente d'abord et retombe sur la vignette, voir photoFull)
    photo: a.url_photo_thumbnail || a.url_photo || null,
    photoThumb: a.url_photo_thumbnail || null,
    photoFull: a.url_photo || null,
    photoCredit: a.url_photo || a.url_photo_thumbnail ? 'adsbdb / airport-data.com' : null,
    photoLink: a.url_photo || null,
    source: 'adsbdb',
  };
}

/**
 * Planespotters.net : la meilleure source gratuite (419×280, souvent plusieurs
 * photos, photographe crédité — obligatoire, affiché sous la photo).
 * Recherche par hex, puis par immatriculation (mieux couverte).
 */
async function photosFromPlanespotters(hex, registration) {
  if (!PLANESPOTTERS_UA) return null;
  const tries = [`hex/${encodeURIComponent(hex)}`];
  if (registration) tries.push(`reg/${encodeURIComponent(registration)}`);
  for (const path of tries) {
    let data;
    try {
      data = await limitPs(() => fetchJson(`https://api.planespotters.net/pub/photos/${path}`, { userAgent: PLANESPOTTERS_UA, timeout: 6000 }));
    } catch (err) {
      if (err.status !== 404) console.warn(`[photo] planespotters ${path}: ${err.message}`);
      continue;
    }
    const photos = (data?.photos || []).map((p) => ({
      src: p.thumbnail_large?.src || p.thumbnail?.src || null,
      width: p.thumbnail_large?.size?.width || p.thumbnail?.size?.width || null,
      height: p.thumbnail_large?.size?.height || p.thumbnail?.size?.height || null,
      credit: p.photographer ? `© ${p.photographer} / Planespotters.net` : 'Planespotters.net',
      link: p.link || null,
    })).filter((p) => p.src).slice(0, 4);
    if (photos.length) return photos;
  }
  return null;
}

/**
 * Choisit la meilleure photo : Planespotters (grande, créditée) devant la vignette
 * adsbdb. `photos` garde jusqu'à 4 clichés pour la galerie du panneau.
 */
async function withBestPhoto(hex, info) {
  if (!info) return info;
  const out = { ...info, photoChecked: Boolean(PLANESPOTTERS_UA) };
  const ps = await photosFromPlanespotters(hex, info.registration);
  if (ps?.length) {
    out.photos = ps;
    out.photo = ps[0].src;
    out.photoThumb = ps[0].src;
    out.photoFull = ps[0].src;
    out.photoCredit = ps[0].credit;
    out.photoLink = ps[0].link;
    out.photoSource = 'Planespotters.net';
  } else if (out.photo) {
    out.photos = [{ src: out.photoThumb || out.photo, full: out.photoFull, credit: out.photoCredit, link: out.photoLink }];
    out.photoSource = 'adsbdb';
  }
  return out;
}

async function aircraftFromHexdb(hex) {
  const a = await limitHex(() =>
    fetchJson(`https://hexdb.io/api/v1/aircraft/${encodeURIComponent(hex)}`, { userAgent: UA })
  );
  if (!a || (!a.Type && !a.Registration)) return null;
  return {
    type: a.Type || a.ICAOTypeCode || null,
    icaoType: a.ICAOTypeCode || null,
    manufacturer: a.Manufacturer || null,
    registration: a.Registration || null,
    owner: a.RegisteredOwners || null,
    ownerCountry: null,
    flagCode: a.OperatorFlagCode || null,
    photo: null,
    photoThumb: null,
    source: 'hexdb.io',
  };
}

export async function getAircraftInfo(hex) {
  const key = String(hex).toLowerCase();
  const cached = aircraftCache.get(key);
  if (cached !== undefined) {
    // fiche mise en cache avant l'activation de Planespotters (ou avant CONTACT) : on tente
    // une seule fois d'améliorer la photo, puis on marque la fiche pour ne plus y revenir
    if (cached && PLANESPOTTERS_UA && !cached.photoChecked) {
      return dedupe(`acphoto:${key}`, async () => aircraftCache.set(key, await withBestPhoto(key, cached)));
    }
    return cached;
  }

  // Base locale prioritaire : zéro appel réseau (mais pas de photo)
  if (LOCAL_FIRST) {
    const local = ref.findAircraftLocal(key);
    if (local) return aircraftCache.set(key, local);
  }

  return dedupe(`ac:${key}`, async () => {
    for (const attempt of [() => aircraftFromAdsbdb(key), () => aircraftFromHexdb(key)]) {
      try {
        const info = await attempt();
        if (info) return aircraftCache.set(key, await withBestPhoto(key, info));
      } catch (err) {
        if (err.status !== 404) console.warn(`[aircraft] ${key}: ${err.message}`);
      }
    }
    // Dernier recours : la base locale, qui marche même si tout est hors ligne
    const local = ref.findAircraftLocal(key);
    if (local) return aircraftCache.set(key, await withBestPhoto(key, local));

    return aircraftCache.set(key, null, 3600_000); // cache négatif 1 h
  });
}

// ════════════════════════════════════════════════════════════════════════════
// 03 · TRAJET (callsign → aéroport de départ / d'arrivée)
// ════════════════════════════════════════════════════════════════════════════
const mapAirportLol = (ap) =>
  ap && {
    iata: ap.iata || null,
    icao: ap.icao || null,
    name: ap.name || null,
    city: ap.location || null,
    country: ap.countryiso2 || null,
    lat: num(ap.lat),
    lon: num(ap.lon),
  };

const mapAirportDb = (ap) =>
  ap && {
    iata: ap.iata_code || null,
    icao: ap.icao_code || null,
    name: ap.name || null,
    city: ap.municipality || null,
    country: ap.country_iso_name || null,
    lat: num(ap.latitude),
    lon: num(ap.longitude),
  };

/** A · adsb.lol routeset — même hôte que les positions, accepte un lot d'avions. */
async function routeFromAdsbLol(callsign, lat, lon) {
  const data = await limitLol(() =>
    fetchJson('https://api.adsb.lol/api/0/routeset', {
      method: 'POST',
      userAgent: UA,
      body: { planes: [{ callsign, lat: lat ?? 0, lng: lon ?? 0 }] },
    })
  );
  const r = Array.isArray(data) ? data[0] : data?.[0];
  const airports = r?._airports;
  if (!r || r.plausible === false || !Array.isArray(airports) || airports.length < 2) return null;
  return {
    origin: mapAirportLol(airports[0]),
    destination: mapAirportLol(airports[airports.length - 1]),
    stops: airports.length > 2 ? airports.slice(1, -1).map(mapAirportLol) : [],
    airline: r.airline_code ? { icao: r.airline_code, name: null } : null,
    flightNumber: r.number || null,
    source: 'adsb.lol',
  };
}

/** B · adsbdb — ajoute le nom complet de la compagnie et le numéro IATA. */
async function routeFromAdsbdb(callsign) {
  const data = await limitDb(() =>
    fetchJson(`https://api.adsbdb.com/v0/callsign/${encodeURIComponent(callsign)}`, { userAgent: UA })
  );
  const fr = data?.response?.flightroute;
  if (!fr) return null;
  // on retient le nom de la compagnie pour les stats et les filtres
  if (fr.airline?.icao && fr.airline?.name) stats.AIRLINE_NAMES.set(fr.airline.icao, fr.airline.name);
  if (fr.airline?.icao && fr.airline?.iata) stats.AIRLINE_IATA.set(fr.airline.iata.toUpperCase(), fr.airline.icao.toUpperCase());
  return {
    origin: mapAirportDb(fr.origin),
    destination: mapAirportDb(fr.destination),
    stops: fr.midpoint ? [mapAirportDb(fr.midpoint)] : [],
    airline: fr.airline
      ? { icao: fr.airline.icao || null, iata: fr.airline.iata || null, name: fr.airline.name || null }
      : null,
    flightNumber: fr.callsign_iata || null,
    source: 'adsbdb',
  };
}

/** C · hexdb.io — renvoie juste "EGLL-KJFK" : OurAirports fait le reste en local. */
async function routeFromHexdb(callsign) {
  const data = await limitHex(() =>
    fetchJson(`https://hexdb.io/api/v1/route/icao/${encodeURIComponent(callsign)}`, { userAgent: UA })
  );
  const codes = String(data?.route || '').split('-').map((c) => c.trim()).filter(Boolean);
  if (codes.length < 2) return null;
  return {
    origin: ref.airportFromCode(codes[0]),
    destination: ref.airportFromCode(codes[codes.length - 1]),
    stops: codes.slice(1, -1).map(ref.airportFromCode).filter(Boolean),
    airline: null,
    flightNumber: null,
    source: 'hexdb.io',
  };
}

export async function getRoute(callsign, lat, lon) {
  const key = String(callsign).trim().toUpperCase();
  if (!key) return null;
  const cached = routeCache.get(key);
  if (cached !== undefined) return cached;

  return dedupe(`rt:${key}`, async () => {
    const chain = [
      () => routeFromAdsbLol(key, lat, lon),
      () => routeFromAdsbdb(key),
      () => routeFromHexdb(key),
    ];
    for (const attempt of chain) {
      try {
        const route = await attempt();
        if (route?.origin && route?.destination) {
          // 04 · on complète les aéroports avec OurAirports (local, gratuit, instantané)
          route.origin = ref.enrichAirport(route.origin);
          route.destination = ref.enrichAirport(route.destination);
          route.stops = (route.stops || []).map(ref.enrichAirport);
          return routeCache.set(key, route);
        }
      } catch (err) {
        if (err.status !== 404) console.warn(`[route] ${key}: ${err.message}`);
      }
    }
    return routeCache.set(key, null, 3600_000); // vol privé / militaire / non commercial
  });
}

/**
 * Trajets par lot : adsb.lol routeset accepte plusieurs avions dans UNE requête.
 * Sert au tableau d'un aéroport (départs / arrivées) sans multiplier les appels.
 * Les callsigns déjà en cache ne sont pas redemandés. 40 avions max par lot.
 */
export async function getRoutesBatch(list) {
  const result = new Map();
  const missing = [];
  for (const { callsign, lat, lon } of list) {
    const key = String(callsign || '').trim().toUpperCase();
    if (!key) continue;
    const cached = routeCache.get(key);
    if (cached !== undefined) result.set(key, cached);
    else if (!missing.some((m) => m.callsign === key)) missing.push({ callsign: key, lat: lat ?? 0, lng: lon ?? 0 });
  }
  if (!missing.length) return result;
  try {
    const data = await limitLol(() =>
      fetchJson('https://api.adsb.lol/api/0/routeset', {
        method: 'POST', userAgent: UA, timeout: 9000,
        body: { planes: missing.slice(0, 40) },
      })
    );
    const seen = new Set();
    for (const r of Array.isArray(data) ? data : []) {
      const key = String(r?.callsign || '').trim().toUpperCase();
      if (!key) continue;
      seen.add(key);
      const airports = r._airports;
      if (r.plausible === false || !Array.isArray(airports) || airports.length < 2) {
        result.set(key, routeCache.set(key, null, 3600_000));
        continue;
      }
      const route = {
        origin: ref.enrichAirport(mapAirportLol(airports[0])),
        destination: ref.enrichAirport(mapAirportLol(airports[airports.length - 1])),
        stops: airports.length > 2 ? airports.slice(1, -1).map(mapAirportLol).map(ref.enrichAirport) : [],
        airline: r.airline_code ? { icao: r.airline_code, name: stats.AIRLINE_NAMES.get(r.airline_code) || null } : null,
        flightNumber: r.number || null,
        source: 'adsb.lol',
      };
      result.set(key, routeCache.set(key, route));
    }
    for (const m of missing) if (!seen.has(m.callsign)) result.set(m.callsign, null);
  } catch (err) {
    console.warn(`[routeset] lot de ${missing.length} : ${err.message}`);
  }
  return result;
}

// ════════════════════════════════════════════════════════════════════════════
// 05 · MÉTÉO AÉRONAUTIQUE (NOAA — gratuit, sans clé, 100 req/min)
// ════════════════════════════════════════════════════════════════════════════
export async function getMetar(icao) {
  const code = String(icao || '').toUpperCase().trim();
  if (!/^[A-Z0-9]{4}$/.test(code)) return null;

  const cached = metarCache.get(code);
  if (cached !== undefined) return cached;

  return dedupe(`wx:${code}`, async () => {
    try {
      const data = await limitWx(() =>
        fetchJson(`https://aviationweather.gov/api/data/metar?ids=${code}&format=json`, {
          userAgent: UA,
          timeout: 7000,
        })
      );
      const m = Array.isArray(data) ? data[0] : data;
      if (!m) return metarCache.set(code, null, 5 * 60_000);
      return metarCache.set(code, {
        icao: code,
        raw: m.rawOb || null,
        temp: num(m.temp),
        wind: num(m.wspd),
        windDir: num(m.wdir),
        visibility: m.visib ?? null,
        observed: m.obsTime ? new Date(m.obsTime * 1000).toISOString() : null,
      });
    } catch (err) {
      console.warn(`[metar] ${code}: ${err.message}`);
      return metarCache.set(code, null, 60_000);
    }
  });
}

export function cacheStats() {
  return [positionCache.stats(), aircraftCache.stats(), routeCache.stats(), metarCache.stats(), searchCache.stats()];
}

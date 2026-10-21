/**
 * 06 · HORAIRES, PORTES, RETARDS — les APIs à clé (gratuites mais plafonnées).
 *
 * L'ADS-B ne diffuse pas d'horaire : ces infos viennent des systèmes des
 * compagnies, et personne ne les redistribue gratuitement sans limite.
 * Trois fournisseurs, chacun activé par une variable d'environnement :
 *
 *   AERODATABOX_KEY   RapidAPI, ~300 req/mois gratuites (illimité si feeder)   ← le meilleur
 *   AIRLABS_KEY       ~1 000 req/mois gratuites
 *   AVIATIONSTACK_KEY 100 req/mois gratuites (via apilayer)
 *
 * Règles :
 *   - appelé UNIQUEMENT à la demande (jamais en boucle), avec cache
 *   - chaque appel passe par le compteur de quota (lib/quota.js)
 *   - la clé ne quitte JAMAIS le serveur
 *   - tout est normalisé dans un format unique pour le front
 */
import { fetchJson } from './limiter.js';
import { TTLCache, createDeduper } from './cache.js';
import { createQuota } from './quota.js';
import * as ref from './refdata.js';
import { learnAirportTimezone } from './geo.js';

const UA = process.env.USER_AGENT || 'flightmap/2.0 (projet perso de suivi de vols)';

// persistant : un redémarrage ne doit jamais coûter une requête à quota
export const scheduleCache = new TTLCache({ ttl: 15 * 60_000, max: 10_000, name: 'schedule', persist: 'schedule' });
const dedupe = createDeduper();

const envInt = (name, def) => {
  const v = Number.parseInt(process.env[name] || '', 10);
  return Number.isFinite(v) && v > 0 ? v : def;
};

// ── Outils temps ────────────────────────────────────────────────────────────
/** Décalage (ms) d'un fuseau IANA à un instant donné. */
function tzOffsetMs(date, tz) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: tz, hourCycle: 'h23',
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
  }).formatToParts(date);
  const g = (t) => Number(parts.find((p) => p.type === t)?.value);
  const asUtc = Date.UTC(g('year'), g('month') - 1, g('day'), g('hour'), g('minute'), g('second'));
  return asUtc - date.getTime();
}

/** "2026-09-12T18:50" (heure locale de l'aéroport) + fuseau → ISO UTC. */
export function localToUtc(local, tz) {
  const m = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})/.exec(local || '');
  if (!m) return null;
  const guess = Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5]);
  if (!tz) return new Date(guess).toISOString();
  try {
    let utc = guess - tzOffsetMs(new Date(guess), tz);
    utc = guess - tzOffsetMs(new Date(utc), tz); // 2e passe : bord de changement d'heure
    return new Date(utc).toISOString();
  } catch {
    return new Date(guess).toISOString();
  }
}

/** ISO UTC + fuseau → "YYYY-MM-DDTHH:mm" heure locale. */
function utcToLocal(iso, tz) {
  if (!iso) return null;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  if (!tz) return d.toISOString().slice(0, 16);
  try {
    return new Date(d.getTime() + tzOffsetMs(d, tz)).toISOString().slice(0, 16);
  } catch {
    return d.toISOString().slice(0, 16);
  }
}

/** Objet horaire normalisé : { utc, local } ou null. */
const stamp = (utc, local) => (utc || local ? { utc: utc || null, local: local || null } : null);

/** Aéroport normalisé, complété par OurAirports (local, 0 appel). */
function airport(codes) {
  const base = {
    iata: codes.iata || null, icao: codes.icao || null,
    name: codes.name || null, city: null, country: null, lat: null, lon: null,
  };
  return { ...ref.enrichAirport(base), timezone: codes.timezone || null };
}

const STATUS_LABELS = {
  scheduled: 'Prévu', boarding: 'Embarquement', active: 'En vol', landed: 'Atterri',
  cancelled: 'Annulé', diverted: 'Dérouté', delayed: 'Retardé', unknown: 'Statut inconnu',
};

/** Durée de cache selon le statut : un vol terminé ne bouge plus. */
function ttlFor(status) {
  if (status === 'landed' || status === 'cancelled') return 6 * 3600_000;
  if (status === 'active') return 10 * 60_000;
  return 15 * 60_000;
}

// ════════════════════════════════════════════════════════════════════════════
// A · AeroDataBox (RapidAPI) — le plus complet, fournit UTC + local
// ════════════════════════════════════════════════════════════════════════════
function adbTime(t) {
  if (!t) return null;
  // formats : { utc: "2026-09-12 16:50Z", local: "2026-09-12 18:50+02:00" }
  const utc = t.utc ? new Date(t.utc.replace(' ', 'T')).toISOString() : null;
  const local = t.local ? t.local.replace(' ', 'T').slice(0, 16) : null;
  return stamp(utc, local);
}

const ADB_STATUS = {
  Expected: 'scheduled', CheckIn: 'scheduled', Boarding: 'boarding', GateClosed: 'boarding',
  Departed: 'active', EnRoute: 'active', Approaching: 'active', Delayed: 'delayed',
  Arrived: 'landed', Canceled: 'cancelled', CanceledUncertain: 'cancelled', Diverted: 'diverted',
};

async function fromAeroDataBox({ callsign, flightNumber, hex }, key) {
  // Recherche par hex ICAO24 : aucune ambiguïté de codeshare. Sinon callsign.
  const path = hex ? `flights/icao24/${hex}` : `flights/callsign/${encodeURIComponent(callsign)}`;
  const url = `https://aerodatabox.p.rapidapi.com/${path}?withAircraftImage=false&withLocation=false`;
  const data = await fetchJson(url, {
    userAgent: UA, timeout: 9000,
    headers: { 'x-rapidapi-key': key, 'x-rapidapi-host': 'aerodatabox.p.rapidapi.com' },
  });
  const list = Array.isArray(data) ? data : [];
  const f = pickFlight(list, {
    byNumber: (x) => x.number?.replace(/\s+/g, '') === (flightNumber || '').replace(/\s+/g, ''),
    byCallsign: (x) => x.callSign?.replace(/\s+/g, '') === callsign,
    isActive: (x) => ['Departed', 'EnRoute', 'Approaching'].includes(x.status),
  });
  if (!f) return null;
  const side = (s) => ({
    ...airport({ iata: s?.airport?.iata, icao: s?.airport?.icao, name: s?.airport?.name, timezone: s?.airport?.timeZone }),
    scheduled: adbTime(s?.scheduledTime),
    estimated: adbTime(s?.revisedTime || s?.predictedTime),
    actual: adbTime(s?.runwayTime),
    terminal: s?.terminal || null,
    gate: s?.gate || null,
    baggage: s?.baggageBelt || null,
    delayMin: null,
  });
  const status = ADB_STATUS[f.status] || 'unknown';
  return {
    source: 'AeroDataBox',
    status, statusLabel: STATUS_LABELS[status],
    flightNumber: f.number || null,
    airline: f.airline ? { name: f.airline.name || null, iata: f.airline.iata || null, icao: f.airline.icao || null } : null,
    departure: side(f.departure),
    arrival: side(f.arrival),
    distanceKm: f.greatCircleDistance?.km ?? null,
    updatedAt: f.lastUpdatedUtc ? new Date(f.lastUpdatedUtc.replace(' ', 'T')).toISOString() : null,
  };
}

// ════════════════════════════════════════════════════════════════════════════
// B · AirLabs — fournit local + UTC, terminal, porte, tapis bagages
// ════════════════════════════════════════════════════════════════════════════
const AIRLABS_STATUS = { scheduled: 'scheduled', 'en-route': 'active', landed: 'landed', cancelled: 'cancelled' };

async function fromAirLabs({ callsign, flightNumber }, key) {
  const qs = new URLSearchParams({ api_key: key });
  if (flightNumber) qs.set('flight_iata', flightNumber);
  else qs.set('flight_icao', callsign);
  const data = await fetchJson(`https://airlabs.co/api/v9/flight?${qs}`, { userAgent: UA, timeout: 9000 });
  const f = data?.response;
  if (!f || data?.error) return null;
  const t = (local, utc) => stamp(utc ? new Date(utc.replace(' ', 'T') + 'Z').toISOString() : null, local ? local.replace(' ', 'T') : null);
  const side = (p) => ({
    ...airport({ iata: f[`${p}_iata`], icao: f[`${p}_icao`], name: f[`${p}_name`] }),
    scheduled: t(f[`${p}_time`], f[`${p}_time_utc`]),
    estimated: t(f[`${p}_estimated`], f[`${p}_estimated_utc`]),
    actual: t(f[`${p}_actual`], f[`${p}_actual_utc`]),
    terminal: f[`${p}_terminal`] || null,
    gate: f[`${p}_gate`] || null,
    baggage: p === 'arr' ? f.arr_baggage || null : null,
    delayMin: f[`${p}_delayed`] ?? null,
  });
  const status = AIRLABS_STATUS[f.status] || 'unknown';
  return {
    source: 'AirLabs',
    status, statusLabel: STATUS_LABELS[status],
    flightNumber: f.flight_iata || null,
    airline: { name: f.airline_name || null, iata: f.airline_iata || null, icao: f.airline_icao || null },
    departure: side('dep'),
    arrival: side('arr'),
    distanceKm: null,
    updatedAt: f.updated ? new Date(f.updated * 1000).toISOString() : null,
  };
}

// ════════════════════════════════════════════════════════════════════════════
// C · Aviationstack (apilayer) — 100 req/mois. Piège : les heures sont
//     LOCALES mais suffixées "+00:00". On les réinterprète avec le fuseau.
// ════════════════════════════════════════════════════════════════════════════
const AVS_STATUS = { scheduled: 'scheduled', active: 'active', landed: 'landed', cancelled: 'cancelled', incident: 'diverted', diverted: 'diverted' };

async function fromAviationstack({ callsign, flightNumber, hex }, key) {
  const qs = new URLSearchParams({ access_key: key, limit: '10' });
  if (flightNumber) qs.set('flight_iata', flightNumber);
  else qs.set('flight_icao', callsign);
  const data = await fetchJson(`https://api.apilayer.net/aviationstack/v1/flights?${qs}`, { userAgent: UA, timeout: 9000 });
  if (data?.error) throw new Error(`aviationstack: ${data.error.code || data.error.message}`);
  const list = Array.isArray(data?.data) ? data.data : [];
  // Une réponse par codeshare : on veut celle de l'exploitant réel
  const f = pickFlight(list, {
    byHex: (x) => hex && x.aircraft?.icao24?.toLowerCase() === hex,
    byNumber: (x) => x.flight?.iata?.toUpperCase() === flightNumber,
    byCallsign: (x) => x.flight?.icao?.toUpperCase() === callsign,
    isOperator: (x) => !x.flight?.codeshared,
    isActive: (x) => x.flight_status === 'active',
  });
  if (!f) return null;
  const side = (s) => {
    const tz = s?.timezone || null;
    const t = (v) => (v ? stamp(localToUtc(v, tz), v.slice(0, 16)) : null);
    return {
      ...airport({ iata: s?.iata, icao: s?.icao, name: s?.airport, timezone: tz }),
      scheduled: t(s?.scheduled),
      estimated: t(s?.estimated),
      actual: t(s?.actual),
      terminal: s?.terminal || null,
      gate: s?.gate || null,
      baggage: s?.baggage || null,
      delayMin: s?.delay ?? null,
    };
  };
  const status = AVS_STATUS[f.flight_status] || 'unknown';
  return {
    source: 'Aviationstack',
    status, statusLabel: STATUS_LABELS[status],
    flightNumber: f.flight?.iata || null,
    airline: f.airline ? { name: f.airline.name || null, iata: f.airline.iata || null, icao: f.airline.icao || null } : null,
    departure: side(f.departure),
    arrival: side(f.arrival),
    distanceKm: null,
    updatedAt: null,
  };
}

/**
 * Choisit le bon vol dans une liste (codeshares, vols d'hier…).
 * Un codeshare partage le même avion (hex) : le hex seul ne suffit pas,
 * on cumule les indices et on garde le meilleur score.
 */
const PICK_WEIGHTS = { byCallsign: 8, byNumber: 8, byHex: 4, isOperator: 2, isActive: 1 };
export function pickFlight(list, tests) {
  if (!list.length) return null;
  let best = null, bestScore = -1;
  for (const x of list) {
    let score = 0;
    for (const [name, weight] of Object.entries(PICK_WEIGHTS)) {
      try { if (tests[name]?.(x)) score += weight; } catch { /* champ absent */ }
    }
    if (score > bestScore) { best = x; bestScore = score; }
  }
  return best;
}

// ════════════════════════════════════════════════════════════════════════════
// Chaîne de fournisseurs (dans l'ordre de qualité), activés par leur clé
// ════════════════════════════════════════════════════════════════════════════
const ALL = [
  { name: 'AeroDataBox', key: process.env.AERODATABOX_KEY, fetch: fromAeroDataBox, monthly: envInt('AERODATABOX_QUOTA', 300) },
  { name: 'AirLabs', key: process.env.AIRLABS_KEY, fetch: fromAirLabs, monthly: envInt('AIRLABS_QUOTA', 1000) },
  { name: 'Aviationstack', key: process.env.AVIATIONSTACK_KEY, fetch: fromAviationstack, monthly: envInt('AVIATIONSTACK_QUOTA', 100) },
];

export const SCHEDULE_PROVIDERS = ALL
  .filter((p) => p.key)
  .map((p) => ({ ...p, quota: createQuota(p.name, { monthly: p.monthly }) }));

export const SCHEDULE_ENABLED = SCHEDULE_PROVIDERS.length > 0;

/**
 * Mode d'affichage côté front :
 *   auto   → horaires chargés au clic sur l'avion (quota confortable)
 *   button → un bouton « Afficher les horaires » (petit quota : on ne
 *            dépense que si le visiteur le demande vraiment)
 */
export const SCHEDULE_MODE =
  (process.env.SCHEDULE_AUTO === '1' || SCHEDULE_PROVIDERS.some((p) => p.monthly >= 1000)) ? 'auto' : 'button';

/** Un callsign de ligne régulière ressemble à AFR1496 / BAW12A. Le reste (N123AB, RCH…) n'a pas d'horaire. */
const looksScheduled = (cs) => /^[A-Z]{3}\d{1,4}[A-Z]{0,2}$/.test(cs || '');

/**
 * Clés de cache : le même vol peut être demandé par callsign (AFR1496) ou par
 * numéro IATA (AF1496). On stocke sous les deux pour ne jamais payer deux fois.
 */
function scheduleKeys({ callsign, flightNumber }) {
  return [...new Set([flightNumber, callsign].map((v) => String(v || '').toUpperCase().replace(/\s+/g, '')).filter(Boolean))];
}

function cacheSet(keys, value, ttl) {
  for (const k of keys) scheduleCache.set(k, value, ttl);
  return value;
}

/** Renvoie l'horaire depuis le cache uniquement (0 appel, 0 quota). */
export function getCachedSchedule(ids) {
  for (const k of scheduleKeys(ids)) {
    const v = scheduleCache.get(k);
    if (v !== undefined) return v;
  }
  return undefined;
}

/** Y a-t-il au moins un fournisseur configuré avec du quota disponible ? */
export function scheduleAvailability() {
  if (!SCHEDULE_ENABLED) return { enabled: false, reason: 'Aucune clé configurée' };
  const ok = SCHEDULE_PROVIDERS.some((p) => p.quota.canSpend());
  return ok
    ? { enabled: true }
    : { enabled: false, reason: 'Quota gratuit du jour épuisé — réessaie demain' };
}

/**
 * @param {{callsign?: string, flightNumber?: string, hex?: string}} ids
 * @returns {Promise<object|null>} horaire normalisé, ou null
 */
export async function getSchedule(ids) {
  const callsign = String(ids.callsign || '').toUpperCase().trim();
  let flightNumber = String(ids.flightNumber || '').toUpperCase().replace(/\s+/g, '') || null;
  // un numéro sans code compagnie (« 176 », renvoyé par certaines sources) ne sert à rien aux APIs
  if (flightNumber && !/^(?=[A-Z0-9]{2}\d)(?=.*[A-Z])/.test(flightNumber)) flightNumber = null;
  const hex = String(ids.hex || '').toLowerCase().trim() || null;
  const keys = scheduleKeys({ callsign, flightNumber });
  if (!keys.length || !SCHEDULE_ENABLED) return null;
  if (!flightNumber && !looksScheduled(callsign)) return null;

  const cached = getCachedSchedule({ callsign, flightNumber });
  if (cached !== undefined) return cached;

  return dedupe(`sch:${keys[0]}`, async () => {
    for (const p of SCHEDULE_PROVIDERS) {
      if (!p.quota.canSpend()) { console.warn(`[schedule] ${p.name} : quota atteint`); continue; }
      try {
        p.quota.spend();
        console.log(`[schedule] ${p.name} ← ${keys.join('/')} (${p.quota.stats().today} aujourd'hui)`);
        const result = await p.fetch({ callsign, flightNumber, hex }, p.key);
        if (result?.departure && result?.arrival) {
          result.fetchedAt = new Date().toISOString();
          // les fournisseurs connaissent le fuseau exact des aéroports : on le retient pour les fiches
          for (const side of [result.departure, result.arrival]) if (side?.icao && side?.timezone) learnAirportTimezone(side.icao, side.timezone);
          // le fournisseur connaît le vrai numéro : on l'ajoute aux clés
          const allKeys = scheduleKeys({ callsign, flightNumber: flightNumber || result.flightNumber });
          return cacheSet(allKeys, result, ttlFor(result.status));
        }
      } catch (err) {
        console.warn(`[schedule] ${p.name} ${keys[0]}: ${err.message}`);
      }
    }
    return cacheSet(keys, null, 30 * 60_000); // cache négatif : ne pas re-dépenser
  });
}

export function scheduleStats() {
  return {
    mode: SCHEDULE_MODE,
    providers: SCHEDULE_PROVIDERS.map((p) => p.quota.stats()),
    cache: scheduleCache.stats(),
  };
}

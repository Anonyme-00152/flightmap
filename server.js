/**
 * FlightMap — backend.
 *
 * Rôle : être le SEUL à parler aux APIs externes.
 *   navigateur  ->  ce serveur (cache + référentiel local + SQLite)  ->  APIs gratuites
 *
 * Pourquoi ce n'est pas optionnel :
 *   - 100 visiteurs qui pollent adsb.lol directement = IP bannie en 5 min
 *   - le cache transforme 1000 visiteurs en 1 seule requête par zone
 *   - le référentiel local (aéroports, appareils remarquables) répond sans
 *     aucun appel réseau
 *   - les clés d'API restent ici, invisibles du navigateur
 *
 * Routes :
 *   GET /api/aircraft?lat&lon&dist      avions d'une zone (poll)
 *   GET /api/stream?lat&lon&dist        même chose, poussé en SSE
 *   GET /api/aircraft/hex/:hex          un avion précis (mode « suivre »)
 *   GET /api/search?q=                  callsign / immat / hex, monde entier
 *   GET /api/flight/:hex                fiche complète (identité, trajet, météo…)
 *   GET /api/flight/:hex/schedule       horaires / portes (API à clé, quota)
 *   GET /api/trail/:hex                 trace réelle + vols du jour
 *   GET /api/history/:hex?days=7        vols archivés (SQLite)
 *   GET /api/stats                      agrégats pour /stats.html
 *   GET /api/health · /api/ping         supervision
 */
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// .env (clés d'API) — chargé AVANT les imports qui lisent process.env.
// En ligne (Render, Fly, Railway…) les variables viennent du dashboard : pas de .env.
{
  const envFile = path.join(__dirname, '.env');
  if (fs.existsSync(envFile) && typeof process.loadEnvFile === 'function') {
    process.loadEnvFile(envFile);
  } else if (fs.existsSync(envFile)) {
    // Node < 20.12 : lecture minimaliste KEY=VALUE
    for (const line of fs.readFileSync(envFile, 'utf8').split('\n')) {
      const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/i.exec(line);
      if (m && !(m[1] in process.env)) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
    }
  }
}

const express = (await import('express')).default;
const {
  getLiveAircraft, getAircraftByHex, searchAircraft, getAircraftInfo, getRoute, getMetar, getSighting,
  cacheStats, LIVE_PROVIDERS, COMMERCIAL,
} = await import('./lib/providers.js');
const {
  getSchedule, getCachedSchedule, scheduleAvailability, scheduleStats,
  SCHEDULE_ENABLED, SCHEDULE_MODE, SCHEDULE_PROVIDERS,
} = await import('./lib/schedule.js');
const { getTrail, trailCache } = await import('./lib/trail.js');
const archive = await import('./lib/archive.js');
const stats = await import('./lib/stats.js');
const store = await import('./lib/store.js');
const { handleStream, streamStats } = await import('./lib/stream.js');
const { createRateLimit } = await import('./lib/ratelimit.js');
const ref = await import('./lib/refdata.js');
const providersModule = await import('./lib/providers.js');
const { routeCache } = providersModule;
const { airportBoard } = await import('./lib/airport.js');
const movements = await import('./lib/movements.js');
const registry = await import('./lib/registry.js');
const events = await import('./lib/events.js');
const { EXPORT_FORMATS } = await import('./lib/export.js');
const accounts = await import('./lib/accounts.js');
const geo = await import('./lib/geo.js');

const app = express();
const PORT = process.env.PORT || 3000;
const SCHEDULE_PER_IP_DAY = Number.parseInt(process.env.SCHEDULE_PER_IP_DAY || '10', 10);

app.disable('x-powered-by');
app.set('trust proxy', 1);   // derrière Render/Fly : req.ip = vraie IP du visiteur
app.use(express.json({ limit: '10kb' }));

// ── Garde-fous : limites par IP, par famille de routes ──────────────────────
const limitGeneral = createRateLimit({ windowMs: 60_000, max: 240 });
const limitSearch = createRateLimit({ windowMs: 60_000, max: 30, message: 'Trop de recherches, attends une minute.' });
const limitTrail = createRateLimit({ windowMs: 60_000, max: 60 });
const limitSchedule = createRateLimit({
  windowMs: 24 * 3600_000, max: SCHEDULE_PER_IP_DAY,
  message: `Limite atteinte : ${SCHEDULE_PER_IP_DAY} consultations d'horaires par jour et par visiteur (quota gratuit partagé).`,
});
app.use('/api', limitGeneral);

const validHex = (h) => /^[0-9a-f]{6}$/.test(h);

// ════════════════════════════════════════════════════════════════════════════
// POSITIONS
// ════════════════════════════════════════════════════════════════════════════
app.get('/api/aircraft', async (req, res) => {
  const lat = Number.parseFloat(req.query.lat);
  const lon = Number.parseFloat(req.query.lon);
  const dist = Number.parseFloat(req.query.dist) || 100;
  if (!Number.isFinite(lat) || !Number.isFinite(lon) || Math.abs(lat) > 90 || Math.abs(lon) > 180) {
    return res.status(400).json({ error: 'lat/lon invalides' });
  }
  try {
    const data = await getLiveAircraft(lat, lon, dist);
    res.set('Cache-Control', 'public, max-age=3');
    res.json(data);
  } catch (err) {
    console.error('[/api/aircraft]', err.message);
    res.status(502).json({ error: 'Sources de positions injoignables', detail: err.message });
  }
});

// Flux poussé : une connexion par onglet, le serveur envoie toutes les 5 s
app.get('/api/stream', (req, res) => handleStream(req, res, getLiveAircraft));

// Un avion précis, où qu'il soit (mode « suivre »)
app.get('/api/aircraft/hex/:hex', async (req, res) => {
  const hex = String(req.params.hex || '').trim().toLowerCase();
  if (!validHex(hex)) return res.status(400).json({ error: 'hex invalide' });
  try {
    res.set('Cache-Control', 'public, max-age=3');
    res.json(await getAircraftByHex(hex));
  } catch (err) {
    res.status(502).json({ error: 'Sources injoignables', detail: err.message });
  }
});

// Recherche mondiale : callsign, immatriculation ou hex
app.get('/api/search', limitSearch, async (req, res) => {
  const q = String(req.query.q || '').trim();
  if (!q) return res.status(400).json({ error: 'q requis' });
  try {
    res.set('Cache-Control', 'no-store');
    res.json(await searchAircraft(q));
  } catch (err) {
    res.status(502).json({ error: 'Sources injoignables', detail: err.message });
  }
});

// ════════════════════════════════════════════════════════════════════════════
// GET /api/flight/:hex?callsign=AFR123&lat=..&lon=..
// LA requête d'enrichissement : appelée UNIQUEMENT au clic sur un avion.
//   · identité   hex      → adsbdb → hexdb.io → base locale (+ photo Planespotters)
//   · trajet     callsign → adsb.lol routeset → adsbdb → hexdb.io
//   · aéroports  complétés avec OurAirports (local, 0 appel)
//   · météo      METAR à l'arrivée (NOAA, gratuit)
//   · horaires   si déjà en cache (0 quota), sinon selon le mode
// ════════════════════════════════════════════════════════════════════════════
app.get('/api/flight/:hex', async (req, res) => {
  const hex = String(req.params.hex || '').trim().toLowerCase();
  const callsign = String(req.query.callsign || '').trim().toUpperCase();
  const lat = Number.parseFloat(req.query.lat);
  const lon = Number.parseFloat(req.query.lon);
  if (!validHex(hex)) return res.status(400).json({ error: 'hex invalide' });

  archive.markInterest(hex, callsign || null);   // cet avion sera archivé pendant 24 h

  const [aircraft, route] = await Promise.all([
    getAircraftInfo(hex).catch(() => null),
    callsign ? getRoute(callsign, lat, lon).catch(() => null) : Promise.resolve(null),
  ]);

  // La météo dépend du trajet : on la demande après, et seulement si utile.
  const metar = route?.destination?.icao ? await getMetar(route.destination.icao).catch(() => null) : null;

  const ids = { callsign, flightNumber: route?.flightNumber, hex };
  let schedule = SCHEDULE_ENABLED ? getCachedSchedule(ids) : undefined;
  if (schedule === undefined && SCHEDULE_MODE === 'auto') {
    schedule = await getSchedule(ids).catch(() => null);
  }

  res.set('Cache-Control', 'no-store');
  res.json({
    hex,
    callsign: callsign || null,
    aircraft,
    route,
    metar,
    notable: ref.findNotable(hex),
    sighting: getSighting(hex),
    schedule: schedule ?? null,
    scheduleMode: SCHEDULE_MODE,
    scheduleAvailable: schedule === undefined ? scheduleAvailability() : { enabled: false, reason: 'done' },
    airlineName: /^[A-Z]{3}\d/.test(callsign) ? stats.AIRLINE_NAMES.get(callsign.slice(0, 3)) || null : null,
    // durée habituelle de ce vol d'après l'archive (prédiction d'arrivée sans API)
    prediction: callsign ? registry.predictDuration(route?.flightNumber || callsign) || registry.predictDuration(callsign) : null,
  });
});

// ════════════════════════════════════════════════════════════════════════════
// GET /api/flight/:hex/schedule?callsign=AFR123&flight=AF123
// Horaires, portes, retards — la seule route qui DÉPENSE du quota à clé.
// ════════════════════════════════════════════════════════════════════════════
app.get('/api/flight/:hex/schedule', async (req, res, next) => {
  const hex = String(req.params.hex || '').trim().toLowerCase();
  const callsign = String(req.query.callsign || '').trim().toUpperCase();
  const flightNumber = String(req.query.flight || '').trim().toUpperCase() || null;
  if (!validHex(hex)) return res.status(400).json({ error: 'hex invalide' });
  if (!callsign && !flightNumber) return res.status(400).json({ error: 'callsign requis' });

  res.set('Cache-Control', 'no-store');
  if (!SCHEDULE_ENABLED) return res.json({ schedule: null, reason: 'Aucune clé configurée' });

  const ids = { callsign, flightNumber, hex };
  const cached = getCachedSchedule(ids);
  if (cached !== undefined) return res.json({ schedule: cached, cached: true });   // gratuit : pas de limite

  // à partir d'ici ça peut coûter : limite journalière par visiteur
  limitSchedule(req, res, async () => {
    const avail = scheduleAvailability();
    if (!avail.enabled) return res.json({ schedule: null, reason: avail.reason });
    try {
      const schedule = await getSchedule(ids);
      res.json({ schedule, reason: schedule ? null : 'Aucun horaire trouvé pour ce vol' });
    } catch (err) {
      console.error('[/api/flight/schedule]', err.message);
      res.status(502).json({ schedule: null, reason: 'Fournisseur injoignable' });
    }
  });
});

// ════════════════════════════════════════════════════════════════════════════
// TRACES & HISTORIQUE
// ════════════════════════════════════════════════════════════════════════════
app.get('/api/trail/:hex', limitTrail, async (req, res) => {
  const hex = String(req.params.hex || '').trim().toLowerCase();
  if (!validHex(hex)) return res.status(400).json({ error: 'hex invalide' });
  try {
    // callsign (facultatif) : étiquette le vol en cours et permet de détecter un déroutement
    const callsign = String(req.query.callsign || '').trim().toUpperCase() || null;
    const destination = callsign ? routeCache.get(callsign)?.destination || null : null;
    res.set('Cache-Control', 'public, max-age=30');
    res.json(await getTrail(hex, { callsign, destination }));
  } catch (err) {
    console.error('[/api/trail]', err.message);
    res.status(502).json({ error: 'Trace indisponible' });
  }
});

app.get('/api/history/:hex', (req, res) => {
  const hex = String(req.params.hex || '').trim().toLowerCase();
  if (!validHex(hex)) return res.status(400).json({ error: 'hex invalide' });
  const days = Number.parseInt(req.query.days || '7', 10) || 7;
  res.set('Cache-Control', 'public, max-age=60');
  res.json({ hex, days, legs: archive.getHistory(hex, days) });
});

// Traces locales de plusieurs avions (ce que CE serveur a vu, 0 appel externe) :
// sert à dessiner les orbites de la vue militaire sans solliciter adsb.lol.
app.get('/api/local-trails', (req, res) => {
  const hexes = String(req.query.hexes || '').toLowerCase().split(',').filter(validHex).slice(0, 100);
  const { getLocalHistory } = providersModule;
  const out = {};
  for (const h of hexes) {
    const pts = getLocalHistory(h);
    if (pts.length >= 2) out[h] = pts.map((p) => [p.t, +p.lat.toFixed(4), +p.lon.toFixed(4), p.onGround ? 0 : p.alt]);
  }
  res.set('Cache-Control', 'public, max-age=20');
  res.json({ trails: out });
});

// Export d'un vol : /api/trail/:hex/export.gpx?leg=2 (leg = index dans la liste du jour, défaut : en cours)
app.get('/api/trail/:hex/export.:fmt', limitTrail, async (req, res) => {
  const hex = String(req.params.hex || '').trim().toLowerCase();
  const fmt = EXPORT_FORMATS[String(req.params.fmt || '').toLowerCase()];
  if (!validHex(hex)) return res.status(400).json({ error: 'hex invalide' });
  if (!fmt) return res.status(400).json({ error: 'format : gpx, kml ou csv' });
  try {
    let leg;
    if (req.query.archived) {
      // vol archivé : identifié par son heure de début
      const start = new Date(String(req.query.archived)).getTime();
      leg = archive.getHistory(hex, 30).find((l) => new Date(l.start).getTime() === start);
    } else {
      const trail = await getTrail(hex);
      const idx = req.query.leg != null ? Number.parseInt(req.query.leg, 10) : trail.legs.length - 1;
      leg = trail.legs[idx];
    }
    if (!leg) return res.status(404).json({ error: 'vol introuvable' });
    const name = `${leg.callsign || hex}_${String(leg.start).slice(0, 16).replace(/[:T]/g, '-')}.${fmt.ext}`;
    res.set('Content-Type', fmt.type);
    res.set('Content-Disposition', `attachment; filename="${name}"`);
    res.send(fmt.fn(leg, hex));
  } catch (err) {
    console.error('[/api/trail/export]', err.message);
    res.status(502).json({ error: 'Export indisponible' });
  }
});

// ════════════════════════════════════════════════════════════════════════════
// AÉROPORTS
// ════════════════════════════════════════════════════════════════════════════
// Aéroports à dessiner dans la vue : ?south&west&north&east[&min=large|medium]
app.get('/api/airports', (req, res) => {
  const b = ['south', 'west', 'north', 'east'].map((k) => Number.parseFloat(req.query[k]));
  if (b.some((v) => !Number.isFinite(v))) return res.status(400).json({ error: 'bounds invalides' });
  const [south, west, north, east] = b;
  if (north - south > 40 || east - west > 60) return res.json({ airports: [], note: 'zone trop large : zoome' });
  const minSize = req.query.min === 'large' ? 'large' : 'medium';
  res.set('Cache-Control', 'public, max-age=300');
  res.json({ airports: ref.airportsInBounds({ south, west, north, east }, { minSize, limit: 200 }) });
});

// Tableau d'un aéroport : départs / arrivées / au sol / pistes / METAR / piste en service
app.get('/api/airport/:code', async (req, res) => {
  const code = String(req.params.code || '').trim().toUpperCase();
  if (!/^[A-Z0-9]{3,4}$/.test(code)) return res.status(400).json({ error: 'code invalide' });
  try {
    const board = await airportBoard(code);
    if (!board) return res.status(404).json({ error: 'aéroport inconnu' });
    res.set('Cache-Control', 'public, max-age=30');
    res.json(board);
  } catch (err) {
    console.error('[/api/airport]', err.message);
    res.status(502).json({ error: 'Tableau indisponible' });
  }
});

// Statistiques seules d'un aéroport (7 à 30 jours) — mouvements observés par ce serveur
app.get('/api/airport/:code/stats', (req, res) => {
  const ap = ref.findAirport(String(req.params.code || '').toUpperCase());
  if (!ap) return res.status(404).json({ error: 'aéroport inconnu' });
  const days = Math.min(30, Math.max(1, Number.parseInt(req.query.days || '7', 10) || 7));
  const { airportTimezone } = geo;
  res.set('Cache-Control', 'public, max-age=60');
  res.json({ airport: { icao: ap.icao, iata: ap.iata, name: ap.name }, stats: movements.airportStats(ap.icao || ap.iata, days, airportTimezone(ap)) });
});

// Aéroports les plus actifs vus par ce serveur (7 jours)
app.get('/api/airports/busiest', (req, res) => {
  const days = Math.min(30, Number.parseInt(req.query.days || '7', 10) || 7);
  const list = store.busiestAirports(Date.now() - days * 24 * 3600_000, 30).map((x) => ({ ...x, ...(() => { const ap = ref.findAirport(x.airport); return ap ? { iata: ap.iata, name: ap.name, city: ap.city, country: ap.country } : {}; })() }));
  res.set('Cache-Control', 'public, max-age=120');
  res.json({ days, airports: list, watched: movements.watchStatus() });
});

// ════════════════════════════════════════════════════════════════════════════
// FICHES (avion, vol), ÉVÉNEMENTS, REJOUER UNE JOURNÉE
// ════════════════════════════════════════════════════════════════════════════
app.get('/api/registry/aircraft/:q', (req, res) => {
  const page = registry.aircraftPage(req.params.q);
  if (!page) return res.status(404).json({ error: 'Appareil inconnu de ce serveur (il faut l\'avoir vu passer ou consulté).' });
  res.set('Cache-Control', 'public, max-age=60');
  res.json(page);
});

app.get('/api/registry/flight/:number', (req, res) => {
  const page = registry.flightPage(req.params.number);
  if (!page) return res.status(400).json({ error: 'numéro invalide' });
  res.set('Cache-Control', 'public, max-age=60');
  res.json(page);
});

app.get('/api/events', (req, res) => {
  res.set('Cache-Control', 'public, max-age=30');
  res.json({ events: events.recentEvents(Number.parseInt(req.query.limit || '100', 10) || 100), labels: events.EVENT_LABELS });
});

// Tous les vols archivés d'une journée (UTC) pour /replay.html
app.get('/api/replay', (req, res) => {
  const day = /^\d{4}-\d{2}-\d{2}$/.test(req.query.day || '') ? req.query.day : new Date().toISOString().slice(0, 10);
  const start = new Date(`${day}T00:00:00Z`).getTime();
  const legs = store.legsOverlapping(start, start + 24 * 3600_000, 1500);
  res.set('Cache-Control', 'public, max-age=120');
  res.json({ day, legs: legs.map((l) => ({ hex: l.hex, callsign: l.callsign, from: l.from?.iata || null, to: l.to?.iata || null, points: l.points })) });
});

// Pages « jolies » : /aircraft/F-GKXM · /flight/AF1496 · /airport/CDG
app.get('/aircraft/:q', (_req, res) => res.sendFile(path.join(__dirname, 'public', 'aircraft.html')));
app.get('/flight/:q', (_req, res) => res.sendFile(path.join(__dirname, 'public', 'flight.html')));
app.get('/airport/:q', (req, res) => res.redirect(`/?airport=${encodeURIComponent(req.params.q)}`));

// ════════════════════════════════════════════════════════════════════════════
// COMPTES LÉGERS : favoris, règles d'alerte, canaux, boîte de réception
// ════════════════════════════════════════════════════════════════════════════
const limitAccount = createRateLimit({ windowMs: 60_000, max: 60 });
function withUser(req, res, next) {
  const token = String(req.get('x-user-token') || req.query.token || '');
  const user = accounts.getUser(token);
  if (!user) return res.status(401).json({ error: 'jeton invalide' });
  req.userToken = token;
  req.user = user;
  res.set('Cache-Control', 'no-store');
  next();
}

app.post('/api/me/new', limitAccount, (_req, res) => {
  const token = accounts.newToken();
  accounts.saveUser(token, accounts.getUser(token));
  res.json({ token });
});
app.get('/api/me', limitAccount, withUser, (req, res) => {
  res.json({ ...req.user, telegram: accounts.telegramInfo(req.userToken), channelsAvailable: accounts.channelsAvailable });
});
app.put('/api/me/favorites', limitAccount, withUser, (req, res) => {
  req.user.favorites = accounts.sanitizeFavorites(req.body?.favorites);
  res.json({ favorites: accounts.saveUser(req.userToken, req.user).favorites });
});
app.put('/api/me/rules', limitAccount, withUser, (req, res) => {
  req.user.rules = accounts.sanitizeRules(req.body?.rules);
  res.json({ rules: accounts.saveUser(req.userToken, req.user).rules });
});
app.put('/api/me/channels', limitAccount, withUser, (req, res) => {
  req.user.channels = { ...req.user.channels, ...accounts.sanitizeChannels(req.body) };
  if (req.body?.telegramChatId === null) req.user.channels.telegramChatId = null;
  res.json({ channels: accounts.saveUser(req.userToken, req.user).channels });
});
app.get('/api/me/inbox', limitAccount, withUser, (req, res) => {
  const since = req.query.since ? new Date(String(req.query.since)).getTime() : 0;
  res.json({ inbox: (req.user.inbox || []).filter((n) => new Date(n.t).getTime() > since) });
});
app.post('/api/me/test', limitAccount, withUser, async (req, res) => {
  const sent = await accounts.notifyUser(req.userToken, req.user, { text: 'Test d\'alerte FlightMap ✈', hex: null, channels: ['app', 'telegram', 'email'] });
  res.json({ sent });
});

// ════════════════════════════════════════════════════════════════════════════
// STATS & SUPERVISION
// ════════════════════════════════════════════════════════════════════════════
app.get('/api/stats', (req, res) => {
  const days = Math.min(30, Number.parseInt(req.query.days || '7', 10) || 7);
  res.set('Cache-Control', 'public, max-age=60');
  res.json(stats.getStats(days));
});

// Ping ultra-léger pour UptimeRobot & co (évite la mise en veille de Render)
app.get('/api/ping', (_req, res) => res.type('text').send('ok'));

app.get('/api/health', (_req, res) => {
  res.json({
    ok: true,
    uptime: Math.round(process.uptime()),
    node: process.version,
    commercialMode: COMMERCIAL,
    sources: LIVE_PROVIDERS.map((p) => p.name),
    schedule: scheduleStats(),
    store: archive.archiveStatus(),
    stream: streamStats(),
    accounts: accounts.accountsStatus(),
    events: events.recentEvents(5).length,
    airports: movements.watchStatus(),
    rateLimits: { general: limitGeneral.stats(), search: limitSearch.stats(), schedule: limitSchedule.stats() },
    refdata: ref.status,
    caches: [...cacheStats(), trailCache.stats()],
  });
});

// ── Statique ────────────────────────────────────────────────────────────────
// Leaflet servi depuis node_modules : pas de CDN, le site marche même sans
// réseau (hors tuiles de la carte, évidemment).
app.use('/vendor/leaflet', express.static(path.join(__dirname, 'node_modules/leaflet/dist'), { maxAge: '7d' }));
app.use(express.static(path.join(__dirname, 'public'), {
  maxAge: '7d',   // icônes, images
  setHeaders(res, filePath) {
    // code et pages : toujours revalidés (ETag → 304, quasi gratuit) pour que
    // les mises à jour arrivent ; les modules ES n'ont pas de ?v= cache-buster
    if (/\.(js|css|html|webmanifest)$/.test(filePath)) res.set('Cache-Control', 'no-cache');
    if (filePath.endsWith('.webmanifest')) res.type('application/manifest+json');
  },
}));

archive.startArchiveJob(getTrail);
accounts.startAlertEngine();
movements.startAirportWatch(getLiveAircraft);

app.listen(PORT, () => {
  console.log(`\n  ✈  FlightMap sur http://localhost:${PORT}`);
  console.log(`     Sources de positions : ${LIVE_PROVIDERS.map((p) => p.name).join(' → ')}`);
  if (SCHEDULE_ENABLED) {
    console.log(`     Horaires / portes    : ${SCHEDULE_PROVIDERS.map((p) => `${p.name} (${p.monthly}/mois)`).join(' → ')} · mode ${SCHEDULE_MODE}`);
  } else {
    console.log('     Horaires / portes    : désactivés (ajoute AVIATIONSTACK_KEY, AIRLABS_KEY ou AERODATABOX_KEY dans .env)');
  }
  console.log(`     Persistance          : ${store.backend}${store.backend === 'json' ? ' (node:sqlite indisponible, Node ≥ 22.13 recommandé)' : ''}`);
  console.log(providersModule.PLANESPOTTERS_UA
    ? '     Photos               : Planespotters.net (grandes, créditées) → adsbdb'
    : '     Photos               : adsbdb (vignettes 200 px). Ajoute CONTACT=mailto:toi@exemple.fr dans .env pour activer Planespotters (2× plus grandes)');
  if (COMMERCIAL) {
    console.log('     ⚠ MODE COMMERCIAL : sources non commerciales désactivées.');
    console.log('       Garde l\'attribution adsb.lol (ODbL) visible sur la page.');
  }
  console.log(`     Stats du cache : http://localhost:${PORT}/api/health · statistiques : /stats.html\n`);
  ref.report();
});

// Snapshot des stats avant de partir (redéploiement, Ctrl+C)
for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => { stats.snapshot(); process.exit(0); });
}

/**
 * Flux SSE (Server-Sent Events) : le serveur POUSSE les positions au lieu
 * que chaque onglet les demande toutes les 5 s.
 *
 * Les clients sont regroupés par zone (même arrondi que le cache de
 * positions) : une zone = un seul timer, une seule requête amont, N envois.
 * SSE plutôt que WebSocket : natif dans Express, passe partout (proxies,
 * Render), reconnexion automatique côté navigateur.
 */
const PUSH_EVERY = 5_000;
const HEARTBEAT = 20_000;
const MAX_CLIENTS = 300;
const MAX_PER_IP = 4;

/** zoneKey → { clients: Set<res>, timer, args } */
const zones = new Map();
const perIp = new Map();
let total = 0;

export function zoneKey(lat, lon, dist) {
  const gLat = Math.round(lat * 4) / 4;
  const gLon = Math.round(lon * 4) / 4;
  const gDist = Math.min(250, Math.max(25, Math.ceil(dist / 25) * 25));
  return { key: `${gLat},${gLon},${gDist}`, gLat, gLon, gDist };
}

function send(res, event, data) {
  try { res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`); } catch { /* client parti */ }
}

/**
 * @param {import('express').Request} req
 * @param {import('express').Response} res
 * @param {(lat:number, lon:number, dist:number) => Promise<object>} getLiveAircraft
 */
export function handleStream(req, res, getLiveAircraft) {
  const lat = Number.parseFloat(req.query.lat);
  const lon = Number.parseFloat(req.query.lon);
  const dist = Number.parseFloat(req.query.dist) || 100;
  if (!Number.isFinite(lat) || !Number.isFinite(lon) || Math.abs(lat) > 90 || Math.abs(lon) > 180) {
    return res.status(400).json({ error: 'lat/lon invalides' });
  }
  const ip = req.ip || 'unknown';
  if (total >= MAX_CLIENTS || (perIp.get(ip) || 0) >= MAX_PER_IP) {
    return res.status(429).json({ error: 'Trop de flux ouverts, repasse en mode classique.' });
  }

  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-transform',
    'Connection': 'keep-alive',
    'X-Accel-Buffering': 'no',   // nginx : ne pas tamponner
  });
  res.write(': connecté\n\n');

  const { key, gLat, gLon, gDist } = zoneKey(lat, lon, dist);
  let zone = zones.get(key);
  if (!zone) {
    zone = { clients: new Set(), timer: null };
    zone.tick = async () => {
      try {
        const data = await getLiveAircraft(gLat, gLon, gDist);
        for (const c of zone.clients) send(c, 'aircraft', data);
      } catch (err) {
        for (const c of zone.clients) send(c, 'error', { error: 'Sources de positions injoignables', detail: err.message });
      }
    };
    zone.timer = setInterval(zone.tick, PUSH_EVERY);
    zones.set(key, zone);
  }
  zone.clients.add(res);
  total++;
  perIp.set(ip, (perIp.get(ip) || 0) + 1);
  zone.tick();   // première salve immédiate

  const heartbeat = setInterval(() => { try { res.write(': ping\n\n'); } catch { /* ignore */ } }, HEARTBEAT);

  req.on('close', () => {
    clearInterval(heartbeat);
    zone.clients.delete(res);
    total--;
    const n = (perIp.get(ip) || 1) - 1;
    if (n <= 0) perIp.delete(ip); else perIp.set(ip, n);
    if (!zone.clients.size) { clearInterval(zone.timer); zones.delete(key); }
  });
}

export function streamStats() {
  return { clients: total, zones: zones.size };
}

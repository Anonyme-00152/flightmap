/**
 * Limiteur de débit sortant : garantit un intervalle minimum entre deux
 * appels vers une même API externe.
 *
 * adsb.lol / adsb.fi / airplanes.live tournent sur des dons et des bénévoles :
 * la règle communautaire est ~1 requête/seconde maximum. Au-delà, IP bannie.
 */
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export function createLimiter(minIntervalMs) {
  let queue = Promise.resolve();
  let lastStart = 0;

  return function schedule(fn) {
    const gate = queue.then(async () => {
      const wait = lastStart + minIntervalMs - Date.now();
      if (wait > 0) await sleep(wait);
      lastStart = Date.now();
    });
    // la file continue même si fn() plante
    queue = gate.catch(() => {});
    return gate.then(fn);
  };
}

/** fetch avec timeout + User-Agent explicite (demandé par les APIs open data). */
export async function fetchJson(url, { timeout = 8000, method = 'GET', body, userAgent, headers } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);
  try {
    const res = await fetch(url, {
      method,
      signal: controller.signal,
      headers: {
        'Accept': 'application/json',
        'User-Agent': userAgent || 'flightmap/1.0 (projet perso)',
        ...(body ? { 'Content-Type': 'application/json' } : {}),
        ...(headers || {}),   // clés d'API (RapidAPI…), jamais envoyées au navigateur
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    if (!res.ok) {
      const err = new Error(`HTTP ${res.status} sur ${url}`);
      err.status = res.status;
      throw err;
    }
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

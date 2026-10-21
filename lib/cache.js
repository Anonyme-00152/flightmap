/**
 * Cache mémoire minimaliste avec TTL — optionnellement persistant.
 * C'est LA pièce qui rend le projet gratuit : sans cache, tu exploses
 * les quotas (et tu te fais bloquer par adsb.lol) en quelques minutes.
 *
 * `persist: 'nom'` → chaque entrée de plus d'une minute est aussi écrite
 * dans le store (SQLite) et relue au redémarrage. Les positions (4 s) ne
 * sont jamais persistées : ça n'aurait aucun sens.
 */
import * as store from './store.js';

const PERSIST_MIN_TTL = 60_000;

export class TTLCache {
  /** @param {{ttl?: number, max?: number, name?: string, persist?: string}} opts */
  constructor({ ttl = 60_000, max = 20_000, name = 'cache', persist = null } = {}) {
    this.defaultTtl = ttl;
    this.max = max;
    this.name = name;
    this.persist = persist;
    this.map = new Map();
    this.hits = 0;
    this.misses = 0;
    this.diskHits = 0;
  }

  get(key) {
    const entry = this.map.get(key);
    if (entry) {
      if (entry.expires >= Date.now()) {
        // LRU light : on remet la clé en fin de Map à chaque accès
        this.map.delete(key);
        this.map.set(key, entry);
        this.hits++;
        return entry.value;
      }
      this.map.delete(key);
    }
    // absent en mémoire : peut-être sur disque (après un redémarrage)
    if (this.persist) {
      try {
        const disk = store.kvGet(this.persist, key);
        if (disk) {
          this._put(key, disk.v, disk.expires);
          this.diskHits++;
          this.hits++;
          return disk.v;
        }
      } catch (err) {
        console.warn(`[cache ${this.name}] lecture disque : ${err.message}`);
      }
    }
    this.misses++;
    return undefined;
  }

  _put(key, value, expires) {
    if (this.map.size >= this.max) {
      // on vire la plus ancienne (première clé insérée)
      const oldest = this.map.keys().next().value;
      this.map.delete(oldest);
    }
    this.map.set(key, { value, expires });
  }

  set(key, value, ttl = this.defaultTtl) {
    const expires = Date.now() + ttl;
    this._put(key, value, expires);
    if (this.persist && ttl >= PERSIST_MIN_TTL) {
      try { store.kvSet(this.persist, key, value, expires); } catch (err) {
        console.warn(`[cache ${this.name}] écriture disque : ${err.message}`);
      }
    }
    return value;
  }

  /** Récupère depuis le cache, sinon exécute fn() et met en cache. */
  async wrap(key, ttl, fn) {
    const cached = this.get(key);
    if (cached !== undefined) return cached;
    const value = await fn();
    if (value !== undefined) this.set(key, value, ttl);
    return value;
  }

  stats() {
    const total = this.hits + this.misses;
    return {
      name: this.name,
      entries: this.map.size,
      hits: this.hits,
      misses: this.misses,
      hitRate: total ? `${((this.hits / total) * 100).toFixed(1)}%` : 'n/a',
      ...(this.persist ? { persisted: true, diskHits: this.diskHits } : {}),
    };
  }
}

/**
 * Empêche 2 requêtes identiques simultanées d'aller taper l'API en double.
 * (10 visiteurs qui regardent Paris en même temps = 1 seul appel réseau)
 */
export function createDeduper() {
  const inflight = new Map();
  return function dedupe(key, fn) {
    if (inflight.has(key)) return inflight.get(key);
    const promise = Promise.resolve()
      .then(fn)
      .finally(() => inflight.delete(key));
    inflight.set(key, promise);
    return promise;
  };
}

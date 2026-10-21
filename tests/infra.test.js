import './helpers.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';

const { createQuota } = await import('../lib/quota.js');
const { TTLCache, createDeduper } = await import('../lib/cache.js');
const { createRateLimit } = await import('../lib/ratelimit.js');
const store = await import('../lib/store.js');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

test('quota : plafond mensuel avec marge, plafond journalier lissé', () => {
  const q = createQuota('test-provider', { monthly: 100 });
  // 100/mois → 95 utilisables ; journalier = 2 × ceil(100/30) = 8
  assert.equal(q.stats().month, '0/95');
  assert.equal(q.stats().today, '0/8');
  for (let i = 0; i < 8; i++) { assert.equal(q.canSpend(), true); q.spend(); }
  assert.equal(q.canSpend(), false, 'plafond du jour atteint');
  assert.equal(q.stats().available, false);
});

test('quota : petit plan → jamais moins de 3 par jour', () => {
  const q = createQuota('tiny', { monthly: 10 });
  assert.equal(q.stats().today, '0/3');
  assert.equal(q.stats().month, '0/9');
});

test('cache TTL : expiration, LRU, valeurs nulles (cache négatif)', async () => {
  const c = new TTLCache({ ttl: 30, max: 2, name: 't' });
  c.set('a', 1);
  c.set('n', null);
  assert.equal(c.get('a'), 1);
  assert.equal(c.get('n'), null, 'null est une valeur, pas une absence');
  assert.equal(c.get('zz'), undefined);
  c.set('b', 2);            // max 2 → 'a' (la plus ancienne non rafraîchie) est évincée… sauf qu'on vient de la lire
  c.set('c', 3);
  assert.equal(c.map.size, 2);
  await sleep(40);
  assert.equal(c.get('b'), undefined, 'expiré');
  assert.equal(c.stats().hits >= 2, true);
});

test('cache persistant : relu depuis le store après perte de la mémoire', () => {
  const c1 = new TTLCache({ ttl: 60_000, name: 'p', persist: 'test-ns' });
  c1.set('k', { v: 42 });
  const c2 = new TTLCache({ ttl: 60_000, name: 'p2', persist: 'test-ns' });
  assert.deepEqual(c2.get('k'), { v: 42 });
  assert.equal(c2.stats().diskHits, 1);
  // une entrée courte (positions) n'est jamais écrite sur disque
  c1.set('short', 1, 1000);
  assert.equal(store.kvGet('test-ns', 'short'), undefined);
});

test('dedupe : deux appels simultanés = une seule exécution', async () => {
  const dedupe = createDeduper();
  let calls = 0;
  const fn = async () => { calls++; await sleep(10); return 'ok'; };
  const [a, b] = await Promise.all([dedupe('x', fn), dedupe('x', fn)]);
  assert.equal(a, 'ok'); assert.equal(b, 'ok');
  assert.equal(calls, 1);
  await dedupe('x', fn);
  assert.equal(calls, 2, 'une fois terminé, un nouvel appel repart');
});

test('rate limit : max requêtes par fenêtre, puis 429 avec Retry-After', () => {
  const limit = createRateLimit({ windowMs: 60_000, max: 2 });
  const req = { ip: '1.2.3.4' };
  const mkRes = () => {
    const r = { headers: {}, status: 200, body: null };
    r.set = (k, v) => { r.headers[k] = v; };
    r.status = (s) => { r.code = s; return r; };
    r.json = (b) => { r.body = b; return r; };
    return r;
  };
  let passed = 0;
  for (let i = 0; i < 3; i++) limit(req, mkRes(), () => passed++);
  assert.equal(passed, 2);
  const res = mkRes();
  limit(req, res, () => passed++);
  assert.equal(res.code, 429);
  assert.ok(res.headers['Retry-After']);
  assert.equal(passed, 2);
  // une autre IP n'est pas affectée
  let other = 0;
  limit({ ip: '5.6.7.8' }, mkRes(), () => other++);
  assert.equal(other, 1);
});

test('store : archive des vols, liste par période, purge', () => {
  const now = Date.now();
  const leg = (offsetDays) => ({ start: new Date(now - offsetDays * 86_400_000).toISOString(), end: new Date(now - offsetDays * 86_400_000 + 3600_000).toISOString(), maxAlt: 30000 });
  store.legUpsert('abc123', leg(1));
  store.legUpsert('abc123', leg(10));
  store.legUpsert('abc123', leg(40));
  assert.equal(store.legList('abc123', now - 7 * 86_400_000).length, 1);
  assert.equal(store.legList('abc123', now - 30 * 86_400_000).length, 2);
  store.legPurge(now - 30 * 86_400_000);
  assert.equal(store.legList('abc123', 0).length, 2);
  assert.ok(store.legHexesSince(now - 2 * 86_400_000).includes('abc123'));
});

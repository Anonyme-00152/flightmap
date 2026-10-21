/**
 * Persistance : SQLite via `node:sqlite` (intégré à Node ≥ 22.13, aucune
 * compilation native), avec repli sur un fichier JSON si indisponible.
 *
 * Trois tables :
 *   kv     cache clé/valeur avec expiration  (fiches avion, trajets, horaires)
 *   legs   archive des vols (traces)         (historique au-delà des 24 h d'adsb.lol)
 *   stats  agrégats journaliers              (page /stats)
 *
 * Pourquoi : sur un hébergeur gratuit le processus redémarre souvent. Sans
 * persistance, chaque redémarrage refait les mêmes requêtes… et regaspille
 * le quota des APIs à clé.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const DATA_DIR = process.env.DATA_DIR || path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'data');
const DB_FILE = path.join(DATA_DIR, 'flightmap.db');
const JSON_FILE = path.join(DATA_DIR, 'store.json');

let db = null;
let stmts = null;
let json = null;         // repli : { kv: {ns: {k: {v, e}}}, legs: {hex: {start: data}}, stats: {day: data} }
let jsonTimer = null;

function openSqlite() {
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
  } catch { /* lecture seule : on tentera quand même */ }
  const { DatabaseSync } = require_sqlite();
  const d = new DatabaseSync(DB_FILE);
  d.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA synchronous = NORMAL;
    CREATE TABLE IF NOT EXISTS kv (ns TEXT NOT NULL, k TEXT NOT NULL, v TEXT, expires INTEGER NOT NULL, PRIMARY KEY (ns, k));
    CREATE INDEX IF NOT EXISTS kv_expires ON kv (expires);
    CREATE TABLE IF NOT EXISTS legs (hex TEXT NOT NULL, start INTEGER NOT NULL, end INTEGER NOT NULL, data TEXT NOT NULL, PRIMARY KEY (hex, start));
    CREATE INDEX IF NOT EXISTS legs_start ON legs (start);
    CREATE TABLE IF NOT EXISTS stats (day TEXT PRIMARY KEY, data TEXT NOT NULL);
  `);
  // migration douce : colonne callsign (fiches par numéro de vol, prédiction d'arrivée)
  try { d.exec('ALTER TABLE legs ADD COLUMN callsign TEXT'); } catch { /* déjà présente */ }
  d.exec('CREATE INDEX IF NOT EXISTS legs_callsign ON legs (callsign, start)');
  d.exec('CREATE INDEX IF NOT EXISTS legs_end ON legs (end)');
  // mouvements d'aéroport (décollages / atterrissages observés) — statistiques par aéroport
  d.exec(`CREATE TABLE IF NOT EXISTS movements (
    id INTEGER PRIMARY KEY AUTOINCREMENT, t INTEGER NOT NULL, hex TEXT NOT NULL, callsign TEXT, kind TEXT NOT NULL,
    airport TEXT NOT NULL, runway TEXT, track REAL, other TEXT, type TEXT
  )`);
  d.exec('CREATE INDEX IF NOT EXISTS mov_airport ON movements (airport, t)');
  d.exec('CREATE INDEX IF NOT EXISTS mov_t ON movements (t)');
  stmts = {
    movAdd: d.prepare('INSERT INTO movements (t, hex, callsign, kind, airport, runway, track, other, type) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)'),
    movList: d.prepare('SELECT id, t, hex, callsign, kind, airport, runway, track, other, type FROM movements WHERE airport = ? AND t >= ? ORDER BY t DESC LIMIT ?'),
    movLast: d.prepare('SELECT t FROM movements WHERE hex = ? AND kind = ? AND airport = ? ORDER BY t DESC LIMIT 1'),
    movSetOther: d.prepare('UPDATE movements SET other = ? WHERE id = ?'),
    movPurge: d.prepare('DELETE FROM movements WHERE t < ?'),
    movCount: d.prepare('SELECT COUNT(*) AS n FROM movements'),
    movAirports: d.prepare('SELECT airport, COUNT(*) AS n FROM movements WHERE t >= ? GROUP BY airport ORDER BY n DESC LIMIT ?'),
    kvGet: d.prepare('SELECT v, expires FROM kv WHERE ns = ? AND k = ?'),
    kvSet: d.prepare('INSERT OR REPLACE INTO kv (ns, k, v, expires) VALUES (?, ?, ?, ?)'),
    kvDel: d.prepare('DELETE FROM kv WHERE ns = ? AND k = ?'),
    kvAll: d.prepare('SELECT k, v FROM kv WHERE ns = ? AND expires >= ?'),
    kvPurge: d.prepare('DELETE FROM kv WHERE expires < ?'),
    kvCount: d.prepare('SELECT COUNT(*) AS n FROM kv'),
    legUpsert: d.prepare('INSERT OR REPLACE INTO legs (hex, start, end, data, callsign) VALUES (?, ?, ?, ?, ?)'),
    legList: d.prepare('SELECT data FROM legs WHERE hex = ? AND start >= ? ORDER BY start ASC'),
    legByCallsign: d.prepare('SELECT hex, data FROM legs WHERE callsign = ? AND start >= ? ORDER BY start ASC'),
    legOverlap: d.prepare('SELECT hex, data FROM legs WHERE end >= ? AND start <= ? ORDER BY start ASC LIMIT ?'),
    legPurge: d.prepare('DELETE FROM legs WHERE start < ?'),
    legCount: d.prepare('SELECT COUNT(*) AS n FROM legs'),
    legHexes: d.prepare('SELECT DISTINCT hex FROM legs WHERE end >= ?'),
    statGet: d.prepare('SELECT data FROM stats WHERE day = ?'),
    statSet: d.prepare('INSERT OR REPLACE INTO stats (day, data) VALUES (?, ?)'),
    statDays: d.prepare('SELECT day, data FROM stats ORDER BY day DESC LIMIT ?'),
  };
  return d;
}

// Import synchrone et « essayable » de node:sqlite (un import statique
// ferait échouer tout le module sur un Node trop ancien).
function require_sqlite() {
  return createRequire(import.meta.url)('node:sqlite');
}

function loadJson() {
  try { const j = JSON.parse(fs.readFileSync(JSON_FILE, 'utf8')); j.movements ||= []; return j; } catch { return { kv: {}, legs: {}, stats: {}, movements: [] }; }
}

function saveJson() {
  clearTimeout(jsonTimer);
  jsonTimer = setTimeout(() => {
    try {
      fs.mkdirSync(DATA_DIR, { recursive: true });
      fs.writeFileSync(JSON_FILE, JSON.stringify(json));
    } catch (err) {
      console.warn(`[store] écriture JSON impossible : ${err.message}`);
    }
  }, 2000);
}

try {
  db = openSqlite();
} catch (err) {
  console.warn(`[store] node:sqlite indisponible (${err.message}) → repli fichier JSON`);
  json = loadJson();
}

export const backend = db ? 'sqlite' : 'json';

// ── KV ──────────────────────────────────────────────────────────────────────
/** @returns {{v: any, expires: number} | undefined} */
export function kvGet(ns, k) {
  if (db) {
    const row = stmts.kvGet.get(ns, k);
    if (!row) return undefined;
    if (row.expires < Date.now()) return undefined;
    return { v: JSON.parse(row.v), expires: Number(row.expires) };
  }
  const e = json.kv[ns]?.[k];
  if (!e || e.e < Date.now()) return undefined;
  return { v: e.v, expires: e.e };
}

export function kvSet(ns, k, v, expires) {
  if (db) { stmts.kvSet.run(ns, k, JSON.stringify(v ?? null), expires); return; }
  (json.kv[ns] ||= {})[k] = { v: v ?? null, e: expires };
  saveJson();
}

export function kvDel(ns, k) {
  if (db) { stmts.kvDel.run(ns, k); return; }
  if (json.kv[ns]) { delete json.kv[ns][k]; saveJson(); }
}

/** Toutes les entrées valides d'un espace de noms : [{ k, v }]. */
export function kvAll(ns) {
  const now = Date.now();
  if (db) return stmts.kvAll.all(ns, now).map((r) => ({ k: r.k, v: JSON.parse(r.v) }));
  return Object.entries(json.kv[ns] || {}).filter(([, e]) => e.e >= now).map(([k, e]) => ({ k, v: e.v }));
}

export function kvPurge() {
  const now = Date.now();
  if (db) { stmts.kvPurge.run(now); return; }
  for (const ns of Object.keys(json.kv)) {
    for (const [k, e] of Object.entries(json.kv[ns])) if (e.e < now) delete json.kv[ns][k];
  }
  saveJson();
}

// ── Archive des vols ────────────────────────────────────────────────────────
export function legUpsert(hex, leg) {
  const start = new Date(leg.start).getTime();
  const end = new Date(leg.end).getTime();
  const callsign = leg.callsign ? String(leg.callsign).toUpperCase() : null;
  if (db) { stmts.legUpsert.run(hex, start, end, JSON.stringify(leg), callsign); return; }
  (json.legs[hex] ||= {})[start] = leg;
  saveJson();
}

export function legList(hex, sinceMs) {
  if (db) return stmts.legList.all(hex, sinceMs).map((r) => JSON.parse(r.data));
  return Object.entries(json.legs[hex] || {})
    .filter(([s]) => Number(s) >= sinceMs)
    .sort(([a], [b]) => Number(a) - Number(b))
    .map(([, leg]) => leg);
}

/** Vols d'un callsign (tous appareils confondus) : [{ hex, ...leg }]. */
export function legsByCallsign(callsign, sinceMs) {
  const cs = String(callsign || '').toUpperCase();
  if (db) return stmts.legByCallsign.all(cs, sinceMs).map((r) => ({ hex: r.hex, ...JSON.parse(r.data) }));
  const out = [];
  for (const [hex, legs] of Object.entries(json.legs)) {
    for (const [s, leg] of Object.entries(legs)) if (Number(s) >= sinceMs && (leg.callsign || '').toUpperCase() === cs) out.push({ hex, ...leg });
  }
  return out.sort((a, b) => new Date(a.start) - new Date(b.start));
}

/** Vols chevauchant une période (rejouer une journée) : [{ hex, ...leg }]. */
export function legsOverlapping(startMs, endMs, limit = 2000) {
  if (db) return stmts.legOverlap.all(startMs, endMs, limit).map((r) => ({ hex: r.hex, ...JSON.parse(r.data) }));
  const out = [];
  for (const [hex, legs] of Object.entries(json.legs)) {
    for (const [s, leg] of Object.entries(legs)) {
      if (new Date(leg.end).getTime() >= startMs && Number(s) <= endMs) out.push({ hex, ...leg });
    }
  }
  return out.sort((a, b) => new Date(a.start) - new Date(b.start)).slice(0, limit);
}

export function legPurge(olderThanMs) {
  if (db) { stmts.legPurge.run(olderThanMs); return; }
  for (const hex of Object.keys(json.legs)) {
    for (const s of Object.keys(json.legs[hex])) if (Number(s) < olderThanMs) delete json.legs[hex][s];
    if (!Object.keys(json.legs[hex]).length) delete json.legs[hex];
  }
  saveJson();
}

/** Avions ayant un vol archivé récemment (pour le job de rafraîchissement). */
export function legHexesSince(sinceMs) {
  if (db) return stmts.legHexes.all(sinceMs).map((r) => r.hex);
  return Object.keys(json.legs).filter((hex) =>
    Object.values(json.legs[hex]).some((leg) => new Date(leg.end).getTime() >= sinceMs));
}

// ── Mouvements d'aéroport ───────────────────────────────────────────────────
export function movementAdd(m) {
  const row = { t: m.t, hex: m.hex, callsign: m.callsign || null, kind: m.kind, airport: m.airport, runway: m.runway || null, track: m.track ?? null, other: m.other || null, type: m.type || null };
  if (db) { const r = stmts.movAdd.run(row.t, row.hex, row.callsign, row.kind, row.airport, row.runway, row.track, row.other, row.type); return Number(r.lastInsertRowid); }
  row.id = (json.movements.at(-1)?.id || 0) + 1;
  json.movements.push(row);
  if (json.movements.length > 50_000) json.movements.splice(0, json.movements.length - 50_000);
  saveJson();
  return row.id;
}

export function movementsForAirport(icao, sinceMs, limit = 5000) {
  if (db) return stmts.movList.all(icao, sinceMs, limit);
  return json.movements.filter((m) => m.airport === icao && m.t >= sinceMs).sort((a, b) => b.t - a.t).slice(0, limit);
}

/** Dernier mouvement du même type pour un avion à un aéroport (dédoublonnage). */
export function movementLast(hex, kind, icao) {
  if (db) return stmts.movLast.get(hex, kind, icao)?.t ?? null;
  const m = json.movements.filter((x) => x.hex === hex && x.kind === kind && x.airport === icao).sort((a, b) => b.t - a.t)[0];
  return m ? m.t : null;
}

export function movementSetOther(id, other) {
  if (db) { stmts.movSetOther.run(other, id); return; }
  const m = json.movements.find((x) => x.id === id);
  if (m) { m.other = other; saveJson(); }
}

export function movementsPurge(olderThanMs) {
  if (db) { stmts.movPurge.run(olderThanMs); return; }
  json.movements = json.movements.filter((m) => m.t >= olderThanMs);
  saveJson();
}

export function movementsCount() {
  try { return db ? stmts.movCount.get().n : json.movements.length; } catch { return 0; }
}

/** Aéroports les plus actifs (mouvements observés) sur une période. */
export function busiestAirports(sinceMs, limit = 20) {
  if (db) return stmts.movAirports.all(sinceMs, limit).map((r) => ({ airport: r.airport, count: r.n }));
  const c = new Map();
  for (const m of json.movements) if (m.t >= sinceMs) c.set(m.airport, (c.get(m.airport) || 0) + 1);
  return [...c.entries()].sort((a, b) => b[1] - a[1]).slice(0, limit).map(([airport, count]) => ({ airport, count }));
}

// ── Stats journalières ──────────────────────────────────────────────────────
export function statGet(day) {
  if (db) { const r = stmts.statGet.get(day); return r ? JSON.parse(r.data) : null; }
  return json.stats[day] || null;
}

export function statSet(day, data) {
  if (db) { stmts.statSet.run(day, JSON.stringify(data)); return; }
  json.stats[day] = data;
  saveJson();
}

export function statDays(limit = 30) {
  if (db) return stmts.statDays.all(limit).map((r) => ({ day: r.day, ...JSON.parse(r.data) }));
  return Object.entries(json.stats).sort(([a], [b]) => (a < b ? 1 : -1)).slice(0, limit)
    .map(([day, data]) => ({ day, ...data }));
}

export function status() {
  let kv = 0, legs = 0;
  try {
    if (db) { kv = stmts.kvCount.get().n; legs = stmts.legCount.get().n; }
    else { kv = Object.values(json.kv).reduce((n, o) => n + Object.keys(o).length, 0); legs = Object.values(json.legs).reduce((n, o) => n + Object.keys(o).length, 0); }
  } catch { /* stats indisponibles */ }
  return { backend, file: db ? DB_FILE : JSON_FILE, kvEntries: kv, legs };
}

// Ménage : entrées expirées toutes les heures, vols de plus de 30 jours
setInterval(() => {
  try { kvPurge(); legPurge(Date.now() - 30 * 24 * 3600_000); movementsPurge(Date.now() - 90 * 24 * 3600_000); } catch (err) { console.warn(`[store] purge : ${err.message}`); }
}, 3600_000).unref();

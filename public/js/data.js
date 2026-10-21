/**
 * Alimentation en positions :
 *   1. flux SSE (/api/stream) : le serveur pousse toutes les 5 s
 *   2. repli poll (/api/aircraft) si SSE indisponible ou en erreur
 *   3. mode « suivre » : /api/aircraft/hex/:hex pour l'avion sélectionné,
 *      même hors de la zone visible
 *   4. recherche mondiale (/api/search)
 * Zéro requête quand l'onglet est en arrière-plan.
 */
import { CONFIG, planes, state, emit, on, setText, $, toast } from './state.js';
import { map } from './map.js';
import { visibleCount } from './render.js';

let es = null;              // EventSource courant
let sseFailed = false;      // on est passé en poll
let pollTimer = null;
let followTimer = null;
let zoneKey = '';

function viewRadiusNm() {
  const b = map.getBounds();
  const meters = map.distance(b.getCenter(), b.getNorthEast());
  return Math.min(250, Math.max(25, Math.ceil(meters / 1852)));
}

function zoneParams() {
  const c = map.getCenter();
  return `lat=${c.lat.toFixed(3)}&lon=${c.lng.toFixed(3)}&dist=${viewRadiusNm()}`;
}

/** Intègre un lot d'avions dans l'état (positions lissées conservées). */
export function ingest(list, now = Date.now()) {
  for (const a of list) {
    if (!a?.hex) continue;
    const prev = planes.get(a.hex);
    // objet neuf : un champ ADS-B absent de la nouvelle réponse ne doit pas rester affiché
    planes.set(a.hex, { ...a, t: now, rLat: prev ? prev.rLat : a.lat, rLon: prev ? prev.rLon : a.lon, _x: prev?._x, _y: prev?._y });
  }
}

function onData(data) {
  ingest(data.aircraft);
  state.lastUpdate = Date.now();
  state.source = data.source;
  const el = $('stat-source');   // absent dans la version embarquable
  if (el) { el.textContent = data.source + (es ? ' · flux' : ''); el.style.color = ''; }
  emit('aircraft', data);
  updateCount();
}

function onError(message) {
  const el = $('stat-source');
  if (!el) return;
  el.textContent = message;
  el.style.color = '#ff8098';
}

export function updateCount() {
  const total = planes.size;
  setText('stat-count', visibleCount < total ? `${visibleCount} / ${total}` : String(total));
}

// ── SSE ─────────────────────────────────────────────────────────────────────
function openStream() {
  closeStream();
  if (sseFailed || !('EventSource' in window)) return startPoll();
  zoneKey = zoneParams();
  es = new EventSource(`/api/stream?${zoneKey}`);
  let gotData = false;
  es.addEventListener('aircraft', (e) => { gotData = true; onData(JSON.parse(e.data)); });
  es.addEventListener('error', (e) => {
    if (e.data) { try { onError(JSON.parse(e.data).error); } catch { /* ignore */ } return; }
    // erreur de transport : si jamais rien reçu, on abandonne SSE pour cette session
    if (!gotData) { sseFailed = true; closeStream(); startPoll(); }
  });
}

function closeStream() {
  if (es) { es.close(); es = null; }
}

// ── Poll (repli) ────────────────────────────────────────────────────────────
async function poll() {
  if (document.hidden) return;
  try {
    const res = await fetch(`/api/aircraft?${zoneParams()}`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    onData(await res.json());
  } catch (err) {
    onError('source injoignable');
    console.warn('refresh:', err.message);
  }
}

function startPoll() {
  clearInterval(pollTimer);
  pollTimer = setInterval(poll, CONFIG.refreshMs);
  poll();
}

function stopPoll() {
  clearInterval(pollTimer);
  pollTimer = null;
}

// ── Cycle de vie ────────────────────────────────────────────────────────────
export function start() {
  openStream();
  let moveTimer;
  map.on('moveend', () => {
    clearTimeout(moveTimer);
    moveTimer = setTimeout(() => {
      // la zone a changé → on rouvre le flux sur la nouvelle zone (le backend a un cache, c'est gratuit)
      if (es && zoneParams() !== zoneKey) openStream();
      else if (!es) poll();
    }, 700);
  });
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) { closeStream(); stopPoll(); stopFollowLoop(); }
    else { openStream(); if (state.followHex) startFollowLoop(); }
  });
  setInterval(() => {
    setText('stat-age', state.lastUpdate ? `il y a ${Math.round((Date.now() - state.lastUpdate) / 1000)} s` : '—');
  }, 1000);
}

// ── Mode « suivre » ─────────────────────────────────────────────────────────
async function followTick() {
  const hex = state.followHex;
  if (!hex || document.hidden) return;
  try {
    const res = await fetch(`/api/aircraft/hex/${hex}`);
    if (!res.ok) return;
    const data = await res.json();
    if (state.followHex !== hex) return;
    if (data.aircraft) {
      ingest([data.aircraft]);
      const p = planes.get(hex);
      map.panTo([p.rLat, p.rLon], { animate: true, duration: 0.8 });
    } else {
      toast('Signal perdu : plus aucun récepteur ne capte cet avion.');
    }
  } catch { /* réessai au prochain tick */ }
}

function startFollowLoop() {
  clearInterval(followTimer);
  followTimer = setInterval(followTick, CONFIG.refreshMs);
  followTick();
}

function stopFollowLoop() {
  clearInterval(followTimer);
  followTimer = null;
}

export function setFollow(hex) {
  state.followHex = hex;
  if (hex) startFollowLoop(); else stopFollowLoop();
  emit('follow', hex);
}

// ── Recherche mondiale ──────────────────────────────────────────────────────
/** @returns {Promise<string|null>} hex trouvé (déjà injecté dans `planes`) */
export async function searchGlobal(query) {
  const res = await fetch(`/api/search?q=${encodeURIComponent(query)}`);
  if (res.status === 429) { toast('Trop de recherches, attends une minute.'); return null; }
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const data = await res.json();
  if (!data.aircraft.length) return null;
  ingest(data.aircraft);
  return data.aircraft[0].hex;
}

on('filters', updateCount);

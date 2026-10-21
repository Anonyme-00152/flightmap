/**
 * Filtres de la carte + vues « compagnie / type » + alertes navigateur.
 * La logique (passesFilters) est pure : le rendu canvas l'appelle pour
 * chaque avion, le panneau l'utilise pour compter.
 */
import { planes, state, savePrefs, emit, on, $, toast } from './state.js';
import { inGroup } from './military.js';

const EMERGENCY_SQUAWKS = new Set(['7500', '7600', '7700']);

export const isEmergency = (p) => Boolean(p.emergency) || EMERGENCY_SQUAWKS.has(p.squawk);

/** Vrai si l'avion doit être affiché avec les filtres courants. */
export function passesFilters(p, f = state.filters) {
  if (f.military && !p.military) return false;
  if (f.emergency && !isEmergency(p)) return false;
  if (f.notable && !p.notable) return false;
  if (f.hideGround && p.onGround) return false;
  if (!p.onGround && p.alt != null && (p.alt < f.altMin || p.alt > f.altMax)) return false;
  if (f.airline && !(p.callsign || '').startsWith(f.airline)) return false;
  if (f.type && (p.type || '').toUpperCase() !== f.type) return false;
  if (f.osint && !inGroup(p, f.osint)) return false;   // vue militaire / OSINT
  if (f.text) {
    const t = f.text;
    if (!((p.callsign || '').includes(t) || (p.reg || '').toUpperCase().includes(t) || p.hex.toUpperCase().includes(t)
      || (p.desc || '').toUpperCase().includes(t) || (p.type || '').toUpperCase().includes(t))) return false;
  }
  return true;
}

export function activeFilterCount(f = state.filters) {
  let n = 0;
  if (f.military) n++; if (f.emergency) n++; if (f.notable) n++; if (f.hideGround) n++;
  if (f.altMin > 0 || f.altMax < 60000) n++;
  if (f.airline) n++; if (f.type) n++; if (f.text) n++; if (f.osint) n++;
  return n;
}

// ── UI ──────────────────────────────────────────────────────────────────────
const panel = $('filters');
const btn = $('filters-btn');

function syncInputs() {
  const f = state.filters;
  $('f-military').checked = f.military;
  $('f-emergency').checked = f.emergency;
  $('f-notable').checked = f.notable;
  $('f-ground').checked = f.hideGround;
  $('f-altmin').value = f.altMin;
  $('f-altmax').value = f.altMax;
  $('f-airline').value = f.airline;
  $('f-type').value = f.type;
  $('f-text').value = f.text;
  $('a-emergency').checked = state.alerts.emergency;
  $('a-notable').checked = state.alerts.notable;
  $('a-military').checked = state.alerts.military;
  updateAltLabel();
  updateBadge();
}

function updateAltLabel() {
  const f = state.filters;
  $('f-alt-label').textContent = `${f.altMin.toLocaleString('fr-FR')} – ${f.altMax >= 60000 ? '60 000+' : f.altMax.toLocaleString('fr-FR')} ft`;
}

function updateBadge() {
  const n = activeFilterCount();
  $('filters-count').textContent = n ? String(n) : '';
  btn.classList.toggle('is-active', n > 0);
}

function readInputs() {
  const f = state.filters;
  f.military = $('f-military').checked;
  f.emergency = $('f-emergency').checked;
  f.notable = $('f-notable').checked;
  f.hideGround = $('f-ground').checked;
  f.altMin = Math.min(Number($('f-altmin').value) || 0, Number($('f-altmax').value) || 60000);
  f.altMax = Math.max(Number($('f-altmax').value) || 60000, f.altMin);
  f.airline = $('f-airline').value.trim().toUpperCase().slice(0, 3);
  f.type = $('f-type').value.trim().toUpperCase();
  f.text = $('f-text').value.trim().toUpperCase();
  state.alerts.emergency = $('a-emergency').checked;
  state.alerts.notable = $('a-notable').checked;
  state.alerts.military = $('a-military').checked;
  updateAltLabel();
  updateBadge();
  savePrefs();
  emit('filters');
}

export function initFilters() {
  syncInputs();
  panel.addEventListener('input', readInputs);
  panel.addEventListener('change', readInputs);
  btn.addEventListener('click', () => { panel.hidden = !panel.hidden; if (!panel.hidden) renderChips(); });
  $('filters-close').addEventListener('click', () => { panel.hidden = true; });
  $('f-reset').addEventListener('click', () => {
    Object.assign(state.filters, { military: false, emergency: false, notable: false, hideGround: false, altMin: 0, altMax: 60000, airline: '', type: '', text: '', osint: '' });
    syncInputs(); savePrefs(); emit('filters');
    $('f-osint')?.querySelectorAll('.chip').forEach((c) => c.classList.remove('is-on'));
  });
  // les alertes navigateur demandent une permission
  for (const id of ['a-emergency', 'a-notable', 'a-military']) {
    $(id).addEventListener('change', async (e) => {
      if (e.target.checked && 'Notification' in window && Notification.permission === 'default') {
        const perm = await Notification.requestPermission();
        if (perm !== 'granted') toast('Notifications refusées : les alertes s\'afficheront seulement dans la page.');
      }
    });
  }
  on('aircraft', () => { if (!panel.hidden) renderChips(); checkAlerts(); });
}

/** Vues rapides : les compagnies et types les plus présents à l'écran. */
function renderChips() {
  const airlines = new Map(), types = new Map();
  for (const p of planes.values()) {
    if (/^[A-Z]{3}\d/.test(p.callsign || '')) { const k = p.callsign.slice(0, 3); airlines.set(k, (airlines.get(k) || 0) + 1); }
    if (p.type) types.set(p.type, (types.get(p.type) || 0) + 1);
  }
  const top = (m) => [...m.entries()].sort((a, b) => b[1] - a[1]).slice(0, 8);
  const fill = (id, entries, field) => {
    const box = $(id);
    box.textContent = '';
    for (const [k, n] of entries) {
      const chip = document.createElement('button');
      chip.type = 'button';
      chip.className = `chip${state.filters[field] === k ? ' is-on' : ''}`;
      chip.textContent = `${k} · ${n}`;
      chip.addEventListener('click', () => {
        state.filters[field] = state.filters[field] === k ? '' : k;
        syncInputs(); savePrefs(); emit('filters'); renderChips();
      });
      box.appendChild(chip);
    }
    box.hidden = !entries.length;
  };
  fill('f-chips-airline', top(airlines), 'airline');
  fill('f-chips-type', top(types), 'type');
}

// ── Alertes ─────────────────────────────────────────────────────────────────
const alerted = new Map();   // hex → dernier signalement
const ALERT_COOLDOWN = 15 * 60_000;

function checkAlerts() {
  const a = state.alerts;
  if (!a.emergency && !a.notable && !a.military) return;
  const now = Date.now();
  for (const p of planes.values()) {
    let reason = null;
    if (a.emergency && isEmergency(p)) reason = `Urgence ${p.squawk || p.emergency}`;
    else if (a.notable && p.notable) reason = p.notable;
    else if (a.military && p.military) reason = 'Militaire';
    if (!reason) continue;
    if (now - (alerted.get(p.hex) || 0) < ALERT_COOLDOWN) continue;
    alerted.set(p.hex, now);
    notify(`${reason} — ${p.callsign || p.reg || p.hex.toUpperCase()}`, p);
  }
  if (alerted.size > 2000) for (const [h, t] of alerted) if (now - t > ALERT_COOLDOWN) alerted.delete(h);
}

function notify(text, p) {
  toast(`🔔 ${text}`, { duration: 7000, kind: 'alert' });
  if ('Notification' in window && Notification.permission === 'granted' && document.hidden) {
    try {
      const n = new Notification('FlightMap', { body: text, tag: p.hex, icon: 'icons/icon-192.png' });
      n.onclick = () => { window.focus(); emit('select-request', p.hex); n.close(); };
    } catch { /* certains navigateurs exigent un service worker */ }
  }
}

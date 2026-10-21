/**
 * Accessibilité :
 *   - navigation clavier entre les avions visibles (← → ou J/K), Entrée pour ouvrir
 *   - liste hors écran des avions visibles pour les lecteurs d'écran (mise à jour 5 s)
 *   - focus déplacé sur le panneau à l'ouverture, rendu au bouton précédent à la fermeture
 */
import { planes, state, on, emit, $ } from './state.js';
import { map } from './map.js';
import { passesFilters } from './filters.js';

let cursor = -1;
let lastFocus = null;

function visibleSorted() {
  const c = map.getCenter();
  return [...planes.values()]
    .filter((p) => p._x != null && passesFilters(p))
    .map((p) => ({ p, d: Math.hypot(p.rLat - c.lat, (p.rLon - c.lng) * Math.cos((c.lat * Math.PI) / 180)) }))
    .sort((a, b) => a.d - b.d)
    .map((x) => x.p);
}

function updateLiveList() {
  const ul = $('a11y-list');
  if (!ul) return;
  const list = visibleSorted().slice(0, 40);
  ul.textContent = '';
  for (const p of list) {
    const li = document.createElement('li');
    const b = document.createElement('button');
    b.type = 'button';
    b.textContent = `${p.callsign || p.reg || p.hex.toUpperCase()}${p.desc || p.type ? `, ${p.desc || p.type}` : ''}${p.alt != null ? `, ${Math.round(p.alt)} pieds` : ''}${p.speed != null ? `, ${Math.round(p.speed)} nœuds` : ''}`;
    b.addEventListener('click', () => emit('select-request', p.hex));
    li.appendChild(b);
    ul.appendChild(li);
  }
  $('a11y-count').textContent = `${list.length} avions visibles`;
}

export function initA11y() {
  document.addEventListener('keydown', (e) => {
    if (e.target.matches('input, textarea, select') || e.altKey || e.ctrlKey || e.metaKey) return;
    const list = visibleSorted();
    if (!list.length) return;
    if (e.key === 'ArrowRight' || e.key === 'j' || e.key === 'ArrowLeft' || e.key === 'k') {
      e.preventDefault();
      const idx = list.findIndex((p) => p.hex === state.selectedHex);
      cursor = idx >= 0 ? idx : cursor;
      cursor = (e.key === 'ArrowRight' || e.key === 'j') ? (cursor + 1) % list.length : (cursor - 1 + list.length) % list.length;
      emit('select-request', list[cursor].hex);
    }
  });
  on('select', (hex) => {
    const panel = $('panel');
    if (hex) { lastFocus = document.activeElement; panel.setAttribute('aria-label', `Détails ${planes.get(hex)?.callsign || hex}`); setTimeout(() => $('panel-close')?.focus({ preventScroll: true }), 50); }
    else if (lastFocus && document.body.contains(lastFocus)) { lastFocus.focus({ preventScroll: true }); lastFocus = null; }
  });
  setInterval(updateLiveList, 5000);
  updateLiveList();
}

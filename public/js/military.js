/**
 * Vue militaire / OSINT : groupes déduits des catégories et tags de plane-alert-db
 * (ravitailleurs, AWACS/surveillance, chasseurs, transport, hélicoptères,
 * gouvernemental/VIP, drones) + orbites dessinées à partir de l'historique
 * local du serveur (0 appel externe).
 */
import { planes, state, on, emit, savePrefs, $ } from './state.js';
import { map } from './map.js';
import { t } from './i18n.js';

export const OSINT_GROUPS = {
  all: { label: 'Tous militaires', test: (p) => p.military || MIL_CATS.has(p.notableCat) },
  tanker: { label: 'Ravitailleurs', tags: ['Air2Air'] },
  isr: { label: 'Surveillance / AWACS', tags: ['Eye In The Sky', 'Surveillance', 'Aerial Survey', 'Maritime Patrol', 'One Ping Only Vasily', 'Signals Intelligence', 'Electronic Warfare'] },
  fighter: { label: 'Chasseurs', tags: ['Jet Fighter', 'Aggressor Squadron', 'Warthog', 'Danger Zone', 'Delta Wing', 'I Feel The Need....'] },
  transport: { label: 'Transport militaire', tags: ['Tactical Airlift', 'Military Transport', 'Absolute Unit'], cats: ['Toy Soldiers'] },
  helo: { label: 'Hélicoptères', tags: ['Chopper', 'Get To The Choppa', 'Choppa', 'Air Cavalry', 'Tiltrotor'] },
  gov: { label: 'Gouvernemental / VIP', cats: ['Governments', 'Head of State', 'Dictator Alert', 'Royal Aircraft', 'Oligarch'], tags: ['VIP Transport'] },
  uav: { label: 'Drones', cats: ['UAV'], tags: ['UAV'] },
};
const MIL_CATS = new Set(['USAF', 'Other Air Forces', 'Other Navies', 'United States Navy', 'United States Marine Corps', 'RAF', 'GAF', 'Royal Navy Fleet Air Arm', 'Army Air Corps', 'Special Forces', 'Toy Soldiers', 'Gunship', 'Zoomies']);

export function inGroup(p, key) {
  const g = OSINT_GROUPS[key];
  if (!g) return true;
  if (g.test) return g.test(p);
  const tags = p.notableTags || [];
  if (g.tags?.some((tg) => tags.includes(tg))) return true;
  if (g.cats?.includes(p.notableCat)) return true;
  return false;
}

let orbitLayer = null;
let orbitTimer = null;

async function drawOrbits() {
  if (!state.filters.orbits || document.hidden) return;
  const hexes = [...planes.values()].filter((p) => inGroup(p, state.filters.osint || 'all')).map((p) => p.hex).slice(0, 100);
  if (!hexes.length) { if (orbitLayer) { map.removeLayer(orbitLayer); orbitLayer = null; } return; }
  try {
    const res = await fetch(`/api/local-trails?hexes=${hexes.join(',')}`);
    if (!res.ok) return;
    const { trails } = await res.json();
    const lines = [];
    for (const [hex, pts] of Object.entries(trails)) {
      const p = planes.get(hex);
      lines.push(L.polyline(pts.map((q) => [q[1], q[2]]), { color: '#a8d98a', weight: 1.5, opacity: .7, dashArray: '3 4' })
        .bindTooltip(`${p?.callsign || p?.reg || hex.toUpperCase()} · ${Math.round((pts[pts.length - 1][0] - pts[0][0]) / 60_000)} min`, { sticky: true }));
    }
    if (orbitLayer) map.removeLayer(orbitLayer);
    orbitLayer = L.layerGroup(lines).addTo(map);
  } catch { /* prochaine passe */ }
}

function renderChips() {
  const box = $('f-osint');
  box.textContent = '';
  const counts = {};
  for (const p of planes.values()) for (const k of Object.keys(OSINT_GROUPS)) if (inGroup(p, k)) counts[k] = (counts[k] || 0) + 1;
  for (const [k, g] of Object.entries(OSINT_GROUPS)) {
    const chip = document.createElement('button');
    chip.type = 'button';
    chip.className = `chip${state.filters.osint === k ? ' is-on' : ''}`;
    chip.textContent = `${t(g.label)} · ${counts[k] || 0}`;
    chip.addEventListener('click', () => {
      state.filters.osint = state.filters.osint === k ? '' : k;
      savePrefs(); emit('filters'); renderChips();
      if (state.filters.osint) drawOrbits();
    });
    box.appendChild(chip);
  }
}

export function initMilitary() {
  if (state.filters.osint === undefined) state.filters.osint = '';
  if (state.filters.orbits === undefined) state.filters.orbits = false;
  const orbits = $('f-orbits');
  orbits.checked = Boolean(state.filters.orbits);
  orbits.addEventListener('change', () => {
    state.filters.orbits = orbits.checked;
    savePrefs();
    if (orbits.checked) drawOrbits();
    else if (orbitLayer) { map.removeLayer(orbitLayer); orbitLayer = null; }
  });
  renderChips();
  on('aircraft', () => { if (!$('filters').hidden) renderChips(); });
  clearInterval(orbitTimer);
  orbitTimer = setInterval(drawOrbits, 20_000);
}

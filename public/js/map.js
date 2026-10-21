/**
 * Carte Leaflet + fond de carte + thème clair / sombre.
 * Tuiles OSM (gratuites, sans clé) ; le thème sombre est un filtre CSS.
 */
import { CONFIG, state, savePrefs, emit } from './state.js';

export const map = L.map('map', {
  center: [CONFIG.start.lat, CONFIG.start.lon],
  zoom: CONFIG.start.zoom,
  zoomControl: true,
  zoomAnimation: false,   // le calque canvas reste parfaitement aligné
  worldCopyJump: true,
  minZoom: 3,
});

const tiles = L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
  maxZoom: 18,
  className: 'tiles',
}).addTo(map);

export function applyTheme(theme) {
  state.theme = theme;
  document.documentElement.dataset.theme = theme;
  tiles.getContainer()?.classList.toggle('tile-dark', theme === 'dark');
  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta) meta.content = theme === 'dark' ? '#0b0f14' : '#f4f6f9';
  savePrefs();
  emit('theme', theme);
}

export function toggleTheme() {
  applyTheme(state.theme === 'dark' ? 'light' : 'dark');
}

// Le conteneur des tuiles n'existe qu'après le premier rendu
map.whenReady(() => applyTheme(state.theme));

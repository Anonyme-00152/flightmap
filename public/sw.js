/**
 * Service worker : l'INTERFACE marche hors ligne (HTML, CSS, JS, Leaflet,
 * icônes). Les données (/api/*) et les tuiles ne sont jamais mises en cache :
 * une carte de vols périmée serait pire qu'une erreur.
 *
 * Change VERSION à chaque déploiement pour invalider l'ancien cache.
 */
const VERSION = 'flightmap-v9';
const SHELL = [
  './', 'index.html', 'stats.html', 'replay.html', 'embed.html', 'style.css', 'app.js',
  'js/state.js', 'js/map.js', 'js/render.js', 'js/data.js', 'js/panel.js', 'js/filters.js', 'js/url.js', 'js/pwa.js',
  'js/i18n.js', 'js/airports.js', 'js/mezone.js', 'js/account.js', 'js/military.js', 'js/a11y.js', 'js/tour.js',
  'manifest.webmanifest', 'icons/icon-192.png', 'icons/icon-512.png',
  '/vendor/leaflet/leaflet.js', '/vendor/leaflet/leaflet.css',
];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(VERSION).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== VERSION).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET') return;
  // données live et tuiles : réseau uniquement
  if (url.pathname.startsWith('/api/') || url.origin !== location.origin) return;

  // interface : réseau d'abord (pour avoir les mises à jour), cache en secours
  e.respondWith(
    fetch(e.request).then((res) => {
      if (res.ok) caches.open(VERSION).then((c) => c.put(e.request, res.clone()));
      return res;
    }).catch(() => caches.match(e.request, { ignoreSearch: true }))
  );
});

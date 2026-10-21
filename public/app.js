/* ════════════════════════════════════════════════════════════════════════════
   FlightMap — front (point d'entrée)
   ─────────────────
   Principe :
   1. le backend pousse (SSE) ou on lui demande (poll) les avions de la zone
      visible toutes les ~5 s ;
   2. entre deux rafraîchissements, on fait bouger les avions nous-mêmes
      (cap + vitesse = "dead reckoning") pour que ce soit fluide ;
   3. quand on clique sur un avion — et SEULEMENT à ce moment-là — on demande
      les infos détaillées. C'est ce qui garde le projet gratuit.

   Modules : js/state.js (état, bus) · js/map.js (carte, thème) · js/i18n.js (FR/EN)
             js/render.js (canvas) · js/data.js (SSE/poll, suivi, recherche)
             js/panel.js (détails) · js/filters.js + js/military.js (filtres, OSINT, alertes)
             js/airports.js (aéroports) · js/mezone.js (ma zone) · js/account.js (favoris, alertes)
             js/url.js (partage) · js/pwa.js (installation, plein écran)
             js/a11y.js (clavier, lecteurs d'écran) · js/tour.js (visite guidée)
   ════════════════════════════════════════════════════════════════════════════ */
import { loadPrefs, on, $, toast } from './js/state.js';
loadPrefs();   // avant la carte : le thème doit être connu au premier rendu

const { initI18n } = await import('./js/i18n.js');
initI18n();    // avant les modules qui construisent du texte

const { map } = await import('./js/map.js');
const { hitTest } = await import('./js/render.js');
const data = await import('./js/data.js');
const { select, closePanel } = await import('./js/panel.js');
const { initFilters } = await import('./js/filters.js');
const { initMilitary } = await import('./js/military.js');
const { initUrl, openTarget } = await import('./js/url.js');
const { initPwa } = await import('./js/pwa.js');
const { initAirports } = await import('./js/airports.js');
const { initMyZone } = await import('./js/mezone.js');
const { initAccount } = await import('./js/account.js');
const { initA11y } = await import('./js/a11y.js');
const { initTour } = await import('./js/tour.js');

// clic sur la carte → avion le plus proche, sinon fermeture du panneau
map.on('click', (e) => {
  const hex = hitTest(e.containerPoint);
  hex ? select(hex) : closePanel();
});

// recherche : zone affichée d'abord, puis le monde entier
$('search').addEventListener('keydown', async (e) => {
  if (e.key !== 'Enter') return;
  const q = e.target.value.trim();
  if (!q) return;
  e.target.blur();
  toast(`Recherche de « ${q} »…`, { duration: 1500 });
  await openTarget(q);
});
on('open-target', (q) => openTarget(q));

initFilters();
initMilitary();
initPwa();
data.start();
initUrl();
initAirports();
initMyZone();
initAccount();
initA11y();
initTour();

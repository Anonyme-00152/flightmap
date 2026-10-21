/**
 * PWA (installable, hors ligne pour l'interface), plein écran, thème.
 */
import { $, toast } from './state.js';
import { toggleTheme, applyTheme } from './map.js';

export function initPwa() {
  // service worker : cache l'interface (pas les données)
  if ('serviceWorker' in navigator && location.protocol !== 'file:') {
    navigator.serviceWorker.register('sw.js').then((reg) => {
      reg.addEventListener('updatefound', () => {
        const w = reg.installing;
        w?.addEventListener('statechange', () => {
          if (w.state === 'installed' && navigator.serviceWorker.controller) {
            toast('Nouvelle version disponible — recharge la page.', { duration: 8000 });
          }
        });
      });
    }).catch(() => { /* http sans https : pas de SW, pas grave */ });
  }

  // bouton d'installation (Chrome / Edge / Android)
  let deferred = null;
  const installBtn = $('install-btn');
  window.addEventListener('beforeinstallprompt', (e) => {
    e.preventDefault();
    deferred = e;
    installBtn.hidden = false;
  });
  installBtn.addEventListener('click', async () => {
    if (!deferred) return;
    deferred.prompt();
    await deferred.userChoice;
    deferred = null;
    installBtn.hidden = true;
  });
  window.addEventListener('appinstalled', () => { installBtn.hidden = true; });

  // plein écran
  const fsBtn = $('fullscreen-btn');
  if (!document.fullscreenEnabled) fsBtn.hidden = true;
  fsBtn.addEventListener('click', () => {
    if (document.fullscreenElement) document.exitFullscreen();
    else document.documentElement.requestFullscreen().catch(() => {});
  });
  document.addEventListener('fullscreenchange', () => {
    fsBtn.textContent = document.fullscreenElement ? '⤡' : '⤢';
    fsBtn.title = document.fullscreenElement ? 'Quitter le plein écran' : 'Plein écran';
  });

  // thème
  const themeBtn = $('theme-btn');
  const syncThemeBtn = () => {
    const dark = document.documentElement.dataset.theme !== 'light';
    themeBtn.textContent = dark ? '☀' : '☾';
    themeBtn.title = dark ? 'Mode clair' : 'Mode sombre';
  };
  themeBtn.addEventListener('click', () => { toggleTheme(); syncThemeBtn(); });
  syncThemeBtn();

  // raccourcis clavier
  document.addEventListener('keydown', (e) => {
    if (e.target.matches('input, textarea')) return;
    if (e.key === 'f') fsBtn.click();
    if (e.key === 't') themeBtn.click();
    if (e.key === '/') { e.preventDefault(); $('search').focus(); }
  });
}

export { applyTheme };

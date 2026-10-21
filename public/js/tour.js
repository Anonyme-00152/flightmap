/**
 * Visite guidée en 4 étapes, à la première visite (ou via ?tour=1).
 */
import { $ } from './state.js';
import { t } from './i18n.js';

const KEY = 'flightmap:tour-done';
const STEPS = [
  { target: '#map', title: 'Clique sur un avion', text: 'Chaque avion est cliquable : modèle, photo, trajet, trace réelle, données ADS-B. Les couleurs indiquent l\'altitude.' },
  { target: '#search', title: 'Cherche n\'importe quel vol', text: 'Callsign, immatriculation ou hex — dans la zone affichée, puis dans le monde entier.' },
  { target: '#filters-btn', title: 'Filtre et reçois des alertes', text: 'Militaires, urgences, compagnie, type, altitude… et une notification quand quelque chose apparaît dans ta zone.' },
  { target: '#p-sched-btn, #account-btn', title: 'Horaires, favoris, alertes', text: 'Dans la fiche d\'un vol : « Charger les horaires et portes ». Avec ★ tu gardes tes favoris et tu crées des alertes par Telegram ou e-mail.' },
];

let step = 0;
const box = $('tour');

function place(i) {
  const s = STEPS[i];
  $('tour-title').textContent = t(s.title);
  $('tour-text').textContent = t(s.text);
  $('tour-step').textContent = `${i + 1} / ${STEPS.length}`;
  $('tour-next').textContent = i === STEPS.length - 1 ? t('Terminer') : t('Suivant');
  const el = document.querySelector(s.target.split(',')[0]);
  document.querySelectorAll('.tour-hl').forEach((e) => e.classList.remove('tour-hl'));
  if (el && el.id !== 'map') {
    el.classList.add('tour-hl');
    const r = el.getBoundingClientRect();
    box.style.top = `${Math.min(window.innerHeight - 200, r.bottom + 12)}px`;
    box.style.left = `${Math.max(12, Math.min(window.innerWidth - 332, r.left))}px`;
    box.style.bottom = 'auto';
  } else {
    box.style.top = 'auto';
    box.style.bottom = '80px';
    box.style.left = '50%';
    box.style.transform = 'translateX(-50%)';
  }
  if (el && el.id !== 'map') box.style.transform = 'none';
}

function end() {
  box.hidden = true;
  document.querySelectorAll('.tour-hl').forEach((e) => e.classList.remove('tour-hl'));
  try { localStorage.setItem(KEY, '1'); } catch { /* ignore */ }
}

export function startTour() {
  step = 0;
  box.hidden = false;
  place(0);
}

export function initTour() {
  $('tour-next').addEventListener('click', () => { step++; if (step >= STEPS.length) end(); else place(step); });
  $('tour-skip').addEventListener('click', end);
  $('tour-btn')?.addEventListener('click', startTour);
  let done = false;
  try { done = localStorage.getItem(KEY) === '1'; } catch { /* ignore */ }
  const forced = new URLSearchParams(location.search).get('tour') === '1';
  if (forced || (!done && !location.search.includes('hex=') && !location.search.includes('airport='))) setTimeout(startTour, 1500);
}

/**
 * Compte léger (jeton local, sans mot de passe) : favoris, règles d'alerte,
 * canaux (Telegram / e-mail), boîte de réception affichée en toasts.
 */
import { planes, state, on, emit, $, toast, fmtClock } from './state.js';
import { t } from './i18n.js';

const KEY = 'flightmap:token';
let token = null;
let user = null;
let inboxSince = null;
const panel = $('account-panel');

async function api(path, opts = {}) {
  const res = await fetch(`/api/me${path}`, {
    ...opts,
    headers: { 'Content-Type': 'application/json', ...(token ? { 'X-User-Token': token } : {}), ...(opts.headers || {}) },
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

async function ensureToken() {
  try { token = localStorage.getItem(KEY); } catch { /* ignore */ }
  if (!token) {
    const { token: fresh } = await api('/new', { method: 'POST' });
    token = fresh;
    try { localStorage.setItem(KEY, token); } catch { /* ignore */ }
  }
  return token;
}

async function load() {
  await ensureToken();
  user = await api('');
  render();
}

// ── Favoris ─────────────────────────────────────────────────────────────────
export function isFavorite(hex) {
  return Boolean(user?.favorites?.some((f) => f.hex === hex));
}

export async function toggleFavorite(p) {
  await ensureToken();
  if (!user) user = await api('');
  const has = isFavorite(p.hex);
  const favorites = has
    ? user.favorites.filter((f) => f.hex !== p.hex)
    : [...user.favorites, { hex: p.hex, reg: p.reg || null, callsign: p.callsign || null, label: p.desc || p.type || null }];
  const res = await api('/favorites', { method: 'PUT', body: { favorites } });
  user.favorites = res.favorites;
  toast(has ? 'Retiré des favoris.' : `★ ${p.callsign || p.reg || p.hex.toUpperCase()} ajouté aux favoris.`);
  emit('favorites');
  render();
}

// ── Rendu du panneau ────────────────────────────────────────────────────────
function render() {
  if (!user) return;
  $('acc-token').value = token;
  const fav = $('acc-favorites');
  fav.textContent = '';
  for (const f of user.favorites) {
    const el = document.createElement('div');
    el.className = 'leg leg--static';
    el.innerHTML = `<span class="leg-route">★ ${f.reg || f.callsign || f.hex.toUpperCase()} <small>${f.label || ''}</small></span><span class="leg-meta"><button type="button" class="mini" data-open="${f.reg || f.callsign || f.hex}">→</button> <button type="button" class="mini" data-del="${f.hex}">×</button></span>`;
    fav.appendChild(el);
  }
  if (!user.favorites.length) fav.innerHTML = `<div class="sched-note">${t('Aucun favori. Ouvre un avion et clique ★.')}</div>`;

  const rules = $('acc-rules');
  rules.textContent = '';
  for (const r of user.rules) {
    const el = document.createElement('div');
    el.className = 'leg leg--static';
    const label = r.type === 'aircraft' ? t('Avion (immat. ou hex) en vol') : r.type === 'flight' ? t('Vol (callsign) en vol') : t('Type en approche d\'un aéroport');
    el.innerHTML = `<span class="leg-route">${r.value}${r.airport ? ` @ ${r.airport}` : ''} <small>${label} · ${r.channels.join(', ')}</small></span><span class="leg-meta">${r.lastFired ? fmtClock(new Date(r.lastFired)) : ''} <button type="button" class="mini" data-rule-del="${r.id}">×</button></span>`;
    rules.appendChild(el);
  }
  if (!user.rules.length) rules.innerHTML = `<div class="sched-note">${t('Aucune règle.')}</div>`;

  $('acc-email').value = user.channels?.email || '';
  const tg = $('acc-telegram');
  if (user.telegram?.enabled) {
    tg.hidden = false;
    $('acc-tg-status').textContent = user.channels?.telegramChatId ? '✓ Telegram connecté' : 'Non connecté';
    const a = $('acc-tg-link');
    a.href = user.telegram.link || '#';
    a.hidden = !user.telegram.link || Boolean(user.channels?.telegramChatId);
  } else tg.hidden = true;
  $('acc-email-wrap').hidden = !user.channelsAvailable?.email;
  $('acc-nochannel').hidden = Boolean(user.channelsAvailable?.email || user.telegram?.enabled);
  $('acc-rule-telegram').disabled = !user.telegram?.enabled;
  $('acc-rule-email').disabled = !user.channelsAvailable?.email;

  const inbox = $('acc-inbox');
  inbox.textContent = '';
  for (const n of (user.inbox || []).slice(0, 10)) {
    const el = document.createElement('div');
    el.className = 'leg leg--static';
    el.innerHTML = `<span class="leg-time">${fmtClock(new Date(n.t))}</span><span class="leg-route">${n.text}</span><span class="leg-meta">${n.hex ? `<button type="button" class="mini" data-open="${n.hex}">→</button>` : ''}</span>`;
    inbox.appendChild(el);
  }
  if (!user.inbox?.length) inbox.innerHTML = `<div class="sched-note">${t('Rien pour le moment.')}</div>`;
}

// ── Boîte de réception : toasts pour les nouvelles alertes ──────────────────
async function pollInbox() {
  if (!token || document.hidden) return;
  try {
    const { inbox } = await api(`/inbox${inboxSince ? `?since=${encodeURIComponent(inboxSince)}` : ''}`);
    if (inboxSince) for (const n of inbox.reverse()) toast(`🔔 ${n.text}`, { duration: 9000, kind: 'alert' });
    if (inbox.length) inboxSince = inbox[inbox.length - 1]?.t || inbox[0].t;
    if (!inboxSince) inboxSince = new Date().toISOString();
    if (user && inbox.length) { user.inbox = [...inbox, ...(user.inbox || [])].slice(0, 30); if (!panel.hidden) render(); }
  } catch { /* hors ligne */ }
}

export function initAccount() {
  $('account-btn').addEventListener('click', async () => {
    panel.hidden = !panel.hidden;
    if (!panel.hidden) { emit('account-open'); try { await load(); } catch { toast('Compte indisponible (serveur ?).'); } }
  });
  $('account-close').addEventListener('click', () => { panel.hidden = true; });

  panel.addEventListener('click', async (e) => {
    const b = e.target.closest('button');
    if (!b) return;
    try {
      if (b.dataset.open) { panel.hidden = true; emit('open-target', b.dataset.open); }
      else if (b.dataset.del) { user.favorites = (await api('/favorites', { method: 'PUT', body: { favorites: user.favorites.filter((f) => f.hex !== b.dataset.del) } })).favorites; emit('favorites'); render(); }
      else if (b.dataset.ruleDel) { user.rules = (await api('/rules', { method: 'PUT', body: { rules: user.rules.filter((r) => r.id !== b.dataset.ruleDel) } })).rules; render(); }
    } catch { toast('Action impossible.'); }
  });

  $('acc-rule-add').addEventListener('click', async () => {
    const type = $('acc-rule-type').value;
    const value = $('acc-rule-value').value.trim().toUpperCase();
    const airport = $('acc-rule-airport').value.trim().toUpperCase();
    if (!value || (type === 'type-airport' && !airport)) { toast('Renseigne la valeur (et l\'aéroport).'); return; }
    const channels = ['app'];
    if ($('acc-rule-telegram').checked) channels.push('telegram');
    if ($('acc-rule-email').checked) channels.push('email');
    try {
      const res = await api('/rules', { method: 'PUT', body: { rules: [...user.rules, { type, value, airport, channels }] } });
      if (res.rules.length === user.rules.length) toast('Règle refusée (aéroport inconnu ou limite de 20 atteinte).');
      user.rules = res.rules;
      $('acc-rule-value').value = '';
      render();
    } catch { toast('Enregistrement impossible.'); }
  });
  $('acc-rule-type').addEventListener('change', () => { $('acc-rule-airport').hidden = $('acc-rule-type').value !== 'type-airport'; });

  $('acc-email-save').addEventListener('click', async () => {
    try { user.channels = (await api('/channels', { method: 'PUT', body: { email: $('acc-email').value } })).channels; toast(user.channels.email ? 'E-mail enregistré.' : 'Adresse invalide.'); render(); } catch { toast('Enregistrement impossible.'); }
  });
  $('acc-test').addEventListener('click', async () => {
    try { const { sent } = await api('/test', { method: 'POST' }); toast(`Test envoyé : ${Object.entries(sent).filter(([, v]) => v).map(([k]) => k).join(', ') || 'rien'}`); await load(); } catch { toast('Test impossible.'); }
  });
  $('acc-token-copy').addEventListener('click', async () => { try { await navigator.clipboard.writeText(token); toast('Jeton copié.'); } catch { /* ignore */ } });
  $('acc-token-use').addEventListener('click', async () => {
    const v = $('acc-token').value.trim();
    if (!/^[a-f0-9]{32,64}$/.test(v)) { toast('Jeton invalide.'); return; }
    token = v; try { localStorage.setItem(KEY, v); } catch { /* ignore */ }
    try { await load(); toast('Compte restauré.'); } catch { toast('Jeton inconnu.'); }
  });

  // ★ dans le panneau avion
  const favBtn = $('p-fav');
  favBtn.addEventListener('click', async () => {
    const p = planes.get(state.selectedHex);
    if (!p) return;
    try { await toggleFavorite(p); syncFavButton(); } catch { toast('Favoris indisponibles (serveur ?).'); }
  });
  const syncFavButton = () => {
    const on = state.selectedHex && isFavorite(state.selectedHex);
    favBtn.textContent = on ? `★ ${t('Favori ✓')}` : `☆ ${t('Favori')}`;
    favBtn.classList.toggle('is-on', Boolean(on));
  };
  on('select', syncFavButton);
  on('favorites', syncFavButton);

  // au démarrage : si un jeton existe déjà, on charge silencieusement (favoris, inbox)
  try { token = localStorage.getItem(KEY); } catch { /* ignore */ }
  if (token) load().then(syncFavButton).catch(() => {});
  setInterval(pollInbox, 60_000);
  setTimeout(pollInbox, 5000);
}

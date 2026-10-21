/**
 * Comptes légers — sans mot de passe : le navigateur génère un jeton aléatoire,
 * le serveur y rattache favoris, règles d'alerte, canaux et boîte de réception.
 * Perdre le jeton = perdre le compte (il est affiché pour être sauvegardé).
 *
 * Règles d'alerte :
 *   aircraft      « préviens-moi quand F-GKXM (ou un hex) est en vol »
 *   flight        « quand AFR1496 apparaît »
 *   type-airport  « quand un A388 approche de CDG »
 *
 * Canaux : boîte de réception (toasts dans la page), Telegram (bot gratuit),
 * e-mail (Resend ou Brevo, gratuits). Cooldown 2 h par règle.
 *
 * Le moteur interroge les sources à un rythme borné (20 recherches/min au
 * total) : 100 règles = chaque règle vérifiée toutes les 5 min.
 */
import crypto from 'node:crypto';
import * as store from './store.js';
import { getAircraftByHex, searchAircraft, getLiveAircraft, hexForReg } from './providers.js';
import { fetchJson } from './limiter.js';
import * as ref from './refdata.js';

const NS = 'users';
const USER_TTL = 365 * 24 * 3600_000;
const MAX_RULES = 20;
const MAX_FAVORITES = 50;
const MAX_INBOX = 30;
const COOLDOWN = 2 * 3600_000;
const LOOKUPS_PER_MINUTE = 20;

const TELEGRAM_TOKEN = process.env.TELEGRAM_BOT_TOKEN || null;
const RESEND_KEY = process.env.RESEND_API_KEY || null;
const BREVO_KEY = process.env.BREVO_API_KEY || null;
const MAIL_FROM = process.env.MAIL_FROM || 'FlightMap <onboarding@resend.dev>';
const PUBLIC_URL = (process.env.PUBLIC_URL || '').replace(/\/$/, '');

export const channelsAvailable = { telegram: Boolean(TELEGRAM_TOKEN), email: Boolean(RESEND_KEY || BREVO_KEY) };

// ── Utilisateurs ────────────────────────────────────────────────────────────
const validToken = (t) => /^[a-f0-9]{32,64}$/.test(String(t || ''));

function blank() {
  return { createdAt: new Date().toISOString(), favorites: [], rules: [], channels: { email: null, telegramChatId: null }, inbox: [] };
}

export function getUser(token) {
  if (!validToken(token)) return null;
  const hit = store.kvGet(NS, token);
  return hit ? { ...blank(), ...hit.v } : blank();
}

export function saveUser(token, user) {
  if (!validToken(token)) throw new Error('jeton invalide');
  user.updatedAt = new Date().toISOString();
  store.kvSet(NS, token, user, Date.now() + USER_TTL);
  return user;
}

export function newToken() {
  return crypto.randomBytes(24).toString('hex');
}

// ── Validation ──────────────────────────────────────────────────────────────
const clean = (s, n = 40) => String(s || '').trim().slice(0, n);

export function sanitizeFavorites(list) {
  return (Array.isArray(list) ? list : []).slice(0, MAX_FAVORITES).map((f) => ({
    hex: /^[0-9a-f]{6}$/i.test(f.hex || '') ? f.hex.toLowerCase() : null,
    reg: clean(f.reg, 12).toUpperCase() || null,
    callsign: clean(f.callsign, 10).toUpperCase() || null,
    label: clean(f.label, 60) || null,
    addedAt: f.addedAt || new Date().toISOString(),
  })).filter((f) => f.hex || f.reg || f.callsign);
}

export function sanitizeRules(list) {
  const out = [];
  for (const r of Array.isArray(list) ? list : []) {
    const type = ['aircraft', 'flight', 'type-airport'].includes(r.type) ? r.type : null;
    const value = clean(r.value, 12).toUpperCase().replace(/[^A-Z0-9-]/g, '');
    if (!type || !value) continue;
    const airport = type === 'type-airport' ? clean(r.airport, 4).toUpperCase() : null;
    if (type === 'type-airport' && !ref.findAirport(airport)) continue;
    const channels = (Array.isArray(r.channels) ? r.channels : ['app']).filter((c) => ['app', 'telegram', 'email'].includes(c));
    out.push({
      id: /^[a-z0-9]{6,16}$/.test(r.id || '') ? r.id : crypto.randomBytes(4).toString('hex'),
      type, value, airport,
      channels: channels.length ? channels : ['app'],
      createdAt: r.createdAt || new Date().toISOString(),
      lastFired: r.lastFired || null,
    });
    if (out.length >= MAX_RULES) break;
  }
  return out;
}

export function sanitizeChannels(c) {
  const email = clean(c?.email, 120).toLowerCase();
  return {
    email: /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) ? email : null,
    telegramChatId: /^-?\d{4,16}$/.test(String(c?.telegramChatId || '')) ? String(c.telegramChatId) : null,
  };
}

function describeRule(r) {
  if (r.type === 'aircraft') return `Avion ${r.value} en vol`;
  if (r.type === 'flight') return `Vol ${r.value} en vol`;
  return `${r.value} en approche de ${r.airport}`;
}

// ── Envoi ───────────────────────────────────────────────────────────────────
async function sendTelegram(chatId, text) {
  if (!TELEGRAM_TOKEN || !chatId) return false;
  await fetchJson(`https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendMessage`, {
    method: 'POST', body: { chat_id: chatId, text, disable_web_page_preview: true }, timeout: 8000,
  });
  return true;
}

async function sendEmail(to, subject, text) {
  if (!to) return false;
  if (RESEND_KEY) {
    await fetchJson('https://api.resend.com/emails', {
      method: 'POST', timeout: 8000, headers: { Authorization: `Bearer ${RESEND_KEY}` },
      body: { from: MAIL_FROM, to: [to], subject, text },
    });
    return true;
  }
  if (BREVO_KEY) {
    const m = /^(.*?)\s*<(.+)>$/.exec(MAIL_FROM);
    await fetchJson('https://api.brevo.com/v3/smtp/email', {
      method: 'POST', timeout: 8000, headers: { 'api-key': BREVO_KEY },
      body: { sender: { name: m ? m[1] : 'FlightMap', email: m ? m[2] : MAIL_FROM }, to: [{ email: to }], subject, textContent: text },
    });
    return true;
  }
  return false;
}

/** Notifie un utilisateur sur les canaux demandés ; renvoie ce qui a marché. */
export async function notifyUser(token, user, { text, hex, channels }) {
  const link = hex ? `${PUBLIC_URL || ''}/?hex=${hex}` : PUBLIC_URL || '';
  const full = link ? `${text}\n${link}` : text;
  const sent = { app: false, telegram: false, email: false };
  user.inbox = [{ t: new Date().toISOString(), text, hex: hex || null }, ...(user.inbox || [])].slice(0, MAX_INBOX);
  sent.app = true;
  if (channels.includes('telegram')) {
    try { sent.telegram = await sendTelegram(user.channels?.telegramChatId, full); } catch (err) { console.warn(`[alerts] telegram : ${err.message}`); }
  }
  if (channels.includes('email')) {
    try { sent.email = await sendEmail(user.channels?.email, `FlightMap — ${text}`, full); } catch (err) { console.warn(`[alerts] email : ${err.message}`); }
  }
  saveUser(token, user);
  return sent;
}

// ── Telegram : rattacher un chat à un compte via /start <jeton> ─────────────
let botUsername = null;
let tgOffset = 0;

export function telegramInfo(token) {
  if (!TELEGRAM_TOKEN) return { enabled: false };
  return { enabled: true, botUsername, link: botUsername ? `https://t.me/${botUsername}?start=${token}` : null };
}

async function pollTelegram() {
  if (!TELEGRAM_TOKEN) return;
  try {
    if (!botUsername) {
      const me = await fetchJson(`https://api.telegram.org/bot${TELEGRAM_TOKEN}/getMe`, { timeout: 8000 });
      botUsername = me?.result?.username || null;
    }
    const data = await fetchJson(`https://api.telegram.org/bot${TELEGRAM_TOKEN}/getUpdates?offset=${tgOffset}&timeout=0`, { timeout: 10000 });
    for (const u of data?.result || []) {
      tgOffset = u.update_id + 1;
      const text = u.message?.text || '';
      const chatId = u.message?.chat?.id;
      const m = /^\/start\s+([a-f0-9]{32,64})/.exec(text);
      if (!m || !chatId) continue;
      const user = getUser(m[1]);
      if (!user) continue;
      user.channels = { ...user.channels, telegramChatId: String(chatId) };
      saveUser(m[1], user);
      await sendTelegram(chatId, '✈ FlightMap : ce chat recevra tes alertes.');
    }
  } catch (err) {
    console.warn(`[alerts] telegram poll : ${err.message}`);
  }
}

// ── Moteur de règles ────────────────────────────────────────────────────────
const ruleState = new Map();   // ruleKey → { airborne: bool, lastSeen: ms }
let cursor = 0;

async function evaluateRule(token, user, rule) {
  const key = `${token.slice(0, 8)}:${rule.id}`;
  const st = ruleState.get(key) || { airborne: false, lastSeen: 0 };
  let hit = null;   // avion qui déclenche

  if (rule.type === 'aircraft') {
    const hex = /^[0-9A-F]{6}$/.test(rule.value) ? rule.value.toLowerCase() : hexForReg(rule.value);
    if (hex) hit = (await getAircraftByHex(hex)).aircraft;
    else hit = (await searchAircraft(rule.value)).aircraft[0] || null;
  } else if (rule.type === 'flight') {
    hit = (await searchAircraft(rule.value)).aircraft[0] || null;
  } else if (rule.type === 'type-airport') {
    const ap = ref.findAirport(rule.airport);
    if (ap?.lat != null) {
      const live = await getLiveAircraft(ap.lat, ap.lon, 60);
      hit = live.aircraft.find((a) => (a.type || '').toUpperCase() === rule.value && !a.onGround && (a.vertRate ?? 0) < 0 && (a.alt ?? 99999) < 15000) || null;
    }
  }

  const airborneNow = Boolean(hit && !hit.onGround);
  const now = Date.now();
  // déclenche sur la transition « pas en vol → en vol » (ou réapparition après 2 h)
  const fire = airborneNow && (!st.airborne || now - st.lastSeen > COOLDOWN) && (!rule.lastFired || now - new Date(rule.lastFired).getTime() > COOLDOWN);
  ruleState.set(key, { airborne: airborneNow, lastSeen: airborneNow ? now : st.lastSeen });
  if (!fire) return false;

  rule.lastFired = new Date(now).toISOString();
  const what = hit.callsign || hit.reg || hit.hex.toUpperCase();
  const text = rule.type === 'type-airport'
    ? `${hit.type} ${what} en approche de ${rule.airport} (${hit.alt?.toLocaleString('fr-FR')} ft)`
    : `${describeRule(rule)} — ${what}${hit.alt != null ? `, ${hit.alt.toLocaleString('fr-FR')} ft` : ''}`;
  await notifyUser(token, user, { text, hex: hit.hex, channels: rule.channels });
  return true;
}

async function tick() {
  const users = store.kvAll(NS);
  const all = [];
  for (const { k: token, v: user } of users) for (const rule of user.rules || []) all.push({ token, user, rule });
  if (!all.length) return;
  const batch = [];
  for (let i = 0; i < Math.min(LOOKUPS_PER_MINUTE, all.length); i++) {
    batch.push(all[(cursor + i) % all.length]);
  }
  cursor = (cursor + batch.length) % all.length;
  for (const { token, user, rule } of batch) {
    try { await evaluateRule(token, user, rule); } catch (err) { console.warn(`[alerts] règle ${rule.id} : ${err.message}`); }
  }
}

export function startAlertEngine() {
  setInterval(tick, 60_000).unref();
  if (TELEGRAM_TOKEN) { pollTelegram(); setInterval(pollTelegram, 30_000).unref(); }
}

export function accountsStatus() {
  return { users: store.kvAll(NS).length, rules: store.kvAll(NS).reduce((n, u) => n + (u.v.rules?.length || 0), 0), channels: channelsAvailable, telegramBot: botUsername };
}

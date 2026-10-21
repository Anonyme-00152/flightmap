/**
 * Compteur de quota pour les APIs à clé (horaires, portes, retards).
 *
 * Ces APIs sont gratuites mais plafonnées au MOIS (100 pour Aviationstack…).
 * Sans garde-fou, 30 visiteurs curieux vident le quota le premier jour et le
 * site n'affiche plus rien jusqu'au 1er du mois suivant. Ici :
 *   - plafond mensuel avec 5 % de marge (jamais 100 %, en cas de recomptage)
 *   - plafond journalier pour lisser sur le mois
 *   - persistance dans data/quota.json : survit aux redémarrages du serveur
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const FILE = process.env.QUOTA_FILE
  || path.join(process.env.DATA_DIR || path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'data'), 'quota.json');

function load() {
  try { return JSON.parse(fs.readFileSync(FILE, 'utf8')); } catch { return {}; }
}

const state = load();
let saveTimer = null;

function save() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    try {
      fs.mkdirSync(path.dirname(FILE), { recursive: true });
      fs.writeFileSync(FILE, JSON.stringify(state));
    } catch (err) {
      console.warn(`[quota] sauvegarde impossible : ${err.message}`);
    }
  }, 500);
}

const monthKey = () => new Date().toISOString().slice(0, 7);
const dayKey = () => new Date().toISOString().slice(0, 10);

/**
 * @param {string} name        identifiant du fournisseur
 * @param {{monthly: number, daily?: number}} limits
 */
export function createQuota(name, { monthly, daily }) {
  // Par défaut on lisse : 2× la moyenne journalière, jamais moins de 3
  const dailyCap = daily ?? Math.max(3, Math.ceil(monthly / 30) * 2);
  const monthlyCap = monthly - Math.max(1, Math.round(monthly * 0.05));

  function entry() {
    const e = state[name] || (state[name] = {});
    if (e.month !== monthKey()) { e.month = monthKey(); e.monthCount = 0; }
    if (e.day !== dayKey()) { e.day = dayKey(); e.dayCount = 0; }
    return e;
  }

  return {
    name,
    canSpend() {
      const e = entry();
      return e.monthCount < monthlyCap && e.dayCount < dailyCap;
    },
    spend() {
      const e = entry();
      e.monthCount++;
      e.dayCount++;
      save();
    },
    stats() {
      const e = entry();
      return {
        provider: name,
        month: `${e.monthCount}/${monthlyCap}`,
        today: `${e.dayCount}/${dailyCap}`,
        available: this.canSpend(),
      };
    },
  };
}

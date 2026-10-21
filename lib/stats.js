/**
 * Statistiques : agrégées à partir des avions que le serveur voit passer
 * (donc uniquement les zones que les visiteurs regardent). Zéro appel API.
 *
 *   - avions uniques par heure
 *   - compagnies (préfixe du callsign) et types d'appareils les plus vus
 *   - histogramme d'altitude
 *   - militaires, remarquables, urgences (squawk 7500/7600/7700)
 *   - carte de chaleur (grille 0,5°)
 *
 * La journée en cours est en mémoire (Sets d'hex pour compter en unique),
 * snapshot dans le store toutes les 5 min, jours précédents relus du store.
 */
import * as store from './store.js';

const dayKey = (t = Date.now()) => new Date(t).toISOString().slice(0, 10);
const ALT_BUCKETS = [0, 5000, 10000, 20000, 30000, 40000, 60000];

/** Noms des compagnies les plus courantes ; complété au fil de l'eau par adsbdb. */
export const AIRLINE_NAMES = new Map(Object.entries({
  AFR: 'Air France', KLM: 'KLM', BAW: 'British Airways', DLH: 'Lufthansa', EZY: 'easyJet', EJU: 'easyJet Europe',
  RYR: 'Ryanair', VLG: 'Vueling', TVF: 'Transavia France', TRA: 'Transavia', IBE: 'Iberia', SWR: 'Swiss', AUA: 'Austrian',
  SAS: 'SAS', FIN: 'Finnair', TAP: 'TAP Portugal', AEE: 'Aegean', THY: 'Turkish Airlines', UAE: 'Emirates', QTR: 'Qatar Airways',
  ETD: 'Etihad', AAL: 'American Airlines', DAL: 'Delta', UAL: 'United', SWA: 'Southwest', JBU: 'JetBlue', ACA: 'Air Canada',
  WZZ: 'Wizz Air', EWG: 'Eurowings', BEL: 'Brussels Airlines', ITY: 'ITA Airways', LOT: 'LOT', CSA: 'Czech Airlines',
  NAX: 'Norwegian', NOZ: 'Norwegian', EIN: 'Aer Lingus', VIR: 'Virgin Atlantic', TOM: 'TUI Airways', TUI: 'TUI fly',
  HOP: 'HOP!', CTM: 'Air Corsica', BZH: 'Brit Air', FDX: 'FedEx', UPS: 'UPS', GEC: 'Lufthansa Cargo', CLX: 'Cargolux',
  RCH: 'US Air Force (AMC)', FAF: 'Armée de l\'air', ANE: 'Air Nostrum', SIA: 'Singapore Airlines',
  CPA: 'Cathay Pacific', JAL: 'Japan Airlines', ANA: 'ANA', KAL: 'Korean Air', AIC: 'Air India', ETH: 'Ethiopian',
  MSR: 'EgyptAir', RAM: 'Royal Air Maroc', TAR: 'Tunisair', DAH: 'Air Algérie', ASL: 'ASL Airlines France', FPO: 'ASL Airlines France',
}));

/** IATA (2 caractères) → ICAO (3 lettres) des compagnies courantes, complété par adsbdb au fil de l'eau. */
export const AIRLINE_IATA = new Map(Object.entries({
  AF: 'AFR', KL: 'KLM', BA: 'BAW', LH: 'DLH', U2: 'EZY', EC: 'EJU', FR: 'RYR', VY: 'VLG', TO: 'TVF', HV: 'TRA',
  IB: 'IBE', LX: 'SWR', OS: 'AUA', SK: 'SAS', AY: 'FIN', TP: 'TAP', A3: 'AEE', TK: 'THY', EK: 'UAE', QR: 'QTR',
  EY: 'ETD', AA: 'AAL', DL: 'DAL', UA: 'UAL', WN: 'SWA', B6: 'JBU', AC: 'ACA', W6: 'WZZ', EW: 'EWG', SN: 'BEL',
  AZ: 'ITY', LO: 'LOT', OK: 'CSA', DY: 'NAX', EI: 'EIN', VS: 'VIR', BY: 'TOM', A5: 'HOP', XK: 'CTM', FX: 'FDX',
  '5X': 'UPS', SQ: 'SIA', CX: 'CPA', JL: 'JAL', NH: 'ANA', KE: 'KAL', AI: 'AIC', ET: 'ETH', MS: 'MSR', AT: 'RAM',
  TU: 'TAR', AH: 'DAH', '5O': 'FPO',
}));

function emptyDay(day) {
  return {
    day,
    hours: Array.from({ length: 24 }, () => new Set()),
    airlines: new Map(),   // prefix → Set(hex)
    types: new Map(),      // type → Set(hex)
    alt: new Array(ALT_BUCKETS.length - 1).fill(0),
    altSamples: 0,
    military: new Set(),
    notable: new Set(),
    emergencies: new Map(), // hex → {hex, callsign, squawk, emergency, first, last}
    grid: new Map(),        // "lat,lon" → count
    unique: new Set(),
    samples: 0,
    peak: 0,
  };
}

let current = emptyDay(dayKey());
let dirty = false;

/** Appelé à chaque lot de positions reçu (lib/providers.js). */
export function observe(aircraft, now = Date.now()) {
  const day = dayKey(now);
  if (day !== current.day) { snapshot(); current = emptyDay(day); }
  const hour = new Date(now).getUTCHours();
  if (aircraft.length > current.peak) current.peak = aircraft.length;
  current.samples++;

  for (const a of aircraft) {
    current.unique.add(a.hex);
    current.hours[hour].add(a.hex);
    const prefix = /^[A-Z]{3}\d/.test(a.callsign || '') ? a.callsign.slice(0, 3) : null;
    if (prefix) { if (!current.airlines.has(prefix)) current.airlines.set(prefix, new Set()); current.airlines.get(prefix).add(a.hex); }
    if (a.type) { if (!current.types.has(a.type)) current.types.set(a.type, new Set()); current.types.get(a.type).add(a.hex); }
    if (a.alt != null && !a.onGround) {
      for (let i = 0; i < ALT_BUCKETS.length - 1; i++) {
        if (a.alt < ALT_BUCKETS[i + 1]) { current.alt[i]++; break; }
      }
      current.altSamples++;
    }
    if (a.military) current.military.add(a.hex);
    if (a.notable) current.notable.add(a.hex);
    if (a.emergency || ['7500', '7600', '7700'].includes(a.squawk)) {
      const e = current.emergencies.get(a.hex) || { hex: a.hex, callsign: a.callsign, squawk: a.squawk, emergency: a.emergency, first: now, last: now };
      e.last = now; e.squawk = a.squawk; e.emergency = a.emergency;
      current.emergencies.set(a.hex, e);
    }
    const cell = `${(Math.floor(a.lat * 2) / 2).toFixed(1)},${(Math.floor(a.lon * 2) / 2).toFixed(1)}`;
    current.grid.set(cell, (current.grid.get(cell) || 0) + 1);
  }
  dirty = true;
}

/** Version sérialisable de la journée (Sets → nombres, tops limités). */
function serialize(d) {
  const top = (m, n) => [...m.entries()].map(([k, s]) => [k, s.size]).sort((a, b) => b[1] - a[1]).slice(0, n);
  return {
    hours: d.hours.map((s) => s.size),
    airlines: top(d.airlines, 25).map(([code, count]) => ({ code, name: AIRLINE_NAMES.get(code) || null, count })),
    types: top(d.types, 25).map(([code, count]) => ({ code, count })),
    alt: d.alt, altBuckets: ALT_BUCKETS, altSamples: d.altSamples,
    military: d.military.size,
    notable: d.notable.size,
    emergencies: [...d.emergencies.values()].slice(-50),
    grid: [...d.grid.entries()].sort((a, b) => b[1] - a[1]).slice(0, 2000),
    unique: d.unique.size,
    samples: d.samples,
    peak: d.peak,
  };
}

export function snapshot() {
  if (!dirty) return;
  try { store.statSet(current.day, serialize(current)); dirty = false; } catch (err) {
    console.warn(`[stats] snapshot : ${err.message}`);
  }
}

/** Journée en cours + jours précédents. */
export function getStats(days = 7) {
  const today = { day: current.day, ...serialize(current), live: true };
  const previous = store.statDays(days).filter((d) => d.day !== current.day).slice(0, days - 1);
  return { today, previous, note: 'Compté sur les zones que les visiteurs ont regardées, pas sur le trafic mondial.' };
}

setInterval(snapshot, 5 * 60_000).unref();

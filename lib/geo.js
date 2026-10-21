/**
 * Géographie sans API :
 *   - fuseau horaire IANA d'un aéroport (pays → fuseau, régions/longitude pour les grands pays,
 *     et ce que les APIs d'horaires nous ont appris en passant)
 *   - lever / coucher du soleil (algorithme NOAA)
 *   - nom des pays (Intl, en français)
 */
import * as store from './store.js';

// ── Fuseaux : pays à fuseau unique ──────────────────────────────────────────
const COUNTRY_TZ = {
  FR: 'Europe/Paris', DE: 'Europe/Berlin', GB: 'Europe/London', IE: 'Europe/Dublin', ES: 'Europe/Madrid', PT: 'Europe/Lisbon',
  IT: 'Europe/Rome', CH: 'Europe/Zurich', AT: 'Europe/Vienna', BE: 'Europe/Brussels', NL: 'Europe/Amsterdam', LU: 'Europe/Luxembourg',
  DK: 'Europe/Copenhagen', NO: 'Europe/Oslo', SE: 'Europe/Stockholm', FI: 'Europe/Helsinki', IS: 'Atlantic/Reykjavik', PL: 'Europe/Warsaw',
  CZ: 'Europe/Prague', SK: 'Europe/Bratislava', HU: 'Europe/Budapest', RO: 'Europe/Bucharest', BG: 'Europe/Sofia', GR: 'Europe/Athens',
  TR: 'Europe/Istanbul', CY: 'Asia/Nicosia', MT: 'Europe/Malta', HR: 'Europe/Zagreb', SI: 'Europe/Ljubljana', RS: 'Europe/Belgrade',
  BA: 'Europe/Sarajevo', ME: 'Europe/Podgorica', MK: 'Europe/Skopje', AL: 'Europe/Tirane', XK: 'Europe/Belgrade', EE: 'Europe/Tallinn',
  LV: 'Europe/Riga', LT: 'Europe/Vilnius', BY: 'Europe/Minsk', UA: 'Europe/Kyiv', MD: 'Europe/Chisinau', GE: 'Asia/Tbilisi',
  AM: 'Asia/Yerevan', AZ: 'Asia/Baku', IL: 'Asia/Jerusalem', JO: 'Asia/Amman', LB: 'Asia/Beirut', SY: 'Asia/Damascus', IQ: 'Asia/Baghdad',
  IR: 'Asia/Tehran', SA: 'Asia/Riyadh', AE: 'Asia/Dubai', QA: 'Asia/Qatar', BH: 'Asia/Bahrain', KW: 'Asia/Kuwait', OM: 'Asia/Muscat',
  YE: 'Asia/Aden', EG: 'Africa/Cairo', LY: 'Africa/Tripoli', TN: 'Africa/Tunis', DZ: 'Africa/Algiers', MA: 'Africa/Casablanca',
  EH: 'Africa/El_Aaiun', MR: 'Africa/Nouakchott', SN: 'Africa/Dakar', GM: 'Africa/Banjul', GN: 'Africa/Conakry', GW: 'Africa/Bissau',
  SL: 'Africa/Freetown', LR: 'Africa/Monrovia', CI: 'Africa/Abidjan', GH: 'Africa/Accra', TG: 'Africa/Lome', BJ: 'Africa/Porto-Novo',
  NG: 'Africa/Lagos', NE: 'Africa/Niamey', ML: 'Africa/Bamako', BF: 'Africa/Ouagadougou', CM: 'Africa/Douala', TD: 'Africa/Ndjamena',
  CF: 'Africa/Bangui', GA: 'Africa/Libreville', GQ: 'Africa/Malabo', CG: 'Africa/Brazzaville', AO: 'Africa/Luanda', NA: 'Africa/Windhoek',
  ZA: 'Africa/Johannesburg', LS: 'Africa/Maseru', SZ: 'Africa/Mbabane', BW: 'Africa/Gaborone', ZW: 'Africa/Harare', ZM: 'Africa/Lusaka',
  MW: 'Africa/Blantyre', MZ: 'Africa/Maputo', TZ: 'Africa/Dar_es_Salaam', KE: 'Africa/Nairobi', UG: 'Africa/Kampala', RW: 'Africa/Kigali',
  BI: 'Africa/Bujumbura', ET: 'Africa/Addis_Ababa', ER: 'Africa/Asmara', DJ: 'Africa/Djibouti', SO: 'Africa/Mogadishu', SD: 'Africa/Khartoum',
  SS: 'Africa/Juba', MG: 'Indian/Antananarivo', MU: 'Indian/Mauritius', RE: 'Indian/Reunion', YT: 'Indian/Mayotte', SC: 'Indian/Mahe',
  KM: 'Indian/Comoro', CV: 'Atlantic/Cape_Verde', ST: 'Africa/Sao_Tome', IN: 'Asia/Kolkata', PK: 'Asia/Karachi', AF: 'Asia/Kabul',
  BD: 'Asia/Dhaka', LK: 'Asia/Colombo', NP: 'Asia/Kathmandu', BT: 'Asia/Thimphu', MV: 'Indian/Maldives', MM: 'Asia/Yangon',
  TH: 'Asia/Bangkok', LA: 'Asia/Vientiane', KH: 'Asia/Phnom_Penh', VN: 'Asia/Ho_Chi_Minh', MY: 'Asia/Kuala_Lumpur', SG: 'Asia/Singapore',
  BN: 'Asia/Brunei', PH: 'Asia/Manila', TW: 'Asia/Taipei', HK: 'Asia/Hong_Kong', MO: 'Asia/Macau', CN: 'Asia/Shanghai', JP: 'Asia/Tokyo',
  KR: 'Asia/Seoul', KP: 'Asia/Pyongyang', UZ: 'Asia/Tashkent', TM: 'Asia/Ashgabat', TJ: 'Asia/Dushanbe', KG: 'Asia/Bishkek',
  KZ: 'Asia/Almaty', NZ: 'Pacific/Auckland', FJ: 'Pacific/Fiji', PG: 'Pacific/Port_Moresby', NC: 'Pacific/Noumea', PF: 'Pacific/Tahiti',
  WS: 'Pacific/Apia', TO: 'Pacific/Tongatapu', VU: 'Pacific/Efate', SB: 'Pacific/Guadalcanal', GU: 'Pacific/Guam', CU: 'America/Havana',
  JM: 'America/Jamaica', HT: 'America/Port-au-Prince', DO: 'America/Santo_Domingo', PR: 'America/Puerto_Rico', BS: 'America/Nassau',
  BB: 'America/Barbados', TT: 'America/Port_of_Spain', GP: 'America/Guadeloupe', MQ: 'America/Martinique', LC: 'America/St_Lucia',
  AW: 'America/Aruba', CW: 'America/Curacao', GT: 'America/Guatemala', BZ: 'America/Belize', HN: 'America/Tegucigalpa',
  SV: 'America/El_Salvador', NI: 'America/Managua', CR: 'America/Costa_Rica', PA: 'America/Panama', CO: 'America/Bogota',
  VE: 'America/Caracas', GY: 'America/Guyana', SR: 'America/Paramaribo', GF: 'America/Cayenne', EC: 'America/Guayaquil', PE: 'America/Lima',
  BO: 'America/La_Paz', PY: 'America/Asuncion', UY: 'America/Montevideo', AR: 'America/Argentina/Buenos_Aires', CL: 'America/Santiago',
  IS_: 'Atlantic/Reykjavik', GL: 'America/Nuuk', BM: 'Atlantic/Bermuda', KY: 'America/Cayman', TC: 'America/Grand_Turk',
};

// ── Grands pays : par région ISO (états / provinces) ou par longitude ────────
const US_STATE_TZ = {
  'US-HI': 'Pacific/Honolulu', 'US-AK': 'America/Anchorage',
  'US-WA': 'America/Los_Angeles', 'US-OR': 'America/Los_Angeles', 'US-CA': 'America/Los_Angeles', 'US-NV': 'America/Los_Angeles',
  'US-ID': 'America/Boise', 'US-MT': 'America/Denver', 'US-WY': 'America/Denver', 'US-UT': 'America/Denver', 'US-CO': 'America/Denver',
  'US-NM': 'America/Denver', 'US-AZ': 'America/Phoenix',
  'US-ND': 'America/Chicago', 'US-SD': 'America/Chicago', 'US-NE': 'America/Chicago', 'US-KS': 'America/Chicago', 'US-OK': 'America/Chicago',
  'US-TX': 'America/Chicago', 'US-MN': 'America/Chicago', 'US-IA': 'America/Chicago', 'US-MO': 'America/Chicago', 'US-AR': 'America/Chicago',
  'US-LA': 'America/Chicago', 'US-WI': 'America/Chicago', 'US-IL': 'America/Chicago', 'US-MS': 'America/Chicago', 'US-AL': 'America/Chicago',
  'US-TN': 'America/Chicago',
  'US-MI': 'America/Detroit', 'US-IN': 'America/Indiana/Indianapolis', 'US-KY': 'America/New_York', 'US-OH': 'America/New_York',
  'US-GA': 'America/New_York', 'US-FL': 'America/New_York', 'US-SC': 'America/New_York', 'US-NC': 'America/New_York', 'US-VA': 'America/New_York',
  'US-WV': 'America/New_York', 'US-PA': 'America/New_York', 'US-NY': 'America/New_York', 'US-NJ': 'America/New_York', 'US-CT': 'America/New_York',
  'US-RI': 'America/New_York', 'US-MA': 'America/New_York', 'US-VT': 'America/New_York', 'US-NH': 'America/New_York', 'US-ME': 'America/New_York',
  'US-MD': 'America/New_York', 'US-DE': 'America/New_York', 'US-DC': 'America/New_York',
};
const CA_PROV_TZ = {
  'CA-BC': 'America/Vancouver', 'CA-YT': 'America/Whitehorse', 'CA-AB': 'America/Edmonton', 'CA-NT': 'America/Yellowknife',
  'CA-SK': 'America/Regina', 'CA-MB': 'America/Winnipeg', 'CA-NU': 'America/Iqaluit', 'CA-ON': 'America/Toronto', 'CA-QC': 'America/Toronto',
  'CA-NB': 'America/Moncton', 'CA-NS': 'America/Halifax', 'CA-PE': 'America/Halifax', 'CA-NL': 'America/St_Johns',
};
const AU_STATE_TZ = {
  'AU-WA': 'Australia/Perth', 'AU-NT': 'Australia/Darwin', 'AU-SA': 'Australia/Adelaide', 'AU-QLD': 'Australia/Brisbane',
  'AU-NSW': 'Australia/Sydney', 'AU-ACT': 'Australia/Sydney', 'AU-VIC': 'Australia/Melbourne', 'AU-TAS': 'Australia/Hobart',
};
const BR_STATE_TZ = { 'BR-AC': 'America/Rio_Branco', 'BR-AM': 'America/Manaus', 'BR-RO': 'America/Porto_Velho', 'BR-RR': 'America/Boa_Vista', 'BR-MT': 'America/Cuiaba', 'BR-MS': 'America/Campo_Grande', 'BR-FN': 'America/Noronha' };
const MX_STATE_TZ = { 'MX-BCN': 'America/Tijuana', 'MX-BCS': 'America/Mazatlan', 'MX-SIN': 'America/Mazatlan', 'MX-NAY': 'America/Mazatlan', 'MX-SON': 'America/Hermosillo', 'MX-CHH': 'America/Chihuahua', 'MX-ROO': 'America/Cancun' };

function bigCountryTz(country, region, lat, lon) {
  if (country === 'US') return US_STATE_TZ[region] || (lon < -100 ? 'America/Denver' : 'America/Chicago');
  if (country === 'CA') return CA_PROV_TZ[region] || 'America/Toronto';
  if (country === 'AU') return AU_STATE_TZ[region] || 'Australia/Sydney';
  if (country === 'BR') return BR_STATE_TZ[region] || 'America/Sao_Paulo';
  if (country === 'MX') return MX_STATE_TZ[region] || 'America/Mexico_City';
  if (country === 'RU') {
    if (lon < 25) return 'Europe/Kaliningrad'; if (lon < 47) return 'Europe/Moscow'; if (lon < 55) return 'Europe/Samara';
    if (lon < 75) return 'Asia/Yekaterinburg'; if (lon < 82) return 'Asia/Omsk'; if (lon < 90) return 'Asia/Novosibirsk';
    if (lon < 105) return 'Asia/Krasnoyarsk'; if (lon < 118) return 'Asia/Irkutsk'; if (lon < 130) return 'Asia/Yakutsk';
    if (lon < 145) return 'Asia/Vladivostok'; if (lon < 155) return 'Asia/Magadan'; return 'Asia/Kamchatka';
  }
  if (country === 'ID') return lon < 114 ? 'Asia/Jakarta' : lon < 128 ? 'Asia/Makassar' : 'Asia/Jayapura';
  if (country === 'ES') return lon < -12 ? 'Atlantic/Canary' : 'Europe/Madrid';
  if (country === 'PT') return lon < -20 ? 'Atlantic/Azores' : lon < -15 ? 'Atlantic/Madeira' : 'Europe/Lisbon';
  if (country === 'EC') return lon < -85 ? 'Pacific/Galapagos' : 'America/Guayaquil';
  if (country === 'CL') return lon < -100 ? 'Pacific/Easter' : 'America/Santiago';
  if (country === 'MN') return lon < 100 ? 'Asia/Hovd' : 'Asia/Ulaanbaatar';
  if (country === 'CD') return lon < 20 ? 'Africa/Kinshasa' : 'Africa/Lubumbashi';
  if (country === 'KI') return lon < -160 ? 'Pacific/Tarawa' : lon < -155 ? 'Pacific/Kanton' : 'Pacific/Kiritimati';
  if (country === 'FM') return lon < 155 ? 'Pacific/Chuuk' : 'Pacific/Pohnpei';
  return null;
}

/** Fuseau appris auprès des APIs d'horaires (fiable) : ICAO → IANA, persistant. */
export function learnAirportTimezone(icao, tz) {
  if (!icao || !tz || !/^[A-Za-z_]+\/[A-Za-z_\/+-]+$/.test(tz)) return;
  try { store.kvSet('aptz', String(icao).toUpperCase(), tz, Date.now() + 365 * 24 * 3600_000); } catch { /* ignore */ }
}

const isValidTz = (tz) => { try { new Intl.DateTimeFormat('en-US', { timeZone: tz }); return true; } catch { return false; } };

/** Fuseau IANA d'un aéroport : appris > pays/région > longitude. */
export function airportTimezone(ap) {
  if (!ap) return null;
  try {
    const learned = ap.icao ? store.kvGet('aptz', ap.icao)?.v : null;
    if (learned && isValidTz(learned)) return learned;
  } catch { /* ignore */ }
  const c = String(ap.country || '').toUpperCase();
  let tz = bigCountryTz(c, ap.region, ap.lat, ap.lon) || COUNTRY_TZ[c] || null;
  if (!tz || !isValidTz(tz)) {
    // repli : fuseau nautique par longitude (sans heure d'été)
    const off = Math.round((ap.lon || 0) / 15);
    tz = off === 0 ? 'Etc/UTC' : `Etc/GMT${off > 0 ? '-' : '+'}${Math.abs(off)}`;
  }
  return tz;
}

/** Décalage courant d'un fuseau, ex. "+02:00", et son nom court. */
export function tzInfo(tz, date = new Date()) {
  try {
    const parts = new Intl.DateTimeFormat('fr-FR', { timeZone: tz, timeZoneName: 'longOffset' }).formatToParts(date);
    const off = parts.find((p) => p.type === 'timeZoneName')?.value?.replace('UTC', '').replace('GMT', '') || '+00:00';
    const name = new Intl.DateTimeFormat('fr-FR', { timeZone: tz, timeZoneName: 'long' }).formatToParts(date).find((p) => p.type === 'timeZoneName')?.value || tz;
    return { tz, offset: off === '' ? '+00:00' : off, name };
  } catch {
    return { tz, offset: null, name: tz };
  }
}

// ── Soleil (NOAA) ───────────────────────────────────────────────────────────
const rad = (d) => (d * Math.PI) / 180;
const deg = (r) => (r * 180) / Math.PI;

/** Lever et coucher (ISO UTC) pour un jour donné ; null si soleil de minuit / nuit polaire. */
export function sunTimes(lat, lon, date = new Date()) {
  const d0 = Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate());
  const julian = d0 / 86_400_000 + 2440587.5;
  const n = Math.ceil(julian - 2451545 + 0.0008);   // jour julien entier (midi), comme dans la méthode NOAA
  const jStar = n - lon / 360;
  const M = (357.5291 + 0.98560028 * jStar) % 360;
  const C = 1.9148 * Math.sin(rad(M)) + 0.02 * Math.sin(rad(2 * M)) + 0.0003 * Math.sin(rad(3 * M));
  const lambda = (M + C + 180 + 102.9372) % 360;
  const jTransit = 2451545 + jStar + 0.0053 * Math.sin(rad(M)) - 0.0069 * Math.sin(rad(2 * lambda));
  const decl = deg(Math.asin(Math.sin(rad(lambda)) * Math.sin(rad(23.4397))));
  const cosH = (Math.sin(rad(-0.833)) - Math.sin(rad(lat)) * Math.sin(rad(decl))) / (Math.cos(rad(lat)) * Math.cos(rad(decl)));
  if (cosH < -1 || cosH > 1) return { sunrise: null, sunset: null, polar: cosH < -1 ? 'day' : 'night' };
  const H = deg(Math.acos(cosH)) / 360;
  const toIso = (j) => new Date((j - 2440587.5) * 86_400_000).toISOString();
  return { sunrise: toIso(jTransit - H), sunset: toIso(jTransit + H), polar: null };
}

// ── Pays ────────────────────────────────────────────────────────────────────
let names = null;
export function countryName(iso) {
  if (!iso) return null;
  try {
    names ||= new Intl.DisplayNames(['fr'], { type: 'region' });
    return names.of(String(iso).toUpperCase()) || iso;
  } catch { return iso; }
}

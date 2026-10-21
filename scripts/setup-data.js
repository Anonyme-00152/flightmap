#!/usr/bin/env node
/**
 * Télécharge le "référentiel" une fois pour toutes et le convertit en JSON
 * compact dans data/.
 *
 * Ces fichiers ne sont PAS des APIs : une fois chargés, ton site n'a plus
 * jamais besoin d'appeler personne pour nommer un aéroport ou reconnaître
 * un appareil remarquable. Zéro quota, zéro latence, marche hors ligne.
 *
 *   node scripts/setup-data.js                 # aéroports + avions remarquables
 *   node scripts/setup-data.js --opensky       # + base d'immatriculations (~100 Mo à télécharger)
 *   node scripts/setup-data.js --from-dir ./csv  # si tu as déjà les CSV en local
 */
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { Readable } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { rowMapper, pick } from '../lib/csv.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.join(__dirname, '..', 'data');

const args = process.argv.slice(2);
const WITH_OPENSKY = args.includes('--opensky');
const fromDirIdx = args.indexOf('--from-dir');
const FROM_DIR = fromDirIdx !== -1 ? args[fromDirIdx + 1] : null;

const SOURCES = {
  airports: {
    url: 'https://davidmegginson.github.io/ourairports-data/airports.csv',
    file: 'airports.csv',
    label: 'OurAirports (domaine public)',
  },
  runways: {
    url: 'https://davidmegginson.github.io/ourairports-data/runways.csv',
    file: 'runways.csv',
    label: 'OurAirports — pistes (domaine public)',
  },
  notable: {
    url: 'https://raw.githubusercontent.com/sdr-enthusiasts/plane-alert-db/main/plane-alert-db.csv',
    file: 'plane-alert-db.csv',
    label: 'plane-alert-db (appareils remarquables)',
  },
  opensky: {
    url: 'https://opensky-network.org/datasets/metadata/aircraftDatabase.csv',
    file: 'aircraftDatabase.csv',
    label: 'Base OpenSky (immatriculations)',
  },
};

/** Itère les lignes d'un CSV, qu'il vienne du réseau ou du disque. */
async function* lines(source) {
  let stream;
  if (FROM_DIR) {
    const local = path.join(FROM_DIR, source.file);
    if (!fs.existsSync(local)) throw new Error(`fichier introuvable : ${local}`);
    stream = fs.createReadStream(local);
  } else {
    const res = await fetch(source.url, {
      headers: { 'User-Agent': 'flightmap-setup/1.0 (projet perso)' },
      redirect: 'follow',
    });
    if (!res.ok) throw new Error(`HTTP ${res.status} sur ${source.url}`);
    stream = Readable.fromWeb(res.body);
  }
  const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });
  for await (const line of rl) if (line.trim()) yield line;
}

function write(name, data) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const file = path.join(DATA_DIR, name);
  fs.writeFileSync(file, JSON.stringify(data));
  const mb = (fs.statSync(file).size / 1048576).toFixed(1);
  console.log(`   → data/${name} (${mb} Mo)`);
}

// ── 1. Aéroports du monde (OurAirports, domaine public) ─────────────────────
export async function buildAirports(lineIterator) {
  const byIcao = {};
  const byIata = {};
  let header = null, mapRow = null, kept = 0;

  for await (const line of lineIterator) {
    if (!header) { header = line; mapRow = rowMapper(line); continue; }
    const r = mapRow(line);
    if (r.type === 'closed') continue;

    const icao = (pick(r, 'icao_code', 'gps_code', 'ident') || '').toUpperCase();
    const iata = (pick(r, 'iata_code') || '').toUpperCase();
    if (!icao && !iata) continue;

    const entry = {
      icao: icao || null,
      iata: iata || null,
      name: pick(r, 'name'),
      city: pick(r, 'municipality'),
      country: pick(r, 'iso_country'),
      lat: Number.parseFloat(r.latitude_deg) || null,
      lon: Number.parseFloat(r.longitude_deg) || null,
      // large / medium / small / heliport… : sert à choisir quels aéroports dessiner sur la carte
      type: String(r.type || '').replace('_airport', '') || null,
      // fiche aéroport : altitude, service régulier, liens (Wikipédia = photo + description)
      elev: Number.parseFloat(r.elevation_ft) || null,
      sched: r.scheduled_service === 'yes',
      wiki: pick(r, 'wikipedia_link') || null,
      home: pick(r, 'home_link') || null,
      region: pick(r, 'iso_region') || null,
    };
    if (icao) byIcao[icao] = entry;
    if (iata && iata.length === 3) byIata[iata] = entry;
    kept++;
  }

  console.log(`   ${kept.toLocaleString('fr-FR')} aéroports retenus`);
  return { byIcao, byIata };
}

// ── 1b. Pistes (OurAirports) : orientation, longueur, coordonnées des seuils ─
export async function buildRunways(lineIterator) {
  const byAirport = {};
  let header = null, mapRow = null, kept = 0;
  const num = (v) => { const n = Number.parseFloat(v); return Number.isFinite(n) ? n : null; };

  for await (const line of lineIterator) {
    if (!header) { header = line; mapRow = rowMapper(line); continue; }
    const r = mapRow(line);
    if (r.closed === '1') continue;
    const airport = (pick(r, 'airport_ident') || '').toUpperCase();
    const leLat = num(r.le_latitude_deg), leLon = num(r.le_longitude_deg);
    const heLat = num(r.he_latitude_deg), heLon = num(r.he_longitude_deg);
    if (!airport || leLat == null || heLat == null) continue;   // sans seuils on ne peut rien dessiner

    // format compact : [ident LE, ident HE, cap LE, cap HE, lat LE, lon LE, lat HE, lon HE, longueur ft, largeur ft, surface]
    (byAirport[airport] ||= []).push([
      pick(r, 'le_ident') || '', pick(r, 'he_ident') || '',
      num(r.le_heading_degT), num(r.he_heading_degT),
      leLat, leLon, heLat, heLon,
      num(r.length_ft), num(r.width_ft), pick(r, 'surface') || null,
    ]);
    kept++;
  }

  console.log(`   ${kept.toLocaleString('fr-FR')} pistes (${Object.keys(byAirport).length.toLocaleString('fr-FR')} aéroports)`);
  return byAirport;
}

// ── 2. Appareils remarquables (plane-alert-db) ──────────────────────────────
export async function buildNotable(lineIterator) {
  const byHex = {};
  let header = null, mapRow = null;

  for await (const line of lineIterator) {
    if (!header) { header = line; mapRow = rowMapper(line); continue; }
    const r = mapRow(line);
    const hex = (pick(r, '$ICAO', 'ICAO', 'icao') || '').toLowerCase();
    if (!/^[0-9a-f]{6}$/.test(hex)) continue;

    const tags = [pick(r, '$Tag 1', 'Tag 1'), pick(r, '$Tag 2', 'Tag 2'), pick(r, '$Tag 3', 'Tag 3')]
      .filter(Boolean);

    byHex[hex] = {
      operator: pick(r, '$Operator', 'Operator'),
      type: pick(r, '$Type', 'Type'),
      registration: pick(r, '$Registration', 'Registration'),
      category: pick(r, 'Category', '#CMPG'),
      tags,
    };
  }

  console.log(`   ${Object.keys(byHex).length.toLocaleString('fr-FR')} appareils remarquables`);
  return byHex;
}

// ── 3. Base d'immatriculations OpenSky (optionnelle, volumineuse) ───────────
export async function buildAircraftDb(lineIterator) {
  const byHex = {};
  let header = null, mapRow = null;

  for await (const line of lineIterator) {
    if (!header) { header = line; mapRow = rowMapper(line); continue; }
    const r = mapRow(line);
    const hex = (pick(r, 'icao24') || '').toLowerCase();
    if (!/^[0-9a-f]{6}$/.test(hex)) continue;

    const model = pick(r, 'model');
    const reg = pick(r, 'registration');
    const owner = pick(r, 'operator', 'owner');
    if (!model && !reg) continue;

    // format compact : un tableau plutôt qu'un objet (3x plus léger en RAM)
    byHex[hex] = [reg, pick(r, 'typecode'), model, pick(r, 'manufacturername'), owner];
  }

  console.log(`   ${Object.keys(byHex).length.toLocaleString('fr-FR')} immatriculations`);
  return byHex;
}

// ── Exécution ───────────────────────────────────────────────────────────────
async function main() {
  console.log(`\n📦 Récupération du référentiel${FROM_DIR ? ` depuis ${FROM_DIR}` : ''}\n`);

  const jobs = [
    { key: 'airports', build: buildAirports, out: 'airports.json' },
    { key: 'runways', build: buildRunways, out: 'runways.json' },
    { key: 'notable', build: buildNotable, out: 'notable.json' },
  ];
  if (WITH_OPENSKY) jobs.push({ key: 'opensky', build: buildAircraftDb, out: 'aircraft-db.json' });

  for (const job of jobs) {
    const source = SOURCES[job.key];
    console.log(`▸ ${source.label}`);
    try {
      write(job.out, await job.build(lines(source)));
    } catch (err) {
      console.error(`   ⚠ échec : ${err.message}`);
      if (job.key === 'opensky') {
        console.error('     (OpenSky demande parfois un compte connecté pour ce fichier —');
        console.error('      télécharge-le à la main puis relance avec --from-dir <dossier>)');
      }
    }
  }

  console.log('\n✅ Terminé. Relance le serveur pour que les données soient chargées.\n');
}

// n'exécute main() que si le script est lancé directement (et pas importé par un test)
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main();
}

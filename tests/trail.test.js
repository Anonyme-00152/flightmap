import './helpers.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';

const { parseTrace, splitLegs, summarizeLeg } = await import('../lib/trail.js');
const ref = await import('../lib/refdata.js');

const BASE = 1_789_200_000; // secondes
const MIN = 60;

/** Fabrique un point tar1090 : [dt, lat, lon, alt|"ground", gs, track, flags, vr, ...] */
const pt = (dt, lat, lon, alt, { gs = 400, flags = 0, vr = 0 } = {}) => [dt, lat, lon, alt, gs, 180, flags, vr, null, 'adsb_icao', null, null, null, null];

test('parseTrace convertit le format tar1090 (sol, altitudes, drapeau nouveau leg)', () => {
  const pts = parseTrace({ timestamp: BASE, trace: [pt(0, 49, 2.5, 'ground', { gs: 10 }), pt(30, 49.1, 2.6, 5000, { flags: 2 }), ['x']] });
  assert.equal(pts.length, 2);
  assert.equal(pts[0].t, BASE * 1000);
  assert.equal(pts[0].onGround, true);
  assert.equal(pts[0].alt, 0);
  assert.equal(pts[1].alt, 5000);
  assert.equal(pts[1].newLeg, true);
  assert.equal(pts[1].t, BASE * 1000 + 30_000);
});

function flight(startSec, { fromLat, fromLon, toLat, toLon, minutes, newLeg = false }) {
  const out = [];
  const n = Math.max(2, Math.round(minutes));
  for (let i = 0; i <= n; i++) {
    const f = i / n;
    const climb = Math.sin(Math.PI * f); // profil monter/descendre
    const alt = i === 0 || i === n ? 'ground' : Math.round(1000 + 34_000 * climb);
    out.push(pt(startSec + i * MIN, fromLat + (toLat - fromLat) * f, fromLon + (toLon - fromLon) * f, alt, { flags: newLeg && i === 0 ? 2 : 0 }));
  }
  return out;
}

test('splitLegs sépare deux vols par la coupure temporelle et par la transition sol → air', () => {
  const raw = [
    ...flight(0, { fromLat: 49.0, fromLon: 2.55, toLat: 43.4, toLon: 5.2, minutes: 60 }),            // CDG → MRS
    ...flight(60 * MIN + 45 * MIN, { fromLat: 43.4, fromLon: 5.2, toLat: 49.0, toLon: 2.55, minutes: 60 }), // 45 min d'escale
  ];
  const legs = splitLegs(parseTrace({ timestamp: BASE, trace: raw }));
  assert.equal(legs.length, 2, 'deux vols');
  assert.ok(legs[0].every((p) => p.t <= BASE * 1000 + 60 * MIN * 1000));
});

test('splitLegs coupe sur le drapeau « nouveau leg » même sans passage au sol', () => {
  const second = flight(31 * MIN, { fromLat: 45, fromLon: 5, toLat: 49, toLon: 2.5, minutes: 30 }).slice(1); // démarre en l'air
  second[0][6] = 2; // readsb : « nouveau leg »
  const raw = [
    ...flight(0, { fromLat: 49, fromLon: 2.5, toLat: 45, toLon: 5, minutes: 30 }).slice(0, -1), // pas de point au sol final
    ...second,
  ];
  const legs = splitLegs(parseTrace({ timestamp: BASE, trace: raw }));
  assert.equal(legs.length, 2);
});

test('splitLegs ignore un leg sans aucun point en l’air (roulage seul)', () => {
  const raw = [pt(0, 49, 2.5, 'ground'), pt(60, 49.001, 2.501, 'ground'), pt(30 * MIN, 49.002, 2.502, 'ground')];
  assert.equal(splitLegs(parseTrace({ timestamp: BASE, trace: raw })).length, 0);
});

test('summarizeLeg : décollage, atterrissage, distance, altitude max, aéroports devinés', () => {
  const raw = flight(0, { fromLat: 49.00896, fromLon: 2.554117, toLat: 43.436, toLon: 5.215, minutes: 60 }); // LFPG → LFML
  const [leg] = splitLegs(parseTrace({ timestamp: BASE, trace: raw }));
  const s = summarizeLeg(leg, { isCurrent: false, now: BASE * 1000 + 3 * 3600_000 });
  assert.equal(s.takeoffAt, new Date((BASE + MIN) * 1000).toISOString(), 'premier point en l’air après le sol');
  assert.equal(s.landedAt, new Date((BASE + 59 * MIN) * 1000).toISOString(), 'dernier point en l’air avant le sol');
  assert.ok(s.distanceKm > 600 && s.distanceKm < 700, `distance ≈ 660 km (${s.distanceKm})`);
  assert.equal(s.maxAlt, 35_000);
  assert.equal(s.complete, true);
  assert.equal(s.points.length, leg.length);
  assert.equal(s.points[0].length, 7, 'format compact [t, lat, lon, alt, gs, track, vr]');
  if (ref.status.airports) {
    assert.equal(s.from?.iata, 'CDG');
    assert.equal(s.to?.iata, 'MRS');
  }
});

test('summarizeLeg : un vol en cours n’a pas d’atterrissage', () => {
  const raw = flight(0, { fromLat: 49, fromLon: 2.5, toLat: 45, toLon: 5, minutes: 40 }).slice(0, 25);
  const [leg] = splitLegs(parseTrace({ timestamp: BASE, trace: raw }));
  const s = summarizeLeg(leg, { isCurrent: true, now: BASE * 1000 + 25 * MIN * 1000 });
  assert.ok(s.takeoffAt);
  assert.equal(s.landedAt, null);
  assert.equal(s.complete, false);
});

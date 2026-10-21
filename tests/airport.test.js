import './helpers.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';

const geo = await import('../lib/geo.js');
const mov = await import('../lib/movements.js');
const ref = await import('../lib/refdata.js');

test('fuseau horaire : pays simple, région US, longitude en Russie, repli nautique', () => {
  assert.equal(geo.airportTimezone({ country: 'FR', lon: 2.5 }), 'Europe/Paris');
  assert.equal(geo.airportTimezone({ country: 'US', region: 'US-CA', lon: -118 }), 'America/Los_Angeles');
  assert.equal(geo.airportTimezone({ country: 'US', region: 'US-NY', lon: -74 }), 'America/New_York');
  assert.equal(geo.airportTimezone({ country: 'RU', lon: 37.6 }), 'Europe/Moscow');
  assert.equal(geo.airportTimezone({ country: 'RU', lon: 131.9 }), 'Asia/Vladivostok');
  assert.equal(geo.airportTimezone({ country: 'ES', lon: -15.4 }), 'Atlantic/Canary');
  assert.equal(geo.airportTimezone({ country: 'ZZ', lon: -45 }), 'Etc/GMT+3');
});

test('fuseau appris auprès d’une API prime sur la déduction', () => {
  geo.learnAirportTimezone('TEST', 'Asia/Tokyo');
  assert.equal(geo.airportTimezone({ icao: 'TEST', country: 'FR', lon: 2 }), 'Asia/Tokyo');
  geo.learnAirportTimezone('TEST2', 'Pas/Un/Fuseau valide');   // ignoré
  assert.equal(geo.airportTimezone({ icao: 'TEST2', country: 'FR', lon: 2 }), 'Europe/Paris');
});

test('lever / coucher du soleil : Strasbourg le 13/09/2026 (07:03 / 19:48 locale), pôle en été', () => {
  const s = geo.sunTimes(48.5383, 7.62823, new Date('2026-09-13T12:00:00Z'));
  const local = (iso) => new Date(iso).toLocaleTimeString('fr-FR', { timeZone: 'Europe/Paris', hour: '2-digit', minute: '2-digit' });
  assert.equal(local(s.sunrise), '07:03');
  assert.equal(local(s.sunset), '19:48');
  assert.equal(geo.sunTimes(78.2, 15.6, new Date('2026-06-21T12:00:00Z')).polar, 'day');
  assert.equal(geo.sunTimes(78.2, 15.6, new Date('2026-12-21T12:00:00Z')).polar, 'night');
});

test('nom de pays en français', () => {
  assert.equal(geo.countryName('FR'), 'France');
  assert.equal(geo.countryName('DE'), 'Allemagne');
});

test('mouvements : décollage sol → air, atterrissage air → sol, piste, statistiques', () => {
  if (!ref.status.airports) return;   // référentiel absent : rien à tester
  const cdg = { lat: 49.00896, lon: 2.554117 };
  const base = { hex: 'abc001', callsign: 'TST100', type: 'A320', lat: cdg.lat, lon: cdg.lon, track: 265 };
  const now = Date.now();
  // décollage : au sol puis en l'air à 800 ft, cap 265 → piste 26x/27x
  mov.observe({ ...base, onGround: true, alt: 0 }, { ...base, onGround: false, alt: 800, vertRate: 1500, lat: cdg.lat + 0.01, lon: cdg.lon - 0.05 }, now - 5000, now);
  // atterrissage : bas et en descente puis au sol
  const land = { ...base, hex: 'abc002', callsign: 'TST200', track: 88 };
  mov.observe({ ...land, onGround: false, alt: 300, vertRate: -600 }, { ...land, onGround: true, alt: 0 }, now - 5000, now + 1000);
  // première apparition en descente : PAS un décollage
  mov.observe(null, { ...base, hex: 'abc003', callsign: 'TST300', onGround: false, alt: 2000, vertRate: -700 }, null, now + 2000);

  const s = mov.airportStats('LFPG', 7, 'Europe/Paris');
  assert.equal(s.takeoffs >= 1, true);
  assert.equal(s.landings >= 1, true);
  assert.ok(!s.latest.some((m) => m.hex === 'abc003'), 'un avion vu pour la première fois en finale n’est pas un décollage');
  const to = s.latest.find((m) => m.hex === 'abc001');
  assert.ok(to.runway && /^2[67]/.test(to.runway), `piste de décollage cohérente avec le cap 265 : ${to.runway}`);
  assert.equal(s.perDay.length, 7);
  assert.equal(s.perHour.length, 24);
});

test('piste par cap : orientation la plus proche (≤ 25°), sinon null', () => {
  if (!ref.status.runways) return;
  assert.ok(/^0[89]/.test(mov.runwayFor('LFPG', 85) || ''));
  assert.equal(mov.runwayFor('LFPG', 180), null);
  assert.equal(mov.runwayFor('LFPG', null), null);
});

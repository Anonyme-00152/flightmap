import './helpers.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';

const { detectGoArounds, detectHolding, detectLegEvents, recordEvents, recentEvents } = await import('../lib/events.js');
const { toIcaoCallsign, predictDuration } = await import('../lib/registry.js');
const { toGpx, toKml, toCsv } = await import('../lib/export.js');
const { runwaysByWind } = await import('../lib/airport.js');
const store = await import('../lib/store.js');
const ref = await import('../lib/refdata.js');

const MIN = 60_000;
const pt = (t, lat, lon, alt, extra = {}) => ({ t, lat, lon, alt, onGround: alt === 0, gs: 250, track: 90, vr: 0, ...extra });

test('remise de gaz : descente sous 2 500 ft puis remontée franche près d’un aéroport', () => {
  // approche de CDG (49.009, 2.55) plein est, jusqu'à 900 ft, puis remontée
  const pts = [];
  for (let i = 0; i < 8; i++) pts.push(pt(i * MIN, 49.009, 2.30 + i * 0.03, 3000 - i * 300, { vr: -700 }));
  pts.push(pt(8 * MIN, 49.009, 2.54, 900, { vr: -500 }));
  for (let i = 1; i <= 4; i++) pts.push(pt((8 + i) * MIN, 49.009, 2.54 + i * 0.03, 900 + i * 700, { vr: 1500 }));
  const ev = detectGoArounds(pts);
  if (!ref.status.airports) return;   // sans référentiel, pas d'aéroport → pas d'événement (comportement voulu)
  assert.equal(ev.length, 1);
  assert.equal(ev[0].type, 'go_around');
  assert.equal(ev[0].minAlt, 900);
  assert.equal(ev[0].airport.iata, 'CDG');
});

test('pas de remise de gaz si l’avion touche le sol (atterrissage normal)', () => {
  const pts = [pt(0, 49, 2.4, 2000, { vr: -600 }), pt(MIN, 49, 2.5, 800, { vr: -500 }), pt(2 * MIN, 49, 2.55, 0), pt(3 * MIN, 49, 2.56, 0)];
  assert.equal(detectGoArounds(pts).length, 0);
});

test('attente en hippodrome : ≥ 330° de virage cumulé en < 12 min sans s’éloigner', () => {
  const pts = [];
  // 2 tours complets en 10 min autour d'un point, à 8 000 ft
  for (let i = 0; i <= 20; i++) {
    const a = (i * 36) % 360;
    pts.push(pt(i * 30_000, 48.5 + 0.02 * Math.cos((a * Math.PI) / 180), 2.5 + 0.03 * Math.sin((a * Math.PI) / 180), 8000, { track: (a + 90) % 360 }));
  }
  const ev = detectHolding(pts);
  assert.equal(ev.length, 1);
  assert.equal(ev[0].type, 'holding');
  assert.ok(ev[0].turns >= 1.5, `tours : ${ev[0].turns}`);
  assert.ok(ev[0].durationMin >= 4);
});

test('vol rectiligne : aucun événement', () => {
  const pts = [];
  for (let i = 0; i < 30; i++) pts.push(pt(i * MIN, 48 + i * 0.05, 2 + i * 0.05, 35000));
  assert.equal(detectHolding(pts).length, 0);
  assert.equal(detectGoArounds(pts).length, 0);
});

test('retour au départ et déroutement détectés depuis le résumé du vol', () => {
  const pts = [pt(0, 49, 2.5, 0), pt(10 * MIN, 49.5, 2.5, 20000), pt(30 * MIN, 49, 2.5, 0)];
  const cdg = { iata: 'CDG', icao: 'LFPG', name: 'CDG' };
  const evRet = detectLegEvents(pts, { from: cdg, to: cdg, complete: true, durationMin: 30 });
  assert.ok(evRet.some((e) => e.type === 'return'));
  const evDiv = detectLegEvents(pts, { from: cdg, to: { iata: 'ORY', icao: 'LFPO' }, complete: true, durationMin: 30 }, { destination: { iata: 'MRS' } });
  assert.ok(evDiv.some((e) => e.type === 'diverted' && e.actual.iata === 'ORY' && e.planned.iata === 'MRS'));
});

test('flux des événements récents : dédoublonné, les plus récents d’abord', () => {
  const now = Date.now();
  const e = (type, t) => ({ type, label: type, t: new Date(t).toISOString(), lat: 0, lon: 0 });
  recordEvents('aaaaaa', 'TST1', [e('holding', now - 60_000), e('holding', now - 61_000)]);   // même événement à 5 min près
  recordEvents('bbbbbb', 'TST2', [e('go_around', now - 10_000)]);
  const list = recentEvents(10);
  assert.equal(list.filter((x) => x.hex === 'aaaaaa').length, 1);
  assert.equal(list[0].hex, 'bbbbbb');
});

test('toIcaoCallsign : AF1496 → AFR1496, AFR1496 inchangé, inconnu inchangé', () => {
  assert.equal(toIcaoCallsign('AF1496'), 'AFR1496');
  assert.equal(toIcaoCallsign('af 1496'), 'AFR1496');
  assert.equal(toIcaoCallsign('AFR1496'), 'AFR1496');
  assert.equal(toIcaoCallsign('ZZ9999'), 'ZZ9999');
});

test('prédiction de durée : médiane des vols complets du même callsign', () => {
  const now = Date.now();
  const mk = (daysAgo, durMin) => {
    const start = now - daysAgo * 86_400_000;
    return { start: new Date(start).toISOString(), end: new Date(start + durMin * MIN).toISOString(), takeoffAt: new Date(start).toISOString(), landedAt: new Date(start + durMin * MIN).toISOString(), complete: true, durationMin: durMin, callsign: 'TST123', from: { iata: 'CDG' }, to: { iata: 'MRS' } };
  };
  store.legUpsert('c0ffee', mk(1, 70));
  store.legUpsert('c0ffee', mk(2, 80));
  store.legUpsert('c0ffee', mk(3, 75));
  store.legUpsert('c0ffee', { ...mk(4, 5), complete: false });   // incomplet : ignoré
  const p = predictDuration('TST123');
  assert.equal(p.samples, 3);
  assert.equal(p.medianMin, 75);
  assert.equal(predictDuration('NOPE1'), null);
});

test('export : GPX / KML / CSV bien formés', () => {
  const leg = { start: '2026-09-12T10:00:00.000Z', callsign: 'TST1', from: { iata: 'CDG' }, to: { iata: 'MRS' }, maxAlt: 35000, distanceKm: 660,
    points: [[1789200000000, 49.0, 2.5, 0, 10, 90, 0], [1789200600000, 48.5, 3.0, 35000, 450, 150, 0]] };
  const gpx = toGpx(leg, 'abcdef');
  assert.ok(gpx.startsWith('<?xml') && gpx.includes('<trkpt lat="48.5" lon="3"') && gpx.includes('<ele>10668</ele>'));
  const kml = toKml(leg, 'abcdef');
  assert.ok(kml.includes('<gx:Track>') && kml.includes('3,48.5,10668'));
  const csv = toCsv(leg, 'abcdef');
  assert.equal(csv.trim().split('\n').length, 4);   // commentaire + en-tête + 2 lignes
  assert.ok(csv.includes('2026-09-12T'));
});

test('piste en service : le seuil avec le meilleur vent de face', () => {
  const runways = [{ name: '09/27', ends: [{ ident: '09', heading: 90 }, { ident: '27', heading: 270 }] }];
  assert.equal(runwaysByWind(runways, 260, 15)[0].end, '27');
  assert.equal(runwaysByWind(runways, 100, 15)[0].end, '09');
  assert.equal(runwaysByWind(runways, null, 15).length, 0);
});

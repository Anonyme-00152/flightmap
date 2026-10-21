import './helpers.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';

const { pickFlight, localToUtc, SCHEDULE_ENABLED, getSchedule } = await import('../lib/schedule.js');

test('localToUtc réinterprète une heure locale avec le fuseau de l’aéroport (piège Aviationstack)', () => {
  // 12 septembre : Paris est en UTC+2, Casablanca en UTC+1
  assert.equal(localToUtc('2026-09-12T18:50:00+00:00', 'Europe/Paris'), '2026-09-12T16:50:00.000Z');
  assert.equal(localToUtc('2026-09-12T21:00', 'Africa/Casablanca'), '2026-09-12T20:00:00.000Z');
  // 15 janvier : Paris en UTC+1
  assert.equal(localToUtc('2026-01-15T08:00', 'Europe/Paris'), '2026-01-15T07:00:00.000Z');
  // sans fuseau : on suppose UTC
  assert.equal(localToUtc('2026-09-12T10:00', null), '2026-09-12T10:00:00.000Z');
  assert.equal(localToUtc('n/a', 'Europe/Paris'), null);
});

test('pickFlight préfère le vol de l’exploitant réel, pas le codeshare qui partage le même avion', () => {
  const list = [
    { flight: { icao: 'KLM2116', iata: 'KL2116', codeshared: { flight_icao: 'afr1496' } }, aircraft: { icao24: '392AEC' }, flight_status: 'active' },
    { flight: { icao: 'AFR1496', iata: 'AF1496', codeshared: null }, aircraft: { icao24: '392AEC' }, flight_status: 'active' },
    { flight: { icao: 'DAL8412', iata: 'DL8412', codeshared: { flight_icao: 'afr1496' } }, aircraft: { icao24: '392AEC' }, flight_status: 'scheduled' },
  ];
  const picked = pickFlight(list, {
    byHex: (x) => x.aircraft?.icao24?.toLowerCase() === '392aec',
    byCallsign: (x) => x.flight?.icao === 'AFR1496',
    isOperator: (x) => !x.flight?.codeshared,
    isActive: (x) => x.flight_status === 'active',
  });
  assert.equal(picked.flight.iata, 'AF1496');
});

test('pickFlight : sans indice fort, le vol actif et opérateur gagne ; liste vide → null', () => {
  assert.equal(pickFlight([], {}), null);
  const list = [
    { id: 'a', status: 'scheduled', cs: false },
    { id: 'b', status: 'active', cs: true },
    { id: 'c', status: 'active', cs: false },
  ];
  const picked = pickFlight(list, { isOperator: (x) => !x.cs, isActive: (x) => x.status === 'active' });
  assert.equal(picked.id, 'c');
});

test('sans clé configurée, les horaires sont désactivés et ne coûtent rien', async () => {
  assert.equal(SCHEDULE_ENABLED, false);
  assert.equal(await getSchedule({ callsign: 'AFR1496', hex: '392aec' }), null);
});

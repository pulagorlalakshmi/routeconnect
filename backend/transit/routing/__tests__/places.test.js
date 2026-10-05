// Place search, name-based planning, and the "no route -> no fabricated alternative" rule.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { makeNetwork, daily, testConfig, NOW } from './helpers.js';
import { normalizePlaceName, searchPlaces, resolvePlace, handlePlaceSearch } from '../placeSearch.js';
import { handlePlanRequest, NO_ROUTE_MESSAGE } from '../planner.js';

const spec = {
  stops: {
    V1: [16.5089, 80.6166], V2: [16.5110, 80.6200], G1: [16.2961, 80.4563], G2: [16.3010, 80.4400],
    K1: [16.70, 81.40], K2: [17.50, 79.00], H1: [17.3769, 78.4838], O1: [15.5110, 80.0416], X1: [18.9, 82.9]
  },
  stopNames: {
    V1: 'VIJAYAWADA', V2: 'VIJAYAWADA BUS STATION', G1: 'GUNTUR', G2: 'GUNTUR JUNCTION',
    K1: 'KALLA', K2: 'KALLA', H1: 'HYDERABAD MGBS', O1: 'ONGOLE', X1: 'ORPHAN'
  },
  trips: [
    { id: 'T1', route: 'R1', service: 'ALL', times: [['V1', '08:00'], ['G1', '08:45']] },
    { id: 'T2', route: 'R1', service: 'ALL', times: [['V2', '09:00'], ['G2', '09:45']] },
    { id: 'T3', route: 'R2', service: 'ALL', times: [['K1', '08:00'], ['V1', '09:00']] },
    { id: 'T4', route: 'R3', service: 'ALL', times: [['K2', '08:00'], ['H1', '10:00']] },
    { id: 'T5', route: 'R4', service: 'ALL', times: [['O1', '08:00'], ['G1', '10:00']] }
  ],
  calendars: [daily()]
};
const network = makeNetwork(spec);
const config = testConfig();
const getNetwork = () => network;
const plan = query => handlePlanRequest({ date: '2026-10-05', time: '07:30', windowMinutes: '120', ...query }, { config, now: NOW, getNetwork });

describe('place name normalisation', () => {
  test('generic transport words are dropped so "Vijayawada Bus Station" finds Vijayawada', () => {
    assert.equal(normalizePlaceName('Vijayawada Bus Station'), 'vijayawada');
    assert.equal(normalizePlaceName('GUNTUR  Junction'), 'guntur');
    assert.equal(normalizePlaceName('  Bhimavaram Railway Station '), 'bhimavaram');
    assert.equal(normalizePlaceName('Hyderabad (MGBS)'), 'hyderabad mgbs');
    assert.equal(normalizePlaceName('Bus Station'), 'bus station', 'a name made only of generic words is kept');
  });
});

describe('place search over GTFS stops', () => {
  test('nearby stops with the same normalised name are one place; far-apart namesakes are not merged', () => {
    const vijayawada = searchPlaces(network, 'vijayawada');
    assert.equal(vijayawada.length, 1);
    assert.equal(vijayawada[0].name, 'Vijayawada');
    assert.equal(vijayawada[0].stopCount, 2);
    assert.equal(searchPlaces(network, 'kalla').length, 2, 'two different villages called Kalla stay separate');
  });

  test('exact beats prefix, prefix beats contains; results are ranked by match quality then service count', () => {
    assert.equal(searchPlaces(network, 'guntur')[0].matchedBy, 'exact');
    assert.equal(searchPlaces(network, 'hyd')[0].name, 'Hyderabad Mgbs');
    assert.equal(searchPlaces(network, 'hyd')[0].matchedBy, 'prefix');
    assert.equal(searchPlaces(network, 'yderabad')[0].matchedBy, 'contains');
    assert.deepEqual(searchPlaces(network, 'v').map(p => p.name), ['Vijayawada']);
  });

  test('only served stops are offered: an unserved stop is never suggested', () => {
    assert.deepEqual(searchPlaces(network, 'orphan'), []);
    assert.equal(resolvePlace(network, 'Orphan'), null);
  });

  test('nothing is invented for unknown text, and limits are respected', () => {
    assert.deepEqual(searchPlaces(network, 'Atlantis'), []);
    assert.deepEqual(searchPlaces(network, ''), []);
    assert.equal(searchPlaces(network, 'kalla', { limit: 1 }).length, 1);
  });

  test('resolve returns coordinates inside the place', () => {
    const place = resolvePlace(network, 'Vijayawada Bus Station');
    assert.ok(Math.abs(place.lat - 16.5) < 0.05 && Math.abs(place.lon - 80.6) < 0.05);
  });

  test('GET /api/v2/places validation and responses', () => {
    assert.equal(handlePlaceSearch({}, getNetwork).status, 400);
    assert.equal(handlePlaceSearch({ query: '' }, getNetwork).status, 400);
    assert.equal(handlePlaceSearch({ query: ['a', 'b'] }, getNetwork).status, 400);
    assert.equal(handlePlaceSearch({ query: 'x'.repeat(200) }, getNetwork).status, 400);
    assert.equal(handlePlaceSearch({ query: 'v', limit: '0' }, getNetwork).status, 400);
    assert.equal(handlePlaceSearch({ query: 'v', limit: '99' }, getNetwork).status, 400);
    assert.equal(handlePlaceSearch({ query: 'v' }, () => null).status, 503);
    assert.equal(handlePlaceSearch({ query: 'v' }, () => { throw new Error('C:\\secret.db'); }).status, 500);
    const ok = handlePlaceSearch({ query: 'vij', limit: '5' }, getNetwork);
    assert.equal(ok.status, 200);
    assert.equal(ok.body.places[0].name, 'Vijayawada');
    assert.ok(!JSON.stringify(ok.body).includes('secret'));
  });
});

describe('GET /api/v2/plan with place names', () => {
  test('names are resolved to stops, reported back, and planned like coordinates', () => {
    const { status, body } = plan({ from: 'Vijayawada', to: 'Guntur' });
    assert.equal(status, 200);
    assert.equal(body.resolved.from.name, 'Vijayawada');
    assert.equal(body.resolved.from.matchedBy, 'exact');
    assert.equal(body.resolved.to.name, 'Guntur');
    assert.ok(body.journeys.length >= 1);
    assert.equal(body.message, null);
    assert.equal(body.journeys[0].legs.find(l => l.mode === 'bus').tripId, 'T1');
  });

  test('typing a stop-type suffix still resolves ("Guntur Junction" -> Guntur)', () => {
    assert.equal(plan({ from: 'Vijayawada Bus Station', to: 'Guntur Junction' }).status, 200);
  });

  test('coordinates take precedence over names', () => {
    const { body } = plan({ from: 'Hyderabad', fromLat: '16.5089', fromLng: '80.6166', to: 'Guntur' });
    assert.equal(body.resolved.from, null, 'the name was ignored');
    assert.equal(body.resolved.to.name, 'Guntur');
    assert.equal(body.query.fromLat, 16.5089);
  });

  test('404 PLACE_NOT_FOUND names the end that could not be resolved', () => {
    const { status, body } = plan({ from: 'Vijayawada', to: 'Atlantis' });
    assert.equal(status, 404);
    assert.equal(body.code, 'PLACE_NOT_FOUND');
    assert.equal(body.place, 'to');
    assert.equal(body.query, 'Atlantis');
    assert.equal(plan({ from: 'Orphan', to: 'Guntur' }).body.place, 'from');
  });

  test('400 for repeated or oversized names, 503 without data', () => {
    assert.equal(plan({ from: ['a', 'b'], to: 'Guntur' }).status, 400);
    assert.equal(plan({ from: 'x'.repeat(500), to: 'Guntur' }).status, 400);
    assert.equal(handlePlanRequest({ from: 'Vijayawada', to: 'Guntur' }, { config, now: NOW, getNetwork: () => null }).status, 503);
  });
});

describe('no route: no fabricated alternative', () => {
  const noRoute = () => plan({ from: 'Hyderabad', to: 'Ongole' }); // no connection between them in this network

  test('the exact message is returned with zero journeys', () => {
    const { status, body } = noRoute();
    assert.equal(status, 200);
    assert.deepEqual(body.journeys, []);
    assert.equal(body.message, 'No timetable-supported public-transport journey was found within the configured access range.');
    assert.equal(body.message, NO_ROUTE_MESSAGE);
    assert.deepEqual(body.winners, { fastest: null, leastTransfers: null, bestBalanced: null, lowerEstimatedCost: null });
  });

  test('nothing but public transport is ever offered: no ride-hailing, taxi, auto, fare or estimate fields', () => {
    const text = JSON.stringify(noRoute().body);
    assert.ok(!/uber|rapido|taxi|\bcab\b|\bauto\b|ride-?hail|availability/i.test(text), 'no alternative mode may appear');
    assert.ok(!/"(price|fare)":\s*[0-9]/.test(text));
  });

  test('a destination with no stop nearby also yields the same message, with the specific reason as a warning', () => {
    const { body } = plan({ fromLat: '16.5089', fromLng: '80.6166', toLat: '25', toLng: '70' });
    assert.deepEqual(body.journeys, []);
    assert.equal(body.message, NO_ROUTE_MESSAGE);
    assert.ok(body.warnings.some(w => w.code === 'NO_STOPS_NEAR_DESTINATION'));
  });
});

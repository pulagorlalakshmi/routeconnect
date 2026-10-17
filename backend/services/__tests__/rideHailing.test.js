// Ride-hailing honesty tests. Runs the real planner against a throw-away database with the network disabled
// (no Google / Nominatim / Overpass calls). Environment must be prepared BEFORE the engine is imported.
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rc-ride-test-'));
process.env.ROUTECONNECT_DATABASE_PATH = path.join(tempDir, 'test.db');
const realFetch = globalThis.fetch;
globalThis.fetch = async () => { throw new Error('network disabled in tests'); };

const { db, initializeDatabase } = await import('../../db/database.js');
const { findMultiModalRoutes, createGpsRideOptions } = await import('../routingEngine.js');
const {
  RIDE_HAILING_ESTIMATE_METADATA, stampRideHailingRoute, isRideHailingRoute, isRideHailingSegment, isLegacyRideHailingEnabled
} = await import('../rideHailing.js');

const GPS_BHIMAVARAM = { latitude: 16.5449, longitude: 81.5212 };
const GPS_ONGOLE = { latitude: 15.50, longitude: 80.04 };
const CURRENT = '📍 Current Location';
const TRUSTED_TAGS = ['fastest', 'budget', 'cheapest', 'best', 'recommended'];

const rideLegs = route => route.segments.filter(isRideHailingSegment);
const search = (from, to, origin = null) => findMultiModalRoutes(from, to, '2026-10-05', null, 1, origin);

before(() => initializeDatabase());
after(() => {
  globalThis.fetch = realFetch;
  try { db.close(); } catch { /* already closed */ }
  fs.rmSync(tempDir, { recursive: true, force: true });
});

function assertHonestRideRoute(route) {
  assert.equal(route.providerIntegration, false);
  assert.notEqual(route.availabilityStatus, 'Available');
  assert.notEqual(route.availabilityStatus, 'verified');
  assert.equal(route.availabilityStatus, 'unknown');
  assert.equal(route.dataConfidence, 'estimated');
  assert.equal(route.fareConfidence, 'estimated');
  assert.equal(route.durationConfidence, 'estimated');
  assert.equal(route.isRealtime, false);
  assert.equal(route.rankingClass, 'estimated_ride_hailing');
  assert.equal(route.tag, null, 'estimated ride-hailing must not carry a ranking tag');
  assert.equal(route.isFastest, false);
  assert.equal(route.isBudget, false);
  assert.ok(!/available/i.test(route.routeName), `route name must not claim availability: ${route.routeName}`);
  for (const leg of rideLegs(route)) {
    assert.equal(leg.providerIntegration, false);
    assert.equal(leg.availabilityStatus, 'unknown');
    assert.equal(leg.dataConfidence, 'estimated');
    assert.equal(leg.fareConfidence, 'estimated');
    assert.equal(leg.durationConfidence, 'estimated');
    assert.equal(leg.isRealtime, false);
    assert.equal(leg.estimated, true);
  }
}

describe('ride-hailing metadata', () => {
  test('the shared estimate metadata is exactly what we promise', () => {
    assert.deepEqual({ ...RIDE_HAILING_ESTIMATE_METADATA }, {
      providerIntegration: false,
      availabilityStatus: 'unknown',
      dataConfidence: 'estimated',
      fareConfidence: 'estimated',
      durationConfidence: 'estimated',
      isRealtime: false
    });
  });

  test('createGpsRideOptions yields honest Uber and Rapido estimates', () => {
    const options = createGpsRideOptions('📍 Current Location', 'Somewhere', 12);
    assert.equal(options.length, 2);
    assert.deepEqual(options.map(o => o.segments[0].mode).sort(), ['rapido', 'uber']);
    for (const option of options) assertHonestRideRoute(option);
  });

  test('stamping overrides a stale "Available" status and strips trusted tags', () => {
    const dirty = {
      tag: 'fastest', isFastest: true, isBudget: true, availabilityStatus: 'Available',
      segments: [{ mode: 'uber', availabilityStatus: 'Available' }]
    };
    const stamped = stampRideHailingRoute(dirty);
    assert.equal(stamped.availabilityStatus, 'unknown');
    assert.equal(stamped.segments[0].availabilityStatus, 'unknown');
    assert.equal(stamped.tag, null);
    assert.equal(stamped.isFastest, false);
    assert.equal(stamped.isBudget, false);
  });

  test('non-ride routes are left untouched', () => {
    const route = { tag: 'fastest', segments: [{ mode: 'bus' }] };
    assert.equal(isRideHailingRoute(route), false);
    assert.equal(stampRideHailingRoute(route), route);
  });
});

// ---------------------------------------------------------------------------------------------------------------------
// PRODUCT DECISION: ride-hailing is off. These tests pin the default behaviour.
// ---------------------------------------------------------------------------------------------------------------------
describe('product decision: ride-hailing is OFF by default', () => {
  test('the development switch is off unless explicitly set to "1"', () => {
    assert.equal(isLegacyRideHailingEnabled({}), false);
    assert.equal(isLegacyRideHailingEnabled({ ROUTECONNECT_LEGACY_RIDE_HAILING: 'true' }), false);
    assert.equal(isLegacyRideHailingEnabled({ ROUTECONNECT_LEGACY_RIDE_HAILING: '0' }), false);
    assert.equal(isLegacyRideHailingEnabled({ ROUTECONNECT_LEGACY_RIDE_HAILING: '1' }), true);
    assert.equal(process.env.ROUTECONNECT_LEGACY_RIDE_HAILING, undefined, 'tests must start with the switch unset');
  });

  test('a GPS search never produces Uber/Rapido options, priced or not, even on a short trip', async () => {
    // Vijayawada from a Bhimavaram GPS fix used to be served only by sample "Bus + Train" routes; with the unverified
    // legacy train data disabled (trainDataPolicy.js) it may legitimately return nothing, but never a ride-hailing option.
    for (const [to, origin, expectRoutes] of [['Ongole Railway Station', GPS_ONGOLE, true], ['Kalla Bus Stop', GPS_BHIMAVARAM, true], ['Vijayawada', GPS_BHIMAVARAM, false]]) {
      const routes = await search(CURRENT, to, origin);
      if (expectRoutes) assert.ok(routes.length > 0, `public-transport routes are still returned for ${to}`);
      for (const route of routes) {
        assert.equal(isRideHailingRoute(route), false, `ride-hailing leaked into ${to}`);
        assert.ok(!/uber|rapido/i.test(JSON.stringify(route)), `ride-hailing text leaked into ${to}`);
        assert.equal(route.rankingClass, undefined);
        assert.equal(route.providerIntegration, undefined);
      }
    }
  });
});

// The remaining ride-hailing tests exercise the DEVELOPMENT-ONLY code path (switch on) to prove that, even then,
// estimates are honestly labelled and never ranked. End users never get this path.
describe('development switch on: legacy estimates stay honest', () => {
  before(() => { process.env.ROUTECONNECT_LEGACY_RIDE_HAILING = '1'; });
  after(() => { delete process.env.ROUTECONNECT_LEGACY_RIDE_HAILING; });

  test('Uber/Rapido are present, honest and listed last', async () => {
    const routes = await search(CURRENT, 'Ongole Railway Station', GPS_ONGOLE);
    const rides = routes.filter(isRideHailingRoute);
    assert.ok(rides.length >= 2, 'expected Uber and Rapido estimates');
    for (const ride of rides) assertHonestRideRoute(ride);
    const firstRideIndex = routes.findIndex(isRideHailingRoute);
    assert.ok(routes.slice(firstRideIndex).every(isRideHailingRoute), 'ride-hailing must come after non-ride options');
  });
});

describe('development switch on: GPS trip with timetable-backed alternatives', () => {
  let routes;
  before(async () => {
    process.env.ROUTECONNECT_LEGACY_RIDE_HAILING = '1';
    routes = await search(CURRENT, 'Kalla Bus Stop', GPS_BHIMAVARAM);
  });
  after(() => { delete process.env.ROUTECONNECT_LEGACY_RIDE_HAILING; });

  test('estimated rides are shown but never carry Fastest / Budget / Recommended', () => {
    const rides = routes.filter(isRideHailingRoute);
    assert.ok(rides.length >= 2);
    for (const ride of rides) {
      assertHonestRideRoute(ride);
      assert.ok(!TRUSTED_TAGS.includes(ride.tag));
    }
  });

  test('rides are faster on paper yet do not steal the trusted "fastest"', () => {
    const trusted = routes.filter(r => !isRideHailingRoute(r));
    const minTrustedDuration = Math.min(...trusted.map(r => r.totalDurationMinutes));
    const minRideDuration = Math.min(...routes.filter(isRideHailingRoute).map(r => r.totalDurationMinutes));
    assert.ok(minRideDuration < minTrustedDuration, 'precondition: the formula makes rides look faster');

    const fastest = trusted.filter(r => r.isFastest);
    assert.ok(fastest.length >= 1, 'a timetable-backed route must still win "fastest"');
    for (const route of fastest) assert.equal(route.totalDurationMinutes, minTrustedDuration);
    assert.ok(trusted.some(r => r.tag === 'budget'), 'budget tag still goes to a timetable-backed route');
    assert.ok(trusted.some(r => r.tag === 'best'), 'best tag still goes to a timetable-backed route');
  });

  test('timetable-backed routes come first and are numbered consecutively', () => {
    const firstRideIndex = routes.findIndex(isRideHailingRoute);
    assert.ok(firstRideIndex > 0);
    assert.ok(routes.slice(firstRideIndex).every(isRideHailingRoute));
    routes.forEach((route, index) => assert.ok(route.routeName.startsWith(`Route ${index + 1} – `), route.routeName));
  });
});

describe('planner: public transit behaviour is unchanged', () => {
  test('no ride-hailing and no ride metadata without a GPS origin', async () => {
    const routes = await search('Bhimavaram', 'Vijayawada');
    assert.ok(routes.length > 0);
    for (const route of routes) {
      assert.equal(isRideHailingRoute(route), false);
      assert.equal(route.rankingClass, undefined);
      assert.equal(route.providerIntegration, undefined);
    }
  });

  // The pre-change golden output also contained sample trains (now disabled, see trainDataPolicy.js). Every BUS route
  // of that golden output must survive unchanged: [name without the "Route N – " prefix, price, minutes, transfers].
  const busCore = r => [r.routeName.replace(/^Route \d+ – /, ''), r.totalPrice, r.totalDurationMinutes, r.totalTransfers];
  const noTrainLegs = routes => routes.every(r => r.segments.every(s => s.mode !== 'train' && !s.trainNumber));

  test('Bhimavaram -> Vijayawada keeps every pre-change bus route and returns no sample trains', async () => {
    const routes = await search('Bhimavaram', 'Vijayawada');
    assert.ok(noTrainLegs(routes));
    const cores = routes.map(busCore);
    for (const expected of [['Bus Only', 320, 170, 0]]) assert.ok(cores.some(c => JSON.stringify(c) === JSON.stringify(expected)), JSON.stringify(expected));
    // Golden output after the train data was disabled: [routeName, tag, price, minutes, transfers].
    assert.deepEqual(routes.map(r => [r.routeName, r.tag, r.totalPrice, r.totalDurationMinutes, r.totalTransfers]), [
      ['Route 1 – Bus Only', 'fastest', 320, 170, 0],
      ['Route 2 – Bus Only', 'budget', 140, 250, 0],
      ['Route 3 – Bus Only', 'best', 180, 195, 0],
      ['Route 4 – Bus Only', null, 240, 185, 0],
      ['Route 5 – Route – Bus Only via Eluru Bus Station', null, 240, 200, 1],
      ['Route 6 – Route – Bus Only via Tadepalligudem Bus Station', null, 240, 201, 1],
      ['Route 7 – Route – Bus Only via Tanuku Bus Station', null, 220, 214, 1],
      ['Route 8 – Route – Bus via Undi & Tanuku Bus Station', null, 312, 287, 2]
    ]);
  });

  test('Narasaraopet -> Ongole (corridor) keeps every pre-change bus route and returns no sample trains', async () => {
    const routes = await search('Narasaraopet', 'Ongole');
    assert.ok(noTrainLegs(routes));
    const cores = routes.map(busCore);
    for (const expected of [
      ['Bus Only: Via Addanki', 110, 105, 1],
      ['Bus Only: Via Chilakaluripeta', 125, 115, 1],
      ['Bus Only', 101, 119, 2],
      ['Bus Only', 115, 132, 2],
      ['Bus Only', 144, 148, 2]
    ]) assert.ok(cores.some(c => JSON.stringify(c) === JSON.stringify(expected)), JSON.stringify(expected));
    assert.equal(routes.length, 5);
  });
});

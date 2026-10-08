// Progressive access / egress search: staged radii, hub scoring, window widening, failure classification, sanity rules.
// Synthetic networks only; nothing here names a real place.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { makeNetwork, plan, daily, testConfig } from './helpers.js';
import { getHubMetrics, hubScore, getConnectivity } from '../hubs.js';
import { buildAccessStages, createServiceCounter, selectFeederCandidates } from '../feeder.js';
import { buildServiceDays, NO_ROUTE_MESSAGE } from '../planner.js';
import { buildWindows } from '../diagnostics.js';
import { getRoutingConfig } from '../config.js';

const STAGES = { feederStageRadiiMeters: [5000, 10000, 20000, 30000], hubStageRadiiMeters: [40000, 50000] };
const O = { lat: 16.5, lon: 80.0 };
const lonAt = km => 80.0 + km / 106.7; // longitude km east of O at this latitude
const trip = (id, route, a, b, ta, tb, service = 'ALL') => ({ id, route, service, times: [[a, ta], [b, tb]] });
const run = (spec, options = {}, config = {}) => plan(makeNetwork(spec), spec, { time: '07:00', windowMinutes: 120, ...options, config: { ...STAGES, ...config } });
const searchedStages = result => result.search.stages.filter(stage => stage.searched).map(stage => stage.name);

describe('progressive radii', () => {
  test('the default stages are walk, then widening local-feeder radii, then extended hub radii', () => {
    const stages = buildAccessStages(getRoutingConfig({}, {}));
    assert.deepEqual(stages.map(s => s.name), ['walk', 'feeder-5km', 'feeder-10km', 'feeder-20km', 'feeder-30km', 'hub-40km', 'hub-50km']);
    assert.deepEqual(stages.map(s => s.kind), ['walk', 'feeder', 'feeder', 'feeder', 'feeder', 'hub', 'hub']);
    assert.deepEqual(buildAccessStages(testConfig()).map(s => s.name), ['walk'], 'rides can be switched off');
  });

  test('a hub 8 km away is found at the 10 km stage and nothing wider is searched', () => {
    const spec = { stops: { H: [16.5, lonAt(8)], T: [16.5, lonAt(32)] }, trips: [trip('H1', 'R1', 'H', 'T', '08:00', '08:40'), trip('H2', 'R1', 'H', 'T', '09:00', '09:40')], calendars: [daily()] };
    const result = run(spec, { from: O, to: 'T' });
    assert.ok(result.journeys.length > 0);
    assert.equal(result.search.stageUsed, 'feeder-10km');
    assert.deepEqual(searchedStages(result), ['feeder-10km'], 'the 5 km stage had no candidate; the 20/30/40/50 km stages were never needed');
    assert.equal(result.search.radiusUsedMeters, 10000);
  });

  test('a hub 24 km away is only reached by the 30 km stage', () => {
    const spec = { stops: { H: [16.5, lonAt(24)], T: [16.5, lonAt(70)] }, trips: [trip('H1', 'R1', 'H', 'T', '09:00', '10:00'), trip('H2', 'R1', 'H', 'T', '10:00', '11:00')], calendars: [daily()] };
    const result = run(spec, { from: O, to: 'T', windowMinutes: 180 });
    assert.ok(result.journeys.length > 0, JSON.stringify(result.diagnostics));
    assert.equal(result.search.stageUsed, 'feeder-30km');
    assert.equal(result.search.stages.find(s => s.name === 'feeder-20km').accessCandidates, 0);
    assert.ok(result.search.stages.find(s => s.name === 'feeder-30km').accessCandidates > 0);
  });

  test('the search does NOT expand when walking already gives a good journey', () => {
    const spec = { stops: { W: [16.5, 80.0], T: [16.5, lonAt(30)], H: [16.5, lonAt(8)] }, trips: [trip('W1', 'R1', 'W', 'T', '07:30', '08:30'), trip('H1', 'R2', 'H', 'T', '07:40', '08:20')], calendars: [daily()] };
    const result = run(spec, { from: 'W', to: 'T' });
    assert.equal(result.search.stageUsed, 'walk');
    assert.equal(result.search.stages.length, 1, 'no later stage was even evaluated');
    assert.ok(result.journeys.every(j => j.localRideCount === 0), 'walking is preferred over an unnecessary ride');
  });

  test('walk preferred: a walkable stop with a good bus beats a farther hub that is only marginally better', () => {
    const spec = {
      stops: { W: [16.5054, 80.0], H: [16.5, lonAt(8)], T: [16.5, lonAt(32)] },
      trips: [trip('W1', 'R1', 'W', 'T', '08:05', '08:50'), trip('H1', 'R2', 'H', 'T', '08:00', '08:40'), trip('H2', 'R2', 'H', 'T', '09:00', '09:40')],
      calendars: [daily()]
    };
    const result = run(spec, { from: O, to: 'T' }, { acceptableDurationFactor: 0, acceptableBaseSeconds: 0 }); // exhaustive: ride option was evaluated
    assert.ok(result.journeys.length > 0);
    assert.ok(result.journeys.every(j => j.localRideCount === 0), 'a 10-minute gain does not justify an unverified local ride');
  });
});

describe('hub scoring', () => {
  const world = () => {
    const stops = { WEAK: [16.5, lonAt(6)], HUB: [16.5, lonAt(9)], T: [16.5, lonAt(60)], X: [16.5, lonAt(75)], Y: [16.5, lonAt(90)] };
    const trips = [trip('W1', 'RW', 'WEAK', 'T', '08:00', '09:00'), trip('W2', 'RW', 'WEAK', 'T', '09:00', '10:00')];
    for (const [route, dest] of [['RA', 'T'], ['RB', 'X'], ['RC', 'Y']]) {
      for (const hour of ['07:30', '08:00', '08:30', '09:00', '09:30', '10:00']) trips.push(trip(`${route}-${hour}`, route, 'HUB', dest, hour, `${String(Number(hour.slice(0, 2)) + 1).padStart(2, '0')}${hour.slice(2)}`));
    }
    return { stops, trips, calendars: [daily()] };
  };
  const pick = (config, role = 'access') => {
    const spec = world();
    const network = makeNetwork(spec);
    const cfg = testConfig({ ...STAGES, ...config });
    const query = { date: '2026-10-05', timeSeconds: 7 * 3600, windowMinutes: 180 };
    const counter = createServiceCounter(network, buildServiceDays(network, query, cfg));
    const legs = selectFeederCandidates(network, O, {
      role, stage: { kind: 'feeder', radiusMeters: 10000 }, otherPoint: { lat: 16.5, lon: lonAt(60) }, counter,
      windowStart: 7 * 3600, windowEnd: 10 * 3600, horizonSeconds: 86400, config: cfg
    });
    return { network, legs, names: legs.map(leg => network.stopSourceIds[leg.stopIdx]) };
  };

  test('hub strength is data-derived, bounded 0..1, and higher for the better-connected stop', () => {
    const { network } = pick({});
    const metrics = getHubMetrics(network);
    const idx = name => network.stopSourceIds.indexOf(name);
    assert.ok(metrics.strength[idx('HUB')] > metrics.strength[idx('WEAK')]);
    for (const s of metrics.served) assert.ok(metrics.strength[s] >= 0 && metrics.strength[s] <= 1);
    assert.equal(metrics.routes[idx('HUB')], 3);
    assert.equal(metrics.routes[idx('WEAK')], 1);
    assert.ok(metrics.onward[idx('HUB')] >= 3);
  });

  test('hubScore rises with services in the window and with network strength', () => {
    assert.ok(hubScore(0.5, 20) > hubScore(0.5, 10));
    assert.ok(hubScore(0.9, 10) > hubScore(0.2, 10));
    assert.equal(hubScore(0.9, 0), 0);
  });

  test('a farther, major hub beats a nearer weak stop', () => {
    const { names } = pick({ maxFeederCandidates: 1 });
    assert.deepEqual(names, ['HUB'], 'HUB (3 routes, 18 trips) is 3 km farther than WEAK (1 route, 2 trips) and still wins');
  });

  test('without a budget both are returned, best first', () => {
    const { names } = pick({ maxFeederCandidates: 5 });
    assert.deepEqual(names, ['HUB', 'WEAK']);
  });

  test('stops that no service connects to the other end of the journey are not candidates', () => {
    const spec = {
      stops: { H: [16.5, lonAt(8)], T: [16.5, lonAt(32)], ISL: [16.5, lonAt(-22)], ISL2: [16.9, lonAt(-22)] },
      trips: [trip('H1', 'R1', 'H', 'T', '08:00', '08:40'), trip('H2', 'R1', 'H', 'T', '09:00', '09:40'),
        trip('I1', 'RI', 'ISL', 'ISL2', '08:00', '08:30'), trip('I2', 'RI', 'ISL', 'ISL2', '08:10', '08:40'), trip('I3', 'RI', 'ISL', 'ISL2', '08:20', '08:50')],
      calendars: [daily()]
    };
    const network = makeNetwork(spec);
    const { component } = getConnectivity(network);
    const idx = name => network.stopSourceIds.indexOf(name);
    assert.notEqual(component[idx('ISL')], component[idx('H')]);
    assert.equal(component[idx('H')], component[idx('T')]);
    const names = run(spec, { from: O, to: 'T' }).access.feederOriginCandidates.map(c => c.stopId);
    assert.ok(names.includes('H') && !names.includes('ISL'), `candidates ${names}`);
  });
});

describe('candidate budgets', () => {
  const crowded = () => {
    const stops = { END: [16.5, lonAt(200)] };
    const trips = [];
    for (let i = 0; i < 8; i++) {
      stops[`L${i}`] = [16.5 + (i % 4) * 0.04, lonAt(3 + i)];
      stops[`F${i}`] = [16.5 + (i % 4) * 0.04, lonAt(32 + i * 2)];
      for (const name of [`L${i}`, `F${i}`]) for (const time of ['08:00', '09:00']) trips.push(trip(`${name}-${time}`, `R-${name}`, name, 'END', time, `${String(Number(time.slice(0, 2)) + 4).padStart(2, '0')}:00`));
    }
    return { stops, trips, calendars: [daily()] };
  };

  test('local feeder and extended-hub candidates are bounded separately', () => {
    const spec = crowded();
    const network = makeNetwork(spec);
    const config = testConfig({ ...STAGES, maxFeederCandidates: 3, maxHubCandidates: 2, hubMinStrength: 0 });
    const query = { date: '2026-10-05', timeSeconds: 7 * 3600, windowMinutes: 180 };
    const counter = createServiceCounter(network, buildServiceDays(network, query, config));
    const legs = selectFeederCandidates(network, O, {
      role: 'access', stage: { kind: 'hub', radiusMeters: 50000 }, otherPoint: { lat: 16.5, lon: lonAt(200) }, counter,
      windowStart: 7 * 3600, windowEnd: 10 * 3600, horizonSeconds: 86400, config
    });
    const local = legs.filter(leg => leg.straightLineMeters <= 30000), far = legs.filter(leg => leg.straightLineMeters > 30000);
    assert.equal(local.length, 3);
    assert.ok(far.length > 0 && far.length <= 2, `${far.length} far hubs`);
    assert.ok(legs.length <= 5);
  });

  test('beyond the local-feeder range only strong hubs qualify', () => {
    const stops = { END: [16.5, lonAt(200)], WEAKFAR: [16.5, lonAt(35)], STRONGFAR: [16.5, lonAt(37)] };
    const trips = [trip('w1', 'RW', 'WEAKFAR', 'END', '08:00', '12:00'), trip('w2', 'RW', 'WEAKFAR', 'END', '09:00', '13:00')];
    for (let i = 0; i < 12; i++) stops[`N${i}`] = [17.5 + i * 0.01, lonAt(100)], trips.push(trip(`n${i}`, `RN${i}`, `N${i}`, 'END', '08:00', '12:00')); // many ordinary stops
    for (const route of ['RA', 'RB', 'RC']) for (const t of ['07:30', '08:00', '08:30', '09:00', '09:30', '10:00']) trips.push(trip(`${route}-${t}`, route, 'STRONGFAR', 'END', t, '13:00'));
    const spec = { stops, trips, calendars: [daily()] };
    const names = config => {
      const network = makeNetwork(spec);
      const cfg = testConfig({ ...STAGES, ...config });
      const counter = createServiceCounter(network, buildServiceDays(network, { date: '2026-10-05', timeSeconds: 7 * 3600, windowMinutes: 180 }, cfg));
      return selectFeederCandidates(network, O, {
        role: 'access', stage: { kind: 'hub', radiusMeters: 50000 }, otherPoint: { lat: 16.5, lon: lonAt(200) }, counter,
        windowStart: 7 * 3600, windowEnd: 10 * 3600, horizonSeconds: 86400, config: cfg
      }).map(leg => network.stopSourceIds[leg.stopIdx]);
    };
    const strict = names({ hubMinStrength: 0.7 });
    assert.ok(strict.includes('STRONGFAR') && !strict.includes('WEAKFAR'), `strict: ${strict}`);
    assert.ok(names({ hubMinStrength: 0 }).includes('WEAKFAR'), 'the strength gate is a configurable rule');
  });
});

describe('adaptive time window', () => {
  const sparse = (...times) => ({
    stops: { A: [16.5, 80.0], B: [16.5, lonAt(30)] },
    trips: times.map((t, i) => trip(`S${i}`, 'R1', 'A', 'B', t, `${String(Number(t.slice(0, 2)) + 1).padStart(2, '0')}${t.slice(2)}`)),
    calendars: [daily()]
  });

  test('windows are the requested one, then the configured wider ones, capped at the maximum', () => {
    const config = getRoutingConfig({}, {});
    assert.deepEqual(buildWindows(180, config), [180, 540, 720]);
    assert.deepEqual(buildWindows(600, config), [600, 720]);
    assert.deepEqual(buildWindows(720, config), [720]);
    assert.deepEqual(buildWindows(180, getRoutingConfig({ windowExpansionMinutes: [] }, {})), [180]);
  });

  test('a sparse timetable widens the window, reports it, and finds the afternoon bus', () => {
    const result = run(sparse('14:00', '15:00'), { from: 'A', to: 'B', windowMinutes: 120 });
    assert.ok(result.journeys.length > 0);
    assert.equal(result.search.windowRequestedMinutes, 120);
    assert.equal(result.search.windowUsedMinutes, 540);
    assert.equal(result.search.windowExpanded, true);
    assert.deepEqual(result.search.windowsTriedMinutes, [120, 540]);
    assert.ok(result.warnings.some(w => w.code === 'SEARCH_WINDOW_EXPANDED'));
    assert.ok(!result.warnings.some(w => w.code === 'NO_DEPARTURE_IN_WINDOW'));
  });

  test('a good result in the requested window is not widened', () => {
    const result = run(sparse('07:30', '14:00'), { from: 'A', to: 'B', windowMinutes: 120 });
    assert.equal(result.search.windowExpanded, false);
    assert.deepEqual(result.search.windowsTriedMinutes, [120]);
  });

  test('the search is bounded: it never widens past the configured maximum, then falls back with a warning', () => {
    const result = run(sparse('23:00'), { from: 'A', to: 'B', windowMinutes: 120 });
    assert.deepEqual(result.search.windowsTriedMinutes, [120, 540, 720]);
    assert.equal(result.search.windowUsedMinutes, 720);
    assert.ok(result.warnings.some(w => w.code === 'NO_DEPARTURE_IN_WINDOW'));
    assert.equal(result.journeys[0].legs[0].tripId, 'S0');
  });

  test('widening can be disabled', () => {
    const result = run(sparse('14:00'), { from: 'A', to: 'B', windowMinutes: 120 }, { windowExpansionMinutes: [] });
    assert.deepEqual(result.search.windowsTriedMinutes, [120]);
    assert.ok(result.warnings.some(w => w.code === 'NO_DEPARTURE_IN_WINDOW'));
  });
});

describe('failure classification', () => {
  const pair = (extra = {}) => ({
    stops: { A: [16.5, 80.0], B: [16.5, lonAt(30)] },
    trips: [trip('P1', 'R1', 'A', 'B', '08:00', '09:00'), trip('P2', 'R1', 'A', 'B', '09:00', '10:00')],
    calendars: [daily()],
    ...extra
  });
  const far = { lat: 16.5, lon: lonAt(400) }; // ~370 km beyond anything

  test('NO_ACCESS_CANDIDATE: nothing with service near the origin, even at the widest radius', () => {
    const result = run(pair(), { from: far, to: 'B' });
    assert.deepEqual(result.journeys, []);
    assert.equal(result.message, NO_ROUTE_MESSAGE);
    assert.equal(result.diagnostics.failureCode, 'NO_ACCESS_CANDIDATE');
    assert.equal(result.diagnostics.origin.servedStopsInRange, 0);
    assert.ok(result.warnings.some(w => w.code === 'NO_STOPS_NEAR_ORIGIN'));
  });

  test('NO_DESTINATION_EGRESS: nothing with service near the destination', () => {
    const result = run(pair(), { from: 'A', to: far });
    assert.equal(result.diagnostics.failureCode, 'NO_DESTINATION_EGRESS');
    assert.equal(result.diagnostics.destination.servedStopsInRange, 0);
  });

  test('NO_TIMETABLE_SERVICE: stops exist near the origin but nothing runs on this date', () => {
    const spec = pair({
      trips: [trip('S1', 'R1', 'A', 'B', '08:00', '09:00', 'SAT')],
      calendars: [{ service: 'SAT', days: [0, 0, 0, 0, 0, 1, 0], start: '2026-10-01', end: '2026-12-31' }]
    });
    const result = run(spec, { from: { lat: 16.5, lon: lonAt(3) }, to: 'B' }); // Monday 2026-10-05, origin ~3 km from stop A
    assert.deepEqual(result.journeys, []);
    assert.equal(result.diagnostics.failureCode, 'NO_TIMETABLE_SERVICE');
    const hub = result.diagnostics.origin.nearestServedStop;
    assert.equal(hub.stopId, 'A');
    assert.ok(hub.distanceMeters > 2500 && hub.distanceMeters < 3500);
    assert.equal(hub.hasOnwardService, false);
    assert.equal(hub.servicesInSearchedWindow, 0);
  });

  test('DATASET_COVERAGE_LIMITATION: the two areas are not connected by any service, at any time', () => {
    const spec = {
      stops: { A: [16.5, 80.0], B: [16.5, lonAt(30)], C: [17.5, 80.0], D: [17.5, lonAt(30)] },
      trips: [trip('P1', 'R1', 'A', 'B', '08:00', '09:00'), trip('P2', 'R1', 'A', 'B', '09:00', '10:00'), trip('Q1', 'R2', 'C', 'D', '08:00', '09:00'), trip('Q2', 'R2', 'C', 'D', '09:00', '10:00')],
      calendars: [daily()]
    };
    const result = run(spec, { from: 'A', to: 'D' });
    assert.equal(result.diagnostics.failureCode, 'DATASET_COVERAGE_LIMITATION');
    assert.equal(result.diagnostics.sameNetwork, false);
    assert.equal(result.performance.rangeSearches, 0, 'no pointless RAPTOR run');
  });

  test('a successful search carries no failure', () => {
    const result = run(pair(), { from: 'A', to: 'B' });
    assert.equal(result.diagnostics, null);
    assert.equal(result.message, null);
  });
});

describe('journey sanity rules', () => {
  const D = lonAt(8);
  const absurd = extra => ({
    // the only bus leaves from 12 km WEST of the traveller and runs east to the destination 8 km EAST of them: a 12 km ride for an 8 km trip
    stops: { HW: [16.5, lonAt(-12)], D: [16.5, D], ...(extra.stops ?? {}) },
    trips: [trip('X1', 'RX', 'HW', 'D', '08:00', '08:40'), trip('X2', 'RX', 'HW', 'D', '09:00', '09:40'), ...(extra.trips ?? [])],
    calendars: [daily()]
  });

  test('a ride that backtracks and exceeds the direct distance is a last resort, and says so', () => {
    const result = run(absurd({}), { from: O, to: 'D', windowMinutes: 180 });
    assert.ok(result.journeys.length > 0, 'it is the only timetable-backed option, so it is shown');
    assert.ok(result.warnings.some(w => w.code === 'LOCAL_RIDE_HEAVY'));
    assert.ok(result.journeys.every(j => !('_rideHeavy' in j)), 'internal flags never leak into the response');
  });

  test('...but it is dropped when a saner timetable-backed alternative exists', () => {
    const spec = absurd({ stops: { W: [16.5054, 80.0] }, trips: [trip('W1', 'RW', 'W', 'D', '11:30', '12:00')] });
    const result = run(spec, { from: O, to: 'D', windowMinutes: 360 });
    assert.ok(result.journeys.length > 0);
    assert.ok(result.journeys.every(j => j.localRideCount === 0), 'the 08:xx ride-and-bus option is not offered next to a walkable bus');
    assert.ok(!result.warnings.some(w => w.code === 'LOCAL_RIDE_HEAVY'));
  });

  test('the hard rule still holds: the bus must cover at least as much ground as the rides', () => {
    const spec = {
      stops: { A: [16.5, lonAt(8)], B: [16.5, lonAt(10)] },
      trips: [trip('S1', 'R1', 'A', 'B', '08:00', '08:05'), trip('S2', 'R1', 'A', 'B', '09:00', '09:05')],
      calendars: [daily()]
    };
    assert.deepEqual(run(spec, { from: O, to: { lat: 16.5, lon: lonAt(18) } }).journeys, []);
  });
});

describe('both sides, full journey, determinism', () => {
  const spec = {
    stops: { H: [16.5, lonAt(8)], T: [16.5, lonAt(32)] },
    trips: [trip('H1', 'R1', 'H', 'T', '08:00', '08:40'), trip('H2', 'R1', 'H', 'T', '09:00', '09:40')],
    calendars: [daily()]
  };
  const beyondT = { lat: 16.5, lon: lonAt(40) };

  test('origin AND destination candidates are generated, and the journey rides at both ends', () => {
    const result = run(spec, { from: O, to: beyondT });
    const journey = result.journeys[0];
    assert.equal(journey.localRideCount, 2);
    assert.ok(result.access.feederOriginCandidates.length > 0 && result.access.feederDestinationCandidates.length > 0);
    const record = result.search.stages.find(stage => stage.searched);
    assert.ok(record.accessCandidates > 0 && record.egressCandidates > 0);
    assert.ok(journey.fareEstimate.complete && journey.fareEstimate.min < journey.fareEstimate.max, 'fare covers ride + bus + ride');
    assert.equal(journey.fareEstimate.components.length, 3);
  });

  test('FASTEST is the journey with the least complete door-to-door duration', () => {
    const { journeys } = run(spec, { from: O, to: beyondT, windowMinutes: 180 });
    const fastest = journeys.find(j => j.labels.includes('FASTEST'));
    assert.equal(fastest.totalDurationSeconds, Math.min(...journeys.map(j => j.totalDurationSeconds)));
  });

  test('identical searches give identical results', () => {
    const strip = result => JSON.stringify(result, (key, value) => (key === 'queryTimeMs' || key === 'networkLoadTimeMs' ? undefined : value));
    assert.equal(strip(run(spec, { from: O, to: beyondT })), strip(run(spec, { from: O, to: beyondT })));
  });
});

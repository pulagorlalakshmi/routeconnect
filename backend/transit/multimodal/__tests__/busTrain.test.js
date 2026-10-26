// Real Bus + Train journey planning: transfer-hub discovery, time-dependent connection checks, the RailRadar request
// budget, ranking and coverage reporting. Everything here is a SYNTHETIC fixture (test codes, test names): a GTFS bus
// network built with the routing test helpers, and a fake RailRadar answering in the documented response shape.
// No real request is ever made (the fake fetch counts every request instead).
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { createRailRadarClient } from '../../rail/verification/railRadar.js';
import { createRailRadarSource, railSearchSettings, chainAtStation, RAIL_SEARCH_DEFAULTS } from '../../sources/rail/railRadarSource.js';
import { handleMultimodalPlanRequest, journeyKind, noJourneyMessage, describeCoverage } from '../planMultimodal.js';
import { composeAroundTrunk, chainTrunks } from '../compose.js';
import { buildShortlist, simplerAlternativeExists, diversityModeOf } from '../shortlist.js';
import { comparableFare, comparatorFor } from '../preferences.js';
import { hubCandidates, rankStationPairs, busReachFrom, HUB_DEFAULTS } from '../railHubs.js';
import { getRoutingConfig } from '../../routing/config.js';
import { getFareConfig } from '../../fare/fareConfig.js';
import { makeNetwork, daily, NOW } from '../../routing/__tests__/helpers.js';

const config = getRoutingConfig();
const fareConfig = getFareConfig();
const DATE = '2026-10-05'; // a Monday inside the synthetic feed's validity
const ms = iso => Date.parse(iso);

// ---------- the synthetic world ----------
// T: a small town with only a minor halt (TSS) that has no train to the destination.
// G: a nearer town with Test Gamma Junction (TGN, 1.5 km from its bus stand): one slow train.
// H: a farther, larger hub: Test Hub Junction (TJN, ~500 m from its bus stand, walkable): faster trains.
// D: the destination city: Test Delta (TDS, ~500 m from its bus stand). X: a village 43 km beyond TDS (bus only).
const POINT = {
  T: { lat: 16.2270, lon: 80.0500, name: 'Test Town' },
  D: { lat: 17.7240, lon: 83.3060, name: 'Test City' },
  X: { lat: 18.1000, lon: 83.4000, name: 'Test Village' }
};
const STATIONS = [
  { code: 'TSS', name: 'Test Small Halt', kind: 'halt', lat: 16.2300, lon: 80.0400 },
  { code: 'TGN', name: 'Test Gamma Junction', kind: 'station', lat: 16.3010, lon: 80.4430 },
  { code: 'TJN', name: 'Test Hub Junction', kind: 'station', lat: 16.5130, lon: 80.6190 },
  { code: 'TDS', name: 'Test Delta', kind: 'station', lat: 17.7215, lon: 83.3020 }
];
const IMPORTANCE = { TSS: 0.1, TGN: 0.7, TJN: 1, TDS: 0.8 };
const stationSet = { stations: STATIONS, importanceOf: s => IMPORTANCE[s.code] ?? 0.3 };
// A handful of stops makes percentile-based bus strength meaningless: relax only that threshold for the fixture.
const hubOptions = { ...HUB_DEFAULTS, minBusSideStrength: 0 };

const busSpec = ({ directBus = true } = {}) => ({
  stops: { T: [16.2270, 80.0500], G: [16.2960, 80.4560], H: [16.5090, 80.6170], D: [17.7240, 83.3060], X: [18.1000, 83.4000] },
  stopNames: { T: 'Test Town', G: 'Test Gamma Bus Stand', H: 'Test Hub Bus Stand', D: 'Test City Bus Stand', X: 'Test Village' },
  agency: 'APSRTC',
  trips: [
    { id: 'r1a', route: '01001', service: 'ALL', times: [['T', '06:00'], ['H', '07:30']] },
    { id: 'r1b', route: '01001', service: 'ALL', times: [['T', '07:00'], ['H', '08:30']] },
    { id: 'r2', route: '01002', service: 'ALL', times: [['T', '06:30'], ['G', '07:30']] },
    ...(directBus ? [{ id: 'r3', route: '01003', service: 'ALL', times: [['H', '08:00'], ['D', '18:00']] }] : []),
    { id: 'r4a', route: '01004', service: 'ALL', times: [['D', '16:10'], ['X', '17:10']] },
    { id: 'r4b', route: '01004', service: 'ALL', times: [['D', '20:30'], ['X', '21:30']] },
    { id: 'r5', route: '01005', service: 'ALL', times: [['H', '14:00'], ['T', '15:30']] }
  ],
  calendars: [daily('ALL')]
});

const ALL_DAYS = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'];
const apiTrain = (number, from, to, dep, arr, { depDay = 1, arrDay = 1, runDays = ALL_DAYS, name = `Test Express ${number}` } = {}) => ({
  train: { number, name, type: 'Mail/Express', runDays },
  from: { code: from, name: `Test ${from}`, departure: dep, day: depDay },
  to: { code: to, name: `Test ${to}`, arrival: arr, day: arrDay },
  distance: 350, duration: 360, totalHaltsBetween: 6
});
const TIMETABLE = {
  'TSS>TDS': [],                                                       // the small town's halt: no train to the city
  'TJN>TDS': [apiTrain('22101', 'TJN', 'TDS', '09:00', '15:00'), apiTrain('22103', 'TJN', 'TDS', '11:00', '17:30')],
  'TGN>TDS': [apiTrain('22201', 'TGN', 'TDS', '09:30', '19:30')],      // nearer hub, much slower train
  'TDS>TSS': [],
  'TDS>TJN': [apiTrain('22102', 'TDS', 'TJN', '07:00', '13:00')],
  'TDS>TGN': []
};

function fakeRailRadar(table = TIMETABLE, { hang = new Set(), fail = new Set(), remaining = '90' } = {}) {
  const calls = [];
  const fetchImpl = async url => {
    const m = /\/trains\/between\/([A-Z]+)\/([A-Z]+)\?date=([\d-]+)/.exec(String(url));
    const key = `${m[1]}>${m[2]}`;
    calls.push({ key, date: m[3] });
    if (hang.has(key)) return new Promise(() => {});
    if (fail.has(key) || fail.has('*')) return new Response('{}', { status: 500 });
    const trains = table[key] ?? [];
    return new Response(JSON.stringify({ success: true, data: { from: { code: m[1] }, to: { code: m[2] }, count: trains.length, trains } }), { status: 200, headers: { 'x-ratelimit-remaining-month': remaining } });
  };
  return { fetchImpl, calls };
}

function setup({ env = {}, settings = null, rr = fakeRailRadar(), directBus = true } = {}) {
  const fullEnv = { RAILRADAR_API_KEY: 'rr_test_key', ...env };
  const client = createRailRadarClient({ env: fullEnv, fetchImpl: rr.fetchImpl });
  const rail = createRailRadarSource({ env: fullEnv, client, getGraph: () => stationSet, hubOptions, ...(settings ? { settings: { ...railSearchSettings(fullEnv), ...settings } } : {}) });
  const network = makeNetwork(busSpec({ directBus }));
  const plan = (from, to, extra = {}) => handleMultimodalPlanRequest(
    { fromLat: String(from.lat), fromLng: String(from.lon), toLat: String(to.lat), toLng: String(to.lon), date: DATE, time: '06:00', windowMinutes: '180', ...extra },
    { getNetwork: () => network, now: NOW, sources: [rail] }
  );
  return { rr, client, rail, network, plan };
}

const vehicleModes = journey => journey.legs.filter(l => l.mode !== 'walk' && l.mode !== 'local_ride').map(l => (l.mode === 'rail' ? 'train' : 'bus'));
const shape = journey => journey.legs.map(l => (l.mode === 'rail' ? `train:${l.trainNumber}` : l.mode === 'bus' ? `bus:${l.routeShortName ?? l.routeCode}` : l.mode)).join(' > ');
const withTrain = (journeys, number) => journeys.filter(j => j.legs.some(l => l.trainNumber === number));
function assertChronological(journey) {
  for (let i = 1; i < journey.legs.length; i++) {
    assert.ok(ms(journey.legs[i].departureTime) >= ms(journey.legs[i - 1].arrivalTime), `leg ${i} of ${shape(journey)} leaves before the previous one arrives`);
  }
  for (const [i, leg] of journey.legs.entries()) {
    if (leg.mode !== 'rail' || i === 0) continue;
    // A train is reached at least the boarding buffer (20 min) before it leaves.
    assert.ok(ms(leg.departureTime) - ms(journey.legs[i - 1].arrivalTime) >= 20 * 60000, 'boarding buffer kept');
  }
}

// ---------- 1-3, 5, 11-13: end-to-end through the planner ----------
describe('Bus + Train journeys through the planner (synthetic timetables)', () => {
  test('1. Bus -> Train: no train from the small town, so a bus to a hub junction connects to a real train', async () => {
    const { plan, rr } = setup();
    const { status, body } = await plan(POINT.T, POINT.D);
    assert.equal(status, 200);
    const mixed = withTrain(body.journeys, '22101');
    assert.ok(mixed.length >= 1, `expected a bus + train via TJN, got ${body.journeys.map(shape).join(' | ')}`);
    const j = mixed[0];
    assert.deepEqual(vehicleModes(j), ['bus', 'train']);
    assertChronological(j);
    const rail = j.legs.find(l => l.mode === 'rail');
    assert.deepEqual([rail.fromStop.code, rail.toStop.code, rail.trainNumber, rail.departureTime], ['TJN', 'TDS', '22101', '2026-10-05T09:00:00+05:30']);
    // The LATEST bus that still makes the train is used (07:00, arriving 08:30), not the first bus of the day.
    assert.equal(j.legs.find(l => l.mode === 'bus').departureTime.slice(11, 16), '07:00');
    assert.ok(rr.calls.length <= RAIL_SEARCH_DEFAULTS.maxRequestsPerSearch, 'never more than the per-search request cap');
    assert.equal(journeyKind(j), 'mixed');
  });

  test('5. walking between the bus stand and the railway station is an explicit, estimated leg', async () => {
    const { plan } = setup();
    const { body } = await plan(POINT.T, POINT.D);
    const j = withTrain(body.journeys, '22101')[0];
    const i = j.legs.findIndex(l => l.mode === 'rail');
    const walk = j.legs[i - 1];
    assert.equal(walk.mode, 'walk');
    assert.equal(walk.to.type, 'station');
    assert.equal(walk.to.code, 'TJN');
    assert.equal(walk.dataConfidence, 'estimated');
    assert.ok(walk.distanceMeters > 300 && walk.distanceMeters < 1000, 'the real stand-to-station distance (~500 m), never invented');
  });

  test('2. Train -> Bus: a train to a hub junction, then the timetable bus to a town with no useful station', async () => {
    const { plan } = setup();
    const { body } = await plan(POINT.D, POINT.T);
    const j = withTrain(body.journeys, '22102')[0];
    assert.ok(j, body.journeys.map(shape).join(' | '));
    assert.deepEqual(vehicleModes(j), ['train', 'bus']);
    assertChronological(j);
    const bus = j.legs.find(l => l.mode === 'bus');
    assert.equal(bus.departureTime.slice(11, 16), '14:00', 'the first bus after the train arrives (13:00) and the station exit');
  });

  test('3. Bus -> Train -> Bus: the village 43 km beyond the station is reached by its bus, never by a 43 km auto ride', async () => {
    const { plan } = setup();
    const { body } = await plan(POINT.T, POINT.X);
    const j = withTrain(body.journeys, '22101')[0];
    assert.ok(j, body.journeys.map(shape).join(' | '));
    assert.deepEqual(vehicleModes(j), ['bus', 'train', 'bus']);
    assertChronological(j);
    assert.equal(j.transfers, 2);
    assert.ok(!j.legs.some(l => l.mode === 'local_ride' && l.straightLineMeters > 40000), 'no long ride-only connection');
    assert.equal(j.legs.filter(l => l.mode === 'bus').at(-1).departureTime.slice(11, 16), '16:10');
  });

  test('11-12. several hubs are checked, and the best is not the nearest', async () => {
    const { plan, rr } = setup();
    const { body } = await plan(POINT.T, POINT.D);
    assert.deepEqual(new Set(rr.calls.map(c => c.key)), new Set(['TSS>TDS', 'TJN>TDS', 'TGN>TDS']));
    assert.ok(body.railSearch.hubs.origin.includes('TGN') && body.railSearch.hubs.origin.includes('TJN'));
    // The nearer junction (TGN, 43 km) only has a slow train; the farther one (TJN, 65 km) gets there first.
    const first = [...body.journeys].sort((a, b) => ms(a.arrivalTime) - ms(b.arrivalTime))[0];
    assert.equal(first.legs.find(l => l.mode === 'rail')?.fromStop.code, 'TJN');
  });

  test('13. no direct bus or train, but a valid bus + train journey exists: it is shown, and explained', async () => {
    const { plan } = setup({ directBus: false });
    const { status, body } = await plan(POINT.T, POINT.D);
    assert.equal(status, 200);
    assert.ok(body.journeys.length > 0);
    assert.ok(body.journeys.every(j => journeyKind(j) === 'mixed'), body.journeys.map(shape).join(' | '));
    assert.equal(body.message, null);
    assert.ok(body.warnings.some(w => w.code === 'MIXED_ONLY'));
    assert.deepEqual(body.searchCoverage.found, { bus: 0, train: 0, mixed: body.searchCoverage.found.mixed });
  });

  test('Bus only never inserts a train; Train only never inserts a scheduled bus (walks and rides only)', async () => {
    const busOnly = await setup().plan(POINT.T, POINT.D, { modes: 'bus' });
    assert.ok(busOnly.body.journeys.length > 0);
    assert.ok(busOnly.body.journeys.every(j => !j.legs.some(l => l.mode === 'rail')));
    const trainOnly = await setup().plan(POINT.T, POINT.D, { modes: 'train' });
    for (const j of trainOnly.body.journeys) assert.ok(!j.legs.some(l => l.mode === 'bus'), shape(j));
    // From the small town a train-only trip has no reachable station with a train: said truthfully, not "no route".
    assert.equal(trainOnly.body.journeys.length, 0);
    assert.match(trainOnly.body.message, /scheduled train/);
  });
});

// ---------- 4, 6-10: connections between services, validated on absolute times ----------
describe('time-dependent connection checks', () => {
  const station = (code, lat, lon) => ({ type: 'station', name: `Test ${code}`, code, lat, lon });
  const trunk = (number, from, to, dep, arr) => ({
    mode: 'rail', trainNumber: number, trainName: `Test ${number}`, displayName: number, operator: 'Indian Railways',
    from, to, departureTime: dep, arrivalTime: arr, durationSeconds: (ms(arr) - ms(dep)) / 1000, scheduleConfidence: 'published', timeQuality: 'exact', fare: null
  });
  const A = station('TAA', 16.0, 80.0);
  const J1 = station('TJ1', 16.5, 80.6);
  const J2 = station('TJ2', 16.53, 80.65);      // ~6 km from TJ1: a different station in the same city
  const J1b = station('TJ1', 16.5004, 80.6003); // same station code
  const C = station('TCC', 17.2, 81.5);
  const ctx = { origin: { lat: 16.0, lon: 80.0, name: 'Origin' }, destination: { lat: 17.2, lon: 81.5, name: 'Dest' }, utcOffset: '+05:30', config, fareConfig };
  const bus = (dep, arr) => [{ mode: 'bus', tripId: `B@${dep}`, routeShortName: '01009', fromStop: { name: 'Test TJ1 stand' }, toStop: { name: 'Test TJ2 stand' }, from: { name: 'a' }, to: { name: 'b' }, departureTime: dep, arrivalTime: arr, durationSeconds: (ms(arr) - ms(dep)) / 1000, dataConfidence: 'inferred', timeQuality: 'approximate' }];

  test('4. Train -> Bus -> Train: two trains at different stations joined by a timetable bus in time', () => {
    const first = trunk('22301', A, J1, '2026-10-05T06:00:00+05:30', '2026-10-05T10:00:00+05:30');
    const second = trunk('22302', J2, C, '2026-10-05T12:00:00+05:30', '2026-10-05T15:00:00+05:30');
    const transitTransfer = (from, to, earliestMs, latestMs) => {
      assert.equal(new Date(earliestMs).toISOString(), '2026-10-05T04:40:00.000Z', 'leaves after the 10-minute station exit');
      assert.equal(new Date(latestMs).toISOString(), '2026-10-05T06:10:00.000Z', 'arrives by the 20-minute boarding buffer');
      return bus('2026-10-05T10:20:00+05:30', '2026-10-05T10:55:00+05:30');
    };
    const journeys = composeAroundTrunk([first, second], { ...ctx, transitTransfer });
    assert.ok(journeys.length >= 1);
    for (const j of journeys) {
      assert.deepEqual(vehicleModes(j), ['train', 'bus', 'train']);
      assertChronological(j);
      assert.equal(j.transfers, 2);
    }
  });

  test('6. without a bus, a station change is an estimated local ride (when it fits the time)', () => {
    const chain = chainTrunks([trunk('22301', A, J1, '2026-10-05T06:00:00+05:30', '2026-10-05T10:00:00+05:30'), trunk('22302', J2, C, '2026-10-05T12:00:00+05:30', '2026-10-05T15:00:00+05:30')], ctx);
    const ride = chain.legs[1];
    assert.equal(ride.mode, 'local_ride');
    assert.equal(ride.kind, 'transfer');
    assert.equal(ride.dataConfidence, 'estimated');
    assert.ok(ms(ride.arrivalTime) <= ms('2026-10-05T11:40:00+05:30'));
  });

  test('7. the next service leaving before the previous one arrives is rejected', () => {
    assert.equal(chainTrunks([trunk('1', A, J1, '2026-10-05T06:00:00+05:30', '2026-10-05T10:00:00+05:30'), trunk('2', J1b, C, '2026-10-05T09:50:00+05:30', '2026-10-05T13:00:00+05:30')], ctx), null);
    // An access bus that would reach the station after the boarding buffer is never used.
    const late = (o, s, latestMs) => bus(new Date(latestMs - 60 * 60000).toISOString(), new Date(latestMs + 5 * 60000).toISOString());
    const journeys = composeAroundTrunk([trunk('22101', station('TS1', 16.1, 80.1), C, '2026-10-05T09:00:00+05:30', '2026-10-05T15:00:00+05:30')], { ...ctx, transitAccess: late });
    assert.ok(journeys.every(j => !j.legs.some(l => l.mode === 'bus')), 'the late bus is dropped; only the ride access remains');
  });

  test('8. an insufficient change time is rejected (same station: 20 minutes; different station: exit + travel + boarding)', () => {
    assert.equal(chainTrunks([trunk('1', A, J1, '2026-10-05T06:00:00+05:30', '2026-10-05T10:00:00+05:30'), trunk('2', J1b, C, '2026-10-05T10:15:00+05:30', '2026-10-05T13:00:00+05:30')], ctx), null, '15 min change');
    assert.ok(chainTrunks([trunk('1', A, J1, '2026-10-05T06:00:00+05:30', '2026-10-05T10:00:00+05:30'), trunk('2', J1b, C, '2026-10-05T10:25:00+05:30', '2026-10-05T13:00:00+05:30')], ctx), '25 min change');
    assert.equal(chainTrunks([trunk('1', A, J1, '2026-10-05T06:00:00+05:30', '2026-10-05T10:00:00+05:30'), trunk('2', J2, C, '2026-10-05T10:35:00+05:30', '2026-10-05T13:00:00+05:30')], ctx), null, '35 min is not enough for exit + 6 km + boarding');
  });

  test('9. overnight: a change after midnight is judged on absolute date-times, not clock times', () => {
    const night = trunk('1', A, J1, '2026-10-05T18:00:00+05:30', '2026-10-05T23:40:00+05:30');
    assert.ok(chainTrunks([night, trunk('2', J1b, C, '2026-10-06T00:30:00+05:30', '2026-10-06T05:00:00+05:30')], ctx), '00:30 next day is 50 minutes later');
    assert.equal(chainTrunks([night, trunk('2', J1b, C, '2026-10-05T00:30:00+05:30', '2026-10-05T05:00:00+05:30')], ctx), null, '00:30 the same day is in the past');
    // A train arriving the next morning: the egress starts on that date.
    const [j] = composeAroundTrunk([trunk('22111', station('TS1', 16.001, 80.001), station('TS2', 17.2001, 81.5001), '2026-10-05T22:00:00+05:30', '2026-10-06T04:00:00+05:30')], ctx);
    assert.ok(j.arrivalTime.startsWith('2026-10-06T04:1'), j.arrivalTime);
  });

  test('10. next-day service: a window past midnight also asks about the next day (and nothing else)', async () => {
    const rr = fakeRailRadar({ 'TSS>TDS': [] });
    const { plan } = setup({ rr, settings: { hubs: false } });
    await plan(POINT.T, POINT.D, { time: '23:00', windowMinutes: '120' });
    assert.deepEqual(rr.calls.map(c => c.date), ['2026-10-05', '2026-10-06']);
  });

  test('two trains at one junction: the earliest second train after the change time, never the same train', () => {
    const leg = (number, dep, arr) => [{ trainNumber: number, departureTime: `x${dep}`, planning: { departureSeconds: dep, arrivalSeconds: arr } }];
    const firsts = [leg('1', 6 * 3600, 10 * 3600)];
    const seconds = [leg('1', 10 * 3600 + 30 * 60, 14 * 3600), leg('2', 10 * 3600 + 10 * 60, 13 * 3600), leg('3', 10 * 3600 + 25 * 60, 15 * 3600)];
    const [pair] = chainAtStation(firsts, seconds, { changeSeconds: 20 * 60, maxWaitSeconds: 4 * 3600 });
    assert.deepEqual(pair.map(l => l.trainNumber), ['1', '3']);
  });
});

// ---------- 14-16: ranking ----------
describe('ranking: mixed journeys earn their place', () => {
  const j = (id, { dep, arr, transfers, kinds, fare = { min: 100, max: 150, complete: true } }) => ({
    id, labels: [], departureTime: `2026-10-05T${dep}:00+05:30`, arrivalTime: `2026-10-05T${arr}:00+05:30`,
    totalDurationSeconds: (ms(`2026-10-05T${arr}:00+05:30`) - ms(`2026-10-05T${dep}:00+05:30`)) / 1000,
    transfers, walkingDurationSeconds: 300, localRideDurationSeconds: 0, localRideCount: 0, waitingDurationSeconds: 0, transitLegCount: kinds.length,
    scheduleConfidence: 'published', timeQuality: 'exact', fareEstimate: fare,
    tracking: { busLegs: 0, verifiedLegs: 0, notFoundLegs: 0, allVerified: false },
    legs: kinds.map((mode, i) => ({ mode, tripId: `${id}-${i}`, departureTime: `2026-10-05T${dep}:00+05:30`, arrivalTime: `2026-10-05T${arr}:00+05:30`, durationSeconds: 3600, operator: mode === 'rail' ? 'Indian Railways' : 'APSRTC', fromStop: { name: 'a' }, toStop: { name: 'b' }, dataConfidence: 'published', timeQuality: 'exact' }))
  });

  test('14. a direct route that leaves later and arrives earlier beats a slower mixed one: the mixed one is dropped', () => {
    const mixed = j('mixed', { dep: '07:00', arr: '15:00', transfers: 1, kinds: ['bus', 'rail'], fare: { min: 60, max: 90, complete: false } });
    const direct = j('direct', { dep: '07:30', arr: '14:30', transfers: 0, kinds: ['bus'] });
    assert.equal(simplerAlternativeExists(mixed, [mixed, direct]), true);
    assert.deepEqual(buildShortlist([mixed, direct]).journeys.map(x => x.id), ['direct']);
    // ... but a mixed journey that genuinely arrives earlier stays, as its own kind.
    const better = j('better', { dep: '07:00', arr: '13:00', transfers: 1, kinds: ['bus', 'rail'], fare: { min: 60, max: 90, complete: false } });
    assert.equal(diversityModeOf(better), 'bus+train');
    assert.ok(buildShortlist([better, direct]).journeys.some(x => x.id === 'better'));
  });

  test('15. a missing train fare is never zero: the total is partial and ranks after complete fares under "cost"', async () => {
    const { plan } = setup();
    const { body } = await plan(POINT.T, POINT.D, { rank: 'cost' });
    const mixed = withTrain(body.journeys, '22101')[0];
    assert.equal(mixed.legs.find(l => l.mode === 'rail').fare, null);
    assert.equal(mixed.fareEstimate.complete, false);
    assert.equal(comparableFare(mixed), null);
    const firstIncomplete = body.journeys.findIndex(x => comparableFare(x) === null);
    assert.ok(body.journeys.slice(firstIncomplete).every(x => comparableFare(x) === null), 'unpriced journeys are listed last');
  });

  test('16. preferences order the list: fastest = shortest door-to-door, transfers = fewest real changes', async () => {
    for (const [rank, key] of [['fastest', x => x.totalDurationSeconds], ['transfers', x => x.transfers]]) {
      const { body } = await setup().plan(POINT.T, POINT.D, { rank });
      const values = body.journeys.map(key);
      assert.deepEqual(values, [...values].sort((a, b) => a - b), rank);
    }
    // A bus + train journey's transfers count the change between bus and train (and nothing else).
    const { body } = await setup().plan(POINT.T, POINT.D, { rank: 'transfers' });
    const mixed = withTrain(body.journeys, '22101')[0];
    assert.equal(mixed.transfers, vehicleModes(mixed).length - 1);
    assert.equal(typeof comparatorFor('fastest'), 'function');
  });
});

// ---------- 17-20: the RailRadar request budget ----------
describe('RailRadar request budget', () => {
  test('18. cached answers are reused: the same search a second time makes no request at all', async () => {
    const { plan, rr } = setup();
    await plan(POINT.T, POINT.D);
    const first = rr.calls.length;
    const { body } = await plan(POINT.T, POINT.D);
    assert.equal(rr.calls.length, first);
    assert.equal(body.railSearch.requests.made, 0);
    assert.equal(body.railSearch.requests.cached, body.railSearch.pairs.length);
  });

  test('19. a limited per-search budget is reported as limited coverage, never as "no route"', async () => {
    const { plan, rr } = setup({ env: { RAILRADAR_MAX_REQUESTS_PER_SEARCH: '1' }, directBus: false });
    const { body } = await plan(POINT.T, POINT.D);
    assert.equal(rr.calls.length, 1, 'the anchor pair only');
    assert.equal(body.railSearch.limitedBy, 'budget');
    assert.ok(body.railSearch.skipped.budget >= 1);
    assert.equal(body.journeys.length, 0);
    assert.match(body.message, /train search was limited/);
    assert.doesNotMatch(body.message, /^No route/);
  });

  test('17. a nearly used-up monthly allowance keeps searches to direct trains; none left turns trains off', async () => {
    const low = setup({ env: { RAILRADAR_MONTHLY_REQUEST_BUDGET: '15' } });
    const { body } = await low.plan(POINT.T, POINT.D);
    assert.equal(low.rr.calls.length, 1);
    assert.equal(body.railSearch.quotaLow, true);
    assert.equal(body.railSearch.limitedBy, 'quota');
    assert.ok(body.warnings.some(w => w.code === 'RAIL_SEARCH_LIMITED' && /allowance/.test(w.message)));
    // RailRadar reports 0 remaining: the next search makes no request and the train source reports itself off.
    const empty = setup({ rr: fakeRailRadar(TIMETABLE, { remaining: '0' }) });
    await empty.plan(POINT.T, POINT.D);
    const calls = empty.rr.calls.length;
    const again = await empty.plan(POINT.T, POINT.X);
    assert.equal(empty.rr.calls.length, calls, 'no request after the provider says none remain');
    assert.equal(again.body.sources.find(s => s.id === 'rail').status, 'not_configured');
    assert.ok(again.body.journeys.length > 0, 'buses still work');
  });

  test('20. a provider that hangs is cut off at the deadline; what was found is still used', async () => {
    const rr = fakeRailRadar(TIMETABLE, { hang: new Set(['TJN>TDS']) });
    const { plan } = setup({ rr, settings: { deadlineMs: 300, minRequestMs: 50 } });
    const started = Date.now();
    const { body } = await plan(POINT.T, POINT.D);
    assert.ok(Date.now() - started < 3000, 'the search does not wait for the hung request');
    assert.equal(body.railSearch.limitedBy, 'time');
    assert.ok(withTrain(body.journeys, '22201').length >= 1, 'the answer that did arrive (TGN) is composed');
  });

  test('20b. every railway request failing degrades to buses with an honest message', async () => {
    const { plan } = setup({ rr: fakeRailRadar(TIMETABLE, { fail: new Set(['*']) }), directBus: false });
    const { status, body } = await plan(POINT.T, POINT.D);
    assert.equal(status, 200);
    assert.equal(body.sources.find(s => s.id === 'rail').status, 'error');
    assert.equal(body.searchCoverage.rail.status, 'error');
    assert.match(noJourneyMessage(body.searchCoverage), /could not be checked/);
  });

  test('a search never spends more than the per-search cap, however many hubs there are', async () => {
    const { plan, rr } = setup();
    await plan(POINT.T, POINT.X);
    assert.ok(rr.calls.length <= RAIL_SEARCH_DEFAULTS.maxRequestsPerSearch);
    assert.equal(railSearchSettings({ RAILRADAR_MAX_REQUESTS_PER_SEARCH: '99' }).maxRequestsPerSearch, RAIL_SEARCH_DEFAULTS.maxRequestsPerSearch, 'out-of-range values fall back to the default');
    assert.equal(railSearchSettings({ RAILRADAR_MAX_REQUESTS_PER_SEARCH: '0' }).maxRequestsPerSearch, 0);
  });
});

// ---------- hub discovery (pure) ----------
describe('hub discovery', () => {
  test('origin hubs come from one time-dependent bus search; far hubs need a real bus, near ones may be a ride', () => {
    const network = makeNetwork(busSpec());
    const reach = busReachFrom(network, POINT.T, { date: DATE, timeSeconds: 6 * 3600, config });
    const hubs = hubCandidates({ stations: STATIONS, point: POINT.T, other: POINT.D, role: 'origin', network, reach, config, options: hubOptions, importanceOf: stationSet.importanceOf });
    const byCode = Object.fromEntries(hubs.map(h => [h.station.code, h]));
    assert.equal(byCode.TJN.via, 'bus');
    assert.equal(byCode.TJN.minutes, 99, 'bus 06:00 -> 07:30 (90 min) plus the ~500 m walk to the station (8.5 min)');
    assert.equal(byCode.TSS.via, 'ride');
    // Without buses, a junction 65 km away is not a hub at all.
    const noBus = hubCandidates({ stations: STATIONS, point: POINT.T, other: POINT.D, role: 'origin', network, reach, busAllowed: false, config, options: hubOptions, importanceOf: stationSet.importanceOf });
    assert.ok(!noBus.some(h => h.station.code === 'TJN'));
  });

  test('pairs are ranked by estimated door-to-door time with station size; the anchor pair stays first', () => {
    const o = [{ station: STATIONS[2], minutes: 100, importance: 1 }, { station: STATIONS[1], minutes: 110, importance: 0.7 }];
    const d = [{ station: STATIONS[3], minutes: 6, importance: 0.8 }];
    const anchor = { from: { station: STATIONS[0], minutes: 5 }, to: { station: STATIONS[3], minutes: 6 } };
    const pairs = rankStationPairs({ anchor, origins: o, destinations: d });
    assert.deepEqual(pairs.map(p => `${p.from.station.code}>${p.to.station.code}`), ['TSS>TDS', 'TJN>TDS', 'TGN>TDS']);
    assert.equal(pairs[0].role, 'anchor');
  });
});

// ---------- 22: what reaches the browser ----------
describe('production compatibility', () => {
  test('22. the response is plain JSON: no key, no internal planning fields, coverage included', async () => {
    const { plan } = setup();
    const { body } = await plan(POINT.T, POINT.D);
    const text = JSON.stringify(body);
    assert.ok(!text.includes('rr_test_key'), 'the API key never reaches the browser');
    assert.ok(!text.includes('"planning"'), 'internal planning estimates are never shown as journey data');
    assert.ok(Array.isArray(body.railSearch.pairs) && body.railSearch.pairs.every(p => /^[A-Z]+$/.test(p.from)));
    assert.equal(typeof body.performance.composeMs, 'number');
    assert.deepEqual(Object.keys(describeCoverage({ journeys: [], candidates: [], railReport: null, railMeta: null, windowMinutes: 60 })).sort(), ['found', 'modes', 'rail', 'shown', 'windowMinutes']);
  });

  test('the train source finishes before the runner gives up on it, so partial results are not thrown away', () => {
    const source = createRailRadarSource({ env: { RAILRADAR_API_KEY: 'rr_test_key' }, client: createRailRadarClient({ env: { RAILRADAR_API_KEY: 'rr_test_key' }, fetchImpl: fakeRailRadar().fetchImpl }), getGraph: () => stationSet });
    assert.ok(source.timeoutMs > RAIL_SEARCH_DEFAULTS.deadlineMs);
  });
});

// RailRadar scheduled trains: response mapping, dates and journey days, running days at the boarding station, station
// anchoring, the request budget, error handling and the no-network guard under tests. All data here is SYNTHETIC but
// shaped exactly like a real GET /v1/trains/between response (test station codes TSA/TSB/TSC, train numbers 9xxxx).
// Real responses were validated separately (see the integration report).
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { createRailRadarClient } from '../../../rail/verification/railRadar.js';
import { createRailRadarSource, trainsToTrunks, anchorStation, runningDaysAtBoarding } from '../railRadarSource.js';
import { getCapabilities } from '../../../rail/railStatus.js';
import { getRoutingConfig } from '../../../routing/config.js';
import { composeAroundTrunk } from '../../../multimodal/compose.js';
import { getFareConfig } from '../../../fare/fareConfig.js';

const H = 3600;
const graph = {
  stations: [
    { code: 'TSA', name: 'Test Alpha Junction', kind: 'station', lat: 16.518, lon: 80.618, node: 1 },
    { code: 'TSH', name: 'Test Alpha Halt', kind: 'halt', lat: 16.510, lon: 80.640, node: 2 },
    { code: 'TSB', name: 'Test Beta Junction', kind: 'station', lat: 16.300, lon: 80.442, node: 3 },
    { code: 'TSC', name: 'Test Gamma', kind: 'station', lat: 17.433, lon: 78.502, node: 4 }
  ]
};
const apiTrain = (number, fromDep, fromDay, toArr, toDay, runDays = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'], extra = {}) => ({
  train: { number, name: `Test Express ${number}`, type: 'Mail/Express', runDays },
  from: { code: 'TSA', name: 'Test Alpha Jn', city: 'Alpha', departure: fromDep, day: fromDay, sequence: 10 },
  to: { code: 'TSB', name: 'Test Beta Jn', city: 'Beta', arrival: toArr, day: toDay, sequence: 14 },
  distance: 31.7, duration: 50, totalHaltsBetween: 2, ...extra
});
const answer = trains => ({ success: true, data: { from: { code: 'TSA' }, to: { code: 'TSB' }, count: trains.length, trains }, meta: { source: 'database' } });
const respond = (body, { status = 200, remaining = '90' } = {}) => async () => new Response(JSON.stringify(body), { status, headers: { 'x-ratelimit-remaining-month': remaining } });
const ctxFor = (extra = {}) => ({
  origin: { lat: 16.519, lon: 80.619, name: 'Origin' }, destination: { lat: 16.301, lon: 80.443, name: 'Destination' },
  date: '2026-10-20', windowStartSeconds: 6 * H, windowEndSeconds: 12 * H, utcOffset: '+05:30', crowFliesMeters: 30000, config: getRoutingConfig(), ...extra
});
const client = (fetchImpl, env = {}) => createRailRadarClient({ env: { RAILRADAR_API_KEY: 'rr_test_key', ...env }, fetchImpl });

describe('client', () => {
  test('maps the documented response; the key goes only in the Authorization header', async () => {
    const seen = [];
    const c = client(async (url, init) => { seen.push({ url, auth: init.headers.Authorization }); return respond(answer([apiTrain('90001', '07:00', 1, '07:50', 1)]))(); });
    const [t] = await c.trainsBetween('TSA', 'TSB', '2026-10-20');
    assert.deepEqual([t.number, t.from.code, t.from.departure, t.from.day, t.to.code, t.to.arrival, t.durationMinutes, t.haltsBetween], ['90001', 'TSA', '07:00', 1, 'TSB', '07:50', 50, 2]);
    assert.match(seen[0].url, /\/trains\/between\/TSA\/TSB\?date=2026-10-20&live=false$/);
    assert.equal(seen[0].auth, 'Bearer rr_test_key');
    assert.ok(!seen[0].url.includes('rr_test_key'));
  });

  test('cached: the same station pair and date never costs a second request', async () => {
    let calls = 0;
    const c = client(async () => { calls++; return respond(answer([]))(); });
    await c.trainsBetween('TSA', 'TSB', '2026-10-20');
    await c.trainsBetween('TSA', 'TSB', '2026-10-20');
    assert.equal(calls, 1);
  });

  test('budget: stops at the configured budget and when RailRadar says none remain', async () => {
    const limited = client(respond(answer([])), { RAILRADAR_MONTHLY_REQUEST_BUDGET: '1' });
    await limited.trainsBetween('TSA', 'TSB', '2026-10-20');
    await assert.rejects(limited.trainsBetween('TSA', 'TSB', '2026-10-21'), e => e.code === 'BUDGET_EXHAUSTED');
    const drained = client(respond(answer([]), { remaining: '0' }));
    await drained.trainsBetween('TSA', 'TSB', '2026-10-20');
    await assert.rejects(drained.trainsBetween('TSA', 'TSB', '2026-10-22'), e => e.code === 'BUDGET_EXHAUSTED');
    assert.equal(drained.budget().providerRemaining, 0);
  });

  test('errors become coded failures, never data', async () => {
    await assert.rejects(client(respond({}, { status: 429 })).trainsBetween('TSA', 'TSB', '2026-10-20'), e => e.code === 'RATE_LIMITED');
    await assert.rejects(client(respond({}, { status: 401 })).trainsBetween('TSA', 'TSB', '2026-10-20'), e => e.code === 'UNAUTHORIZED');
    await assert.rejects(client(respond({}, { status: 503 })).trainsBetween('TSA', 'TSB', '2026-10-20'), e => e.code === 'PROVIDER_ERROR');
    assert.deepEqual(await client(respond({}, { status: 404 })).trainsBetween('TSA', 'TSB', '2026-10-20'), []);
  });

  test('under the test runner a real key is never used without an explicit fetch (protects the monthly quota)', () => {
    assert.equal(createRailRadarClient({ env: { RAILRADAR_API_KEY: 'rr_live_real' } }).configured, false);
  });

  test('malformed trains are dropped, not repaired', async () => {
    const c = client(respond(answer([apiTrain('ABC', '07:00', 1, '07:50', 1), apiTrain('90002', null, 1, '07:50', 1), apiTrain('90003', '07:00', 1, '07:50', 1)])));
    assert.deepEqual((await c.trainsBetween('TSA', 'TSB', '2026-10-20')).map(t => t.number), ['90003']);
  });
});

describe('mapping trains to journeys', () => {
  const stations = new Map(graph.stations.map(s => [s.code, s]));
  const anchors = { from: stations.get('TSA'), to: stations.get('TSB') };
  const op = { name: 'Indian Railways', type: 'rail', source: 'rail:RailRadar', confidence: 'published' };
  const map = async (trains, ctx = ctxFor(), searchDate = ctx.date) => {
    const c = client(respond(answer(trains)));
    return trainsToTrunks(await c.trainsBetween('TSA', 'TSB', searchDate), { ctx, searchDate, stations, anchors, accessSeconds: () => 0, operatorInfo: op });
  };

  test('times on the searched date; train identity exactly as RailRadar gave it; no fare', async () => {
    const [[t]] = await map([apiTrain('90001', '07:00', 1, '07:50', 1)]);
    assert.equal(t.trainNumber, '90001');
    assert.equal(t.trainName, 'Test Express 90001');
    assert.equal(t.departureTime, '2026-10-20T07:00:00+05:30');
    assert.equal(t.arrivalTime, '2026-10-20T07:50:00+05:30');
    assert.equal(t.fare, null);
    assert.equal(t.source.id, 'railradar');
    assert.equal(t.evidence.provider, 'RailRadar');
    assert.equal(t.intermediateStopCount, 2);
  });

  test('a train boarded on its 2nd journey day: run start date and boarding-station running days shift', async () => {
    const [[t]] = await map([apiTrain('90002', '07:10', 2, '08:00', 2, ['mon'])]);
    assert.equal(t.evidence.runStartDate, '2026-10-19', 'started Monday, boards Tuesday');
    assert.deepEqual(t.daysOfOperation, ['Tue']);
    assert.deepEqual(t.evidence.originRunningDays, ['Mon']);
    assert.deepEqual(runningDaysAtBoarding(['sun'], 3), ['Tue']);
  });

  test('overnight: arrival on a later journey day lands on the next calendar date', async () => {
    const [[t]] = await map([apiTrain('90003', '23:30', 1, '05:15', 2)], ctxFor({ windowStartSeconds: 20 * H, windowEndSeconds: 24 * H }));
    assert.equal(t.departureTime, '2026-10-20T23:30:00+05:30');
    assert.equal(t.arrivalTime, '2026-10-21T05:15:00+05:30');
  });

  test('door departure must fall in the window; nothing in it -> the next trains that day', async () => {
    const trains = [apiTrain('90004', '05:00', 1, '05:50', 1), apiTrain('90005', '13:00', 1, '13:50', 1)];
    assert.deepEqual((await map(trains)).map(([t]) => t.trainNumber), ['90005'], '05:00 is before the window; 13:00 is offered as the next train');
    assert.deepEqual((await map(trains, ctxFor({ windowStartSeconds: 4 * H, windowEndSeconds: 6 * H }))).map(([t]) => t.trainNumber), ['90004']);
  });

  test('a train fetched for the next day (late-evening window) is placed on that day', async () => {
    const ctx = ctxFor({ windowStartSeconds: 22 * H, windowEndSeconds: 28 * H });
    const [[t]] = await map([apiTrain('90006', '01:30', 1, '02:20', 1)], ctx, '2026-10-21');
    assert.equal(t.departureTime, '2026-10-21T01:30:00+05:30');
  });

  test('composed into a complete journey with access/egress, and the unknown fare is never zero', async () => {
    const [sequence] = await map([apiTrain('90001', '07:00', 1, '07:50', 1)]);
    const [journey] = composeAroundTrunk(sequence, { ...ctxFor(), fareConfig: getFareConfig() });
    assert.deepEqual(journey.legs.map(l => l.mode), ['walk', 'rail', 'walk']);
    assert.equal(journey.legs[1].trainNumber, '90001');
    assert.equal(journey.fareEstimate.complete, false);
  });
});

describe('source', () => {
  test('anchors on the nearest junction within reach, not on a nearer halt', () => {
    assert.equal(anchorStation(graph, { lat: 16.511, lon: 80.638 }, 40000).s.code, 'TSA');
  });

  test('status: not configured without a key; waits for station locations; not applicable to short trips', () => {
    assert.equal(createRailRadarSource({ env: {}, client: createRailRadarClient({ env: {} }), getGraph: () => graph }).status({ crowFliesMeters: 1e6 }).configured, false);
    const ok = createRailRadarSource({ client: client(respond(answer([]))), getGraph: () => graph });
    assert.equal(ok.status({ crowFliesMeters: 1e6 }).configured, true);
    assert.equal(ok.status({ crowFliesMeters: 2000 }).applicable, false);
    assert.equal(createRailRadarSource({ client: client(respond(answer([]))), getGraph: () => null }).status({ crowFliesMeters: 1e6 }).configured, false);
  });

  test('search makes one request for the anchored pair and returns trunks', async () => {
    const urls = [];
    const c = client(async url => { urls.push(String(url)); return respond(answer([apiTrain('90001', '07:00', 1, '07:50', 1)]))(); });
    const out = await createRailRadarSource({ client: c, getGraph: () => graph }).search(ctxFor());
    assert.equal(urls.length, 1);
    assert.match(urls[0], /\/trains\/between\/TSA\/TSB\?/);
    assert.equal(out.trunks[0][0].trainNumber, '90001');
  });

  test('capabilities: Train becomes scheduled with RailRadar; budget exhaustion turns it off with a reason', async () => {
    const c = client(respond(answer([]), { remaining: '0' }));
    const source = createRailRadarSource({ client: c, getGraph: () => graph });
    const on = getCapabilities({ env: {}, railRadar: source, railNetwork: () => ({ available: true, state: 'ready' }) }).modes.train;
    assert.deepEqual([on.available, on.provider, on.sourceName, on.live], [true, 'railradar', 'RailRadar', false]);
    await c.trainsBetween('TSA', 'TSB', '2026-10-20');
    const off = getCapabilities({ env: {}, railRadar: source, railNetwork: () => ({ available: true, state: 'ready' }) }).modes.train;
    assert.equal(off.available, false);
    assert.match(off.reason, /allowance for this month is used up/);
  });
});

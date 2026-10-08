import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { serviceNumberFor } from '../../sources/gtfs/serviceNumbers.js';
import { operatorIdentity } from '../../sources/operators.js';
import { busIdentity } from '../../routing/journeyBuilder.js';
import { runSources, SOURCE_STATUS } from '../../sources/sourceRunner.js';
import { loadRailTimetable, searchTrains, createRailSource } from '../../sources/rail/railSource.js';
import { offerToTrunks, createDuffelSource } from '../../sources/flights/duffelSource.js';
import { createPrivateBusSource } from '../../sources/privateBus/privateBusSource.js';
import { composeAroundTrunk } from '../compose.js';
import { buildShortlist, dedupeSameVehicles, primaryModeOf } from '../shortlist.js';
import { handleMultimodalPlanRequest } from '../planMultimodal.js';
import { rateJourneys, bestPathIds, trackingScore } from '../../rating/pathRating.js';
import { getRoutingConfig } from '../../routing/config.js';
import { getFareConfig } from '../../fare/fareConfig.js';
import { makeNetwork, daily } from '../../routing/__tests__/helpers.js';

const config = getRoutingConfig();
const fareConfig = getFareConfig();
const ORIGIN = { lat: 16.5062, lon: 80.6480, name: 'Origin' };          // central Vijayawada (synthetic use)
const DEST = { lat: 17.3780, lon: 78.4867, name: 'Destination' };       // central Hyderabad (synthetic use)
const ctxBase = { origin: ORIGIN, destination: DEST, utcOffset: '+05:30', config, fareConfig };

// ---------- synthetic data (clearly fake: test codes, test names) ----------
const timetable = (extra = {}) => loadRailTimetable({
  source: { name: 'Test rail fixture', type: 'community', license: 'test' },
  operator: 'Indian Railways',
  stations: [
    { code: 'TSA', name: 'Test Station A', lat: 16.5176, lon: 80.6195 },
    { code: 'TSM', name: 'Test Station Mid', lat: 17.0, lon: 79.6 },
    { code: 'TSB', name: 'Test Station B', lat: 17.4337, lon: 78.5016 }
  ],
  trains: [
    { number: '99001', name: 'Test Express', days: ['Mon', 'Wed'], stops: [{ code: 'TSA', arr: null, dep: '09:00', day: 0 }, { code: 'TSM', arr: '11:00', dep: '11:02', day: 0 }, { code: 'TSB', arr: '14:30', dep: null, day: 0 }] },
    { number: '99003', name: 'Test Night Mail', days: 'daily', stops: [{ code: 'TSA', arr: null, dep: '23:00', day: 0 }, { code: 'TSB', arr: '04:30', dep: null, day: 1 }] }
  ],
  ...extra
});
const searchCtx = (date, start = 8 * 3600, end = 12 * 3600) => ({ ...ctxBase, date, windowStartSeconds: start, windowEndSeconds: end });

const duffelOffer = (id, amount, segments) => ({
  id, total_amount: String(amount), total_currency: 'INR',
  slices: [{ segments: segments.map(([flight, from, to, dep, arr]) => ({
    marketing_carrier: { iata_code: 'ZZ', name: 'Test Air' }, operating_carrier: { name: 'Test Air' }, marketing_carrier_flight_number: flight,
    origin: { iata_code: from, name: `${from} Test Airport`, latitude: from === 'TAA' ? 16.53 : 17.24, longitude: from === 'TAA' ? 80.80 : 78.43 },
    destination: { iata_code: to, name: `${to} Test Airport`, latitude: to === 'TAB' ? 17.24 : 16.53, longitude: to === 'TAB' ? 78.43 : 80.80 },
    departing_at: dep, arriving_at: arr
  })) }]
});

// A bus journey reduced to what the shortlist reads.
function busJourney(id, { dep, minutes, transfers = 0, trips = [id], operator = 'APSRTC', fareMid = 400, quality = 'approximate', access = 'walk' }) {
  const depMs = Date.parse(`2026-10-05T${dep}:00+05:30`);
  // Local IST timestamps, the format the planner emits.
  const iso = m => new Date(depMs + m * 60000 + 330 * 60000).toISOString().slice(0, 19) + '+05:30';
  const per = minutes / trips.length;
  const legs = [{ mode: access, kind: 'access', durationSeconds: 0, from: { name: 'o' }, to: { name: 's' }, departureTime: iso(0), arrivalTime: iso(0) }];
  trips.forEach((trip, i) => legs.push({
    mode: 'bus', tripId: trip, operator, operatorInfo: operatorIdentity(operator, { source: 'test' }), serviceNumber: null,
    departureTime: iso(i * per + (i ? 5 : 0)), arrivalTime: iso((i + 1) * per), durationSeconds: per * 60,
    timeQuality: quality, dataConfidence: 'inferred', fromStop: { name: 'a' }, toStop: { name: 'b' }, tracking: { status: 'options_available' }
  }));
  return {
    id, labels: [], departureTime: iso(0), arrivalTime: iso(minutes), totalDurationSeconds: minutes * 60, walkingDurationSeconds: 0,
    waitingDurationSeconds: 0, localRideDurationSeconds: 0, localRideCount: 0, transfers, transitLegCount: trips.length,
    scheduleConfidence: 'inferred', timeQuality: quality,
    fareEstimate: { min: fareMid - 50, max: fareMid + 50, currency: 'INR', confidence: 'estimated', complete: true, components: [], unknownComponents: [] },
    tracking: { busLegs: trips.length, verifiedLegs: 0, notFoundLegs: 0, allVerified: false }, legs
  };
}

describe('identity: route ID vs service number, operator', () => {
  test('1. zero-padded feed codes are public service numbers without the zero; unproven shapes stay route codes', () => {
    assert.deepEqual(serviceNumberFor('03846', 'APSRTC'), { serviceNumber: '3846', serviceNumberSource: 'tracker_verified' });
    assert.deepEqual(serviceNumberFor('04001', 'APSRTC'), { serviceNumber: '4001', serviceNumberSource: 'feed_format' });
    assert.deepEqual(serviceNumberFor('35169', 'APSRTC'), { serviceNumber: '35169', serviceNumberSource: 'tracker_verified' });
    for (const code of ['95083', '98509', '952054', 'AB12', '']) assert.equal(serviceNumberFor(code, 'APSRTC').serviceNumber, null, code);
    assert.equal(serviceNumberFor('21212', 'APSRTC').serviceNumber, null, 'checked and not listed by APSRTC: evidence beats the format rule');
    assert.equal(serviceNumberFor('03846', 'Some Other Agency').serviceNumber, null, 'the format is only proven for APSRTC');
    const id = busIdentity({ sourceId: '95083', shortName: '95083', agencyName: 'APSRTC' }, {});
    assert.equal(id.serviceNumber, null);
    assert.equal(id.routeId, '95083');
    assert.equal(id.displayName, 'APSRTC route 95083');
    assert.equal(id.tracking, null, 'no tracker is offered a code that is not a service number');
  });

  test('2. operator identity comes from the source name with factual metadata', () => {
    assert.deepEqual(operatorIdentity('APSRTC', { source: 'gtfs:agency.txt' }), { name: 'APSRTC', type: 'state_transport', source: 'gtfs:agency.txt', confidence: 'published' });
    assert.equal(operatorIdentity('Indian Railways', { source: 'rail' }).type, 'rail');
    assert.equal(operatorIdentity('Test Air', { source: 'duffel', typeHint: 'airline' }).type, 'airline');
    assert.equal(operatorIdentity('Some Travels', { source: 'x' }).type, 'unknown', 'a name alone never makes something a private bus');
  });

  test('3/18. unknown operator stays unknown and is never fabricated', () => {
    assert.deepEqual(operatorIdentity(null, { source: 'gtfs' }), { name: null, type: 'unknown', source: 'gtfs', confidence: 'unknown' });
    const id = busIdentity({ sourceId: '03846', shortName: '03846', agencyName: null }, { name: 'Community APSRTC GTFS' });
    assert.equal(id.operator, null, 'a dataset NAME is not an operator');
    assert.equal(id.displayName, 'Route 03846');
    const [journey] = composeAroundTrunk([{ ...searchTrains(timetable(), searchCtx('2026-10-05'))[0], operator: null, operatorInfo: operatorIdentity(null, { source: 'rail' }) }], ctxBase);
    const rail = journey.legs.find(leg => leg.mode === 'rail');
    assert.equal(rail.operator, null);
    assert.equal(rail.serviceNumber, null);
  });
});

describe('rail source and composition', () => {
  test('6. local ride + train: a train in the timetable becomes a door-to-door journey with estimated access/egress', () => {
    const trunks = searchTrains(timetable(), searchCtx('2026-10-05'));
    assert.deepEqual(trunks.map(t => t.trainNumber), ['99001']);
    const [t] = trunks;
    assert.equal(t.operator, 'Indian Railways');
    assert.equal(t.trainName, 'Test Express');
    assert.equal(t.intermediateStopCount, 1);
    assert.deepEqual(t.intermediateStops, ['Test Station Mid']);
    assert.deepEqual(t.daysOfOperation, ['Mon', 'Wed']);
    const [journey] = composeAroundTrunk([t], ctxBase);
    assert.deepEqual(journey.legs.map(l => l.mode), ['local_ride', 'rail', 'local_ride']);
    assert.equal(primaryModeOf(journey), 'train');
    assert.ok(Date.parse(journey.legs[0].arrivalTime) <= Date.parse(t.departureTime) - 15 * 60000, 'arrives before the boarding buffer');
    assert.equal(journey.fareEstimate.complete, false, 'no rail fare is invented');
  });

  test('days of operation are honoured (Mon-first weekday convention)', () => {
    assert.deepEqual(searchTrains(timetable(), searchCtx('2026-10-06')).map(t => t.trainNumber), [], 'Tuesday: not running');
    assert.deepEqual(searchTrains(timetable(), searchCtx('2026-10-07')).map(t => t.trainNumber), ['99001'], 'Wednesday');
    const night = searchTrains(timetable(), searchCtx('2026-10-05', 22 * 3600, 24 * 3600))[0];
    assert.equal(night.trainNumber, '99003');
    assert.equal(night.arrivalTime, '2026-10-06T04:30:00+05:30');
  });

  test('16. schedule confidence: community data is inferred; official data inside its validity is published', () => {
    assert.equal(searchTrains(timetable(), searchCtx('2026-10-05'))[0].scheduleConfidence, 'inferred');
    const official = timetable({ source: { name: 'Official', type: 'official', validFrom: '2026-01-01', validTo: '2026-12-31' } });
    assert.equal(searchTrains(official, searchCtx('2026-10-05'))[0].scheduleConfidence, 'published');
    const expired = timetable({ source: { name: 'Official', type: 'official', validFrom: '2025-01-01', validTo: '2025-12-31' } });
    assert.equal(searchTrains(expired, searchCtx('2026-10-05'))[0].scheduleConfidence, 'inferred');
  });

  test('a timetable without a declared source is rejected', () => {
    assert.throws(() => loadRailTimetable({ stations: [], trains: [] }), /source/);
  });

  test('5. bus + train: a GTFS bus can be the access to the station (bounded to one alternative)', () => {
    const [t] = searchTrains(timetable(), searchCtx('2026-10-05'));
    const busToStation = (from, to, latestArrivalMs) => [{
      mode: 'bus', tripId: 'B1', operator: 'APSRTC', operatorInfo: operatorIdentity('APSRTC', { source: 'test' }), serviceNumber: '1234',
      fromStop: { name: 'Stop near origin' }, toStop: { name: to.name }, timeQuality: 'approximate', dataConfidence: 'inferred',
      departureTime: new Date(latestArrivalMs - 40 * 60000).toISOString(), arrivalTime: new Date(latestArrivalMs - 10 * 60000).toISOString(), durationSeconds: 1800
    }];
    const journeys = composeAroundTrunk([t], { ...ctxBase, transitAccess: busToStation });
    assert.equal(journeys.length, 2);
    assert.deepEqual(journeys[1].legs.map(l => l.mode), ['bus', 'rail', 'local_ride']);
    assert.equal(journeys[1].transfers, 1);
  });
});

describe('flight source and composition', () => {
  const nonstop = duffelOffer('off_1', 4800, [['101', 'TAA', 'TAB', '2026-10-05T10:00:00+05:30', '2026-10-05T11:10:00+05:30']]);
  const connecting = duffelOffer('off_2', 6100, [
    ['201', 'TAA', 'TAC', '2026-10-05T09:00:00+05:30', '2026-10-05T10:00:00+05:30'],
    ['202', 'TAC', 'TAB', '2026-10-05T11:00:00+05:30', '2026-10-05T12:00:00+05:30']
  ]);

  test('7. a flight offer becomes trunk legs with the airline from the API and the offer price', () => {
    const [leg] = offerToTrunks(nonstop);
    assert.equal(leg.operator, 'Test Air');
    assert.equal(leg.operatorInfo.type, 'airline');
    assert.equal(leg.flightNumber, 'ZZ101');
    assert.deepEqual(leg.fare, { type: 'published', amount: 4800, currency: 'INR', confidence: 'published', basis: 'flight_offer_total' });
    assert.equal(leg.durationSeconds, 70 * 60);
  });

  test('8. local ride + flight + local ride, with check-in and exit time, and a connection priced once', () => {
    const [journey] = composeAroundTrunk(offerToTrunks(connecting), ctxBase);
    assert.deepEqual(journey.legs.map(l => l.mode), ['local_ride', 'air', 'air', 'local_ride']);
    assert.equal(primaryModeOf(journey), 'flight');
    assert.ok(journey.waitingDurationSeconds >= (75 + 20 + 60) * 60, 'airport buffers and the connection count as waiting');
    assert.equal(journey.fareEstimate.unknownComponents.length, 0, 'the second segment is included in the offer price');
    assert.ok(journey.fareEstimate.min >= 6100);
  });

  test('flights are not searched without a token, nor for short trips', async () => {
    const off = createDuffelSource({ env: {} });
    assert.equal(off.status({ crowFliesMeters: 600000 }).configured, false);
    const on = createDuffelSource({ env: { DUFFEL_ACCESS_TOKEN: 'test' }, fetchImpl: () => { throw new Error('must not be called'); } });
    assert.equal(on.status({ crowFliesMeters: 50000 }).applicable, false);
  });

  test('the Duffel adapter sends only airports, the date and one adult (mocked API)', async () => {
    const calls = [];
    const fetchImpl = async (url, init = {}) => {
      calls.push({ url, body: init.body ? JSON.parse(init.body) : null, auth: init.headers?.Authorization, version: init.headers?.['Duffel-Version'] });
      if (url.includes('/places/suggestions')) {
        const near = url.includes('lat=16.5') ? { iata_code: 'TAA', type: 'airport', name: 'A', latitude: 16.53, longitude: 80.8 } : { iata_code: 'TAB', type: 'airport', name: 'B', latitude: 17.24, longitude: 78.43 };
        return { ok: true, json: async () => ({ data: [near] }) };
      }
      return { ok: true, json: async () => ({ data: { offers: [connecting, nonstop] } }) };
    };
    const source = createDuffelSource({ env: { DUFFEL_ACCESS_TOKEN: 'test-token' }, fetchImpl });
    const out = await source.search({ ...ctxBase, date: '2026-10-05' });
    assert.equal(out.trunks.length, 2);
    assert.equal(out.trunks[0][0].flightNumber, 'ZZ101', 'cheapest offer first');
    const request = calls.find(c => c.body);
    assert.deepEqual(request.body, { data: { slices: [{ origin: 'TAA', destination: 'TAB', departure_date: '2026-10-05' }], passengers: [{ type: 'adult' }], cabin_class: 'economy' } });
    assert.ok(calls.every(c => c.version === 'v2' && c.auth === 'Bearer test-token'));
  });

  test('17. trains and flights carry no tracking claim; their journeys have no tracking score', () => {
    const [journey] = composeAroundTrunk(offerToTrunks(nonstop), ctxBase);
    assert.ok(journey.legs.filter(l => l.mode === 'air').every(l => l.tracking === null));
    assert.equal(trackingScore(journey), null);
  });
});

describe('ranking, directness and diversity', () => {
  test('4/14. a direct bus beats a slightly faster transfer chain on approximate timetables', () => {
    const direct = busJourney('direct', { dep: '14:29', minutes: 300 });
    const chain = busJourney('chain', { dep: '14:14', minutes: 265, transfers: 1, trips: ['c1', 'c2'] });
    assert.deepEqual(bestPathIds([direct, chain], rateJourneys([direct, chain])), ['direct']);
    const list = buildShortlist([direct, chain]).journeys;
    assert.ok(list.find(j => j.id === 'direct').labels.includes('BEST_PATH'));
    assert.ok(list.find(j => j.id === 'chain').labels.includes('FASTEST'), 'the chain is still offered, honestly labelled');
  });

  test('a much faster transfer journey still wins', () => {
    const direct = busJourney('direct', { dep: '14:00', minutes: 420 });
    const chain = busJourney('chain', { dep: '14:00', minutes: 280, transfers: 1, trips: ['c1', 'c2'] });
    assert.deepEqual(bestPathIds([direct, chain], rateJourneys([direct, chain])), ['chain']);
  });

  test('10/11. near-identical buses collapse: same vehicles deduped; one corridor, one hour -> the strongest only', () => {
    const sameVehicles = [busJourney('a', { dep: '22:23', minutes: 330, trips: ['X'] }), busJourney('b', { dep: '22:23', minutes: 330, trips: ['X'], access: 'local_ride' })];
    assert.equal(dedupeSameVehicles(sameVehicles).length, 1);
    const band = Array.from({ length: 8 }, (_, i) => busJourney(`n${i}`, { dep: `22:${String(i * 5).padStart(2, '0')}`, minutes: 300 + i, trips: [`T${i}`] }));
    const result = buildShortlist(band);
    assert.ok(result.journeys.length <= 3, `${result.journeys.length} of 8 near-identical buses kept`);
    assert.equal(result.stats.clusters, 1);
  });

  test('9/12/13. multimodal ranking: every real mode is represented; fastest and lower-cost winners are data-driven', () => {
    const [trainTrunk] = searchTrains(timetable(), searchCtx('2026-10-05'));
    const [train] = composeAroundTrunk([trainTrunk], ctxBase);
    const [flight] = composeAroundTrunk(offerToTrunks(duffelOffer('off', 4800, [['101', 'TAA', 'TAB', '2026-10-05T10:00:00+05:30', '2026-10-05T11:10:00+05:30']])), ctxBase);
    const buses = Array.from({ length: 6 }, (_, i) => busJourney(`bus${i}`, { dep: `${String(8 + i * 2).padStart(2, '0')}:00`, minutes: 330, trips: [`B${i}`], fareMid: 450 }));
    const { journeys } = buildShortlist([...buses, train, flight]);
    const modes = new Set(journeys.map(j => j.primaryMode));
    assert.ok(modes.has('bus') && modes.has('train') && modes.has('flight'), [...modes].join(','));
    assert.ok(journeys.length <= 7);
    assert.equal(journeys.find(j => j.labels.includes('FASTEST')).primaryMode, 'flight');
    const cheap = journeys.find(j => j.labels.includes('LOWER_ESTIMATED_COST'));
    if (cheap) assert.equal(cheap.primaryMode, 'bus');
    assert.equal(journeys.filter(j => j.labels.includes('BEST_PATH')).length >= 1, true);
  });

  test('a mode without data never gets a category', () => {
    const { journeys } = buildShortlist([busJourney('only', { dep: '09:00', minutes: 300 })]);
    assert.deepEqual(journeys.map(j => j.primaryMode), ['bus']);
    assert.ok(!journeys[0].labels.includes('LEAST_TRANSFERS'), 'no "fewest transfers" claim without an alternative');
  });

  test('20. performance: shortlisting 300 candidates stays fast', () => {
    const many = Array.from({ length: 300 }, (_, i) => busJourney(`m${i}`, { dep: `${String(6 + (i % 16)).padStart(2, '0')}:${String((i * 7) % 60).padStart(2, '0')}`, minutes: 280 + (i % 50), trips: [`M${i}`], fareMid: 300 + (i % 40) }));
    const t0 = performance.now();
    const result = buildShortlist(many);
    const ms = performance.now() - t0;
    assert.ok(ms < 1500, `${ms.toFixed(0)} ms`);
    assert.ok(result.journeys.length <= 7);
  });
});

describe('sources: isolation and honesty', () => {
  const ok = { id: 'ok', label: 'ok', mode: 'rail', status: () => ({ configured: true }), search: async () => ({ trunks: [{ x: 1 }] }) };
  const boom = { id: 'boom', label: 'boom', mode: 'air', status: () => ({ configured: true }), search: async () => { throw new Error('provider down'); } };
  const slow = { id: 'slow', label: 'slow', mode: 'air', timeoutMs: 50, status: () => ({ configured: true }), search: () => new Promise(resolve => setTimeout(() => resolve({ trunks: [{}] }), 1000)) };
  const off = { id: 'off', label: 'off', mode: 'bus', status: () => ({ configured: false, reason: 'none' }), search: () => { throw new Error('must not run'); } };

  test('15. one failing or slow source never blocks the others', async () => {
    const t0 = performance.now();
    const { results, report } = await runSources([ok, boom, slow, off], {});
    assert.ok(performance.now() - t0 < 900, 'the slow source was cut off');
    assert.deepEqual(Object.fromEntries(report.map(r => [r.id, r.status])), { ok: SOURCE_STATUS.OK, boom: SOURCE_STATUS.ERROR, slow: SOURCE_STATUS.TIMEOUT, off: SOURCE_STATUS.NOT_CONFIGURED });
    assert.deepEqual([...results.keys()], ['ok']);
  });

  test('15b. the planner still returns buses when the rail and flight sources fail', async () => {
    const spec = {
      stops: { A: [16.5, 80.0], C: [16.5, 80.1] },
      trips: [{ id: 'T1', route: '03846', service: 'ALL', times: [['A', '08:00'], ['C', '09:00']] }],
      calendars: [daily()], agency: 'APSRTC'
    };
    const network = makeNetwork(spec);
    const { status, body } = await handleMultimodalPlanRequest(
      { fromLat: '16.5', fromLng: '80.0', toLat: '16.5', toLng: '80.1', date: '2026-10-05', time: '07:30', windowMinutes: '120' },
      { getNetwork: () => network, now: new Date('2026-10-03T06:30:00Z'), sources: [boom, slow] }
    );
    assert.equal(status, 200);
    assert.equal(body.journeys.length, 1);
    assert.equal(body.journeys[0].legs.find(l => l.mode === 'bus').serviceNumber, '3846');
    assert.deepEqual(body.sources.map(s => [s.id, s.status]), [['gtfs', 'ok'], ['boom', 'error'], ['slow', 'timeout']]);
  });

  test('19. private buses are never fabricated: with no licensed source the slot is empty', async () => {
    const { results, report } = await runSources([createPrivateBusSource()], {});
    assert.equal(report[0].status, SOURCE_STATUS.NOT_CONFIGURED);
    assert.equal(results.size, 0);
  });

  test('rail is not configured unless a timetable with a declared source is provided', () => {
    assert.equal(createRailSource({ env: {} }).status({ crowFliesMeters: 300000 }).configured, false);
  });
});

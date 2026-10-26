// Railway timetable: provider normalisation, import validation, date-aware search, freshness, the rail source,
// bus + train composition and the RailRadar adapter. All data here is SYNTHETIC (test codes TA..TF, train numbers 9xxxx);
// real-data validation lives in backend/transit/rail/README.md.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { openRailDb } from '../railDb.js';
import { importRailRecords, validateRailRecords } from '../railImporter.js';
import { normaliseGtfsRail } from '../providers/gtfsRailProvider.js';
import { loadRailNetworkFromDb, railFreshness } from '../railNetwork.js';
import { searchRail, toTrunk, runningDaysAt, paretoRail } from '../railSearch.js';
import { createRailSource, railAvailability } from '../../sources/rail/railSource.js';
import { getCapabilities } from '../railStatus.js';
import { createRailRadarClient } from '../verification/railRadar.js';
import { createBusFeeder, localClock, searchBeforeMinutes } from '../../multimodal/busFeeder.js';
import { haversineMeters } from '../../routing/geo.js';
import { composeAroundTrunk } from '../../multimodal/compose.js';
import { railWarnings } from '../../multimodal/planMultimodal.js';
import { getRoutingConfig } from '../../routing/config.js';
import { getFareConfig } from '../../fare/fareConfig.js';
import { isoToDayNumber } from '../../routing/serviceCalendar.js';

const H = 3600;
const t = (h, m = 0) => h * H + m * 60;
const daily = [1, 1, 1, 1, 1, 1, 1];
// Stations on a synthetic line running north-east, roughly 50 km apart.
const STATIONS = [
  { code: 'TA', name: 'Test A Jn', lat: 16.0, lon: 80.0 },
  { code: 'TB', name: 'Test B', lat: 16.35, lon: 80.3 },
  { code: 'TC', name: 'Test C Jn', lat: 16.7, lon: 80.6 },
  { code: 'TD', name: 'Test D', lat: 17.05, lon: 80.9 },
  { code: 'TE', name: 'Test E Branch', lat: 17.0, lon: 81.4 },
  { code: 'TF', name: 'Test Far', lat: 40.0, lon: 10.0 } // outside India: coordinate must be dropped
];
const stop = (code, arrival, departure) => ({ code, sourceSequence: null, arrival, departure, distanceKm: null });
const train = (number, serviceId, stops, extra = {}) => ({ sourceTripId: number, number, name: `Test Train ${number}`, headsign: null, serviceId, stops: stops.map((s, i) => ({ ...s, sourceSequence: i + 1 })), ...extra });

function records() {
  return {
    meta: { snapshotDate: '2026-10-01', feedStartDate: '2026-10-01', feedEndDate: '2026-11-01' },
    stations: STATIONS,
    services: [
      { serviceId: 'DAILY', days: daily, start: '2026-01-01', end: '2027-06-30' },
      { serviceId: 'MON', days: [1, 0, 0, 0, 0, 0, 0], start: '2026-01-01', end: '2027-06-30' },
      { serviceId: 'ENDED', days: daily, start: '2026-01-01', end: '2026-10-14' },
      { serviceId: 'BROKEN', days: daily, start: '2099-12-31', end: '2027-01-01' }
    ],
    serviceDates: [],
    trains: [
      // A -> B -> C -> D, daily, morning.
      train('90001', 'DAILY', [stop('TA', null, t(6)), stop('TB', t(6, 50), t(6, 52)), stop('TC', t(7, 40), t(7, 45)), stop('TD', t(8, 30), null)]),
      // The reverse direction must never be offered for A -> D.
      train('90002', 'DAILY', [stop('TD', null, t(6, 10)), stop('TC', t(7), t(7, 2)), stop('TA', t(8, 40), null)]),
      // Overnight: leaves A on MONDAY 23:00, reaches C at 01:30 on Tuesday (day 2), D at 02:20.
      train('90003', 'MON', [stop('TA', null, t(23)), stop('TC', t(25, 30), t(25, 32)), stop('TD', t(26, 20), null)]),
      // Calendar ended 14 Oct 2026: never offered after that.
      train('90004', 'ENDED', [stop('TA', null, t(9)), stop('TD', t(11), null)]),
      // Branch: C -> E, connects with 90001 at C (arrives 07:40) after 50 minutes.
      train('90005', 'DAILY', [stop('TC', null, t(8, 30)), stop('TE', t(9, 30), null)]),
      // Branch too soon after 90001 (20 minutes): below the minimum transfer time.
      train('90006', 'DAILY', [stop('TC', null, t(8, 0)), stop('TE', t(9, 0), null)]),
      // Refused at import.
      train('90007', 'NO_SUCH_SERVICE', [stop('TA', null, t(10)), stop('TB', t(11), null)]),
      train('90008', 'BROKEN', [stop('TA', null, t(10)), stop('TB', t(11), null)]),
      train('90009', 'DAILY', [stop('TA', null, t(10)), stop('TB', t(9), t(9, 5)), stop('TC', t(12), null)]),
      train('90010', 'DAILY', [stop('TA', null, t(12))])
    ]
  };
}

function network() {
  const db = openRailDb(':memory:');
  importRailRecords({ db, records: records(), source: { providerId: 'test', name: 'Synthetic rail', type: 'community', license: 'test', licenseStatus: 'unconfirmed', operator: 'Indian Railways' }, checksum: 'x', retrievedAt: '2026-10-02T00:00:00Z' });
  const net = loadRailNetworkFromDb(db);
  db.close();
  return net;
}
const at = code => { const s = STATIONS.find(x => x.code === code); return { lat: s.lat, lon: s.lon }; };
const exact = (from, to) => ({ originStationCodes: [from], destinationStationCodes: [to], extendIfEmptySeconds: 0 });
const numbersOf = (net, result) => result.journeys.map(j => j.legs.map(leg => net.trains[leg.t].number).join('>'));

describe('import validation (provider independent)', () => {
  test('refuses trains without a calendar, with an impossible calendar, backwards times or too few stops', () => {
    const checked = validateRailRecords(records());
    const refused = checked.issues.filter(i => i.severity === 'error').map(i => `${i.code}:${i.entity}`);
    assert.ok(refused.includes('TRAIN_WITHOUT_CALENDAR:90007'));
    assert.ok(refused.includes('SERVICE_RANGE_INVALID:BROKEN'));
    assert.ok(refused.includes('TRAIN_WITHOUT_CALENDAR:90008'), 'a train on an invalid calendar has no usable calendar');
    assert.ok(refused.includes('TIMES_NOT_MONOTONIC:90009'));
    assert.ok(refused.includes('TOO_FEW_STOPS:90010'));
    assert.deepEqual(checked.trains.map(x => x.number), ['90001', '90002', '90003', '90004', '90005', '90006']);
  });

  test('a coordinate outside India is dropped, never "corrected"; origin/terminus placeholders are normalised', () => {
    const checked = validateRailRecords(records());
    assert.deepEqual(checked.stations.find(s => s.code === 'TF'), { code: 'TF', name: 'Test Far', lat: null, lon: null });
    const first = checked.trains[0].stops;
    assert.equal(first[0].arrival, null);
    assert.equal(first.at(-1).departure, null);
  });

  test('validity is the span of the calendars actually used', () => {
    const checked = validateRailRecords(records());
    assert.deepEqual([checked.validFrom, checked.validTo], ['2026-01-01', '2027-06-30']);
  });

  test('a community source can never be stored as verified', () => {
    const db = openRailDb(':memory:');
    assert.throws(() => db.prepare("INSERT INTO rail_datasets (provider_id, source_key, name, source_type, license_status, retrieved_at, imported_at, checksum_sha256, verified) VALUES ('x','x','x','community','unconfirmed','t','t','c',1)").run());
    db.close();
  });
});

describe('GTFS rail provider', () => {
  test('only rail routes are taken, stop_id resolves through stop_code, feed_version gives the snapshot date', () => {
    const table = rows => ({ rows });
    const normalised = normaliseGtfsRail({ tables: {
      feed_info: table([{ feed_version: '2026-08-30-02-22-43', feed_start_date: '20260830', feed_end_date: '20260930' }]),
      routes: table([{ route_id: 'R1', route_short_name: '90001', route_long_name: 'TEST EXP', route_type: '2' }, { route_id: 'B1', route_short_name: '1', route_type: '3' }]),
      trips: table([{ route_id: 'R1', trip_id: 'T1', service_id: 'S' }, { route_id: 'B1', trip_id: 'T2', service_id: 'S' }]),
      stop_times: table([
        { trip_id: 'T1', stop_id: 'ID_B', stop_sequence: '2', arrival_time: '25:10:00', departure_time: '25:12:00', shape_dist_traveled: '40' },
        { trip_id: 'T1', stop_id: 'ID_A', stop_sequence: '1', arrival_time: '23:00:00', departure_time: '23:00:00', shape_dist_traveled: '0' },
        { trip_id: 'T2', stop_id: 'ID_A', stop_sequence: '1', arrival_time: '10:00:00', departure_time: '10:00:00' }
      ]),
      stops: table([{ stop_id: 'ID_A', stop_code: 'TA', stop_name: 'A', stop_lat: '16', stop_lon: '80' }, { stop_id: 'ID_B', stop_code: 'TB', stop_name: 'B', stop_lat: '16.3', stop_lon: '80.3' }]),
      calendar: table([{ service_id: 'S', monday: '1', tuesday: '0', wednesday: '0', thursday: '0', friday: '0', saturday: '0', sunday: '0', start_date: '20260101', end_date: '20261231' }])
    } });
    assert.equal(normalised.meta.snapshotDate, '2026-08-30');
    assert.equal(normalised.trains.length, 1, 'bus routes are not rail');
    assert.deepEqual(normalised.trains[0].stops.map(s => [s.code, s.arrival, s.departure]), [['TA', 82800, 82800], ['TB', 90600, 90720]]);
    assert.deepEqual(normalised.services[0].days, [1, 0, 0, 0, 0, 0, 0]);
  });
});

describe('train search', () => {
  const net = network();

  test('direct trains in the right direction, with the boarding and alighting stop order kept', () => {
    // 2026-10-20 is a Tuesday.
    const result = searchRail(net, { origin: at('TA'), destination: at('TD'), date: '2026-10-20', windowStartSeconds: t(5), windowEndSeconds: t(12) }, { ...exact('TA', 'TD'), boardBufferSeconds: 0, alightBufferSeconds: 0 });
    assert.deepEqual(numbersOf(net, result), ['90001']);
    const leg = result.journeys[0].legs[0];
    assert.deepEqual([leg.board, leg.alight, leg.dep, leg.arr], [0, 3, t(6), t(8, 30)]);
  });

  test('boarding at an intermediate station uses that station\'s own times', () => {
    const result = searchRail(net, { origin: at('TB'), destination: at('TC'), date: '2026-10-20', windowStartSeconds: t(5), windowEndSeconds: t(12) }, { ...exact('TB', 'TC'), boardBufferSeconds: 0, alightBufferSeconds: 0 });
    const [trunk] = result.journeys[0].legs.map(leg => toTrunk(net, leg, { searchDay: isoToDayNumber('2026-10-20'), utcOffset: '+05:30', scheduleConfidence: 'published', source: { snapshotDate: '2026-10-01' } }));
    assert.equal(trunk.departureTime, '2026-10-20T06:52:00+05:30');
    assert.equal(trunk.arrivalTime, '2026-10-20T07:40:00+05:30');
    assert.deepEqual([trunk.evidence.boardStopNumber, trunk.evidence.alightStopNumber, trunk.evidence.totalStops], [2, 3, 4]);
    assert.equal(trunk.fare, null, 'no fare is invented');
  });

  test('running days: the Monday-only overnight train is found on Tuesday at its day-2 station, and not on Wednesday', () => {
    const q = date => searchRail(net, { origin: at('TC'), destination: at('TD'), date, windowStartSeconds: t(0), windowEndSeconds: t(4) }, { ...exact('TC', 'TD'), boardBufferSeconds: 0, alightBufferSeconds: 0 });
    const tuesday = q('2026-10-20');
    assert.deepEqual(numbersOf(net, tuesday), ['90003']);
    const leg = tuesday.journeys[0].legs[0];
    assert.equal(leg.k, -1, 'the run started on Monday');
    const trunk = toTrunk(net, leg, { searchDay: isoToDayNumber('2026-10-20'), utcOffset: '+05:30', scheduleConfidence: 'published', source: null });
    assert.equal(trunk.departureTime, '2026-10-20T01:32:00+05:30');
    assert.equal(trunk.evidence.runStartDate, '2026-10-19');
    assert.equal(trunk.evidence.departureRunDay, 2);
    assert.deepEqual(trunk.daysOfOperation, ['Tue'], 'running days are expressed at the boarding station');
    assert.deepEqual(trunk.evidence.originRunningDays, ['Mon']);
    assert.deepEqual(numbersOf(net, q('2026-10-21')), []);
  });

  test('an overnight journey from the origin arrives on the next calendar day', () => {
    const result = searchRail(net, { origin: at('TA'), destination: at('TD'), date: '2026-10-19', windowStartSeconds: t(22), windowEndSeconds: t(23, 30) }, { ...exact('TA', 'TD'), boardBufferSeconds: 0, alightBufferSeconds: 0 });
    const trunk = toTrunk(net, result.journeys[0].legs[0], { searchDay: isoToDayNumber('2026-10-19'), utcOffset: '+05:30', scheduleConfidence: 'published', source: null });
    assert.equal(trunk.trainNumber, '90003');
    assert.equal(trunk.arrivalTime, '2026-10-20T02:20:00+05:30');
  });

  test('a window crossing midnight finds a run that starts the next day', () => {
    const result = searchRail(net, { origin: at('TA'), destination: at('TD'), date: '2026-10-19', windowStartSeconds: t(23, 30), windowEndSeconds: t(30) }, { ...exact('TA', 'TD'), boardBufferSeconds: 0, alightBufferSeconds: 0 });
    const trunk = toTrunk(net, result.journeys[0].legs[0], { searchDay: isoToDayNumber('2026-10-19'), utcOffset: '+05:30', scheduleConfidence: 'published', source: null });
    assert.equal(trunk.departureTime, '2026-10-20T06:00:00+05:30');
  });

  test('an expired calendar is never stretched: 90004 runs on 14 Oct and not on 15 Oct', () => {
    const q = date => numbersOf(net, searchRail(net, { origin: at('TA'), destination: at('TD'), date, windowStartSeconds: t(8, 30), windowEndSeconds: t(9, 30) }, { ...exact('TA', 'TD'), boardBufferSeconds: 0 }));
    assert.deepEqual(q('2026-10-14'), ['90004']);
    assert.deepEqual(q('2026-10-15'), []);
  });

  test('train-to-train change honours the minimum transfer time', () => {
    const result = searchRail(net, { origin: at('TA'), destination: at('TE'), date: '2026-10-20', windowStartSeconds: t(5), windowEndSeconds: t(7) }, { ...exact('TA', 'TE'), boardBufferSeconds: 0, alightBufferSeconds: 0, minTransferSeconds: 45 * 60 });
    assert.deepEqual(numbersOf(net, result), ['90001>90005'], 'the 20-minute connection to 90006 is refused');
    assert.equal(result.journeys[0].transfers, 1);
    const tight = searchRail(net, { origin: at('TA'), destination: at('TE'), date: '2026-10-20', windowStartSeconds: t(5), windowEndSeconds: t(7) }, { ...exact('TA', 'TE'), boardBufferSeconds: 0, alightBufferSeconds: 0, minTransferSeconds: 15 * 60 });
    assert.deepEqual(numbersOf(net, tight), ['90001>90006']);
  });

  test('no change is offered when the wait would exceed the maximum', () => {
    const result = searchRail(net, { origin: at('TA'), destination: at('TE'), date: '2026-10-20', windowStartSeconds: t(5), windowEndSeconds: t(7) }, { ...exact('TA', 'TE'), boardBufferSeconds: 0, minTransferSeconds: 45 * 60, maxTransferWaitSeconds: 30 * 60 });
    assert.deepEqual(numbersOf(net, result), []);
  });

  test('nothing in the window: the search looks once further ahead and says so', () => {
    const result = searchRail(net, { origin: at('TA'), destination: at('TD'), date: '2026-10-20', windowStartSeconds: t(1), windowEndSeconds: t(2) }, { originStationCodes: ['TA'], destinationStationCodes: ['TD'], boardBufferSeconds: 0 });
    assert.deepEqual(numbersOf(net, result), ['90001']);
    assert.ok(result.windowExtendedSeconds > 0);
  });

  test('access is part of the door departure: a train you cannot reach in time is not offered', () => {
    const q = (start, end) => numbersOf(net, searchRail(net, { origin: at('TA'), destination: at('TD'), date: '2026-10-20', windowStartSeconds: start, windowEndSeconds: end }, { originStationCodes: ['TA'], destinationStationCodes: ['TD'], boardBufferSeconds: 20 * 60, extendIfEmptySeconds: 0 }));
    // The 06:00 train needs leaving by 05:40 (20-minute station buffer).
    assert.deepEqual(q(t(5, 30), t(5, 45)), ['90001']);
    assert.deepEqual(q(t(5, 45), t(5, 55)), [], 'a train you would have to leave before the requested time for is not offered');
  });

  test('station discovery by distance keeps the two ends apart and never boards near the destination', () => {
    const point = { lat: 16.36, lon: 80.31 }; // next to TB
    const result = searchRail(net, { origin: point, destination: at('TC'), date: '2026-10-20', windowStartSeconds: t(5), windowEndSeconds: t(9) });
    const origins = result.originStations.map(o => net.stations[o.s].code);
    const destinations = result.destinationStations.map(d => net.stations[d.s].code);
    assert.ok(origins.includes('TB'));
    assert.ok(!origins.some(code => destinations.includes(code)));
    assert.ok(!origins.includes('TC'));
  });

  test('pareto keeps later departures and earlier arrivals, drops dominated journeys', () => {
    const j = (dep, arr, transfers = 0) => ({ doorDeparture: dep, doorArrival: arr, transfers });
    assert.deepEqual(paretoRail([j(1, 10), j(2, 9), j(0, 11), j(2, 9, 1)]).map(x => [x.doorDeparture, x.doorArrival, x.transfers]), [[2, 9, 0]]);
  });

  test('running days shift with the journey day at the boarding station', () => {
    const t3 = net.trains.find(x => x.number === '90003');
    assert.deepEqual(runningDaysAt(net, t3, 0), ['Mon']);
    assert.deepEqual(runningDaysAt(net, t3, 1), ['Tue']);
  });
});

describe('freshness and availability', () => {
  const dataset = { snapshotDate: '2026-08-30' };
  const policy = { staleWarningDays: 45, maxSnapshotAgeDays: 120 };
  test('fresh, stale and expired snapshots', () => {
    assert.equal(railFreshness(dataset, { ...policy, now: new Date('2026-09-10T06:00:00Z') }).status, 'fresh');
    const stale = railFreshness(dataset, { ...policy, now: new Date('2026-10-19T06:00:00Z') });
    assert.deepEqual([stale.status, stale.ageDays, stale.usable], ['stale', 50, true]);
    assert.deepEqual([railFreshness(dataset, { ...policy, now: new Date('2027-01-10T06:00:00Z') }).status, railFreshness(dataset, { ...policy, now: new Date('2027-01-10T06:00:00Z') }).usable], ['expired', false]);
    assert.equal(railFreshness({}, policy).usable, false, 'an undated snapshot is never served');
  });

  test('train search needs an explicit opt-in, an imported timetable and a usable snapshot', () => {
    const net = network();
    assert.equal(railAvailability({ env: {}, getNetwork: () => net }).code, 'RAIL_DISABLED');
    assert.equal(railAvailability({ env: { ROUTECONNECT_RAIL_ENABLED: 'true' }, getNetwork: () => null }).code, 'RAIL_NOT_IMPORTED');
    assert.equal(railAvailability({ env: { ROUTECONNECT_RAIL_ENABLED: 'true' }, getNetwork: () => net, now: new Date('2027-06-01T00:00:00Z') }).code, 'RAIL_SNAPSHOT_EXPIRED');
    assert.equal(railAvailability({ env: { ROUTECONNECT_RAIL_ENABLED: 'true' }, getNetwork: () => net, now: new Date('2026-10-05T00:00:00Z') }).available, true);
  });

  test('capabilities unlock Train only when train search really works', () => {
    const net = network();
    assert.equal(getCapabilities({ env: {}, getNetwork: () => net }).modes.train.available, false);
    const on = getCapabilities({ env: { ROUTECONNECT_RAIL_ENABLED: 'true' }, getNetwork: () => net, now: new Date('2026-10-05T00:00:00Z') }).modes.train;
    assert.deepEqual([on.available, on.snapshotDate, on.official, on.live], [true, '2026-10-01', false, false]);
  });
});

describe('rail source in the planner', () => {
  const net = network();
  const config = getRoutingConfig();
  const source = createRailSource({ env: { ROUTECONNECT_RAIL_ENABLED: 'true' }, getNetwork: () => net, now: () => new Date('2026-10-05T00:00:00Z') });

  test('status: configured, but not applicable to very short trips', () => {
    assert.equal(source.status({ crowFliesMeters: 100000 }).configured, true);
    assert.equal(source.status({ crowFliesMeters: 3000 }).applicable, false);
    assert.equal(createRailSource({ env: {}, getNetwork: () => net }).status({ crowFliesMeters: 100000 }).configured, false);
  });

  test('search returns train trunks with genuine identifiers, schedule evidence and no fare', () => {
    const out = source.search({ origin: { lat: 16.001, lon: 80.001 }, destination: { lat: 17.049, lon: 80.899 }, date: '2026-10-20', windowStartSeconds: t(5), windowEndSeconds: t(6), utcOffset: '+05:30', config });
    const trunk = out.trunks[0][0];
    assert.equal(trunk.trainNumber, '90001');
    assert.equal(trunk.trainName, 'Test Train 90001');
    assert.equal(trunk.from.code, 'TA');
    assert.equal(trunk.to.code, 'TD');
    assert.equal(trunk.fare, null);
    assert.equal(trunk.scheduleConfidence, 'published', 'snapshot 4 days old');
    assert.equal(trunk.evidence.snapshotDate, '2026-10-01');
    assert.equal(out.meta.source.type, 'community');
  });

  test('an old snapshot labels the schedule inferred and the planner says so once', () => {
    const old = createRailSource({ env: { ROUTECONNECT_RAIL_ENABLED: 'true' }, getNetwork: () => net, now: () => new Date('2026-12-01T00:00:00Z') });
    const out = old.search({ origin: { lat: 16.001, lon: 80.001 }, destination: { lat: 17.049, lon: 80.899 }, date: '2026-12-01', windowStartSeconds: t(5), windowEndSeconds: t(6), utcOffset: '+05:30', config });
    assert.equal(out.trunks[0][0].scheduleConfidence, 'inferred');
    const journeys = [{ legs: [{ mode: 'rail' }] }];
    const warnings = railWarnings(out.meta, journeys);
    assert.equal(warnings.length, 1);
    assert.equal(warnings[0].code, 'RAIL_SNAPSHOT_STALE');
    assert.match(warnings[0].message, /Not live/);
    assert.deepEqual(railWarnings(out.meta, [{ legs: [{ mode: 'bus' }] }]), [], 'no train shown, no train notice');
  });
});

describe('bus + train composition', () => {
  const config = getRoutingConfig();
  const fareConfig = getFareConfig();
  const origin = { lat: 15.85, lon: 79.85, name: 'Test village' };   // ~23 km from TA: a local ride is still offered
  const destination = { lat: 17.2, lon: 81.0, name: 'Test town' };     // ~19 km from TD
  const trunk = {
    mode: 'rail', trainNumber: '90001', trainName: 'Test Train 90001', displayName: '90001 Test Train 90001', operator: 'Indian Railways',
    from: { type: 'station', name: 'Test A Jn', code: 'TA', lat: 16.0, lon: 80.0 }, to: { type: 'station', name: 'Test D', code: 'TD', lat: 17.05, lon: 80.9 },
    departureTime: '2026-10-20T06:00:00+05:30', arrivalTime: '2026-10-20T08:30:00+05:30', durationSeconds: 9000, scheduleConfidence: 'published', timeQuality: 'exact', fare: null
  };
  const busLeg = (fromName, toName, depIso, arrIso) => ({ mode: 'bus', tripId: `B-${depIso}`, serviceNumber: '1234', from: { name: fromName }, to: { name: toName }, fromStop: { name: fromName }, toStop: { name: toName }, departureTime: depIso, arrivalTime: arrIso, durationSeconds: (Date.parse(arrIso) - Date.parse(depIso)) / 1000, dataConfidence: 'inferred', timeQuality: 'approximate' });

  test('Bus + Train, Train + Bus and Bus + Train + Bus variants are composed, in time order', () => {
    const access = (o, station, latestMs) => [busLeg(o.name, station.name, new Date(latestMs - 90 * 60000).toISOString(), new Date(latestMs - 5 * 60000).toISOString())];
    const egress = (station, d, earliestMs) => [busLeg(station.name, d.name, new Date(earliestMs + 10 * 60000).toISOString(), new Date(earliestMs + 70 * 60000).toISOString())];
    const journeys = composeAroundTrunk([trunk], { origin, destination, utcOffset: '+05:30', config, fareConfig, transitAccess: access, transitEgress: egress });
    assert.deepEqual(journeys.map(j => j.legs.map(l => l.mode).join('>')), [
      'local_ride>rail>local_ride', 'local_ride>rail>bus', 'bus>rail>local_ride', 'bus>rail>bus'
    ]);
    for (const j of journeys) {
      for (let i = 1; i < j.legs.length; i++) assert.ok(Date.parse(j.legs[i].departureTime) >= Date.parse(j.legs[i - 1].arrivalTime), 'no impossible interchange');
    }
    const rail = journeys[0].legs.find(l => l.mode === 'rail');
    assert.equal(rail.trainNumber, '90001');
    assert.equal(rail.fare, null);
    assert.equal(journeys[0].fareEstimate.complete, false, 'an unknown train fare is never counted as zero');
  });

  test('the bus feeder picks the latest bus that still reaches the station, and only real bus options', () => {
    const plans = [];
    const fakePlan = (network, query) => {
      plans.push(query);
      const iso = (h, m) => `2026-10-20T${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:00+05:30`;
      const ride = { mode: 'local_ride', kind: 'egress', durationSeconds: 600, from: { name: 'stop' }, to: { type: 'destination', name: 'Destination' } };
      return { journeys: [
        { departureTime: iso(4, 0), arrivalTime: iso(5, 0), legs: [{ mode: 'walk', kind: 'access', from: { type: 'origin', name: 'Origin' } }, { mode: 'bus' }, { ...ride }] },
        { departureTime: iso(4, 30), arrivalTime: iso(5, 30), legs: [{ mode: 'walk', kind: 'access', from: { type: 'origin', name: 'Origin' } }, { mode: 'bus' }, { ...ride }] },
        { departureTime: iso(5, 0), arrivalTime: iso(5, 50), legs: [{ mode: 'walk', kind: 'access', from: { type: 'origin', name: 'Origin' } }, { mode: 'bus' }, { ...ride }] }, // too late
        { departureTime: iso(4, 45), arrivalTime: iso(5, 20), legs: [{ mode: 'local_ride', durationSeconds: 2100 }] } // no bus
      ] };
    };
    const feeder = createBusFeeder({ network: {}, config, fareConfig, plan: fakePlan, maxCalls: 1 });
    const legs = feeder.access(origin, trunk.from, Date.parse('2026-10-20T05:40:00+05:30'));
    assert.equal(legs[0].from.name, 'Test village');
    assert.equal(legs.at(-1).kind, 'transfer');
    assert.equal(legs.at(-1).to.code, 'TA');
    // The search starts early enough for the bus ride itself (sized by distance, never less than 150 minutes).
    const before = searchBeforeMinutes(haversineMeters(origin.lat, origin.lon, trunk.from.lat, trunk.from.lon));
    assert.ok(before >= 150);
    assert.equal(plans[0].time, localClock(Date.parse('2026-10-20T05:40:00+05:30') - before * 60000, '+05:30').time);
    assert.equal(feeder.egress(trunk.to, destination, Date.parse('2026-10-20T08:40:00+05:30')), null, 'call budget spent: no unbounded searching');
    assert.equal(feeder.calls, 1);
  });

  test('a station beyond local-ride range is offered only by timetable bus, never as a long auto ride', () => {
    const far = { lat: 15.55, lon: 79.55, name: 'Far village' }; // ~68 km from TA
    const access = (o, station, latestMs) => [busLeg(o.name, station.name, new Date(latestMs - 150 * 60000).toISOString(), new Date(latestMs - 5 * 60000).toISOString())];
    const withBus = composeAroundTrunk([trunk], { origin: far, destination, utcOffset: '+05:30', config, fareConfig, transitAccess: access });
    assert.deepEqual(withBus.map(j => j.legs.map(l => l.mode).join('>')), ['bus>rail>local_ride']);
    assert.deepEqual(composeAroundTrunk([trunk], { origin: far, destination, utcOffset: '+05:30', config, fareConfig }), [], 'no bus, no journey');
  });

  test('local clock conversion for planner queries', () => {
    assert.deepEqual(localClock(Date.parse('2026-10-20T00:15:00+05:30'), '+05:30'), { date: '2026-10-20', time: '00:15', timeSeconds: 900 });
  });
});

describe('RailRadar verification adapter (backend only)', () => {
  const scheduled = { train: '90001', from: 'TA', to: 'TD', date: '2026-10-20', departure: '06:00', arrival: '08:30' };
  const reply = (status, body) => async () => new Response(JSON.stringify(body), { status });
  const listing = trains => ({ success: true, data: { trains } });

  test('without a key nothing is called and the result says so', async () => {
    let called = false;
    const client = createRailRadarClient({ env: {}, fetchImpl: async () => { called = true; } });
    assert.equal(client.configured, false);
    assert.equal((await client.verify(scheduled)).status, 'not_configured');
    assert.equal(called, false);
  });

  test('consistent / differs / not listed, labelled as crowd-powered and unofficial, key only in the header', async () => {
    const seen = [];
    const fetchImpl = async (url, init) => { seen.push({ url, auth: init.headers.Authorization }); return new Response(JSON.stringify(listing([{ train: { number: '90001' }, from: { departure: '06:00' }, to: { arrival: '08:35' } }])), { status: 200 }); };
    const client = createRailRadarClient({ env: { RAILRADAR_API_KEY: 'rr_test_secret' }, fetchImpl });
    const differs = await client.verify(scheduled);
    assert.equal(differs.status, 'differs');
    assert.deepEqual(differs.differences, [{ field: 'arrival', ours: '08:30', provider: '08:35' }]);
    assert.equal(differs.provider.official, false);
    assert.ok(!JSON.stringify(differs).includes('rr_test_secret'));
    assert.equal(seen[0].auth, 'Bearer rr_test_secret');
    assert.ok(!seen[0].url.includes('rr_test_secret'));
    assert.match(seen[0].url, /\/trains\/between\/TA\/TD\?date=2026-10-20&live=false$/);
    assert.equal((await client.verify({ ...scheduled, train: '90002' })).status, 'not_listed');
    assert.equal(seen.length, 1, 'the second question was answered from the cache');
    const consistent = createRailRadarClient({ env: { RAILRADAR_API_KEY: 'k' }, fetchImpl: reply(200, listing([{ train: { number: '90001' }, from: { departure: '06:00' }, to: { arrival: '08:30' } }])) });
    assert.equal((await consistent.verify(scheduled)).status, 'consistent');
  });

  test('provider failures and the monthly budget degrade to "unavailable", never to a guess', async () => {
    assert.equal((await createRailRadarClient({ env: { RAILRADAR_API_KEY: 'k' }, fetchImpl: reply(401, {}) }).verify(scheduled)).reason, 'UNAUTHORIZED');
    assert.equal((await createRailRadarClient({ env: { RAILRADAR_API_KEY: 'k' }, fetchImpl: reply(429, {}) }).verify(scheduled)).reason, 'RATE_LIMITED');
    const limited = createRailRadarClient({ env: { RAILRADAR_API_KEY: 'k', RAILRADAR_MONTHLY_REQUEST_BUDGET: '1' }, fetchImpl: reply(200, listing([])) });
    await limited.verify(scheduled);
    const second = await limited.verify({ ...scheduled, date: '2026-10-21' });
    assert.deepEqual([second.status, second.reason], ['unavailable', 'BUDGET_EXHAUSTED']);
    assert.equal((await limited.verify({ ...scheduled, from: 'ta; drop' })).status, 'invalid_request');
  });
});

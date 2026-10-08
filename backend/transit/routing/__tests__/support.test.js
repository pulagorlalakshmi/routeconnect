// Calendar maths, spatial index, query validation and routing configuration.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  isoToDayNumber, dayNumberToIso, weekdayIndex, parseClockTime, formatLocalDateTime,
  buildServiceIndex, resolveActiveServices, isDayWithinValidity
} from '../serviceCalendar.js';
import { StopIndex } from '../stopIndex.js';
import { haversineMeters } from '../geo.js';
import { parsePlanQuery } from '../planQuery.js';
import { getRoutingConfig, ROUTING_DEFAULTS } from '../config.js';
import { NOW, testConfig } from './helpers.js';

describe('service calendar arithmetic (Asia/Kolkata wall-clock, no UTC drift)', () => {
  test('dates round-trip and invalid dates are rejected', () => {
    assert.equal(dayNumberToIso(isoToDayNumber('2026-10-04')), '2026-10-04');
    assert.equal(isoToDayNumber('2026-02-30'), null);
    assert.equal(isoToDayNumber('2026-13-01'), null);
    assert.equal(isoToDayNumber('04-10-2026'), null);
    assert.equal(isoToDayNumber('2026-03-01'), isoToDayNumber('2026-02-28') + 1); // not a leap year
    assert.equal(isoToDayNumber('2028-03-01'), isoToDayNumber('2028-02-28') + 2); // leap year
  });

  test('weekday index: Monday = 0 ... Sunday = 6', () => {
    assert.equal(weekdayIndex(isoToDayNumber('2026-10-05')), 0); // Monday
    assert.equal(weekdayIndex(isoToDayNumber('2026-10-03')), 5); // Saturday
    assert.equal(weekdayIndex(isoToDayNumber('2026-10-04')), 6); // Sunday
    assert.equal(weekdayIndex(isoToDayNumber('1970-01-01')), 3); // Thursday
  });

  test('a 25:30:00 stop time on service day Oct 3 is Oct 4 at 01:30 local time', () => {
    const oct3 = isoToDayNumber('2026-10-03');
    assert.equal(formatLocalDateTime(oct3, 25 * 3600 + 30 * 60, '+05:30'), '2026-10-04T01:30:00+05:30');
    assert.equal(formatLocalDateTime(oct3, 8 * 3600, '+05:30'), '2026-10-03T08:00:00+05:30');
    assert.equal(formatLocalDateTime(oct3, -1800, '+05:30'), '2026-10-02T23:30:00+05:30'); // previous day
    assert.equal(formatLocalDateTime(oct3, 86400, '+05:30'), '2026-10-04T00:00:00+05:30');
  });

  test('clock times parse strictly', () => {
    assert.equal(parseClockTime('08:30'), 30600);
    assert.equal(parseClockTime('23:59:59'), 86399);
    assert.equal(parseClockTime('24:00'), null);
    assert.equal(parseClockTime('8:30'), null);
  });

  test('weekly calendars, date ranges, exceptions and extrapolation', () => {
    const index = buildServiceIndex({
      calendars: [{ serviceId: 'WK', days: [1, 1, 1, 1, 1, 0, 0], start: '2026-10-01', end: '2026-10-31' }],
      calendarDates: [
        { serviceId: 'WK', date: '2026-10-10', type: 1 },   // Saturday added
        { serviceId: 'WK', date: '2026-10-07', type: 2 },   // Wednesday removed
        { serviceId: 'XMAS', date: '2026-12-25', type: 1 }  // exists only through calendar_dates
      ]
    });
    const wk = index.idToIndex.get('WK');
    const xmas = index.idToIndex.get('XMAS');
    const on = (iso, options) => resolveActiveServices(index, isoToDayNumber(iso), options);
    assert.equal(on('2026-10-05')[wk], 1); // Monday
    assert.equal(on('2026-10-03')[wk], 0); // Saturday
    assert.equal(on('2026-10-10')[wk], 1); // added Saturday
    assert.equal(on('2026-10-07')[wk], 0); // removed Wednesday
    assert.equal(on('2026-11-02')[wk], 0); // Monday after the range ends
    assert.equal(on('2026-11-02', { extrapolate: true })[wk], 1); // weekly pattern reused when asked
    assert.equal(on('2026-12-25')[xmas], 1);
    assert.equal(on('2026-12-26')[xmas], 0);
  });

  test('validity window check', () => {
    const day = iso => isoToDayNumber(iso);
    assert.equal(isDayWithinValidity(day('2026-09-30'), '2026-08-30', '2026-09-30'), true);
    assert.equal(isDayWithinValidity(day('2026-10-01'), '2026-08-30', '2026-09-30'), false);
    assert.equal(isDayWithinValidity(day('2026-10-01'), null, null), true);
  });
});

describe('stop index', () => {
  const lats = Float64Array.from([16.5, 16.5, 16.5, 16.6, 17.5]);
  const lons = Float64Array.from([80.0, 80.005, 80.1, 80.0, 81.0]);
  const index = new StopIndex(lats, lons);

  test('returns stops within the radius, nearest first, with true distances', () => {
    const near = index.nearby(16.5, 80.0, 1000);
    assert.deepEqual(near.map(n => n.stop), [0, 1]);
    assert.ok(Math.abs(near[1].distanceMeters - haversineMeters(16.5, 80.0, 16.5, 80.005)) < 1e-6);
    assert.equal(index.nearby(16.5, 80.0, 5000).length, 2);
    assert.deepEqual(index.nearby(16.5, 80.0, 11000).map(n => n.stop), [0, 1, 2]);       // stop 3 is 11.12 km north
    assert.deepEqual(index.nearby(16.5, 80.0, 12000).map(n => n.stop), [0, 1, 2, 3]);
  });

  test('respects limit and finds nothing in empty areas', () => {
    assert.equal(index.nearby(16.5, 80.0, 20000, { limit: 2 }).length, 2);
    assert.deepEqual(index.nearby(10, 70, 5000), []);
  });

  test('matches a brute-force scan', () => {
    for (const [lat, lon, radius] of [[16.52, 80.03, 4000], [16.55, 80.05, 9000], [17.4, 80.9, 30000]]) {
      const expected = [...lats.keys()].filter(i => haversineMeters(lat, lon, lats[i], lons[i]) <= radius).sort((a, b) => a - b);
      assert.deepEqual(index.nearby(lat, lon, radius).map(n => n.stop).sort((a, b) => a - b), expected);
    }
  });
});

describe('query validation (GET /api/v2/plan)', () => {
  const config = testConfig();
  const valid = { fromLat: '16.5', fromLng: '80.6', toLat: '16.3', toLng: '80.4', date: '2026-10-05', time: '08:00' };

  test('accepts a complete query and applies configured defaults', () => {
    const result = parsePlanQuery(valid, config, NOW);
    assert.equal(result.ok, true);
    assert.equal(result.value.timeSeconds, 8 * 3600);
    assert.equal(result.value.maxTransfers, config.defaultMaxTransfers);
    assert.equal(result.value.windowMinutes, config.defaultWindowMinutes);
  });

  test('date and time default to "now" in Asia/Kolkata (not UTC)', () => {
    const { value } = parsePlanQuery({ fromLat: '1', fromLng: '1', toLat: '2', toLng: '2' }, config, NOW);
    assert.equal(value.date, '2026-10-03');
    assert.equal(value.time, '12:00');
    const otherDay = parsePlanQuery({ ...valid, time: undefined, date: '2026-12-01' }, config, NOW).value;
    assert.equal(otherDay.time, '00:00');
  });

  test('rejects missing, malformed and out-of-range values', () => {
    const bad = patch => parsePlanQuery({ ...valid, ...patch }, config, NOW);
    assert.equal(parsePlanQuery({}, config, NOW).ok, false);
    assert.equal(parsePlanQuery({}, config, NOW).errors.length, 4);
    assert.equal(bad({ fromLat: '91' }).ok, false);
    assert.equal(bad({ fromLng: '-181' }).ok, false);
    assert.equal(bad({ toLat: 'abc' }).ok, false);
    assert.equal(bad({ toLat: '0x10' }).ok, false);
    assert.equal(bad({ toLng: '' }).ok, false);
    assert.equal(bad({ date: '2026-02-30' }).ok, false);
    assert.equal(bad({ date: '05-10-2026' }).ok, false);
    assert.equal(bad({ time: '25:00' }).ok, false);
    assert.equal(bad({ time: '8:00' }).ok, false);
    assert.equal(bad({ maxTransfers: '9' }).ok, false);
    assert.equal(bad({ maxTransfers: '-1' }).ok, false);
    assert.equal(bad({ maxTransfers: '1.5' }).ok, false);
    assert.equal(bad({ windowMinutes: String(config.maxWindowMinutes + 1) }).ok, false);
    assert.equal(bad({ fromLat: ['1', '2'] }).ok, false);
  });
});

describe('routing configuration', () => {
  test('defaults are exposed, frozen and overridable from the environment', () => {
    assert.ok(Object.isFrozen(ROUTING_DEFAULTS));
    assert.equal(getRoutingConfig({}, {}).minTransferSeconds, ROUTING_DEFAULTS.minTransferSeconds);
    const overridden = getRoutingConfig({}, {
      ROUTECONNECT_ROUTING_MIN_TRANSFER_SECONDS: '600',
      ROUTECONNECT_ROUTING_WALK_ACCESS_RADIUS_METERS: '1500',
      ROUTECONNECT_ROUTING_FEEDER_STAGE_RADII_METERS: '4000, 12000,30000',
      ROUTECONNECT_ROUTING_HUB_STAGE_RADII_METERS: 'none',
      ROUTECONNECT_ROUTING_LOCAL_RIDE_SPEED_KPH: '30',
      ROUTECONNECT_ROUTING_RANKING_TRANSFER_PENALTY_SECONDS: '1200'
    });
    assert.equal(overridden.minTransferSeconds, 600);
    assert.equal(overridden.walkAccessRadiusMeters, 1500);
    assert.deepEqual(overridden.feederStageRadiiMeters, [4000, 12000, 30000]);
    assert.deepEqual(overridden.hubStageRadiiMeters, []);
    assert.equal(overridden.localRideSpeedKph, 30);
    assert.equal(overridden.ranking.transferPenaltySeconds, 1200);
    assert.equal(getRoutingConfig({}, { ROUTECONNECT_ROUTING_MIN_TRANSFER_SECONDS: 'junk' }).minTransferSeconds, ROUTING_DEFAULTS.minTransferSeconds);
  });

  test('the default minimum transfer is inside the 5-10 minute range and walking is estimated, not routed', () => {
    assert.ok(ROUTING_DEFAULTS.minTransferSeconds >= 300 && ROUTING_DEFAULTS.minTransferSeconds <= 600);
    // tiered access: a short walking radius, and a much larger feeder radius reached by an estimated local ride
    assert.ok(ROUTING_DEFAULTS.walkAccessRadiusMeters >= 1000 && ROUTING_DEFAULTS.walkAccessRadiusMeters <= 1500);
    assert.ok(Math.max(...ROUTING_DEFAULTS.feederStageRadiiMeters) >= 20000 && Math.max(...ROUTING_DEFAULTS.feederStageRadiiMeters) <= 30000);
    assert.ok(Math.max(...ROUTING_DEFAULTS.hubStageRadiiMeters) <= 50000);
  });
});

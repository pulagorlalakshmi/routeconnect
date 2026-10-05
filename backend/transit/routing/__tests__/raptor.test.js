import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { makeNetwork, plan, daily, lineSpec, LINE_STOPS, NOW } from './helpers.js';
import { estimateWalk } from '../accessEgress.js';
import { haversineMeters } from '../geo.js';
import { formatLocalDateTime, isoToDayNumber } from '../serviceCalendar.js';
import { testConfig } from './helpers.js';

const at = (date, hhmmss) => `${date}T${hhmmss}+05:30`;
const run = (spec, options, config) => plan(makeNetwork(spec, config), spec, { ...options, config });

describe('direct trips', () => {
  test('1. a simple direct trip is found with exact times and no walking legs', () => {
    const result = run(lineSpec(), { from: 'A', to: 'C' });
    assert.equal(result.journeys.length, 1);
    const [journey] = result.journeys;
    assert.equal(journey.transfers, 0);
    assert.equal(journey.transitLegCount, 1);
    assert.equal(journey.legs.length, 1);
    const leg = journey.legs[0];
    assert.equal(leg.mode, 'bus');
    assert.equal(leg.tripId, 'T1');
    assert.equal(leg.routeShortName, 'R1');
    assert.equal(leg.routeLongName, 'Route R1');
    assert.equal(leg.fromStop.stopId, 'A');
    assert.equal(leg.toStop.stopId, 'C');
    assert.equal(leg.departureTime, at('2026-10-05', '08:00:00'));
    assert.equal(leg.arrivalTime, at('2026-10-05', '09:00:00'));
    assert.equal(leg.gtfsDepartureTime, '08:00:00');
    assert.equal(leg.durationSeconds, 3600);
    assert.equal(leg.intermediateStopCount, 1);
    assert.equal(leg.datasetId, 1);
    assert.equal(leg.timeQuality, 'exact');
    assert.equal(journey.totalDurationSeconds, 3600);
    assert.equal(journey.walkingDurationSeconds, 0);
    assert.equal(journey.waitingDurationSeconds, 0);
  });

  test('departure time is honoured: a trip before the requested time is never offered', () => {
    const result = run(lineSpec(), { from: 'A', to: 'C', time: '08:01', windowMinutes: 60 });
    assert.equal(result.journeys.length, 0);
  });
});

describe('transfers', () => {
  test('2. a one-transfer journey chains two trips at the shared stop', () => {
    const [journey] = run(lineSpec(), { from: 'A', to: 'E' }).journeys;
    assert.equal(journey.transfers, 1);
    assert.deepEqual(journey.legs.map(leg => leg.tripId), ['T1', 'T2']);
    assert.equal(journey.arrivalTime, at('2026-10-05', '10:20:00'));
    assert.equal(journey.waitingDurationSeconds, 20 * 60); // 09:00 -> 09:20 at C
    assert.equal(journey.totalDurationSeconds, 140 * 60);
  });

  test('3. a two-transfer journey', () => {
    const [journey] = run(lineSpec(), { from: 'A', to: 'F' }).journeys;
    assert.equal(journey.transfers, 2);
    assert.equal(journey.transitLegCount, 3);
    assert.deepEqual(journey.legs.map(leg => leg.tripId), ['T1', 'T2', 'T3']);
    assert.equal(journey.arrivalTime, at('2026-10-05', '11:10:00'));
    assert.equal(journey.waitingDurationSeconds, 40 * 60);
  });

  test('4. no route: wrong direction, and a destination with no stop nearby', () => {
    const wrongWay = run(lineSpec(), { from: 'F', to: 'A' });
    assert.deepEqual(wrongWay.journeys, []);
    assert.ok(wrongWay.warnings.some(w => w.code === 'NO_JOURNEY_FOUND'));

    const nowhere = run(lineSpec(), { from: 'A', to: { lat: 18.5, lon: 82.0 } });
    assert.deepEqual(nowhere.journeys, []);
    assert.ok(nowhere.warnings.some(w => w.code === 'NO_STOPS_NEAR_DESTINATION'));
  });

  test('5. maxTransfers is enforced', () => {
    const spec = lineSpec();
    assert.equal(run(spec, { from: 'A', to: 'F', maxTransfers: 1 }).journeys.length, 0);
    assert.equal(run(spec, { from: 'A', to: 'F', maxTransfers: 2 }).journeys.length, 1);
    assert.equal(run(spec, { from: 'A', to: 'E', maxTransfers: 0 }).journeys.length, 0);
    assert.equal(run(spec, { from: 'A', to: 'C', maxTransfers: 0 }).journeys.length, 1);
  });

  test('RAPTOR executes at most maxTransfers + 1 rounds', () => {
    const result = run(lineSpec(), { from: 'A', to: 'F', maxTransfers: 3 });
    const { rangeSearches, roundsExecuted } = result.performance;
    assert.ok(rangeSearches >= 1);
    assert.ok(roundsExecuted <= rangeSearches * 4, `rounds ${roundsExecuted} for ${rangeSearches} searches`);
    assert.ok(result.performance.patternsScanned > 0);
  });
});

describe('minimum transfer time', () => {
  const connection = (secondTrips) => ({
    stops: LINE_STOPS,
    trips: [
      { id: 'T1', route: 'R1', service: 'ALL', times: [['A', '08:00'], ['C', '09:00']] },
      ...secondTrips
    ],
    calendars: [daily()]
  });
  const tooTight = { id: 'T2a', route: 'R2', service: 'ALL', times: [['C', '09:03'], ['D', '09:30']] };
  const comfortable = { id: 'T2b', route: 'R2', service: 'ALL', times: [['C', '09:20'], ['D', '09:50']] };

  test('13. the minimum transfer time is respected: a too-tight connection is skipped for the next trip', () => {
    const [journey] = run(connection([tooTight, comfortable]), { from: 'A', to: 'D' }).journeys;
    assert.equal(journey.legs[1].tripId, 'T2b');
    assert.equal(journey.arrivalTime, at('2026-10-05', '09:50:00'));
  });

  test('14. an impossible connection is rejected (3 min < 5 min minimum), and accepted when the minimum is lowered', () => {
    const spec = connection([tooTight]);
    assert.equal(run(spec, { from: 'A', to: 'D' }).journeys.length, 0);
    const lowered = run(spec, { from: 'A', to: 'D' }, { minTransferSeconds: 120 });
    assert.equal(lowered.journeys.length, 1);
    assert.equal(lowered.journeys[0].legs[1].tripId, 'T2a');
  });

  test('a per-stop transfers-table entry overrides the default minimum', () => {
    const spec = { ...connection([tooTight]), transfers: [{ from: 'C', to: 'C', minSeconds: 30 }] };
    assert.equal(run(spec, { from: 'A', to: 'D' }).journeys.length, 1);
  });

  test('staying on the same trip needs no transfer time', () => {
    const [journey] = run(lineSpec(), { from: 'A', to: 'C' }).journeys;
    assert.equal(journey.transfers, 0);
  });
});

describe('walking transfers between nearby stops', () => {
  const spec = (secondDeparture) => ({
    stops: { ...LINE_STOPS, C2: [16.5 + 0.00135, 80.10] }, // ~150 m north of C
    trips: [
      { id: 'T1', route: 'R1', service: 'ALL', times: [['A', '08:00'], ['C', '09:00']] },
      { id: 'T2', route: 'R2', service: 'ALL', times: [['C2', secondDeparture], ['D', '09:40']] }
    ],
    calendars: [daily()]
  });
  const walk = estimateWalk(haversineMeters(16.5, 80.10, 16.5 + 0.00135, 80.10), testConfig());

  test('a derived footpath is used, marked estimated, and counted as walking', () => {
    const [journey] = run(spec('09:10'), { from: 'A', to: 'D' }).journeys;
    assert.deepEqual(journey.legs.map(leg => leg.kind ?? leg.mode), ['bus', 'transfer', 'bus']);
    const transfer = journey.legs[1];
    assert.equal(transfer.dataConfidence, 'estimated');
    assert.equal(transfer.durationSeconds, walk.durationSeconds);
    assert.equal(journey.walkingDurationSeconds, walk.durationSeconds);
    assert.equal(journey.waitingDurationSeconds, 10 * 60 - walk.durationSeconds);
    assert.equal(journey.transfers, 1);
  });

  test('walk time counts towards the minimum transfer time, so a 4-minute connection is infeasible', () => {
    assert.equal(run(spec('09:04'), { from: 'A', to: 'D' }).journeys.length, 0);
  });

  test('footpaths can be disabled by configuration', () => {
    assert.equal(run(spec('09:10'), { from: 'A', to: 'D' }, { transferRadiusMeters: 0 }).journeys.length, 0);
  });
});

describe('access and egress walking', () => {
  const spec = lineSpec();
  const north600 = { lat: 16.5 + 0.0054, lon: 80.0 }; // ~600 m from A
  const config = testConfig();

  test('11. access walking: origin away from the stop, leg estimated, departure trimmed to leave just in time', () => {
    const straight = haversineMeters(north600.lat, north600.lon, 16.5, 80.0);
    const expected = estimateWalk(straight, config);
    const [journey] = run(spec, { from: north600, to: 'C' }).journeys;
    const access = journey.legs[0];
    assert.equal(access.mode, 'walk');
    assert.equal(access.kind, 'access');
    assert.equal(access.dataConfidence, 'estimated');
    assert.equal(access.durationSeconds, expected.durationSeconds);
    assert.equal(access.distanceMeters, expected.distanceMeters);
    assert.ok(access.distanceMeters > access.straightLineMeters, 'detour factor applied');
    assert.equal(journey.walkingDurationSeconds, expected.durationSeconds);
    assert.equal(journey.departureTime, formatLocalDateTime(isoToDayNumber('2026-10-05'), 28800 - expected.durationSeconds, '+05:30'));
    assert.equal(journey.legs[1].tripId, 'T1');
  });

  test('12. egress walking: destination away from the stop', () => {
    const dest = { lat: 16.5 + 0.0054, lon: 80.10 };
    const expected = estimateWalk(haversineMeters(dest.lat, dest.lon, 16.5, 80.10), config);
    const [journey] = run(spec, { from: 'A', to: dest }).journeys;
    const egress = journey.legs.at(-1);
    assert.equal(egress.kind, 'egress');
    assert.equal(egress.dataConfidence, 'estimated');
    assert.equal(egress.durationSeconds, expected.durationSeconds);
    assert.equal(egress.departureTime, at('2026-10-05', '09:00:00'));
    assert.equal(journey.totalDurationSeconds, 3600 + expected.durationSeconds);
  });

  test('radii are configuration, not constants', () => {
    assert.equal(run(spec, { from: north600, to: 'C' }, { walkAccessRadiusMeters: 500 }).journeys.length, 0);
    const far = run(spec, { from: { lat: 16.59, lon: 80.0 }, to: 'C' });
    assert.ok(far.warnings.some(w => w.code === 'NO_STOPS_NEAR_ORIGIN'));
    // ~2.2 km away: reachable with a larger radius; the ~38 min walk means leaving before 07:22 for the 08:00 bus
    const farther = { from: { lat: 16.52, lon: 80.0 }, to: 'C', time: '07:00', windowMinutes: 120 };
    assert.equal(run(spec, farther, { walkAccessRadiusMeters: 2000 }).journeys.length, 0);
    assert.equal(run(spec, farther, { walkAccessRadiusMeters: 5000 }).journeys.length, 1);
    assert.equal(run(spec, { ...farther, time: '07:30', windowMinutes: 60 }, { walkAccessRadiusMeters: 5000 }).journeys.length, 0,
      'cannot leave before the requested time, so the 08:00 bus is out of reach');
  });
});

describe('service calendars', () => {
  const weekdayOnly = (extra = {}) => ({
    stops: LINE_STOPS,
    trips: [{ id: 'W1', route: 'R1', service: 'WK', times: [['A', '08:00'], ['C', '09:00']] }],
    calendars: [{ service: 'WK', days: [1, 1, 1, 1, 1, 0, 0], start: '2026-10-01', end: '2026-12-31' }],
    ...extra
  });

  test('6. weekday filtering: runs Monday, not Saturday or Sunday', () => {
    const spec = weekdayOnly();
    assert.equal(run(spec, { from: 'A', to: 'C', date: '2026-10-05' }).journeys.length, 1); // Monday
    assert.equal(run(spec, { from: 'A', to: 'C', date: '2026-10-03' }).journeys.length, 0); // Saturday
    assert.equal(run(spec, { from: 'A', to: 'C', date: '2026-10-04' }).journeys.length, 0); // Sunday
  });

  test('calendar_dates exceptions add and remove service days', () => {
    const spec = weekdayOnly({ calendarDates: [
      { service: 'WK', date: '2026-10-04', type: 1 }, // extra Sunday
      { service: 'WK', date: '2026-10-05', type: 2 }  // Monday removed
    ] });
    assert.equal(run(spec, { from: 'A', to: 'C', date: '2026-10-04' }).journeys.length, 1);
    assert.equal(run(spec, { from: 'A', to: 'C', date: '2026-10-05' }).journeys.length, 0);
  });

  test('a trip is not offered before the calendar start date', () => {
    const spec = weekdayOnly();
    const result = run(spec, { from: 'A', to: 'C', date: '2026-09-28' }, { extrapolateOutsideValidity: false });
    assert.equal(result.journeys.length, 0);
  });
});

describe('overnight GTFS times', () => {
  const overnight = {
    stops: LINE_STOPS,
    trips: [{ id: 'N1', route: 'RN', service: 'ALL', times: [['A', '23:00'], ['B', '24:30'], ['C', '25:30']] }],
    calendars: [daily()]
  };

  test('8. 23:00 -> 25:30 arrives at 01:30 the next calendar day, still on the same service day', () => {
    const [journey] = run(overnight, { from: 'A', to: 'C', time: '22:30' }).journeys;
    const leg = journey.legs[0];
    assert.equal(leg.departureTime, at('2026-10-05', '23:00:00'));
    assert.equal(leg.arrivalTime, at('2026-10-06', '01:30:00'));
    assert.equal(leg.gtfsArrivalTime, '25:30:00');
    assert.equal(leg.serviceDate, '2026-10-05');
    assert.equal(journey.totalDurationSeconds, 2.5 * 3600);
  });

  test('9. service day D-1: a Monday-only trip is still catchable after midnight on Tuesday', () => {
    const spec = {
      stops: { ...LINE_STOPS },
      trips: [{ id: 'M1', route: 'RM', service: 'MON', times: [['A', '23:30'], ['B', '24:30'], ['C', '25:30'], ['D', '26:30']] }],
      calendars: [{ service: 'MON', days: [1, 0, 0, 0, 0, 0, 0], start: '2026-10-01', end: '2026-12-31' }]
    };
    const tuesday = run(spec, { from: 'B', to: 'D', date: '2026-10-06', time: '00:15' });
    assert.equal(tuesday.journeys.length, 1);
    const leg = tuesday.journeys[0].legs[0];
    assert.equal(leg.serviceDate, '2026-10-05'); // Monday's service
    assert.equal(leg.departureTime, at('2026-10-06', '00:30:00'));
    assert.equal(leg.arrivalTime, at('2026-10-06', '02:30:00'));

    // Wednesday 00:15 would need Tuesday's service, which does not run.
    assert.equal(run(spec, { from: 'B', to: 'D', date: '2026-10-07', time: '00:15' }).journeys.length, 0);
  });

  test('a trip on service day D+1 is reachable from a late-evening search', () => {
    const spec = {
      stops: LINE_STOPS,
      trips: [{ id: 'E1', route: 'RE', service: 'ALL', times: [['A', '06:00'], ['C', '07:00']] }],
      calendars: [daily()]
    };
    const result = run(spec, { from: 'A', to: 'C', date: '2026-10-05', time: '23:30', windowMinutes: 480 });
    assert.equal(result.journeys.length, 1);
    assert.equal(result.journeys[0].legs[0].departureTime, at('2026-10-06', '06:00:00'));
    assert.equal(result.journeys[0].legs[0].serviceDate, '2026-10-06');
  });
});

describe('dataset validity and confidence', () => {
  test('7. an expired dataset downgrades confidence to "inferred" and warns explicitly', () => {
    const spec = lineSpec();
    const result = run(spec, { from: 'A', to: 'C', date: '2027-02-01' }); // after valid_to 2026-12-31
    assert.equal(result.dataset.confidence, 'published');
    assert.equal(result.dataset.effectiveConfidence, 'inferred');
    assert.equal(result.dataset.coversSearchDate, false);
    assert.equal(result.dataset.verified, false);
    assert.match(result.datasetWarning, /last valid through 2026-12-31/);
    assert.ok(result.warnings.some(w => w.code === 'SEARCH_DATE_OUTSIDE_FEED_VALIDITY'));
    assert.equal(result.journeys.length, 1, 'expired feeds are still searchable');
    const leg = result.journeys[0].legs[0];
    assert.equal(leg.dataConfidence, 'inferred');
    assert.equal(leg.scheduleBasis, 'extrapolated_weekly_pattern');
    assert.equal(result.journeys[0].scheduleConfidence, 'inferred');
    for (const journey of result.journeys) {
      assert.notEqual(journey.confidence, 'verified');
      assert.notEqual(journey.confidence, 'live');
    }
  });

  test('inside the validity window the schedule is "published"', () => {
    const result = run(lineSpec(), { from: 'A', to: 'C', date: '2026-10-05' });
    assert.equal(result.dataset.effectiveConfidence, 'published');
    assert.equal(result.datasetWarning, null);
    assert.equal(result.journeys[0].legs[0].dataConfidence, 'published');
    assert.equal(result.journeys[0].legs[0].scheduleBasis, 'published_calendar');
    assert.equal(result.journeys[0].scheduleConfidence, 'published');
  });

  test('a feed that expired before today is flagged even for a date inside its window', () => {
    const spec = lineSpec({ dataset: { valid_from: '2026-08-30', valid_to: '2026-10-02' } }); // NOW is 2026-10-03
    const result = run(spec, { from: 'A', to: 'C', date: '2026-10-01' });
    assert.equal(result.dataset.feedCurrentlyValid, false);
    assert.equal(result.dataset.coversSearchDate, true);
    assert.ok(result.warnings.some(w => w.code === 'FEED_EXPIRED'));
  });

  test('extrapolation can be switched off: no service outside the calendar window', () => {
    const result = run(lineSpec(), { from: 'A', to: 'C', date: '2027-02-01' }, { extrapolateOutsideValidity: false });
    assert.equal(result.journeys.length, 0);
  });

  test('19. journey confidence is the weakest leg: interpolated times cap a leg, walking caps the journey', () => {
    const spec = {
      stops: LINE_STOPS,
      trips: [
        { id: 'T1', route: 'R1', service: 'ALL', times: [['A', '08:00'], ['C', '09:00']], quality: 'exact' },
        { id: 'T2', route: 'R2', service: 'ALL', times: [['C', '09:20'], ['D', '09:50']], quality: 'interpolated' }
      ],
      calendars: [daily()]
    };
    const [journey] = run(spec, { from: 'A', to: 'D' }).journeys;
    assert.equal(journey.legs[0].dataConfidence, 'published');
    assert.equal(journey.legs[1].dataConfidence, 'inferred');
    assert.equal(journey.scheduleConfidence, 'inferred');
    assert.equal(journey.confidence, 'inferred');
    assert.equal(journey.timeQuality, 'interpolated');

    const walked = run(spec, { from: { lat: 16.5 + 0.0054, lon: 80.0 }, to: 'D' }).journeys[0];
    assert.equal(walked.confidence, 'estimated', 'estimated walking is the weakest leg');
    assert.equal(walked.scheduleConfidence, 'inferred');
  });
});

describe('journey identity and determinism', () => {
  test('10. journey ids are stable, content-derived and distinct per journey', () => {
    const spec = lineSpec();
    const first = run(spec, { from: 'A', to: 'E' }).journeys[0].id;
    const second = run(spec, { from: 'A', to: 'E' }).journeys[0].id;
    assert.match(first, /^jr_[0-9a-f]{16}$/);
    assert.equal(first, second);
    assert.notEqual(first, run(spec, { from: 'A', to: 'C' }).journeys[0].id);
    assert.notEqual(first, run(spec, { from: 'A', to: 'E', date: '2026-10-06' }).journeys[0].id, 'a different service date is a different journey');
  });

  test('21. repeated searches (even on freshly built networks) return identical results', () => {
    const spec = lineSpec();
    const strip = ({ performance, ...rest }) => rest;
    const a = strip(plan(makeNetwork(spec), spec, { from: 'A', to: 'F', windowMinutes: 180 }));
    const b = strip(plan(makeNetwork(spec), spec, { from: 'A', to: 'F', windowMinutes: 180 }));
    assert.deepEqual(JSON.parse(JSON.stringify(a)), JSON.parse(JSON.stringify(b)));
  });

  test('20. no exact or published fare is ever invented: only labelled estimated ranges exist', () => {
    const result = run(lineSpec(), { from: { lat: 16.5054, lon: 80.0 }, to: 'F' });
    assert.ok(result.journeys.length > 0);
    const fares = [];
    const walk = value => {
      if (Array.isArray(value)) value.forEach(walk);
      else if (value && typeof value === 'object') {
        for (const [key, inner] of Object.entries(value)) {
          assert.ok(!/^(price|amount|exactFare|publishedFare)$/i.test(key), `unexpected exact-money field "${key}"`);
          if (key === 'fare' && inner) fares.push(inner);
          walk(inner);
        }
      }
    };
    walk(result.journeys);
    for (const journey of result.journeys) assert.equal(journey.fare, null, 'there is no PUBLISHED fare for a journey');
    assert.ok(fares.length > 0, 'transit legs carry estimated ranges');
    for (const fare of fares) {
      assert.equal(fare.type, 'estimated_range');
      assert.equal(fare.confidence, 'estimated');
      assert.ok(fare.min < fare.max, 'a range, never a single value');
      assert.ok(!('amount' in fare));
    }
    for (const journey of result.journeys) {
      assert.equal(journey.fareEstimate.confidence, 'estimated');
      assert.equal(journey.fareEstimate.complete, true);
      assert.ok(journey.fareEstimate.min < journey.fareEstimate.max);
    }
    assert.ok(!result.journeys.some(j => ['cheapest', 'CHEAPEST', 'BUDGET'].some(label => j.labels.includes(label))));
    assert.ok(result.warnings.some(w => w.code === 'FARE_ESTIMATED'));
  });

  test('the response never exposes uber/rapido or internal fields', () => {
    const text = JSON.stringify(run(lineSpec(), { from: 'A', to: 'C' }));
    assert.ok(!/uber|rapido/i.test(text));
    assert.ok(!text.includes('_departureSeconds'));
  });
});

describe('range queries', () => {
  const frequent = {
    stops: LINE_STOPS,
    trips: ['08:00', '09:00', '10:00'].map((time, i) => ({
      id: `H${i}`, route: 'R1', service: 'ALL',
      times: [['A', time], ['C', `${String(Number(time.slice(0, 2)) + 1).padStart(2, '0')}:00`]]
    })),
    calendars: [daily()]
  };

  test('departures across the window are all offered, without duplicates', () => {
    const { journeys } = run(frequent, { from: 'A', to: 'C', windowMinutes: 180 });
    assert.equal(journeys.length, 3);
    assert.equal(new Set(journeys.map(j => j.id)).size, 3);
    assert.deepEqual(journeys.map(j => j.legs[0].tripId), ['H0', 'H1', 'H2']);
  });

  test('the window bounds which departures are offered', () => {
    const { journeys } = run(frequent, { from: 'A', to: 'C', time: '07:30', windowMinutes: 30 });
    assert.deepEqual(journeys.map(j => j.legs[0].tripId), ['H0']);
  });

  test('when nothing leaves inside the window the next available journey is returned with a warning', () => {
    const result = run(frequent, { from: 'A', to: 'C', time: '08:30', windowMinutes: 10 });
    assert.deepEqual(result.journeys.map(j => j.legs[0].tripId), ['H1']);
    assert.ok(result.warnings.some(w => w.code === 'NO_DEPARTURE_IN_WINDOW'));
  });

  test('the number of RAPTOR runs is capped by configuration', () => {
    const result = run(frequent, { from: 'A', to: 'C', windowMinutes: 180 }, { maxRangeSearches: 2 });
    assert.ok(result.performance.rangeSearches <= 2);
  });
});

describe('network construction rules', () => {
  test('pickup / drop-off restrictions are honoured', () => {
    const spec = {
      stops: LINE_STOPS,
      trips: [{ id: 'P1', route: 'R1', service: 'ALL', times: [['A', '08:00'], ['B', '08:30'], ['C', '09:00']], pickup: [0, 1, 0], dropOff: [0, 0, 1] }],
      calendars: [daily()]
    };
    assert.equal(run(spec, { from: 'B', to: 'C' }).journeys.length, 0, 'no boarding at B');
    assert.equal(run(spec, { from: 'A', to: 'C' }).journeys.length, 0, 'no alighting at C');
    assert.equal(run(spec, { from: 'A', to: 'B' }).journeys.length, 1);
  });

  test('overtaking trips are split into separate patterns and the faster trip wins', () => {
    const spec = {
      stops: LINE_STOPS,
      trips: [
        { id: 'SLOW', route: 'R1', service: 'ALL', times: [['A', '08:00'], ['B', '09:30'], ['C', '10:00']] },
        { id: 'FAST', route: 'R1', service: 'ALL', times: [['A', '08:05'], ['B', '08:30'], ['C', '09:00']] }
      ],
      calendars: [daily()]
    };
    const network = makeNetwork(spec);
    assert.equal(network.patternCount, 2);
    const { journeys } = plan(network, spec, { from: 'A', to: 'C' });
    assert.deepEqual(journeys.map(j => j.legs[0].tripId), ['FAST'], 'the slower, earlier trip is Pareto-dominated');
  });

  test('bad trips are excluded and counted, never routed', () => {
    const spec = {
      stops: LINE_STOPS,
      trips: [
        { id: 'GOOD', route: 'R1', service: 'ALL', times: [['A', '08:00'], ['C', '09:00']] },
        { id: 'BACKWARDS', route: 'R1', service: 'ALL', times: [['A', '10:00'], ['B', '09:00'], ['C', '11:00']] },
        { id: 'LONG', route: 'R2', service: 'ALL', times: [['A', '01:00'], ['C', '30:00']] },
        { id: 'NOTIME', route: 'R3', service: 'ALL', times: [['A', '12:00'], ['B', null], ['C', null]] }
      ],
      calendars: [daily()]
    };
    const network = makeNetwork(spec);
    assert.equal(network.stats.tripsIncluded, 1);
    assert.equal(network.stats.tripsExcluded.nonMonotonic, 1);
    assert.equal(network.stats.tripsExcluded.tooLong, 1);
    assert.equal(network.stats.tripsExcluded.missingTimes, 1);
    assert.deepEqual(plan(network, spec, { from: 'A', to: 'C', windowMinutes: 720 }).journeys.map(j => j.legs[0].tripId), ['GOOD']);
  });
});

void NOW;

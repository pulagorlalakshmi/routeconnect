// First/last mile: tiered access (walk, then estimated local ride to a useful hub), complete-journey selection,
// and the honesty rules for local rides.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { makeNetwork, plan, daily, testConfig } from './helpers.js';
import { haversineMeters } from '../geo.js';
import { estimateLocalRide } from '../accessEgress.js';
import { formatLocalDateTime, isoToDayNumber } from '../serviceCalendar.js';
import { assembleJourney } from '../journeyBuilder.js';
import { NO_ROUTE_MESSAGE } from '../planner.js';
import { rankJourneys, generalizedCost } from '../ranking.js';
import { selectFeederCandidates } from '../feeder.js';
import { buildServiceDays } from '../planner.js';
import { parseClockTime } from '../serviceCalendar.js';

const FEEDER = { feederAccessRadiusMeters: 25000, feederEgressRadiusMeters: 25000 };
const O = { lat: 16.5, lon: 80.0 };        // the traveller (e.g. GPS "current location")
const lonAt = km => 80.0 + km / 106.7;       // longitude km east of O at this latitude

const at = (date, hhmmss) => `${date}T${hhmmss}+05:30`;
const run = (spec, options, config = {}) => plan(makeNetwork(spec), spec, { time: '07:00', windowMinutes: 120, ...options, config: { ...FEEDER, ...config } });
const legModes = journey => journey.legs.map(leg => (leg.mode === 'walk' || leg.mode === 'local_ride' ? `${leg.mode}:${leg.kind}` : leg.mode));

// H: a hub ~8 km east of O (beyond walking distance). T / U: further east.
const hubSpec = (extra = {}) => ({
  stops: { H: [16.5, lonAt(8)], T: [16.5, lonAt(32)], U: [16.5, lonAt(53)], ...(extra.stops ?? {}) },
  trips: [
    { id: 'H1', route: 'R1', service: 'ALL', times: [['H', '08:00'], ['T', '08:40']] },
    { id: 'H2', route: 'R1', service: 'ALL', times: [['H', '09:00'], ['T', '09:40']] },
    ...(extra.trips ?? [])
  ],
  calendars: [daily()]
});

describe('access: beyond the walking radius', () => {
  test('1. a GPS origin with no stop within walking distance is no longer a dead end', () => {
    const spec = hubSpec();
    const result = run(spec, { from: O, to: 'T' });
    assert.ok(result.journeys.length > 0);
    assert.notEqual(result.message, NO_ROUTE_MESSAGE);
    assert.equal(result.access.walkOriginStops, 0, 'nothing is walkable');
    assert.ok(result.access.feederOriginCandidates.length > 0);
  });

  test('...and with local rides switched off the same search honestly finds nothing', () => {
    const result = run(hubSpec(), { from: O, to: 'T' }, { feederAccessRadiusMeters: 0, feederEgressRadiusMeters: 0 });
    assert.deepEqual(result.journeys, []);
    assert.equal(result.message, NO_ROUTE_MESSAGE);
  });

  test('2. the feeder-accessible hub is discovered from the timetable (not hardcoded) and reported', () => {
    const { access } = run(hubSpec(), { from: O, to: 'T' });
    const hub = access.feederOriginCandidates.find(c => c.stopId === 'H');
    assert.ok(hub, 'H is a candidate');
    assert.ok(hub.servicesInWindow >= 2);
    assert.ok(hub.estimatedMinutes > 20 && hub.estimatedMinutes < 45, `ride estimate ${hub.estimatedMinutes} min`);
    assert.ok(hub.roadDistanceMeters > 8000, 'road distance exceeds the straight line');
  });

  test('3. local ride + direct bus, with a correctly modelled generic ride leg', () => {
    const spec = hubSpec();
    const { journeys } = run(spec, { from: O, to: 'T' });
    const journey = journeys.find(j => j.legs.some(l => l.tripId === 'H1'));
    assert.deepEqual(legModes(journey), ['local_ride:access', 'bus']);
    assert.equal(journey.transfers, 0);

    const expected = estimateLocalRide(haversineMeters(O.lat, O.lon, 16.5, lonAt(8)), testConfig());
    const ride = journey.legs[0];
    assert.equal(ride.durationSeconds, expected.durationSeconds);
    assert.equal(ride.distanceMeters, expected.distanceMeters);
    assert.equal(ride.label, 'Estimated local ride');
    assert.equal(ride.arrivalTime, at('2026-10-05', '08:00:00'), 'arrives just in time for the bus');
    assert.equal(ride.departureTime, formatLocalDateTime(isoToDayNumber('2026-10-05'), 28800 - expected.durationSeconds, '+05:30'));
    assert.equal(journey.localRideCount, 1);
    assert.equal(journey.localRideDurationSeconds, expected.durationSeconds);
  });

  test('4. local ride + bus + transfer + bus', () => {
    const spec = hubSpec({ trips: [
      { id: 'U1', route: 'R2', service: 'ALL', times: [['T', '08:50'], ['U', '09:30']] },
      { id: 'U2', route: 'R2', service: 'ALL', times: [['T', '09:50'], ['U', '10:30']] }
    ] });
    const journey = run(spec, { from: O, to: 'U' }).journeys.find(j => j.transfers === 1);
    assert.deepEqual(legModes(journey), ['local_ride:access', 'bus', 'bus']);
    assert.equal(journey.legs[2].tripId, 'U1');
    assert.equal(journey.waitingDurationSeconds, 10 * 60);
  });

  test('a ride must not become the main leg: bus distance must exceed ride distance', () => {
    // a 2 km bus hop sandwiched between two ~8 km rides is really a taxi trip
    const spec = {
      stops: { A: [16.5, lonAt(8)], B: [16.5, lonAt(10)] },
      trips: [{ id: 'S1', route: 'R1', service: 'ALL', times: [['A', '08:00'], ['B', '08:05']] }, { id: 'S2', route: 'R1', service: 'ALL', times: [['A', '09:00'], ['B', '09:05']] }],
      calendars: [daily()]
    };
    const destination = { lat: 16.5, lon: lonAt(18) };
    assert.equal(run(spec, { from: O, to: destination }).journeys.length, 0);
    const relaxed = run(spec, { from: O, to: destination }, { minTransitToRideRatio: 0 });
    assert.ok(relaxed.journeys.length > 0, 'the ratio is a configurable rule, not a hidden constant');
  });
});

describe('hub choice is made on the complete journey', () => {
  const spec = (walkDeparture, walkArrival) => ({
    stops: { W: [16.5054, 80.0], H: [16.5, lonAt(8)], T: [16.5, lonAt(32)] }, // W is ~600 m away on foot; H is the hub 8 km away
    trips: [
      { id: 'W1', route: 'RW', service: 'ALL', times: [['W', walkDeparture], ['T', walkArrival]] },
      { id: 'H1', route: 'RH', service: 'ALL', times: [['H', '08:00'], ['T', '08:40']] },
      { id: 'H2', route: 'RH', service: 'ALL', times: [['H', '09:00'], ['T', '09:40']] }
    ],
    calendars: [daily()]
  });

  test('5. a nearby walkable stop loses to a better, farther hub', () => {
    const result = run(spec('09:30', '11:00'), { from: O, to: 'T', windowMinutes: 240 });
    assert.equal(result.access.walkOriginStops, 1, 'W is walkable and was considered');
    const fastest = result.journeys.find(j => j.labels.includes('FASTEST'));
    const boarding = fastest.legs.find(l => l.mode === 'bus').fromStop.stopId;
    assert.equal(boarding, 'H', 'the best complete journey boards at the hub, not the nearest stop');
    assert.ok(result.journeys.some(j => j.legs[0].mode === 'walk'), 'the walking option is still offered');
  });

  test('a local ride has to earn its place: it is dropped when walking is about as good', () => {
    const result = run(spec('08:05', '08:50'), { from: O, to: 'T' }); // walk arrives 08:50, hub 08:40: only 10 min gain
    assert.ok(result.journeys.length > 0);
    assert.ok(result.journeys.every(j => j.localRideCount === 0));
  });

  test('25. FASTEST uses the full door-to-door duration, not the earliest bus arrival', () => {
    // origin stands AT W. Walk-only: depart 08:00, arrive 09:30 = 90 min. Via hub: bus arrives earlier (09:10)
    // but the ~31 min ride makes the whole trip ~101 min.
    const network = {
      stops: { W: [16.5, 80.0], H: [16.5, lonAt(8)], T: [16.5, lonAt(32)] },
      trips: [
        { id: 'W1', route: 'RW', service: 'ALL', times: [['W', '08:00'], ['T', '09:30']] },
        { id: 'H1', route: 'RH', service: 'ALL', times: [['H', '08:00'], ['T', '09:10']] },
        { id: 'H2', route: 'RH', service: 'ALL', times: [['H', '08:30'], ['T', '09:40']] }
      ],
      calendars: [daily()]
    };
    const { journeys } = run(network, { from: 'W', to: 'T', windowMinutes: 180 });
    const viaHub = journeys.find(j => j.legs.some(l => l.tripId === 'H1'));
    const direct = journeys.find(j => j.legs.some(l => l.tripId === 'W1'));
    assert.ok(viaHub && direct, 'both options are offered');
    assert.ok(viaHub.arrivalTime < direct.arrivalTime, 'the hub route arrives earlier');
    assert.ok(viaHub.totalDurationSeconds > direct.totalDurationSeconds, 'but takes longer door to door');
    assert.ok(direct.labels.includes('FASTEST'));
    assert.ok(!viaHub.labels.includes('FASTEST'));
  });

  test('29. the farther high-service hub is preferred to a nearby low-service stop, and candidate counts are bounded', () => {
    const stops = { N: [16.5, lonAt(3)], F: [16.5, lonAt(15)], T: [16.5, lonAt(40)] };
    const trips = [
      { id: 'N1', route: 'RN', service: 'ALL', times: [['N', '08:00'], ['T', '09:30']] },
      { id: 'N2', route: 'RN', service: 'ALL', times: [['N', '09:00'], ['T', '10:30']] },
      ...['08:00', '08:20', '08:40', '09:00', '09:20', '09:40', '10:00', '10:20'].map((time, i) => ({ id: `F${i}`, route: 'RF', service: 'ALL', times: [['F', time], ['T', `${String(Number(time.slice(0, 2)) + 1).padStart(2, '0')}:${time.slice(3)}`]] }))
    ];
    const world = { stops, trips, calendars: [daily()] };
    const network = makeNetwork(world);
    const query = { date: '2026-10-05', timeSeconds: 7 * 3600, windowMinutes: 180 };
    const config = testConfig({ ...FEEDER, maxFeederCandidates: 1 });
    const serviceDays = buildServiceDays(network, query, config);
    const picked = selectFeederCandidates(network, O, {
      role: 'access', radiusMeters: 25000, excludeWithinMeters: config.walkAccessRadiusMeters, maxCandidates: 1,
      otherPoint: { lat: 16.5, lon: lonAt(40) }, serviceDays, windowStart: 7 * 3600, windowEnd: 10 * 3600, horizonSeconds: 86400, config
    });
    assert.equal(picked.length, 1);
    assert.equal(network.stopSourceIds[picked[0].stopIdx], 'F', 'the 8-trip hub beats the nearer 2-trip stop');
  });

  test('29. the candidate set is bounded and de-clustered', () => {
    const stops = {};
    const trips = [];
    for (let i = 0; i < 12; i++) {
      stops[`S${i}`] = [16.5 + (i % 4) * 0.05, lonAt(3 + i * 1.5)];
      for (const time of ['08:00', '09:00']) trips.push({ id: `T${i}-${time}`, route: `R${i}`, service: 'ALL', times: [[`S${i}`, time], ['END', `${String(Number(time.slice(0, 2)) + 1).padStart(2, '0')}:00`]] });
    }
    stops.END = [16.5, lonAt(60)];
    stops.TWIN = [16.5 + (0 % 4) * 0.05 + 0.0005, lonAt(3) + 0.0003]; // ~60 m from S0
    for (const time of ['08:10', '09:10']) trips.push({ id: `TW-${time}`, route: 'RTW', service: 'ALL', times: [['TWIN', time], ['END', '11:00']] });
    const result = run({ stops, trips, calendars: [daily()] }, { from: O, to: 'END' }, { maxFeederCandidates: 5 });
    const candidates = result.access.feederOriginCandidates;
    assert.ok(candidates.length <= 5, `got ${candidates.length}`);
    const names = candidates.map(c => c.stopId);
    assert.ok(!(names.includes('S0') && names.includes('TWIN')), 'stops ~60 m apart are one hub');
  });
});

describe('last mile and both ends', () => {
  const spec = {
    stops: { H: [16.5, lonAt(8)], T: [16.5, lonAt(32)] },
    trips: [
      { id: 'H1', route: 'R1', service: 'ALL', times: [['H', '08:00'], ['T', '08:40']] },
      { id: 'H2', route: 'R1', service: 'ALL', times: [['H', '09:00'], ['T', '09:40']] }
    ],
    calendars: [daily()]
  };
  const beyondT = { lat: 16.5, lon: lonAt(40) }; // ~8 km past the last stop

  test('6. last mile: bus, then an estimated local ride to the destination', () => {
    const journey = run(spec, { from: 'H', to: beyondT }).journeys.find(j => j.legs.some(l => l.tripId === 'H1'));
    assert.deepEqual(legModes(journey), ['bus', 'local_ride:egress']);
    const ride = journey.legs[1];
    assert.equal(ride.departureTime, journey.legs[0].arrivalTime, 'the ride starts when the bus arrives');
    assert.equal(ride.label, 'Estimated local ride');
    assert.equal(ride.providerIntegration, false);
    assert.equal(ride.availabilityStatus, 'unknown');
    assert.equal(journey.localRideCount, 1);
  });

  test('7. feeder on both sides, with the total fare equal to the sum of its parts', () => {
    const journey = run(spec, { from: O, to: beyondT }).journeys.find(j => j.legs.some(l => l.tripId === 'H1'));
    assert.deepEqual(legModes(journey), ['local_ride:access', 'bus', 'local_ride:egress']);
    assert.equal(journey.localRideCount, 2);
    const parts = journey.legs.map(l => l.fare);
    assert.ok(parts.every(f => f && f.type === 'estimated_range'));
    assert.equal(journey.fareEstimate.min, parts.reduce((s, f) => s + f.min, 0));
    assert.equal(journey.fareEstimate.max, parts.reduce((s, f) => s + f.max, 0));
    assert.equal(journey.fareEstimate.components.length, 3);
    assert.equal(journey.fareEstimate.complete, true);
  });

  test('journey confidence: schedule stays published, the journey as a whole is estimated because of the rides', () => {
    const journey = run(spec, { from: O, to: beyondT }).journeys[0];
    assert.equal(journey.scheduleConfidence, 'published');
    assert.equal(journey.confidence, 'estimated');
  });

  test('26. the GTFS timetable is untouched: transit legs keep their exact scheduled times', () => {
    const journey = run(spec, { from: O, to: beyondT }).journeys.find(j => j.legs.some(l => l.tripId === 'H1'));
    const bus = journey.legs.find(l => l.mode === 'bus');
    assert.equal(bus.gtfsDepartureTime, '08:00:00');
    assert.equal(bus.gtfsArrivalTime, '08:40:00');
    assert.equal(bus.departureTime, at('2026-10-05', '08:00:00'));
    assert.equal(bus.arrivalTime, at('2026-10-05', '08:40:00'));
  });
});

describe('no route and no feeder-only journeys', () => {
  test('8. no route after walking AND feeder access were both tried', () => {
    const spec = {
      stops: { H: [16.5, lonAt(8)], T: [16.5, lonAt(32)], X: [17.2, lonAt(8)], Y: [17.2, lonAt(32)] },
      trips: [
        { id: 'H1', route: 'R1', service: 'ALL', times: [['H', '08:00'], ['T', '08:40']] },
        { id: 'H2', route: 'R1', service: 'ALL', times: [['H', '09:00'], ['T', '09:40']] },
        { id: 'X1', route: 'R2', service: 'ALL', times: [['X', '08:00'], ['Y', '08:40']] },
        { id: 'X2', route: 'R2', service: 'ALL', times: [['X', '09:00'], ['Y', '09:40']] }
      ],
      calendars: [daily()]
    };
    const result = run(spec, { from: O, to: { lat: 17.2, lon: lonAt(36) } });
    assert.deepEqual(result.journeys, []);
    assert.equal(result.message, NO_ROUTE_MESSAGE);
    assert.ok(result.access.feederOriginCandidates.length > 0, 'origin feeder candidates were attempted');
    assert.ok(result.access.feederDestinationCandidates.length > 0, 'destination feeder candidates were attempted');
    assert.match(result.warnings.find(w => w.code === 'NO_JOURNEY_FOUND').message, /local-ride/);
  });

  test('the old dead end ("no stop within walking distance") no longer short-circuits when hubs exist in range', () => {
    const result = run(hubSpec(), { from: O, to: 'T' });
    assert.ok(!result.warnings.some(w => w.code === 'NO_STOPS_NEAR_ORIGIN'));
  });

  test('"no stop at all" is reported only when neither walking nor feeder range contains a usable stop', () => {
    const result = run(hubSpec(), { from: { lat: 25, lon: 70 }, to: 'T' });
    assert.deepEqual(result.journeys, []);
    assert.ok(result.warnings.some(w => w.code === 'NO_STOPS_NEAR_ORIGIN'));
    assert.equal(result.message, NO_ROUTE_MESSAGE);
  });

  test('9. a feeder-only route is rejected: rides exist only to reach timetable transit', () => {
    // only one stop H near both ends and a far-away second stop: there is no bus leg that serves the destination
    const spec = {
      stops: { H: [16.5, lonAt(8)], FAR: [18.5, lonAt(8)] },
      trips: [
        { id: 'H1', route: 'R1', service: 'ALL', times: [['H', '08:00'], ['FAR', '10:00']] },
        { id: 'H2', route: 'R1', service: 'ALL', times: [['H', '09:00'], ['FAR', '11:00']] }
      ],
      calendars: [daily()]
    };
    const result = run(spec, { from: O, to: { lat: 16.5, lon: lonAt(18) } });
    assert.deepEqual(result.journeys, [], 'ride + ride with no bus between them must never be offered');
  });

  test('9. the builder itself refuses a journey without a transit leg', () => {
    const network = makeNetwork(hubSpec());
    assert.throws(() => assembleJourney(network, { chain: { accessStop: 0, segments: [] }, egressStop: 0 }, {
      anchorDayNumber: isoToDayNumber('2026-10-05'), serviceDays: [], dataset: {}, config: testConfig(), origin: O, destination: O,
      accessByStop: new Map(), egressByStop: new Map(), datasetConfidence: 'published'
    }), /at least one timetable \(GTFS\) transit leg/);
  });

  test('27. every journey the planner returns contains at least one GTFS transit leg', () => {
    for (const to of ['T', { lat: 16.5, lon: lonAt(40) }]) {
      for (const journey of run(hubSpec(), { from: O, to }).journeys) {
        assert.ok(journey.legs.some(l => l.mode === 'bus' && l.tripId), 'has a real trip');
        assert.ok(journey.transitLegCount >= 1);
      }
    }
  });
});

describe('honesty rules for local rides', () => {
  const journeys = () => run(hubSpec(), { from: O, to: { lat: 16.5, lon: lonAt(40) } }).journeys;

  test('18/19. no Uber, Rapido or any named provider appears anywhere', () => {
    const text = JSON.stringify(run(hubSpec(), { from: O, to: { lat: 16.5, lon: lonAt(40) } }));
    assert.ok(!/uber|rapido|\bola\b/i.test(text));
    assert.ok(!journeys().some(j => j.legs.some(l => l.mode === 'uber' || l.mode === 'rapido')));
  });

  test('20/21/22. local rides are generic, unverified and labelled estimated', () => {
    const rides = journeys().flatMap(j => j.legs.filter(l => l.mode === 'local_ride'));
    assert.ok(rides.length > 0);
    for (const ride of rides) {
      assert.equal(ride.providerIntegration, false);
      assert.equal(ride.availabilityStatus, 'unknown');
      assert.notEqual(ride.availabilityStatus, 'available');
      assert.equal(ride.isRealtime, false);
      assert.equal(ride.dataConfidence, 'estimated');
      assert.equal(ride.durationConfidence, 'estimated');
      assert.equal(ride.label, 'Estimated local ride');
    }
  });

  test('23/24. nothing is ever labelled published or verified except real timetable legs', () => {
    for (const journey of journeys()) {
      assert.equal(journey.fare, null, 'no published journey fare exists');
      assert.notEqual(journey.fareEstimate.confidence, 'published');
      assert.notEqual(journey.fareEstimate.confidence, 'verified');
      for (const leg of journey.legs) {
        if (leg.fare) { assert.equal(leg.fare.confidence, 'estimated'); assert.equal(leg.fare.type, 'estimated_range'); }
        if (leg.mode === 'local_ride') assert.ok(!['published', 'verified', 'live'].includes(leg.dataConfidence));
      }
      assert.ok(!['verified', 'live'].includes(journey.confidence));
    }
  });

  test('28. results are deterministic', () => {
    const strip = ({ performance, ...rest }) => rest;
    const a = strip(run(hubSpec(), { from: O, to: { lat: 16.5, lon: lonAt(40) } }));
    const b = strip(run(hubSpec(), { from: O, to: { lat: 16.5, lon: lonAt(40) } }));
    assert.deepEqual(JSON.parse(JSON.stringify(a)), JSON.parse(JSON.stringify(b)));
  });

  test('journey ids distinguish the same bus reached by walking vs by ride', () => {
    const spec = {
      stops: { W: [16.5, 80.0], H: [16.5, lonAt(8)], T: [16.5, lonAt(32)] },
      trips: [
        { id: 'B1', route: 'R1', service: 'ALL', times: [['W', '08:00'], ['T', '09:30']] },
        { id: 'B2', route: 'R1', service: 'ALL', times: [['W', '09:00'], ['T', '10:30']] }
      ],
      calendars: [daily()]
    };
    const walk = run(spec, { from: 'W', to: 'T' }).journeys[0];
    assert.match(walk.id, /^jr_[0-9a-f]{16}$/);
    const again = run(spec, { from: 'W', to: 'T' }).journeys[0];
    assert.equal(walk.id, again.id);
  });
});

describe('ranking with local rides (complete door-to-door journey)', () => {
  const ranking = { transferPenaltySeconds: 900, walkingExtraWeight: 1, waitingExtraWeight: 0.5, localRidePenaltySeconds: 600, localRideExtraWeight: 0.5, lowerCostMinGapPercent: 10, maxJourneys: 10 };
  const mk = (id, dep, arr, ride) => ({
    id, labels: [], transfers: 0, totalDurationSeconds: (arr - dep) * 3600, walkingDurationSeconds: 0, waitingDurationSeconds: 0,
    localRideDurationSeconds: ride, localRideCount: ride > 0 ? 1 : 0, _departureSeconds: dep * 3600, _arrivalSeconds: arr * 3600
  });

  test('local-ride time and count raise the generalized cost; the cost of a plain journey is unchanged', () => {
    assert.equal(generalizedCost(mk('plain', 8, 9, 0), ranking), 3600);
    assert.equal(generalizedCost(mk('ride', 8, 9, 1800), ranking), 3600 + 600 + 900);
  });

  test('BEST_BALANCED can prefer a slower journey with no ride; FASTEST still uses the complete duration', () => {
    const quickWithRide = mk('quick', 8, 9 + 41 / 60, 1800);   // 101 min door to door, 30 min of it by estimated ride
    const slowNoRide = mk('slow', 8, 9 + 45 / 60, 0);          // 105 min
    const ranked = rankJourneys([quickWithRide, slowNoRide], ranking);
    assert.equal(ranked.winners.fastest, 'quick');
    assert.equal(ranked.winners.bestBalanced, 'slow');
  });

  test('less estimated-ride time is a Pareto advantage: an equal journey with a ride is dominated', () => {
    const ranked = rankJourneys([mk('withRide', 8, 9, 1200), mk('noRide', 8, 9, 0)], ranking);
    assert.deepEqual(ranked.journeys.map(j => j.id), ['noRide']);
  });
});

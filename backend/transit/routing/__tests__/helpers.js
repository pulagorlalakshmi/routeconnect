// Synthetic network builders for routing tests (no database, no real operator data).
import { buildNetwork } from '../dataLoader.js';
import { getRoutingConfig } from '../config.js';
import { planJourneys } from '../planner.js';
import { parseGtfsTime } from '../../gtfs/time.js';
import { isoToDayNumber, parseClockTime } from '../serviceCalendar.js';

// Fixed "now" so results never depend on the wall clock: Saturday 2026-10-03 12:00 IST.
export const NOW = new Date('2026-10-03T06:30:00Z');

// Tests of the timetable algorithm run with local-ride feeders OFF so they stay pure walking-access tests;
// the feeder tests opt in explicitly (see feeder.test.js).
export const testConfig = (overrides = {}) => getRoutingConfig({ feederAccessRadiusMeters: 0, feederEgressRadiusMeters: 0, ...overrides }, {});

const toSeconds = text => parseGtfsTime(text.length === 5 ? `${text}:00` : text);

/**
 * spec = {
 *   stops:  { A: [lat, lon], ... },
 *   trips:  [{ id, route, service, times: [['A','08:00'], ['B','08:30', '08:31'], ...], quality?, pickup?, dropOff?, headsign? }],
 *   calendars:     [{ service, days: [mon..sun], start, end }],
 *   calendarDates: [{ service, date, type }],
 *   transfers:     [{ from: 'A', to: 'B', minSeconds }],
 *   dataset: { valid_from, valid_to, confidence_default, ... }
 * }
 */
export function makeRecords(spec) {
  const stopNames = Object.keys(spec.stops);
  const stopId = name => stopNames.indexOf(name) + 1;
  const routeNames = [...new Set(spec.trips.map(trip => trip.route))];

  const stopTimes = [];
  spec.trips.forEach((trip, tripIndex) => {
    trip.times.forEach(([stop, arrival, departure], i) => {
      stopTimes.push({
        tripId: tripIndex + 1,
        stopId: stopId(stop),
        seq: i + 1,
        arr: arrival === null ? null : toSeconds(arrival),
        dep: (departure ?? arrival) === null ? null : toSeconds(departure ?? arrival),
        pickup: trip.pickup?.[i] ?? 0,
        dropOff: trip.dropOff?.[i] ?? 0,
        quality: Array.isArray(trip.quality) ? trip.quality[i] : (trip.quality ?? 'exact')
      });
    });
  });

  return {
    stops: stopNames.map(name => ({ id: stopId(name), sourceId: name, name: spec.stopNames?.[name] ?? `Stop ${name}`, lat: spec.stops[name][0], lon: spec.stops[name][1] })),
    routes: routeNames.map((name, i) => ({ id: i + 1, sourceId: name, shortName: name, longName: `Route ${name}`, mode: 'bus' })),
    trips: spec.trips.map((trip, i) => ({
      id: i + 1, sourceId: trip.id, routeId: routeNames.indexOf(trip.route) + 1, serviceId: trip.service, headsign: trip.headsign ?? `To ${trip.times.at(-1)[0]}`
    })),
    stopTimes,
    calendars: (spec.calendars ?? []).map(c => ({ serviceId: c.service, days: c.days, start: c.start, end: c.end })),
    calendarDates: (spec.calendarDates ?? []).map(c => ({ serviceId: c.service, date: c.date, type: c.type })),
    transfers: (spec.transfers ?? []).map(t => ({ from: stopId(t.from), to: stopId(t.to), minSeconds: t.minSeconds })),
    dataset: {
      id: 1, name: 'Synthetic test feed', source_type: 'community_gtfs', license: 'unknown', verified: 0,
      confidence_default: 'published', valid_from: '2026-10-01', valid_to: '2026-12-31',
      retrieved_at: '2026-10-01T00:00:00.000Z', imported_at: '2026-10-01T00:00:00.000Z',
      ...(spec.dataset ?? {})
    }
  };
}

export function makeNetwork(spec, configOverrides = {}) {
  return buildNetwork(makeRecords(spec), testConfig(configOverrides));
}

// A trip-planning query. from/to are stop names from the spec, or { lat, lon } points.
export function plan(network, spec, { from, to, date = '2026-10-05', time = '07:30', maxTransfers = 3, windowMinutes = 60, config = {} }) {
  const point = value => (typeof value === 'string' ? { lat: spec.stops[value][0], lon: spec.stops[value][1] } : value);
  const origin = point(from);
  const destination = point(to);
  return planJourneys(network, {
    fromLat: origin.lat, fromLng: origin.lon, toLat: destination.lat, toLng: destination.lon,
    date, time, timeSeconds: parseClockTime(time), maxTransfers, windowMinutes
  }, { config: testConfig(config), now: NOW });
}

export const daily = (service = 'ALL', start = '2026-10-01', end = '2026-12-31') => ({ service, days: [1, 1, 1, 1, 1, 1, 1], start, end });

// Stops spaced ~5.3 km apart along a latitude line, far enough that no walking transfers or shared access exist.
export const LINE_STOPS = {
  A: [16.5, 80.00], B: [16.5, 80.05], C: [16.5, 80.10], D: [16.5, 80.15], E: [16.5, 80.20], F: [16.5, 80.25]
};

// A -> B -> C (T1), C -> D -> E (T2), E -> F (T3): chained so transfers happen at C and E.
export const lineSpec = (extra = {}) => ({
  stops: LINE_STOPS,
  trips: [
    { id: 'T1', route: 'R1', service: 'ALL', times: [['A', '08:00'], ['B', '08:30'], ['C', '09:00']] },
    { id: 'T2', route: 'R2', service: 'ALL', times: [['C', '09:20'], ['D', '09:50'], ['E', '10:20']] },
    { id: 'T3', route: 'R3', service: 'ALL', times: [['E', '10:40'], ['F', '11:10']] }
  ],
  calendars: [daily()],
  ...extra
});

export { isoToDayNumber };

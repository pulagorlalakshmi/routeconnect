// GTFS rail provider: turns a GTFS archive into RouteConnect's provider-independent normalised rail records.
//
// Normalised shape (every provider returns this; railImporter.js validates and stores it):
//   {
//     meta:         { snapshotDate, feedStartDate, feedEndDate, feedPublisher, feedVersion },
//     stations:     [{ code, name, lat, lon }],
//     services:     [{ serviceId, days: [mon..sun 0/1], start: 'YYYY-MM-DD', end: 'YYYY-MM-DD' }],
//     serviceDates: [{ serviceId, date: 'YYYY-MM-DD', type: 1 | 2 }],
//     trains:       [{ sourceTripId, number, name, headsign, serviceId,
//                      stops: [{ code, sourceSequence, arrival: seconds|null, departure: seconds|null, distanceKm }] }]
//   }
// Only rail routes (GTFS route_type 2 / 100-199) are taken. Nothing is inferred here: values are copied or parsed, and
// anything unparsable becomes null for the importer to judge.
import { parseGtfsTime } from '../../gtfs/time.js';
import { gtfsDateToIso } from '../../datasetMetadata.js';
import { routeTypeToMode } from '../../importers/gtfsImporter.js';

const text = value => {
  const s = String(value ?? '').trim();
  return s === '' ? null : s;
};
const number = value => {
  const s = String(value ?? '').trim();
  if (s === '') return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
};

// feed_version like "2026-08-30-02-22-43" -> "2026-08-30"
function versionDate(version) {
  const match = /^(\d{4}-\d{2}-\d{2})/.exec(String(version ?? ''));
  return match ? match[1] : null;
}

export function normaliseGtfsRail(archive) {
  const rows = name => archive.tables[name]?.rows ?? [];
  const feedInfo = rows('feed_info')[0] ?? null;

  const railRoutes = new Map();
  for (const route of rows('routes')) {
    if (routeTypeToMode(route.route_type) !== 'rail') continue;
    railRoutes.set(route.route_id, route);
  }

  const stopTimesByTrip = new Map();
  for (const row of rows('stop_times')) {
    let list = stopTimesByTrip.get(row.trip_id);
    if (!list) stopTimesByTrip.set(row.trip_id, (list = []));
    list.push(row);
  }

  const trains = [];
  for (const trip of rows('trips')) {
    const route = railRoutes.get(trip.route_id);
    if (!route) continue;
    const stops = (stopTimesByTrip.get(trip.trip_id) ?? [])
      .map(row => ({
        code: text(row.stop_id),
        sourceSequence: number(row.stop_sequence),
        arrival: parseGtfsTime(row.arrival_time),
        departure: parseGtfsTime(row.departure_time),
        distanceKm: number(row.shape_dist_traveled)
      }))
      .sort((a, b) => (a.sourceSequence ?? 0) - (b.sourceSequence ?? 0));
    trains.push({
      sourceTripId: trip.trip_id,
      number: text(route.route_short_name) ?? text(trip.trip_short_name) ?? text(route.route_id),
      name: text(route.route_long_name),
      headsign: text(trip.trip_headsign),
      serviceId: text(trip.service_id),
      stops
    });
  }

  const stations = rows('stops')
    .filter(stop => (text(stop.location_type) ?? '0') === '0' || text(stop.location_type) === '1')
    .map(stop => ({ code: text(stop.stop_code) ?? text(stop.stop_id), sourceId: text(stop.stop_id), name: text(stop.stop_name), lat: number(stop.stop_lat), lon: number(stop.stop_lon) }));

  const services = rows('calendar').map(row => ({
    serviceId: text(row.service_id),
    days: ['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday'].map(day => (String(row[day]).trim() === '1' ? 1 : 0)),
    start: gtfsDateToIso(row.start_date),
    end: gtfsDateToIso(row.end_date)
  }));
  const serviceDates = rows('calendar_dates').map(row => ({
    serviceId: text(row.service_id),
    date: gtfsDateToIso(row.date),
    type: Number(row.exception_type) === 2 ? 2 : 1
  }));

  // Stop rows reference stop_id; expose stations by that id so trains resolve even when stop_code differs.
  const codeBySourceId = new Map(stations.map(s => [s.sourceId, s.code]));
  for (const train of trains) for (const stop of train.stops) stop.code = codeBySourceId.get(stop.code) ?? stop.code;

  return {
    meta: {
      feedPublisher: text(feedInfo?.feed_publisher_name),
      feedVersion: text(feedInfo?.feed_version),
      feedStartDate: gtfsDateToIso(feedInfo?.feed_start_date),
      feedEndDate: gtfsDateToIso(feedInfo?.feed_end_date),
      snapshotDate: versionDate(feedInfo?.feed_version)
    },
    stations: stations.map(({ sourceId, ...station }) => station),
    services,
    serviceDates,
    trains
  };
}

export const gtfsRailProvider = Object.freeze({
  id: 'gtfs',
  label: 'GTFS rail feed',
  normalise: normaliseGtfsRail
});

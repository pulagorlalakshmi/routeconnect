// Generic GTFS validator. Works on tables produced by gtfs/reader.js; no database, no feed-specific rules.
//
// Severity model:
//   error   - blocks import (the data cannot be stored or joined safely)
//   warning - imported, but the data quality issue is reported
//   info    - descriptive (missing optional files, statistics)
import { parseGtfsTime, isInvalidGtfsTime } from '../gtfs/time.js';
import { gtfsDateToIso, deriveValidity, getValidity, todayInTimezone } from '../datasetMetadata.js';

export const REQUIRED_FILES = Object.freeze(['agency', 'stops', 'routes', 'trips', 'stop_times']);

export const REQUIRED_COLUMNS = Object.freeze({
  agency: ['agency_name', 'agency_url', 'agency_timezone'],
  stops: ['stop_id', 'stop_name', 'stop_lat', 'stop_lon'],
  routes: ['route_id', 'route_type'],
  trips: ['route_id', 'service_id', 'trip_id'],
  stop_times: ['trip_id', 'stop_id', 'stop_sequence', 'arrival_time', 'departure_time'],
  calendar: ['service_id', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday', 'start_date', 'end_date'],
  calendar_dates: ['service_id', 'date', 'exception_type']
});

const FARE_FILES = ['fare_attributes', 'fare_rules', 'fare_products', 'fare_leg_rules'];
const MAX_SAMPLES = 10;
const SUSPICIOUS_TRIP_SECONDS = 24 * 3600;
const WEEKDAYS = ['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday'];

function createCollector() {
  const checks = {};
  return {
    checks,
    add(id, severity, description, sample) {
      const check = (checks[id] ??= { id, severity, description, count: 0, samples: [] });
      check.count++;
      if (sample !== undefined && check.samples.length < MAX_SAMPLES) check.samples.push(sample);
    },
    set(id, severity, description, count, samples = []) {
      if (count > 0) checks[id] = { id, severity, description, count, samples: samples.slice(0, MAX_SAMPLES) };
    }
  };
}

function findDuplicates(rows, keyOf) {
  const seen = new Set();
  const duplicates = [];
  for (const row of rows) {
    const key = keyOf(row);
    if (seen.has(key)) duplicates.push(key);
    else seen.add(key);
  }
  return duplicates;
}

function validCoordinate(latText, lonText) {
  if (String(latText).trim() === '' || String(lonText).trim() === '') return false;
  const lat = Number(latText);
  const lon = Number(lonText);
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return false;
  if (lat < -90 || lat > 90 || lon < -180 || lon > 180) return false;
  if (lat === 0 && lon === 0) return false; // "null island"
  return true;
}

export function validateGtfs(archive, options = {}) {
  const tables = archive.tables ?? {};
  const rowsOf = name => tables[name]?.rows ?? [];
  const has = name => Boolean(tables[name]);
  const collector = createCollector();
  const { add, set } = collector;

  const agencyTimezone = rowsOf('agency')[0]?.agency_timezone || 'UTC';
  const asOf = options.asOf ?? todayInTimezone(agencyTimezone, options.now ?? new Date());

  // ---- Files and columns ----
  const present = Object.keys(tables).map(name => `${name}.txt`).sort();
  const missingRequired = REQUIRED_FILES.filter(name => !has(name)).map(name => `${name}.txt`);
  for (const file of missingRequired) add('missing_required_file', 'error', 'A required GTFS file is missing.', file);
  if (!has('calendar') && !has('calendar_dates')) {
    add('missing_calendar', 'error', 'Neither calendar.txt nor calendar_dates.txt is present; service days are unknown.', 'calendar.txt|calendar_dates.txt');
  }

  for (const [file, columns] of Object.entries(REQUIRED_COLUMNS)) {
    if (!has(file)) continue;
    const header = new Set(tables[file].header);
    for (const column of columns) {
      if (!header.has(column)) add('missing_required_column', 'error', 'A required column is missing.', `${file}.txt:${column}`);
    }
    if (tables[file].malformedRows > 0) {
      set(`malformed_rows_${file}`, 'warning', `Rows in ${file}.txt whose column count differs from the header.`, tables[file].malformedRows);
    }
    if (tables[file].unterminatedQuote) add('unterminated_quote', 'warning', 'CSV file ends inside a quoted field.', `${file}.txt`);
  }

  const emptyCounts = () => ({
    agencies: 0, stops: 0, routes: 0, trips: 0, stopTimes: 0, shapePoints: 0,
    calendars: 0, calendarDates: 0, transfers: 0, frequencies: 0
  });
  const counts = {
    ...emptyCounts(),
    agencies: rowsOf('agency').length,
    stops: rowsOf('stops').length,
    routes: rowsOf('routes').length,
    trips: rowsOf('trips').length,
    stopTimes: rowsOf('stop_times').length,
    shapePoints: rowsOf('shapes').length,
    calendars: rowsOf('calendar').length,
    calendarDates: rowsOf('calendar_dates').length,
    transfers: rowsOf('transfers').length,
    frequencies: rowsOf('frequencies').length
  };

  const structuralErrors = Object.values(collector.checks).some(check => check.severity === 'error');
  if (structuralErrors) {
    return finalize({ collector, counts, present, missingRequired, archive, asOf, validity: null, extras: {} });
  }

  // ---- Duplicate IDs ----
  const duplicateChecks = [
    ['duplicate_agency_id', 'agency', row => row.agency_id || '(single)'],
    ['duplicate_stop_id', 'stops', row => row.stop_id],
    ['duplicate_route_id', 'routes', row => row.route_id],
    ['duplicate_trip_id', 'trips', row => row.trip_id],
    ['duplicate_service_id', 'calendar', row => row.service_id]
  ];
  for (const [id, table, keyOf] of duplicateChecks) {
    const duplicates = findDuplicates(rowsOf(table), keyOf);
    set(id, 'error', `Duplicate primary IDs in ${table}.txt.`, duplicates.length, duplicates);
  }
  const duplicateShapePoints = findDuplicates(rowsOf('shapes'), row => `${row.shape_id}#${row.shape_pt_sequence}`);
  set('duplicate_shape_points', 'warning', 'Duplicate (shape_id, shape_pt_sequence) rows in shapes.txt.', duplicateShapePoints.length, duplicateShapePoints);

  // ---- Reference sets ----
  const agencyIds = new Set(rowsOf('agency').map(row => row.agency_id).filter(Boolean));
  const stopIds = new Set(rowsOf('stops').map(row => row.stop_id));
  const routeIds = new Set(rowsOf('routes').map(row => row.route_id));
  const tripIds = new Set(rowsOf('trips').map(row => row.trip_id));
  const serviceIds = new Set([...rowsOf('calendar'), ...rowsOf('calendar_dates')].map(row => row.service_id));
  const shapeIds = new Set(rowsOf('shapes').map(row => row.shape_id));

  // ---- Dangling references ----
  const singleAgency = rowsOf('agency').length === 1;
  for (const route of rowsOf('routes')) {
    if (route.agency_id) {
      if (!agencyIds.has(route.agency_id)) add('dangling_route_agency', 'error', 'routes.agency_id references an unknown agency.', route.route_id);
    } else if (!singleAgency) {
      add('dangling_route_agency', 'error', 'routes.agency_id is blank but the feed has several agencies.', route.route_id);
    }
  }
  for (const trip of rowsOf('trips')) {
    if (!routeIds.has(trip.route_id)) add('dangling_trip_route', 'error', 'trips.route_id references an unknown route.', trip.trip_id);
    if (!serviceIds.has(trip.service_id)) add('dangling_trip_service', 'error', 'trips.service_id has no calendar entry.', trip.trip_id);
    if (trip.shape_id && !shapeIds.has(trip.shape_id)) add('dangling_trip_shape', 'warning', 'trips.shape_id references an unknown shape.', trip.trip_id);
  }
  for (const stop of rowsOf('stops')) {
    if (stop.parent_station && !stopIds.has(stop.parent_station)) {
      add('dangling_stop_parent', 'error', 'stops.parent_station references an unknown stop.', stop.stop_id);
    }
  }
  for (const row of rowsOf('calendar_dates')) {
    if (!serviceIds.has(row.service_id)) add('dangling_calendar_date_service', 'error', 'calendar_dates.service_id is unknown.', row.service_id);
    if (!['1', '2'].includes(String(row.exception_type))) add('invalid_exception_type', 'error', 'calendar_dates.exception_type must be 1 or 2.', row.service_id);
    if (!gtfsDateToIso(row.date)) add('invalid_calendar_date', 'error', 'Unparseable date.', `calendar_dates:${row.date}`);
  }
  for (const row of rowsOf('transfers')) {
    if ((row.from_stop_id && !stopIds.has(row.from_stop_id)) || (row.to_stop_id && !stopIds.has(row.to_stop_id))) {
      add('dangling_transfer_stop', 'warning', 'transfers.txt references an unknown stop.', `${row.from_stop_id}->${row.to_stop_id}`);
    }
  }

  // ---- Calendar sanity ----
  for (const row of rowsOf('calendar')) {
    const start = gtfsDateToIso(row.start_date);
    const end = gtfsDateToIso(row.end_date);
    if (!start || !end) {
      add('invalid_calendar_date', 'error', 'Unparseable date.', `calendar:${row.service_id}:${row.start_date}-${row.end_date}`);
      continue;
    }
    if (end < start) add('calendar_end_before_start', 'warning', 'Service end_date is before start_date.', row.service_id);
    if (WEEKDAYS.every(day => String(row[day]).trim() !== '1')) add('calendar_no_active_days', 'warning', 'Service runs on no weekday.', row.service_id);
  }

  // ---- Stops: coordinates, names, usage ----
  const usedStopIds = new Set(rowsOf('stop_times').map(row => row.stop_id));
  const nameGroups = new Map();
  for (const stop of rowsOf('stops')) {
    const key = stop.stop_name.trim().toLowerCase();
    if (key) {
      if (!nameGroups.has(key)) nameGroups.set(key, []);
      nameGroups.get(key).push(stop.stop_id);
    } else {
      add('stops_missing_name', 'warning', 'Stop has no name.', stop.stop_id);
    }
    const locationType = String(stop.location_type ?? '').trim() || '0';
    const needsCoordinates = ['0', '1', '2'].includes(locationType);
    if (needsCoordinates && !validCoordinate(stop.stop_lat, stop.stop_lon)) {
      if (usedStopIds.has(stop.stop_id)) {
        add('invalid_stop_coordinates_used', 'error', 'A stop that is served by trips has missing or invalid coordinates.', stop.stop_id);
      } else {
        add('invalid_stop_coordinates_unused', 'warning', 'An unused stop has missing or invalid coordinates.', stop.stop_id);
      }
    }
  }
  const parentIds = new Set(rowsOf('stops').map(stop => stop.parent_station).filter(Boolean));
  const unusedStops = rowsOf('stops').filter(stop => !usedStopIds.has(stop.stop_id) && !parentIds.has(stop.stop_id));
  set('unused_stops', 'info', 'Stops that no trip serves.', unusedStops.length, unusedStops.map(stop => stop.stop_id));
  const duplicateNames = [...nameGroups.entries()].filter(([, ids]) => ids.length > 1);
  set('duplicate_stop_names', 'info', 'Distinct stop names shared by more than one stop (may be legitimate separate bays/stops).',
    duplicateNames.length, duplicateNames.map(([name, ids]) => `${name} (${ids.length} stops)`));

  // ---- Routes / trips: naming quality ----
  for (const route of rowsOf('routes')) {
    const short = (route.route_short_name ?? '').trim();
    const long = (route.route_long_name ?? '').trim();
    if (!short && !long) add('routes_missing_names', 'warning', 'Route has neither short nor long name.', route.route_id);
    else if (short === route.route_id && long === route.route_id) {
      add('route_names_equal_id', 'warning', 'Route short/long name is just the route ID (not human-readable).', route.route_id);
    }
  }
  for (const trip of rowsOf('trips')) {
    const headsign = (trip.trip_headsign ?? '').trim();
    if (!headsign) add('trips_missing_headsign', 'warning', 'Trip has no headsign.', trip.trip_id);
    else if (headsign === trip.route_id || /^\d+$/.test(headsign)) {
      add('trip_headsign_not_descriptive', 'warning', 'Trip headsign is just an ID/number, not a destination.', trip.trip_id);
    }
  }

  // ---- stop_times: ordering, times, quality ----
  const byTrip = new Map();
  for (const row of rowsOf('stop_times')) {
    if (!tripIds.has(row.trip_id)) add('dangling_stop_time_trip', 'error', 'stop_times.trip_id references an unknown trip.', row.trip_id);
    if (!stopIds.has(row.stop_id)) add('dangling_stop_time_stop', 'error', 'stop_times.stop_id references an unknown stop.', `${row.trip_id}:${row.stop_id}`);
    if (!/^\d+$/.test(row.stop_sequence)) {
      add('invalid_stop_sequence', 'error', 'stop_sequence must be a non-negative integer.', `${row.trip_id}:${row.stop_sequence}`);
    }
    if (isInvalidGtfsTime(row.arrival_time) || isInvalidGtfsTime(row.departure_time)) {
      add('invalid_time_format', 'error', 'arrival_time/departure_time must be H:MM:SS or HH:MM:SS.', `${row.trip_id}:${row.arrival_time}|${row.departure_time}`);
    }
    let list = byTrip.get(row.trip_id);
    if (!list) byTrip.set(row.trip_id, (list = []));
    list.push(row);
  }

  const hasTimepoint = has('stop_times') && tables.stop_times.header.includes('timepoint');
  let timesAtOrAfter24 = 0;
  let timesAtOrAfter48 = 0;
  let tripsPast24 = 0;
  let zeroTravel = 0;
  let missingTimes = 0;
  let timepointZero = 0;
  let timepointRows = 0;

  for (const [tripId, list] of byTrip) {
    list.sort((a, b) => Number(a.stop_sequence) - Number(b.stop_sequence));
    const sequences = new Set();
    let previousDeparture = null;
    let previousStopId = null;
    let nonMonotonic = false;
    let tripPast24 = false;
    let firstTime = null;
    let lastTime = null;

    for (let i = 0; i < list.length; i++) {
      const row = list[i];
      if (sequences.has(row.stop_sequence)) add('duplicate_stop_time_sequence', 'error', 'Two stop_times share (trip_id, stop_sequence).', `${tripId}:${row.stop_sequence}`);
      sequences.add(row.stop_sequence);

      if (hasTimepoint && String(row.timepoint).trim() !== '') {
        timepointRows++;
        if (String(row.timepoint).trim() === '0') timepointZero++;
      }

      const arrival = parseGtfsTime(row.arrival_time);
      const departure = parseGtfsTime(row.departure_time);
      const effectiveArrival = arrival ?? departure;
      const effectiveDeparture = departure ?? arrival;

      if (effectiveArrival === null) {
        missingTimes++;
        if (i === 0 || i === list.length - 1) add('trip_missing_endpoint_times', 'warning', 'First or last stop of a trip has no time.', tripId);
        continue;
      }

      if (arrival !== null && departure !== null && arrival > departure) {
        add('arrival_after_departure', 'warning', 'Arrival time is later than departure time at the same stop.', `${tripId}:${row.stop_sequence}`);
      }
      for (const value of [arrival, departure]) {
        if (value === null) continue;
        if (value >= 24 * 3600) { timesAtOrAfter24++; tripPast24 = true; }
        if (value >= 48 * 3600) timesAtOrAfter48++;
      }
      if (previousDeparture !== null) {
        if (effectiveArrival < previousDeparture) nonMonotonic = true;
        if (effectiveArrival === previousDeparture && row.stop_id !== previousStopId) zeroTravel++;
      }
      if (firstTime === null) firstTime = effectiveDeparture;
      lastTime = effectiveArrival;
      previousDeparture = effectiveDeparture;
      previousStopId = row.stop_id;
    }

    if (tripPast24) tripsPast24++;
    if (nonMonotonic) add('non_monotonic_times', 'warning', 'Times go backwards within a trip.', tripId);
    if (firstTime !== null && lastTime !== null && lastTime - firstTime > SUSPICIOUS_TRIP_SECONDS) {
      add('suspiciously_long_trips', 'warning', 'Trip lasts more than 24 hours.', `${tripId}: ${((lastTime - firstTime) / 3600).toFixed(1)}h`);
    }
    if (list.length < 2) add('trips_with_fewer_than_2_stops', 'warning', 'Trip has fewer than two stop_times.', tripId);
  }
  for (const tripId of tripIds) {
    if (!byTrip.has(tripId)) add('trips_without_stop_times', 'warning', 'Trip has no stop_times.', tripId);
  }

  set('stop_times_without_any_time', 'info', 'stop_times rows with no arrival or departure time (importer interpolates; flagged as "interpolated").', missingTimes);
  set('times_at_or_after_24h', 'info', 'Stop times at or beyond 24:00:00 (overnight service; valid GTFS).', timesAtOrAfter24);
  set('times_at_or_after_48h', 'warning', 'Stop times at or beyond 48:00:00 (unusual).', timesAtOrAfter48);
  set('zero_travel_time_segments', 'warning', 'Consecutive different stops with identical times (zero travel time, likely rounded/interpolated).', zeroTravel);
  if (hasTimepoint && timepointRows > 0 && timepointZero === timepointRows) {
    add('all_times_approximate', 'warning', 'timepoint=0 on every stop_time: all times are approximate, none are exact timepoints.', `${timepointRows} rows`);
  } else if (timepointZero > 0) {
    set('approximate_times', 'info', 'stop_times flagged timepoint=0 (approximate).', timepointZero);
  }

  // ---- Missing optional data ----
  if (!FARE_FILES.some(has)) add('missing_fares', 'info', 'No fare data in the feed; fares remain UNKNOWN.', 'fare_*.txt');
  if (!has('calendar_dates')) add('missing_calendar_dates', 'info', 'No calendar_dates.txt (no holiday/exception handling).', 'calendar_dates.txt');
  if (!has('transfers')) add('missing_transfers', 'info', 'No transfers.txt (minimum transfer times/footpaths unknown).', 'transfers.txt');
  if (!has('frequencies')) add('missing_frequencies', 'info', 'No frequencies.txt (headway-based service not described).', 'frequencies.txt');
  if (!has('shapes')) add('missing_shapes', 'info', 'No shapes.txt (no route geometry).', 'shapes.txt');
  if (!has('feed_info')) add('missing_feed_info', 'info', 'No feed_info.txt (publisher/version unknown).', 'feed_info.txt');

  // ---- Validity window ----
  const derived = deriveValidity({
    calendarRows: rowsOf('calendar'),
    calendarDateRows: rowsOf('calendar_dates'),
    feedInfoRow: rowsOf('feed_info')[0] ?? null
  });
  const validity = { ...derived, ...getValidity(derived, asOf), asOf };
  if (validity.status === 'expired') add('feed_expired', 'warning', 'The feed validity window has ended; schedules must be treated as inferred.', `valid to ${derived.validTo}, checked ${asOf}`);
  else if (validity.status === 'not_yet_valid') add('feed_not_yet_valid', 'warning', 'The feed validity window has not started yet.', `valid from ${derived.validFrom}, checked ${asOf}`);
  else if (validity.status === 'unknown') add('feed_validity_unknown', 'warning', 'Could not determine the feed validity window.');

  return finalize({
    collector, counts, present, missingRequired, archive, asOf, validity,
    extras: {
      timeStats: { timesAtOrAfter24h: timesAtOrAfter24, tripsPast24h: tripsPast24, timepointZeroRows: timepointZero, timepointRows }
    }
  });
}

function finalize({ collector, counts, present, missingRequired, archive, asOf, validity, extras }) {
  const checks = Object.values(collector.checks);
  const total = severity => checks.filter(check => check.severity === severity).reduce((sum, check) => sum + check.count, 0);
  const blocking = checks.some(check => check.severity === 'error');

  return {
    generatedAt: new Date().toISOString(),
    asOf,
    status: blocking ? 'errors' : (checks.some(check => check.severity === 'warning') ? 'warnings' : 'ok'),
    blocking,
    errorCount: total('error'),
    warningCount: total('warning'),
    infoCount: total('info'),
    archive: { sha256: archive.checksum ?? null, sizeBytes: archive.sizeBytes ?? null, files: present, unknownFiles: archive.unknownFiles ?? [] },
    missingRequiredFiles: missingRequired,
    counts,
    validity,
    ...extras,
    checks: Object.fromEntries(checks.map(check => [check.id, check]))
  };
}

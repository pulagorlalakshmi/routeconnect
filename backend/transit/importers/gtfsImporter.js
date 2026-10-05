// Generic GTFS -> normalised transit database importer (not tied to any operator).
//
// Guarantees:
//  - The feed is validated first; blocking errors abort the import and leave the database untouched.
//  - The whole import (including removal of the previous import of the same source) is ONE transaction.
//  - Provenance is stored on the dataset row. A feed is never labelled verified/live unless explicitly told so.
//  - Times are stored as seconds from the start of the service day (>= 86400 for overnight trips).
//  - Times the importer had to fill in are flagged "interpolated"; timepoint=0 times are flagged "approximate".
import { validateGtfs } from '../validators/gtfsValidator.js';
import { parseGtfsTime } from '../gtfs/time.js';
import { gtfsDateToIso, deriveValidity, getValidity, normalizeSource, makeSourceKey, todayInTimezone } from '../datasetMetadata.js';

export class ImportBlockedError extends Error {
  constructor(report) {
    super(`GTFS import blocked by ${report.errorCount} blocking error(s).`);
    this.name = 'ImportBlockedError';
    this.report = report;
  }
}

// GTFS route_type (basic + common extended codes) -> coarse mode
export function routeTypeToMode(routeType) {
  const t = Number(routeType);
  const basic = { 0: 'tram', 1: 'subway', 2: 'rail', 3: 'bus', 4: 'ferry', 5: 'cable_tram', 6: 'gondola', 7: 'funicular', 11: 'trolleybus', 12: 'monorail' };
  if (basic[t]) return basic[t];
  if (t >= 100 && t < 200) return 'rail';
  if (t >= 200 && t < 300) return 'bus'; // coach
  if (t >= 400 && t < 500) return 'subway';
  if (t >= 700 && t < 800) return 'bus';
  if (t >= 900 && t < 1000) return 'tram';
  if (t >= 1000 && t < 1100) return 'ferry';
  return 'other';
}

const textOrNull = value => {
  const text = String(value ?? '').trim();
  return text === '' ? null : text;
};
const intOr = (value, fallback) => {
  const n = Number.parseInt(value, 10);
  return Number.isFinite(n) ? n : fallback;
};
const numberOrNull = value => {
  if (String(value ?? '').trim() === '') return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
};
const coordinateOrNull = (latText, lonText) => {
  const lat = numberOrNull(latText);
  const lon = numberOrNull(lonText);
  if (lat === null || lon === null || lat < -90 || lat > 90 || lon < -180 || lon > 180 || (lat === 0 && lon === 0)) {
    return { lat: null, lon: null };
  }
  return { lat, lon };
};

// Fills in missing times for one trip (rows already sorted by stop_sequence).
// Returns [{ arrival, departure, quality }] aligned with rows.
export function resolveTripTimes(rows, hasTimepointColumn) {
  const resolved = rows.map(row => {
    const arrival = parseGtfsTime(row.arrival_time);
    const departure = parseGtfsTime(row.departure_time);
    let quality = 'exact';
    if (hasTimepointColumn) {
      const timepoint = String(row.timepoint ?? '').trim();
      if (timepoint === '0') quality = 'approximate';
      else if (timepoint === '1' || timepoint === '') quality = 'exact';
    }
    return {
      arrival: arrival ?? departure,
      departure: departure ?? arrival,
      quality,
      missing: arrival === null && departure === null
    };
  });

  // Linear interpolation (by position in the trip) between the nearest timed neighbours.
  let i = 0;
  while (i < resolved.length) {
    if (!resolved[i].missing) { i++; continue; }
    let j = i;
    while (j < resolved.length && resolved[j].missing) j++;
    const before = i > 0 ? resolved[i - 1] : null;
    const after = j < resolved.length ? resolved[j] : null;
    for (let k = i; k < j; k++) {
      if (before && after && before.departure !== null && after.arrival !== null) {
        const fraction = (k - i + 1) / (j - i + 1);
        const time = Math.round(before.departure + (after.arrival - before.departure) * fraction);
        resolved[k].arrival = time;
        resolved[k].departure = time;
        resolved[k].quality = 'interpolated';
      } else {
        resolved[k].quality = 'unknown'; // cannot be resolved (missing first/last time)
      }
    }
    i = j;
  }
  return resolved;
}

export function importGtfs({
  db,
  archive,
  source,
  retrievedAt,
  report = null,
  asOf,
  force = false,
  skipIfUnchanged = true,
  now = new Date()
}) {
  const normalizedSource = normalizeSource(source);
  const tables = archive.tables;
  const rowsOf = name => tables[name]?.rows ?? [];

  const validation = report ?? validateGtfs(archive, { asOf, now });
  if (validation.blocking && !force) throw new ImportBlockedError(validation);

  const sourceKey = makeSourceKey(normalizedSource);
  if (skipIfUnchanged && !force) {
    const existing = db.prepare('SELECT id, imported_at FROM datasets WHERE source_key = ? AND checksum_sha256 = ?').get(sourceKey, archive.checksum);
    if (existing) {
      return { skipped: true, reason: 'unchanged', datasetId: Number(existing.id), importedAt: existing.imported_at, report: validation };
    }
  }

  const derived = deriveValidity({
    calendarRows: rowsOf('calendar'),
    calendarDateRows: rowsOf('calendar_dates'),
    feedInfoRow: rowsOf('feed_info')[0] ?? null
  });
  const feedInfo = rowsOf('feed_info')[0] ?? {};
  const timezone = rowsOf('agency')[0]?.agency_timezone || 'UTC';
  const effectiveAsOf = asOf ?? todayInTimezone(timezone, now);
  const validity = getValidity(derived, effectiveAsOf);
  const hasTimepointColumn = Boolean(tables.stop_times?.header?.includes('timepoint'));

  const importedAt = now.toISOString();
  const counts = { agencies: 0, stops: 0, routes: 0, trips: 0, stopTimes: 0, shapePoints: 0, calendars: 0, calendarDates: 0, transfers: 0 };
  const timeQuality = { exact: 0, approximate: 0, interpolated: 0, unknown: 0 };

  db.exec('PRAGMA foreign_keys = ON;');
  db.exec('BEGIN IMMEDIATE');
  try {
    // Replace any previous import of the same source (atomic with the new import).
    const previous = db.prepare('SELECT id FROM datasets WHERE source_key = ?').all(sourceKey);
    for (const row of previous) db.prepare('DELETE FROM datasets WHERE id = ?').run(row.id);

    const datasetResult = db.prepare(`
      INSERT INTO datasets (source_key, name, source_type, source_url, license, confidence_default, verified,
                            retrieved_at, imported_at, valid_from, valid_to, feed_start_date, feed_end_date,
                            feed_publisher, feed_version, checksum_sha256)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      sourceKey, normalizedSource.name, normalizedSource.type, normalizedSource.url, normalizedSource.license,
      normalizedSource.confidence, normalizedSource.verified ? 1 : 0,
      retrievedAt ?? importedAt, importedAt, derived.validFrom, derived.validTo, derived.feedStart, derived.feedEnd,
      textOrNull(feedInfo.feed_publisher_name), textOrNull(feedInfo.feed_version), archive.checksum
    );
    const datasetId = Number(datasetResult.lastInsertRowid);

    // Agencies
    const agencyIdBySource = new Map();
    const insertAgency = db.prepare('INSERT INTO agencies (source_agency_id, name, url, timezone, dataset_id) VALUES (?, ?, ?, ?, ?)');
    for (const row of rowsOf('agency')) {
      const result = insertAgency.run(textOrNull(row.agency_id), row.agency_name, textOrNull(row.agency_url), textOrNull(row.agency_timezone), datasetId);
      agencyIdBySource.set(row.agency_id || '', Number(result.lastInsertRowid));
      counts.agencies++;
    }
    const soleAgencyId = agencyIdBySource.size === 1 ? [...agencyIdBySource.values()][0] : null;

    // Stops (parents wired in a second pass)
    const stopIdBySource = new Map();
    const insertStop = db.prepare('INSERT INTO stops (source_stop_id, name, lat, lon, location_type, kind, dataset_id) VALUES (?, ?, ?, ?, ?, ?, ?)');
    for (const row of rowsOf('stops')) {
      const { lat, lon } = coordinateOrNull(row.stop_lat, row.stop_lon);
      const locationType = intOr(row.location_type, 0);
      const kind = locationType === 1 ? 'station' : null;
      const result = insertStop.run(row.stop_id, row.stop_name || row.stop_id, lat, lon, locationType, kind, datasetId);
      stopIdBySource.set(row.stop_id, Number(result.lastInsertRowid));
      counts.stops++;
    }
    const setParent = db.prepare('UPDATE stops SET parent_station = ? WHERE id = ?');
    for (const row of rowsOf('stops')) {
      if (row.parent_station && stopIdBySource.has(row.parent_station)) {
        setParent.run(stopIdBySource.get(row.parent_station), stopIdBySource.get(row.stop_id));
      }
    }

    // Routes
    const routeIdBySource = new Map();
    const insertRoute = db.prepare('INSERT INTO routes (source_route_id, agency_id, short_name, long_name, route_type, mode, dataset_id) VALUES (?, ?, ?, ?, ?, ?, ?)');
    for (const row of rowsOf('routes')) {
      const agencyId = row.agency_id ? (agencyIdBySource.get(row.agency_id) ?? null) : soleAgencyId;
      const routeType = intOr(row.route_type, 3);
      const result = insertRoute.run(row.route_id, agencyId, textOrNull(row.route_short_name), textOrNull(row.route_long_name), routeType, routeTypeToMode(routeType), datasetId);
      routeIdBySource.set(row.route_id, Number(result.lastInsertRowid));
      counts.routes++;
    }

    // Calendars
    const insertCalendar = db.prepare(`
      INSERT INTO service_calendars (dataset_id, service_id, monday, tuesday, wednesday, thursday, friday, saturday, sunday, start_date, end_date)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    for (const row of rowsOf('calendar')) {
      const flag = value => (String(value).trim() === '1' ? 1 : 0);
      insertCalendar.run(
        datasetId, row.service_id, flag(row.monday), flag(row.tuesday), flag(row.wednesday), flag(row.thursday),
        flag(row.friday), flag(row.saturday), flag(row.sunday), gtfsDateToIso(row.start_date), gtfsDateToIso(row.end_date)
      );
      counts.calendars++;
    }
    const insertCalendarDate = db.prepare('INSERT OR REPLACE INTO calendar_dates (dataset_id, service_id, date, exception_type) VALUES (?, ?, ?, ?)');
    for (const row of rowsOf('calendar_dates')) {
      insertCalendarDate.run(datasetId, row.service_id, gtfsDateToIso(row.date), intOr(row.exception_type, 1));
      counts.calendarDates++;
    }

    // Trips
    const tripIdBySource = new Map();
    const insertTrip = db.prepare('INSERT INTO trips (source_trip_id, route_id, service_id, headsign, direction_id, shape_id, dataset_id) VALUES (?, ?, ?, ?, ?, ?, ?)');
    for (const row of rowsOf('trips')) {
      const result = insertTrip.run(
        row.trip_id, routeIdBySource.get(row.route_id), row.service_id, textOrNull(row.trip_headsign),
        row.direction_id === undefined || String(row.direction_id).trim() === '' ? null : intOr(row.direction_id, null),
        textOrNull(row.shape_id), datasetId
      );
      tripIdBySource.set(row.trip_id, Number(result.lastInsertRowid));
      counts.trips++;
    }

    // Shapes
    const insertShape = db.prepare('INSERT OR IGNORE INTO shapes (dataset_id, shape_id, sequence, lat, lon, distance_traveled) VALUES (?, ?, ?, ?, ?, ?)');
    for (const row of rowsOf('shapes')) {
      const lat = numberOrNull(row.shape_pt_lat);
      const lon = numberOrNull(row.shape_pt_lon);
      if (lat === null || lon === null) continue;
      const result = insertShape.run(datasetId, row.shape_id, intOr(row.shape_pt_sequence, 0), lat, lon, numberOrNull(row.shape_dist_traveled));
      if (result.changes > 0) counts.shapePoints++;
    }

    // Transfers (optional file)
    const insertTransfer = db.prepare('INSERT OR REPLACE INTO transfers (dataset_id, from_stop_id, to_stop_id, transfer_type, min_transfer_seconds) VALUES (?, ?, ?, ?, ?)');
    for (const row of rowsOf('transfers')) {
      const from = stopIdBySource.get(row.from_stop_id);
      const to = stopIdBySource.get(row.to_stop_id);
      if (from === undefined || to === undefined) continue;
      insertTransfer.run(datasetId, from, to, intOr(row.transfer_type, 0), numberOrNull(row.min_transfer_time));
      counts.transfers++;
    }

    // Stop times, trip by trip
    const byTrip = new Map();
    for (const row of rowsOf('stop_times')) {
      let list = byTrip.get(row.trip_id);
      if (!list) byTrip.set(row.trip_id, (list = []));
      list.push(row);
    }
    const insertStopTime = db.prepare(`
      INSERT INTO stop_times (trip_id, stop_id, stop_sequence, arrival_seconds, departure_seconds, pickup_type, drop_off_type, time_quality)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `);
    for (const [sourceTripId, list] of byTrip) {
      const tripId = tripIdBySource.get(sourceTripId);
      list.sort((a, b) => Number(a.stop_sequence) - Number(b.stop_sequence));
      const times = resolveTripTimes(list, hasTimepointColumn);
      for (let i = 0; i < list.length; i++) {
        const row = list[i];
        const time = times[i];
        insertStopTime.run(
          tripId, stopIdBySource.get(row.stop_id), Number(row.stop_sequence), time.arrival, time.departure,
          intOr(row.pickup_type, 0), intOr(row.drop_off_type, 0), time.quality
        );
        timeQuality[time.quality]++;
        counts.stopTimes++;
      }
    }

    // Derive stop kind from the modes of the routes that serve it
    db.prepare(`
      UPDATE stops SET kind = COALESCE((
        SELECT CASE WHEN COUNT(DISTINCT r.mode) = 1 THEN MIN(r.mode) ELSE 'mixed' END
        FROM stop_times st
        JOIN trips t ON t.id = st.trip_id
        JOIN routes r ON r.id = t.route_id
        WHERE st.stop_id = stops.id
        HAVING COUNT(*) > 0
      ), 'unserved')
      WHERE dataset_id = ? AND kind IS NULL
    `).run(datasetId);

    const stats = { counts, timeQuality, importedForDate: effectiveAsOf, validityAtImport: validity.status };
    const validationSummary = {
      status: validation.status, errorCount: validation.errorCount, warningCount: validation.warningCount, infoCount: validation.infoCount
    };
    db.prepare('UPDATE datasets SET stats_json = ?, validation_json = ? WHERE id = ?')
      .run(JSON.stringify(stats), JSON.stringify(validationSummary), datasetId);

    db.exec('COMMIT');
    return { skipped: false, datasetId, importedAt, counts, timeQuality, validity: { ...derived, ...validity, asOf: effectiveAsOf }, report: validation };
  } catch (error) {
    try { db.exec('ROLLBACK'); } catch { /* transaction already closed */ }
    throw error;
  }
}

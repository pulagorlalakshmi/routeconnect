// Validates normalised rail records (from any provider) and stores them in rail.db in ONE transaction.
//
// Refused (recorded as an issue, never "repaired" into something the source did not say):
//   - trains whose service_id has no calendar          TRAIN_WITHOUT_CALENDAR
//   - calendars that end before they start              SERVICE_RANGE_INVALID
//   - trains whose times go backwards along the run     TIMES_NOT_MONOTONIC
//   - trains with fewer than two usable stops           TOO_FEW_STOPS
// Flagged but kept: impossible-looking speeds between consecutive stops, stations without usable coordinates (they can
// still be passed through but are never offered for station discovery), stops at unknown station codes (dropped).
import { haversineMeters } from '../routing/geo.js';

// Generous bounding box for India; anything outside is treated as a missing coordinate.
const INDIA = { minLat: 6, maxLat: 37.6, minLon: 68, maxLon: 97.6 };
const IMPLAUSIBLE_KMH = 180;
const MAX_ISSUE_SAMPLES = 200;

export class RailImportError extends Error {}

export function validateRailRecords(records) {
  const issues = [];
  const counts = new Map();
  const issue = (severity, code, entity, detail) => {
    counts.set(code, (counts.get(code) ?? 0) + 1);
    if (issues.length < MAX_ISSUE_SAMPLES || severity === 'error') issues.push({ severity, code, entity, detail });
  };

  const stations = new Map();
  for (const s of records.stations ?? []) {
    if (!s.code) { issue('warning', 'STATION_WITHOUT_CODE', s.name ?? null, null); continue; }
    if (stations.has(s.code)) { issue('warning', 'DUPLICATE_STATION_CODE', s.code, null); continue; }
    const ok = Number.isFinite(s.lat) && Number.isFinite(s.lon) && s.lat >= INDIA.minLat && s.lat <= INDIA.maxLat && s.lon >= INDIA.minLon && s.lon <= INDIA.maxLon;
    if (!ok) issue('warning', 'STATION_COORDINATE_INVALID', s.code, `${s.lat},${s.lon}`);
    stations.set(s.code, { code: s.code, name: s.name ?? s.code, lat: ok ? s.lat : null, lon: ok ? s.lon : null });
  }

  const services = new Map();
  for (const svc of records.services ?? []) {
    if (!svc.serviceId || !svc.start || !svc.end) { issue('error', 'SERVICE_INVALID', svc.serviceId ?? null, 'missing id or dates'); continue; }
    if (svc.start > svc.end) { issue('error', 'SERVICE_RANGE_INVALID', svc.serviceId, `${svc.start} > ${svc.end}`); continue; }
    if (!svc.days.some(Boolean)) { issue('warning', 'SERVICE_NO_RUNNING_DAYS', svc.serviceId, null); continue; }
    services.set(svc.serviceId, svc);
  }
  const serviceDates = (records.serviceDates ?? []).filter(d => d.serviceId && d.date);
  const datedServices = new Set(serviceDates.filter(d => d.type === 1).map(d => d.serviceId));

  const trains = [];
  for (const train of records.trains ?? []) {
    const entity = train.number ?? train.sourceTripId;
    if (!train.number) { issue('error', 'TRAIN_WITHOUT_NUMBER', train.sourceTripId, null); continue; }
    if (!services.has(train.serviceId) && !datedServices.has(train.serviceId)) {
      issue('error', 'TRAIN_WITHOUT_CALENDAR', entity, `service_id ${train.serviceId ?? '(none)'} has no usable calendar`);
      continue;
    }
    const stops = [];
    for (const stop of train.stops) {
      if (!stations.has(stop.code)) { issue('warning', 'STOP_UNKNOWN_STATION', entity, stop.code); continue; }
      stops.push({ ...stop });
    }
    if (stops.length < 2) { issue('error', 'TOO_FEW_STOPS', entity, `${stops.length} usable stop(s)`); continue; }
    // The origin has no arrival and the terminus no departure, whatever placeholder the source used.
    stops[0].arrival = null;
    stops.at(-1).departure = null;
    if (stops[0].departure === null || stops.at(-1).arrival === null) { issue('error', 'ENDPOINT_TIME_MISSING', entity, null); continue; }

    let monotonic = true;
    let last = -1;
    for (const stop of stops) {
      for (const t of [stop.arrival, stop.departure]) {
        if (t === null) continue;
        if (t < last) monotonic = false;
        last = t;
      }
    }
    if (!monotonic) { issue('error', 'TIMES_NOT_MONOTONIC', entity, null); continue; }

    for (let i = 1; i < stops.length; i++) {
      const a = stations.get(stops[i - 1].code);
      const b = stations.get(stops[i].code);
      const dep = stops[i - 1].departure;
      const arr = stops[i].arrival;
      if (a.lat === null || b.lat === null || dep === null || arr === null) continue;
      const km = haversineMeters(a.lat, a.lon, b.lat, b.lon) / 1000;
      const hours = Math.max(arr - dep, 30) / 3600; // times are minute-precision; allow half a minute
      if (km >= 3 && km / hours > IMPLAUSIBLE_KMH) issue('warning', 'IMPLAUSIBLE_SPEED', entity, `${a.code}->${b.code} ${km.toFixed(1)} km in ${Math.round((arr - dep) / 60)} min`);
    }
    trains.push({ ...train, stops });
  }

  // Validity: the span of the calendars actually used by importable trains.
  const used = new Set(trains.map(t => t.serviceId));
  const dates = [];
  for (const id of used) {
    const svc = services.get(id);
    if (svc) dates.push(svc.start, svc.end);
  }
  for (const d of serviceDates) if (used.has(d.serviceId) && d.type === 1) dates.push(d.date);
  dates.sort();

  return {
    stations: [...stations.values()],
    services: [...services.values()].filter(svc => used.has(svc.serviceId)),
    serviceDates: serviceDates.filter(d => used.has(d.serviceId)),
    trains,
    validFrom: dates[0] ?? null,
    validTo: dates.at(-1) ?? null,
    issues,
    issueCounts: Object.fromEntries([...counts.entries()].sort()),
    stats: {
      stationsInSource: (records.stations ?? []).length,
      stations: stations.size,
      stationsWithCoordinates: [...stations.values()].filter(s => s.lat !== null).length,
      trainsInSource: (records.trains ?? []).length,
      trains: trains.length,
      trainsExcluded: (records.trains ?? []).length - trains.length,
      stops: trains.reduce((sum, t) => sum + t.stops.length, 0),
      services: used.size
    }
  };
}

/**
 * @param db        open rail database (railDb.openRailDb)
 * @param records   normalised records from a provider
 * @param source    { providerId, name, type, url, license, licenseStatus, operator, provenanceNote }
 */
export function importRailRecords({ db, records, source, checksum, retrievedAt, now = new Date() }) {
  if (!source?.name || !source?.type || !source?.providerId) throw new RailImportError('Rail source must declare providerId, name and type.');
  const checked = validateRailRecords(records);
  if (checked.trains.length === 0) throw new RailImportError('No importable trains: nothing was written.');

  const sourceKey = `${source.providerId}|${source.type}|${source.name}`;
  const importedAt = now.toISOString();
  const stats = { ...checked.stats, issueCounts: checked.issueCounts };

  db.exec('BEGIN');
  try {
    db.prepare('DELETE FROM rail_datasets WHERE source_key = ?').run(sourceKey);
    const datasetId = Number(db.prepare(`
      INSERT INTO rail_datasets (provider_id, source_key, name, source_type, source_url, license, license_status, provenance_note, operator,
        snapshot_date, retrieved_at, imported_at, feed_start_date, feed_end_date, valid_from, valid_to, checksum_sha256, stats_json, verified)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0)
    `).run(
      source.providerId, sourceKey, source.name, source.type, source.url ?? null, source.license ?? 'unknown', source.licenseStatus ?? 'unconfirmed',
      source.provenanceNote ?? null, source.operator ?? null,
      records.meta?.snapshotDate ?? (retrievedAt ? retrievedAt.slice(0, 10) : null), retrievedAt ?? importedAt, importedAt,
      records.meta?.feedStartDate ?? null, records.meta?.feedEndDate ?? null, checked.validFrom, checked.validTo, checksum, JSON.stringify(stats)
    ).lastInsertRowid);

    const stationId = new Map();
    const insertStation = db.prepare('INSERT INTO rail_stations (dataset_id, code, name, lat, lon) VALUES (?, ?, ?, ?, ?)');
    for (const s of checked.stations) stationId.set(s.code, Number(insertStation.run(datasetId, s.code, s.name, s.lat, s.lon).lastInsertRowid));

    const insertService = db.prepare('INSERT INTO rail_services VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)');
    for (const svc of checked.services) insertService.run(datasetId, svc.serviceId, ...svc.days, svc.start, svc.end);
    const insertDate = db.prepare('INSERT OR REPLACE INTO rail_service_dates VALUES (?, ?, ?, ?)');
    for (const d of checked.serviceDates) insertDate.run(datasetId, d.serviceId, d.date, d.type);

    const insertTrain = db.prepare('INSERT INTO rail_trains (dataset_id, source_trip_id, number, name, headsign, service_id) VALUES (?, ?, ?, ?, ?, ?)');
    const insertStop = db.prepare('INSERT INTO rail_train_stops (train_id, seq, station_id, arrival_seconds, departure_seconds, distance_km) VALUES (?, ?, ?, ?, ?, ?)');
    for (const train of checked.trains) {
      const trainId = Number(insertTrain.run(datasetId, train.sourceTripId, train.number, train.name, train.headsign, train.serviceId).lastInsertRowid);
      train.stops.forEach((stop, seq) => insertStop.run(trainId, seq, stationId.get(stop.code), stop.arrival, stop.departure, stop.distanceKm));
    }

    const insertIssue = db.prepare('INSERT INTO rail_import_issues (dataset_id, severity, code, entity, detail) VALUES (?, ?, ?, ?, ?)');
    for (const i of checked.issues) insertIssue.run(datasetId, i.severity, i.code, i.entity ?? null, i.detail ?? null);

    db.exec('COMMIT');
    return { datasetId, sourceKey, validFrom: checked.validFrom, validTo: checked.validTo, stats, issues: checked.issues };
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}

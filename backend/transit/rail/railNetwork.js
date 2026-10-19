// Loads rail.db into a compact in-memory index for train search, and judges how fresh the snapshot is.
import fs from 'fs';
import { openRailDb } from './railDb.js';
import { getRailConfig } from './railConfig.js';
import { buildServiceIndex, resolveActiveServices, isoToDayNumber } from '../routing/serviceCalendar.js';
import { todayInTimezone } from '../datasetMetadata.js';

const NONE = -1;
const SECONDS_PER_DAY = 86400;

export function loadRailNetworkFromDb(db) {
  const dataset = db.prepare('SELECT * FROM rail_datasets ORDER BY imported_at DESC, id DESC LIMIT 1').get();
  if (!dataset) return null;
  const id = dataset.id;

  const stationRows = db.prepare('SELECT id, code, name, lat, lon FROM rail_stations WHERE dataset_id = ? ORDER BY id').all(id);
  const stations = stationRows.map(r => ({ code: r.code, name: r.name, lat: r.lat, lon: r.lon }));
  const stationIdxById = new Map(stationRows.map((r, i) => [r.id, i]));
  const stationIndex = new Map(stations.map((s, i) => [s.code, i]));

  const serviceIndex = buildServiceIndex({
    calendars: db.prepare('SELECT * FROM rail_services WHERE dataset_id = ?').all(id).map(r => ({
      serviceId: r.service_id, days: [r.monday, r.tuesday, r.wednesday, r.thursday, r.friday, r.saturday, r.sunday], start: r.start_date, end: r.end_date
    })),
    calendarDates: db.prepare('SELECT service_id, date, exception_type FROM rail_service_dates WHERE dataset_id = ?').all(id).map(r => ({ serviceId: r.service_id, date: r.date, type: r.exception_type }))
  });

  const trainRows = db.prepare('SELECT id, number, name, headsign, service_id FROM rail_trains WHERE dataset_id = ? ORDER BY id').all(id);
  const trainIdxById = new Map(trainRows.map((r, i) => [r.id, i]));
  const stopsByTrain = trainRows.map(() => []);
  const stopRows = db.prepare(`
    SELECT s.train_id, s.seq, s.station_id, s.arrival_seconds, s.departure_seconds, s.distance_km
    FROM rail_train_stops s JOIN rail_trains t ON t.id = s.train_id WHERE t.dataset_id = ? ORDER BY s.train_id, s.seq
  `).all(id);
  for (const r of stopRows) stopsByTrain[trainIdxById.get(r.train_id)].push(r);

  let maxRunSeconds = 0;
  const stationStops = stations.map(() => []);
  const trains = trainRows.map((r, t) => {
    const rows = stopsByTrain[t];
    const n = rows.length;
    const train = {
      number: r.number, name: r.name, headsign: r.headsign, serviceId: r.service_id,
      serviceIdx: serviceIndex.idToIndex.get(r.service_id) ?? NONE,
      station: new Int32Array(n), arr: new Int32Array(n), dep: new Int32Array(n), dist: new Float64Array(n)
    };
    rows.forEach((row, p) => {
      const s = stationIdxById.get(row.station_id);
      train.station[p] = s;
      train.arr[p] = row.arrival_seconds ?? NONE;
      train.dep[p] = row.departure_seconds ?? NONE;
      train.dist[p] = row.distance_km ?? NaN;
      stationStops[s].push(t, p);
      maxRunSeconds = Math.max(maxRunSeconds, row.arrival_seconds ?? 0, row.departure_seconds ?? 0);
    });
    return train;
  });

  return {
    dataset: {
      id,
      name: dataset.name,
      providerId: dataset.provider_id,
      sourceType: dataset.source_type,
      sourceUrl: dataset.source_url,
      license: dataset.license,
      licenseStatus: dataset.license_status,
      provenanceNote: dataset.provenance_note,
      operator: dataset.operator,
      snapshotDate: dataset.snapshot_date,
      retrievedAt: dataset.retrieved_at,
      importedAt: dataset.imported_at,
      feedStartDate: dataset.feed_start_date,
      feedEndDate: dataset.feed_end_date,
      validFrom: dataset.valid_from,
      validTo: dataset.valid_to,
      checksum: dataset.checksum_sha256,
      stats: dataset.stats_json ? JSON.parse(dataset.stats_json) : {}
    },
    stations,
    stationIndex,
    stationStops,            // per station: flat [trainIdx, pos, trainIdx, pos, ...]
    trains,
    serviceIndex,
    maxRunDays: Math.floor(maxRunSeconds / SECONDS_PER_DAY),
    activeCache: new Map()
  };
}

// Services running on a calendar day (cached; never extrapolated beyond the calendars).
export function activeServicesOn(network, dayNumber) {
  let active = network.activeCache.get(dayNumber);
  if (!active) {
    if (network.activeCache.size > 64) network.activeCache.clear();
    active = resolveActiveServices(network.serviceIndex, dayNumber, { extrapolate: false });
    network.activeCache.set(dayNumber, active);
  }
  return active;
}

/**
 * How old the snapshot is, and whether it may still be served.
 *   fresh   - younger than staleWarningDays
 *   stale   - usable, but every result says when the snapshot was taken
 *   expired - older than maxSnapshotAgeDays: train search is switched off
 */
export function railFreshness(dataset, { now = new Date(), staleWarningDays, maxSnapshotAgeDays } = getRailConfig().freshness) {
  const today = todayInTimezone('Asia/Kolkata', now);
  const snapshot = dataset?.snapshotDate ?? dataset?.retrievedAt?.slice(0, 10) ?? null;
  const snapshotDay = isoToDayNumber(snapshot);
  if (snapshotDay === null) return { status: 'expired', usable: false, snapshotDate: null, ageDays: null, checkedOn: today };
  const ageDays = isoToDayNumber(today) - snapshotDay;
  const status = ageDays > maxSnapshotAgeDays ? 'expired' : ageDays > staleWarningDays ? 'stale' : 'fresh';
  return { status, usable: status !== 'expired', snapshotDate: snapshot, ageDays, staleWarningDays, maxSnapshotAgeDays, checkedOn: today };
}

let cache = null; // { dbPath, mtimeMs, network }

export function getRailNetwork({ config = getRailConfig(), force = false } = {}) {
  let stat;
  try {
    stat = fs.statSync(config.dbPath);
  } catch {
    cache = null;
    return null;
  }
  if (!force && cache && cache.dbPath === config.dbPath && cache.mtimeMs === stat.mtimeMs) return cache.network;
  const started = performance.now();
  const db = openRailDb(config.dbPath, { readOnly: true });
  try {
    const network = loadRailNetworkFromDb(db);
    if (network) network.loadTimeMs = Math.round(performance.now() - started);
    cache = { dbPath: config.dbPath, mtimeMs: stat.mtimeMs, network };
    return network;
  } finally {
    db.close();
  }
}

export function clearRailNetworkCache() {
  cache = null;
}

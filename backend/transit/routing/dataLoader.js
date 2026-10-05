// Builds the in-memory RAPTOR network.
//
//   buildNetwork(records, config)   pure: plain records in, typed-array network out (used directly by tests)
//   loadNetworkFromDb(db, config)   reads transit.db ONCE with a handful of bulk queries, then calls buildNetwork
//   getTransitNetwork()             process-wide cache, auto-reloads when the database file changes
//
// No SQL runs during routing: every query operates on the arrays built here.
import fs from 'fs';
import { performance } from 'node:perf_hooks';
import { getTransitConfig } from '../config.js';
import { openTransitDb } from '../transitDb.js';
import { getRoutingConfig } from './config.js';
import { buildServiceIndex } from './serviceCalendar.js';
import { StopIndex } from './stopIndex.js';
import { estimateWalk } from './accessEgress.js';
import { haversineMeters } from './geo.js';
import { TIME_QUALITY_CODE } from './types.js';

const compareStrings = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

/**
 * @param {Object} records
 * @param {{id:number, sourceId:string, name:string, lat:number, lon:number}[]} records.stops
 * @param {{id:number, sourceId:string, shortName:?string, longName:?string, mode:string}[]} records.routes
 * @param {{id:number, sourceId:string, routeId:number, serviceId:string, headsign:?string}[]} records.trips
 * @param {Iterable<{tripId:number, stopId:number, seq:number, arr:?number, dep:?number, pickup:number, dropOff:number, quality:string}>} records.stopTimes
 * @param {{serviceId:string, days:number[], start:string, end:string}[]} [records.calendars]
 * @param {{serviceId:string, date:string, type:number}[]} [records.calendarDates]
 * @param {{from:number, to:number, minSeconds:?number}[]} [records.transfers]
 * @param {Object} [records.dataset]
 */
export function buildNetwork(records, config = getRoutingConfig()) {
  const startedAt = performance.now();
  const excluded = { tooFewStops: 0, unmappedStop: 0, missingTimes: 0, nonMonotonic: 0, tooLong: 0, unknownTrip: 0 };
  let repairedDwell = 0;

  // ---- Stops ----
  const stopDbToIdx = new Map();
  const stopNames = [];
  const stopSourceIds = [];
  const latList = [];
  const lonList = [];
  let skippedStops = 0;
  for (const stop of records.stops) {
    if (!Number.isFinite(stop.lat) || !Number.isFinite(stop.lon)) { skippedStops++; continue; }
    stopDbToIdx.set(stop.id, stopNames.length);
    stopNames.push(stop.name);
    stopSourceIds.push(stop.sourceId);
    latList.push(stop.lat);
    lonList.push(stop.lon);
  }
  const stopCount = stopNames.length;
  const stopLat = Float64Array.from(latList);
  const stopLon = Float64Array.from(lonList);
  const stopIndex = new StopIndex(stopLat, stopLon);

  // ---- Routes and trips (metadata only; times live in the patterns) ----
  const routeDbToIdx = new Map();
  const routes = [];
  for (const route of records.routes) {
    routeDbToIdx.set(route.id, routes.length);
    routes.push({ sourceId: route.sourceId, shortName: route.shortName ?? null, longName: route.longName ?? null, mode: route.mode });
  }
  const tripMeta = new Map();
  for (const trip of records.trips) {
    tripMeta.set(trip.id, { sourceId: trip.sourceId, routeIdx: routeDbToIdx.get(trip.routeId), serviceId: trip.serviceId, headsign: trip.headsign ?? null });
  }

  const serviceIndex = buildServiceIndex({
    calendars: records.calendars ?? [],
    calendarDates: records.calendarDates ?? [],
    extraServiceIds: records.trips.map(trip => trip.serviceId)
  });

  // ---- Group stop_times by trip, validate, and bucket trips by stop pattern ----
  const groups = new Map();
  let includedTrips = 0;
  let maxTripTimeSeconds = 0;

  const processTrip = (tripDbId, rows) => {
    const meta = tripMeta.get(tripDbId);
    if (!meta || meta.routeIdx === undefined) { excluded.unknownTrip++; return; }
    if (rows.length < 2) { excluded.tooFewStops++; return; }
    rows.sort((a, b) => a.seq - b.seq);

    const n = rows.length;
    const stops = new Int32Array(n);
    const arr = new Int32Array(n);
    const dep = new Int32Array(n);
    const pickup = new Uint8Array(n);
    const dropOff = new Uint8Array(n);
    const quality = new Uint8Array(n);

    for (let i = 0; i < n; i++) {
      const row = rows[i];
      const stopIdx = stopDbToIdx.get(row.stopId);
      if (stopIdx === undefined) { excluded.unmappedStop++; return; }
      if (row.arr === null || row.arr === undefined || row.dep === null || row.dep === undefined) { excluded.missingTimes++; return; }
      let departure = row.dep;
      if (departure < row.arr) { departure = row.arr; repairedDwell++; }
      if (i > 0 && row.arr < dep[i - 1]) { excluded.nonMonotonic++; return; }
      stops[i] = stopIdx;
      arr[i] = row.arr;
      dep[i] = departure;
      pickup[i] = row.pickup === 1 ? 0 : 1; // pickup_type 1 = no pickup
      dropOff[i] = row.dropOff === 1 ? 0 : 1;
      quality[i] = TIME_QUALITY_CODE[row.quality] ?? TIME_QUALITY_CODE.unknown;
    }
    if (arr[n - 1] - dep[0] > config.maxTripDurationSeconds) { excluded.tooLong++; return; }

    const serviceIdx = serviceIndex.idToIndex.get(meta.serviceId);
    const key = `${meta.routeIdx}|${Array.from(stops).join(',')}|${Array.from(pickup).join('')}|${Array.from(dropOff).join('')}`;
    let group = groups.get(key);
    if (!group) groups.set(key, (group = { routeIdx: meta.routeIdx, stops, pickup, dropOff, trips: [] }));
    group.trips.push({ sourceId: meta.sourceId, headsign: meta.headsign, serviceIdx, arr, dep, quality });
    if (arr[n - 1] > maxTripTimeSeconds) maxTripTimeSeconds = arr[n - 1];
    includedTrips++;
  };

  let currentTrip = null;
  let currentRows = [];
  for (const row of records.stopTimes) {
    if (currentTrip !== row.tripId) {
      if (currentTrip !== null) processTrip(currentTrip, currentRows);
      currentTrip = row.tripId;
      currentRows = [];
    }
    currentRows.push(row);
  }
  if (currentTrip !== null) processTrip(currentTrip, currentRows);

  // ---- Patterns: split each group into chains of non-overtaking trips (a RAPTOR requirement) ----
  const patterns = [];
  for (const group of groups.values()) {
    const trips = group.trips.sort((a, b) => a.dep[0] - b.dep[0] || compareStrings(a.sourceId, b.sourceId));
    const chains = [];
    for (const trip of trips) {
      let placed = false;
      for (const chain of chains) {
        const last = chain[chain.length - 1];
        let ok = true;
        for (let i = 0; i < group.stops.length && ok; i++) ok = trip.dep[i] >= last.dep[i] && trip.arr[i] >= last.arr[i];
        if (ok) { chain.push(trip); placed = true; break; }
      }
      if (!placed) chains.push([trip]);
    }

    const n = group.stops.length;
    for (const chain of chains) {
      const tripCount = chain.length;
      const dep = new Int32Array(tripCount * n);
      const arr = new Int32Array(tripCount * n);
      const quality = new Uint8Array(tripCount * n);
      const service = new Int32Array(tripCount);
      chain.forEach((trip, j) => {
        dep.set(trip.dep, j * n);
        arr.set(trip.arr, j * n);
        quality.set(trip.quality, j * n);
        service[j] = trip.serviceIdx;
      });
      patterns.push({
        routeIdx: group.routeIdx,
        n,
        stops: group.stops,
        tripCount,
        dep,
        arr,
        quality,
        service,
        tripSourceIds: chain.map(trip => trip.sourceId),
        headsigns: chain.map(trip => trip.headsign),
        pickup: group.pickup,
        dropOff: group.dropOff
      });
    }
  }

  // ---- stop -> (pattern, position) index in CSR form ----
  const counts = new Int32Array(stopCount + 1);
  for (const pattern of patterns) for (let i = 0; i < pattern.n; i++) counts[pattern.stops[i] + 1]++;
  const stopPatternOffsets = new Int32Array(stopCount + 1);
  for (let s = 0; s < stopCount; s++) stopPatternOffsets[s + 1] = stopPatternOffsets[s] + counts[s + 1];
  const stopPatternPattern = new Int32Array(stopPatternOffsets[stopCount]);
  const stopPatternPos = new Int32Array(stopPatternOffsets[stopCount]);
  const cursor = Int32Array.from(stopPatternOffsets.subarray(0, stopCount));
  patterns.forEach((pattern, p) => {
    for (let i = 0; i < pattern.n; i++) {
      const slot = cursor[pattern.stops[i]]++;
      stopPatternPattern[slot] = p;
      stopPatternPos[slot] = i;
    }
  });

  // ---- Transfers: per-stop minimum transfer time + walking footpaths ----
  const minTransfer = new Int32Array(stopCount).fill(config.minTransferSeconds);
  const footMaps = new Array(stopCount).fill(null);
  const setFoot = (from, to, seconds, meters, source) => {
    (footMaps[from] ??= new Map()).set(to, { seconds, meters, source });
  };

  if (config.transferRadiusMeters > 0) {
    for (let s = 0; s < stopCount; s++) {
      const near = stopIndex.nearby(stopLat[s], stopLon[s], config.transferRadiusMeters, { limit: config.maxFootpathsPerStop + 1 });
      let added = 0;
      for (const { stop, distanceMeters } of near) {
        if (stop === s || added >= config.maxFootpathsPerStop) continue;
        const walk = estimateWalk(distanceMeters, config);
        setFoot(s, stop, walk.durationSeconds, walk.distanceMeters, 0); // source 0 = estimated walk
        added++;
      }
    }
  }
  for (const transfer of records.transfers ?? []) {
    const from = stopDbToIdx.get(transfer.from);
    const to = stopDbToIdx.get(transfer.to);
    if (from === undefined || to === undefined) continue;
    if (from === to) {
      if (Number.isFinite(transfer.minSeconds)) minTransfer[from] = transfer.minSeconds; // table overrides the default
    } else {
      const walk = estimateWalk(haversineMeters(stopLat[from], stopLon[from], stopLat[to], stopLon[to]), config);
      const seconds = Number.isFinite(transfer.minSeconds) ? transfer.minSeconds : walk.durationSeconds;
      setFoot(from, to, seconds, walk.distanceMeters, 1); // source 1 = transfers table
    }
  }

  const footOffsets = new Int32Array(stopCount + 1);
  const footEntries = [];
  for (let s = 0; s < stopCount; s++) {
    const entries = footMaps[s] ? [...footMaps[s].entries()].sort((a, b) => a[0] - b[0]) : [];
    footOffsets[s + 1] = footOffsets[s] + entries.length;
    footEntries.push(...entries);
  }
  const footTo = Int32Array.from(footEntries, entry => entry[0]);
  const footSeconds = Int32Array.from(footEntries, entry => entry[1].seconds);
  const footMeters = Int32Array.from(footEntries, entry => entry[1].meters);
  const footSource = Uint8Array.from(footEntries, entry => entry[1].source);

  return {
    stopCount,
    stopNames,
    stopSourceIds,
    stopLat,
    stopLon,
    stopIndex,
    routes,
    patterns,
    patternCount: patterns.length,
    stopPatternOffsets,
    stopPatternPattern,
    stopPatternPos,
    footOffsets,
    footTo,
    footSeconds,
    footMeters,
    footSource,
    minTransfer,
    serviceIndex,
    maxTripTimeSeconds,
    dataset: records.dataset ?? null,
    stats: {
      stops: stopCount,
      skippedStopsWithoutCoordinates: skippedStops,
      routes: routes.length,
      patterns: patterns.length,
      tripsIncluded: includedTrips,
      tripsExcluded: excluded,
      repairedDwellTimes: repairedDwell,
      stopTimes: patterns.reduce((sum, pattern) => sum + pattern.tripCount * pattern.n, 0),
      footpaths: footTo.length,
      maxTripTimeSeconds,
      buildTimeMs: Math.round((performance.now() - startedAt) * 10) / 10
    }
  };
}

// ---------------------------------------------------------------------------------------------------------------------
// Database -> records
// ---------------------------------------------------------------------------------------------------------------------

function* iterateRows(statement, ...params) {
  if (typeof statement.iterate === 'function') yield* statement.iterate(...params);
  else yield* statement.all(...params);
}

export function loadNetworkFromDb(db, config = getRoutingConfig()) {
  const startedAt = performance.now();
  const dataset = db.prepare('SELECT * FROM datasets ORDER BY imported_at DESC, id DESC LIMIT 1').get();
  if (!dataset) return null;
  const datasetId = dataset.id;

  const stops = db.prepare('SELECT id, source_stop_id, name, lat, lon FROM stops WHERE dataset_id = ? ORDER BY id').all(datasetId)
    .map(row => ({ id: row.id, sourceId: row.source_stop_id, name: row.name, lat: row.lat, lon: row.lon }));
  const routes = db.prepare('SELECT id, source_route_id, short_name, long_name, mode FROM routes WHERE dataset_id = ? ORDER BY id').all(datasetId)
    .map(row => ({ id: row.id, sourceId: row.source_route_id, shortName: row.short_name, longName: row.long_name, mode: row.mode }));
  const trips = db.prepare('SELECT id, source_trip_id, route_id, service_id, headsign FROM trips WHERE dataset_id = ? ORDER BY id').all(datasetId)
    .map(row => ({ id: row.id, sourceId: row.source_trip_id, routeId: row.route_id, serviceId: row.service_id, headsign: row.headsign }));
  const calendars = db.prepare('SELECT * FROM service_calendars WHERE dataset_id = ?').all(datasetId)
    .map(row => ({
      serviceId: row.service_id,
      days: [row.monday, row.tuesday, row.wednesday, row.thursday, row.friday, row.saturday, row.sunday],
      start: row.start_date,
      end: row.end_date
    }));
  const calendarDates = db.prepare('SELECT service_id, date, exception_type FROM calendar_dates WHERE dataset_id = ?').all(datasetId)
    .map(row => ({ serviceId: row.service_id, date: row.date, type: row.exception_type }));
  const transfers = db.prepare('SELECT from_stop_id, to_stop_id, min_transfer_seconds FROM transfers WHERE dataset_id = ?').all(datasetId)
    .map(row => ({ from: row.from_stop_id, to: row.to_stop_id, minSeconds: row.min_transfer_seconds }));

  const stopTimeStatement = db.prepare(`
    SELECT st.trip_id, st.stop_id, st.stop_sequence, st.arrival_seconds, st.departure_seconds,
           st.pickup_type, st.drop_off_type, st.time_quality
    FROM stop_times st JOIN trips t ON t.id = st.trip_id
    WHERE t.dataset_id = ?
    ORDER BY st.trip_id, st.stop_sequence
  `);
  function* stopTimes() {
    for (const row of iterateRows(stopTimeStatement, datasetId)) {
      yield {
        tripId: row.trip_id,
        stopId: row.stop_id,
        seq: row.stop_sequence,
        arr: row.arrival_seconds,
        dep: row.departure_seconds,
        pickup: row.pickup_type,
        dropOff: row.drop_off_type,
        quality: row.time_quality
      };
    }
  }

  const network = buildNetwork({ stops, routes, trips, stopTimes: stopTimes(), calendars, calendarDates, transfers, dataset: { ...dataset } }, config);
  network.stats.loadTimeMs = Math.round((performance.now() - startedAt) * 10) / 10;
  network.loadInfo = { loadedAt: new Date().toISOString(), loadTimeMs: network.stats.loadTimeMs };
  return network;
}

// ---------------------------------------------------------------------------------------------------------------------
// Process-wide cache
// ---------------------------------------------------------------------------------------------------------------------

let cache = null; // { key, network }

// Returns the cached network, rebuilding it when the database file (or the routing config) changed.
// Returns null when no transit database / dataset exists.
export function getTransitNetwork({ dbPath = getTransitConfig().dbPath, config = getRoutingConfig(), force = false } = {}) {
  let stat;
  try {
    stat = fs.statSync(dbPath);
  } catch {
    cache = null;
    return null;
  }

  const key = `${dbPath}|${stat.mtimeMs}|${stat.size}|${JSON.stringify(config)}`;
  if (!force && cache && cache.key === key) return cache.network;

  const db = openTransitDb(dbPath, { readOnly: true });
  try {
    const network = loadNetworkFromDb(db, config);
    cache = network ? { key, network } : null;
    return network;
  } finally {
    db.close();
  }
}

// Explicit reload (e.g. after "npm run transit:import" while the server keeps running).
export function reloadTransitNetwork(options = {}) {
  return getTransitNetwork({ ...options, force: true });
}

export function clearTransitNetworkCache() {
  cache = null;
}

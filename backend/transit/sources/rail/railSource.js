// Rail source. RouteConnect ships no rail data. Train search comes from one of two places:
//
//   - the imported rail database (backend/transit/rail: provider-independent schema, `npm run rail:import`), served
//     only when ROUTECONNECT_RAIL_ENABLED=true and the snapshot is recent enough (see railConfig.js); or
//   - a small NORMALISED JSON timetable file with a stated source, for tests and hand-curated data:
//
//   ROUTECONNECT_RAIL_TIMETABLE_PATH=/path/to/rail-timetable.json
//
// File schema (one object):
// {
//   "source":   { "name": "...", "type": "official" | "open_data" | "community", "license": "...",
//                 "url": "...", "retrievedAt": "YYYY-MM-DD", "validFrom": "YYYY-MM-DD"|null, "validTo": "YYYY-MM-DD"|null },
//   "operator": "Indian Railways",
//   "stations": [{ "code": "BZA", "name": "Vijayawada Junction", "lat": 16.5176, "lon": 80.6195 }],
//   "trains":   [{ "number": "12345", "name": "...", "days": ["Mon", ...] | "daily",
//                  "stops": [{ "code": "BZA", "arr": "HH:MM"|null, "dep": "HH:MM"|null, "day": 0 }] }]
// }
// `day` is the day offset from the train's first departure (0 = same day). `days` are the first station's running days.
// Nothing is fetched at search time and no train is invented: only trains in the file can be returned.
import fs from 'node:fs';
import { haversineMeters } from '../../routing/geo.js';
import { isoToDayNumber, weekdayIndex, formatLocalDateTime } from '../../routing/serviceCalendar.js';
import { operatorIdentity } from '../operators.js';
import { getRailConfig } from '../../rail/railConfig.js';
import { getRailNetwork, railFreshness } from '../../rail/railNetwork.js';
import { searchRail, toTrunk } from '../../rail/railSearch.js';
import { estimateLocalRide, estimateWalk } from '../../routing/accessEgress.js';
import { getRoutingConfig } from '../../routing/config.js';
import { COMPOSE_DEFAULTS } from '../../multimodal/compose.js';

// Same order as weekdayIndex(): 0 = Monday ... 6 = Sunday.
const WEEKDAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
const SOURCE_TYPES = ['official', 'open_data', 'community'];

const toSeconds = text => {
  if (typeof text !== 'string' || !/^\d{1,2}:\d{2}$/.test(text)) return null;
  const [h, m] = text.split(':').map(Number);
  return h * 3600 + m * 60;
};

// Validates and indexes a timetable object. Throws on a file that does not say where its data comes from.
export function loadRailTimetable(raw) {
  if (!raw?.source?.name || !SOURCE_TYPES.includes(raw.source.type)) {
    throw new Error('Rail timetable must declare source.name and source.type (official | open_data | community).');
  }
  const stations = new Map();
  for (const s of raw.stations ?? []) {
    if (s.code && Number.isFinite(s.lat) && Number.isFinite(s.lon)) stations.set(s.code, { code: s.code, name: s.name ?? s.code, lat: s.lat, lon: s.lon });
  }
  const trains = [];
  for (const t of raw.trains ?? []) {
    const days = t.days === 'daily' ? WEEKDAYS : (t.days ?? []).filter(d => WEEKDAYS.includes(d));
    const stops = (t.stops ?? [])
      .filter(stop => stations.has(stop.code))
      .map(stop => ({ code: stop.code, arr: toSeconds(stop.arr), dep: toSeconds(stop.dep), day: Number.isInteger(stop.day) ? stop.day : 0 }));
    if (!t.number || stops.length < 2 || days.length === 0) continue;
    trains.push({ number: String(t.number), name: t.name ?? null, days: new Set(days), stops });
  }
  return { source: raw.source, operator: raw.operator ?? null, stations, trains };
}

export function nearestStations(timetable, point, { radiusMeters = 40000, limit = 3 } = {}) {
  return [...timetable.stations.values()]
    .map(station => ({ station, meters: haversineMeters(point.lat, point.lon, station.lat, station.lon) }))
    .filter(entry => entry.meters <= radiusMeters)
    .sort((a, b) => a.meters - b.meters)
    .slice(0, limit);
}

/**
 * Direct trains between stations near the origin and near the destination, departing in [windowStart, windowEnd]
 * (seconds after midnight of `date`). Returns normalised TRUNK legs for the multimodal composer.
 */
export function searchTrains(timetable, { origin, destination, date, windowStartSeconds, windowEndSeconds, utcOffset = '+05:30' }, options = {}) {
  const from = nearestStations(timetable, origin, options);
  const to = nearestStations(timetable, destination, options);
  if (from.length === 0 || to.length === 0) return [];
  const fromCodes = new Map(from.map(e => [e.station.code, e]));
  const toCodes = new Map(to.map(e => [e.station.code, e]));
  const searchDay = isoToDayNumber(date);
  const operator = operatorIdentity(timetable.operator, { source: `rail:${timetable.source.name}`, confidence: timetable.source.type === 'official' ? 'published' : 'inferred', typeHint: 'rail' });
  const outsideValidity = (timetable.source.validTo && date > timetable.source.validTo) || (timetable.source.validFrom && date < timetable.source.validFrom);
  const scheduleConfidence = timetable.source.type === 'official' && !outsideValidity ? 'published' : 'inferred';
  const trunks = [];

  for (const train of timetable.trains) {
    for (let i = 0; i < train.stops.length; i++) {
      const board = train.stops[i];
      if (!fromCodes.has(board.code) || board.dep === null) continue;
      for (let j = i + 1; j < train.stops.length; j++) {
        const alight = train.stops[j];
        if (!toCodes.has(alight.code) || alight.arr === null) continue;
        // The train starts its run `board.day` days before it reaches the boarding station.
        const startDay = searchDay - board.day;
        if (!train.days.has(WEEKDAYS[weekdayIndex(startDay)])) continue;
        if (board.dep < windowStartSeconds || board.dep > windowEndSeconds) continue;
        const depAbs = board.dep;
        const arrAbs = (alight.day - board.day) * 86400 + alight.arr;
        if (arrAbs <= depAbs) continue;
        const iso = seconds => formatLocalDateTime(searchDay, seconds, utcOffset);
        const fromStation = timetable.stations.get(board.code);
        const toStation = timetable.stations.get(alight.code);
        trunks.push({
          mode: 'rail',
          operatorInfo: operator,
          operator: operator.name,
          trainNumber: train.number,
          trainName: train.name,
          displayName: `${train.number}${train.name ? ` ${train.name}` : ''}`,
          from: { type: 'station', name: fromStation.name, code: fromStation.code, lat: fromStation.lat, lon: fromStation.lon },
          to: { type: 'station', name: toStation.name, code: toStation.code, lat: toStation.lat, lon: toStation.lon },
          departureTime: iso(depAbs),
          arrivalTime: iso(arrAbs),
          durationSeconds: arrAbs - depAbs,
          intermediateStopCount: j - i - 1,
          intermediateStops: train.stops.slice(i + 1, j).map(stop => timetable.stations.get(stop.code).name),
          daysOfOperation: WEEKDAYS.filter(d => train.days.has(d)),
          scheduleConfidence,
          timeQuality: 'exact',
          fare: null, // no fare in the timetable; never guessed as a price
          source: { id: 'rail', name: timetable.source.name, type: timetable.source.type, license: timetable.source.license ?? null }
        });
        break; // nearest alighting station on this run is enough
      }
    }
  }
  return trunks;
}

// Trains are offered from this straight-line distance up (Guntur -> Tenali is ~22 km and well served by trains).
export const MIN_RAIL_TRIP_METERS = 8000;

// Live state of the imported rail database: why train search is or is not available right now.
export function railAvailability({ env = process.env, getNetwork = getRailNetwork, now = new Date() } = {}) {
  const config = getRailConfig(env);
  if (!config.enabled) {
    return { available: false, code: 'RAIL_DISABLED', reason: 'Train search is switched off: no railway timetable has been approved for use (ROUTECONNECT_RAIL_ENABLED).' };
  }
  let network = null;
  try {
    network = getNetwork({ config });
  } catch (error) {
    return { available: false, code: 'RAIL_DATA_ERROR', reason: `The railway timetable could not be loaded: ${error.message}` };
  }
  if (!network) return { available: false, code: 'RAIL_NOT_IMPORTED', reason: 'No railway timetable has been imported yet.' };
  const freshness = railFreshness(network.dataset, { now, ...config.freshness });
  if (!freshness.usable) {
    return {
      available: false, code: 'RAIL_SNAPSHOT_EXPIRED', network, freshness, config,
      reason: `The railway timetable snapshot (${freshness.snapshotDate ?? 'undated'}) is older than ${config.freshness.maxSnapshotAgeDays} days, so train search is paused until it is refreshed.`
    };
  }
  return { available: true, network, freshness, config };
}

// Source description carried by every train leg (shown as schedule evidence; never "official" for a community feed).
export function railSourceInfo(dataset) {
  return {
    id: 'rail',
    name: dataset.name,
    type: dataset.sourceType,
    license: dataset.license,
    licenseStatus: dataset.licenseStatus,
    snapshotDate: dataset.snapshotDate,
    url: dataset.sourceUrl
  };
}

/**
 * Rail source for the multimodal planner.
 *   1. ROUTECONNECT_RAIL_TIMETABLE_PATH (a normalised JSON timetable, see the top of this file), if set;
 *   2. otherwise the imported rail database (backend/transit/rail), when ROUTECONNECT_RAIL_ENABLED=true and the
 *      snapshot is not expired.
 */
export function createRailSource({ env = process.env, readFile = path => fs.readFileSync(path, 'utf8'), getNetwork = getRailNetwork, now = () => new Date() } = {}) {
  let cached = null;
  const path = env.ROUTECONNECT_RAIL_TIMETABLE_PATH ?? null;
  const timetable = () => {
    if (!cached) cached = loadRailTimetable(JSON.parse(readFile(path)));
    return cached;
  };
  return {
    id: 'rail',
    label: 'Rail timetable',
    mode: 'rail',
    timeoutMs: 5000,
    status(ctx) {
      if (path) {
        if (ctx.crowFliesMeters < MIN_RAIL_TRIP_METERS) return { configured: true, applicable: false, reason: 'Too short for a train journey.' };
        return { configured: true };
      }
      const state = railAvailability({ env, getNetwork, now: now() });
      if (!state.available) return { configured: false, reason: state.reason, code: state.code };
      if (ctx.crowFliesMeters < MIN_RAIL_TRIP_METERS) return { configured: true, applicable: false, reason: 'Too short for a train journey.' };
      return { configured: true };
    },
    search(ctx) {
      if (path) {
        const table = timetable();
        return { trunks: searchTrains(table, ctx), meta: { source: table.source } };
      }
      const state = railAvailability({ env, getNetwork, now: now() });
      if (!state.available) return { trunks: [], meta: { unavailable: state.reason } };
      return searchRailDatabase(state, ctx);
    }
  };
}

function searchRailDatabase({ network, freshness, config }, ctx) {
  const routing = ctx.config ?? getRoutingConfig();
  const accessSeconds = meters => (meters <= COMPOSE_DEFAULTS.walkMaxMeters
    ? estimateWalk(meters, routing).durationSeconds
    : estimateLocalRide(meters, routing).durationSeconds);
  const result = searchRail(network, ctx, {
    radiusMeters: config.search.stationRadiusMeters,
    minTransferSeconds: config.search.minTransferSeconds,
    maxTransferWaitSeconds: config.search.maxTransferWaitSeconds,
    boardBufferSeconds: COMPOSE_DEFAULTS.bufferBeforeSeconds.rail,
    alightBufferSeconds: COMPOSE_DEFAULTS.bufferAfterSeconds.rail,
    accessSeconds,
    maxResults: COMPOSE_DEFAULTS.maxTrunks
  });
  const dataset = network.dataset;
  const source = railSourceInfo(dataset);
  const operatorInfo = operatorIdentity(dataset.operator, { source: `rail:${dataset.name}`, confidence: dataset.sourceType === 'official' ? 'published' : 'inferred', typeHint: 'rail' });
  // A community snapshot is "published timetable" data only while it is recent; older snapshots are labelled inferred.
  const scheduleConfidence = freshness.status === 'fresh' ? 'published' : 'inferred';
  const searchDay = isoToDayNumber(ctx.date);
  const trunks = result.journeys.map(journey => journey.legs.map(leg => toTrunk(network, leg, { searchDay, utcOffset: ctx.utcOffset ?? '+05:30', operatorInfo, scheduleConfidence, source })));
  return {
    trunks,
    meta: {
      source,
      freshness,
      dateCovered: (!dataset.validFrom || ctx.date >= dataset.validFrom) && (!dataset.validTo || ctx.date <= dataset.validTo),
      stations: {
        origin: result.originStations.map(o => network.stations[o.s].code),
        destination: result.destinationStations.map(d => network.stations[d.s].code)
      },
      stats: result.stats
    }
  };
}

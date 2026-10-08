// Rail source: searches a NORMALISED static rail timetable. RouteConnect ships no rail data; this source is
// "not configured" until a timetable file with a stated, legitimate source is provided:
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

export function createRailSource({ env = process.env, readFile = path => fs.readFileSync(path, 'utf8') } = {}) {
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
    timeoutMs: 3000,
    status(ctx) {
      if (!path) return { configured: false, reason: 'No rail timetable is configured (ROUTECONNECT_RAIL_TIMETABLE_PATH). No legitimate, licensed Indian Railways timetable dataset is bundled.' };
      if (ctx.crowFliesMeters < 30000) return { configured: true, applicable: false, reason: 'Too short for an intercity train.' };
      return { configured: true };
    },
    search(ctx) {
      const table = timetable();
      return { trunks: searchTrains(table, ctx), meta: { source: table.source } };
    }
  };
}

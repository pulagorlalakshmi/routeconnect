// Railway station locations (code, name, coordinates) for the scheduled-train source (RailRadar).
//
// Scheduled trains must not depend on the Estimated Rail explorer being ready: the explorer may be switched off,
// still preparing, or have failed to build, and RailRadar only needs to know where stations are. So stations come from
// the built graph when there is one, otherwise straight from the seed shipped with the code (ODbL, seed/README.md).
//
// Each set also carries a station-SIZE signal for choosing transfer hubs: the length of mapped track within 1.5 km of
// the station (large stations have yards and several lines; a wayside halt has one or two tracks). It is a planning
// proxy only, never shown as a fact about services. Freight yards also have a lot of track, so the official station
// name counts too: an Indian Railways "Junction" is where lines meet and passenger services interchange.
import { haversineMeters } from '../routing/geo.js';
import { getRailNetworkConfig } from './railNetworkConfig.js';
import { getRailGraph } from './railExplorer.js';
import { readRailNetworkSeed } from './railNetworkData.js';
import { createSpatialIndex, getStationIndex, stationImportance } from './stationReference.js';

export const TRACK_RADIUS_METERS = 1500;
// Track length at which a station counts as fully "major" (Vijayawada, Visakhapatnam, Secunderabad have 20-25 km).
export const MAJOR_TRACK_KM = 20;

let seedCache = null; // { path, set }
const graphSets = new WeakMap();

// km of mapped track within TRACK_RADIUS_METERS of each station, using a coarse grid over segment midpoints.
export function trackKmByStation(graph) {
  const cell = 0.02; // degrees (~2 km)
  const grid = new Map();
  for (const edge of graph.edges ?? []) {
    const geom = edge.geom ?? [];
    for (let i = 1; i < geom.length; i++) {
      const lat = (geom[i - 1][0] + geom[i][0]) / 2;
      const lon = (geom[i - 1][1] + geom[i][1]) / 2;
      const km = haversineMeters(geom[i - 1][0], geom[i - 1][1], geom[i][0], geom[i][1]) / 1000;
      const key = `${Math.floor(lat / cell)}|${Math.floor(lon / cell)}`;
      let list = grid.get(key);
      if (!list) grid.set(key, (list = []));
      list.push(lat, lon, km);
    }
  }
  const out = new Map();
  for (const station of graph.stations ?? []) {
    if (!station.code || out.has(station.code)) continue;
    const gy = Math.floor(station.lat / cell);
    const gx = Math.floor(station.lon / cell);
    let km = 0;
    for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
      const list = grid.get(`${gy + dy}|${gx + dx}`);
      if (!list) continue;
      for (let i = 0; i < list.length; i += 3) if (haversineMeters(station.lat, station.lon, list[i], list[i + 1]) <= TRACK_RADIUS_METERS) km += list[i + 2];
    }
    out.set(station.code, Math.round(km * 10) / 10);
  }
  return out;
}

// Trains seen per station in timetable answers (this process): the busiest single answer that included the station.
// Evidence from the provider itself, so a terminal that turned out to be busy ranks higher next time.
const seenTrains = new Map();
export function recordTimetableEvidence(trains) {
  const counts = new Map();
  for (const t of trains ?? []) for (const code of [t.from?.code, t.to?.code]) if (code) counts.set(code, (counts.get(code) ?? 0) + 1);
  for (const [code, n] of counts) if (n > (seenTrains.get(code) ?? 0)) seenTrains.set(code, n);
}
export const trainsSeenAt = code => seenTrains.get(code) ?? 0;
export function clearTimetableEvidence() { seenTrains.clear(); }

// The stations RailRadar can be asked about: the NATIONWIDE reference (stationReference.js, all of India), plus any
// station of the regional railway graph whose code the reference lacks. The regional graph only adds its track-based
// size signal (Andhra Pradesh / Telangana); it never limits where trains are searched.
function stationSet(graph, from, national = getStationIndex()) {
  const trackKm = graph ? trackKmByStation(graph) : new Map();
  const merged = new Map();
  for (const s of national?.stations ?? []) merged.set(s.code, s);
  for (const s of graph?.stations ?? []) {
    if (s.code && !merged.has(s.code)) merged.set(s.code, { code: s.code, name: s.name, aliases: [], kind: s.kind, lat: s.lat, lon: s.lon, wikidata: false });
  }
  const stations = [...merged.values()];
  const spatial = createSpatialIndex(stations);
  const regional = station => 0.65 * Math.min(1, (trackKm.get(station?.code) ?? MAJOR_TRACK_KM * 0.3) / MAJOR_TRACK_KM)
    + (/junction|\bjn\b/i.test(station?.name ?? '') ? 0.35 : 0);
  return {
    stations,
    from: national ? `${from}+nationwide` : from,
    coverage: national ? { stations: stations.length, source: national.meta?.source ?? null, osmBaseTimestamp: national.meta?.osmBaseTimestamp ?? null } : { stations: stations.length, source: 'regional railway graph' },
    trackKm,
    nearby: spatial.nearby,
    // A multi-terminal city: an OpenStreetMap place=city within `meters` and at least `minStations` stations around it.
    isCity: (point, meters = 10000, minStations = 3) => Boolean(national?.placesNearby?.(point.lat, point.lon, meters).some(e => e.station.type === 'city'))
      && spatial.nearby(point.lat, point.lon, meters).filter(e => e.station.kind === 'station').length >= minStations,
    byCode: new Map(stations.map(s => [s.code, s])),
    // 0..1: how large an interchange a station is. With mapped track (AP / TS) the original track + junction measure;
    // elsewhere explainable reference signals (stationReference.js). Trains already seen at it raise it either way.
    importanceOf: station => {
      const seen = trainsSeenAt(station?.code);
      if (trackKm.has(station?.code)) return Math.max(regional(station), Math.min(1, seen / 20) * 0.6);
      return stationImportance(station, { seenTrains: seen });
    }
  };
}

export function getRailStations(config = getRailNetworkConfig()) {
  let graph = null;
  try { graph = getRailGraph(config); } catch { graph = null; }
  if (graph?.stations?.length) {
    let set = graphSets.get(graph);
    if (!set) graphSets.set(graph, (set = stationSet(graph, 'graph')));
    return set;
  }
  if (!config.seedPath) return null;
  if (seedCache?.path !== config.seedPath) {
    try {
      seedCache = { path: config.seedPath, set: stationSet(readRailNetworkSeed(config), 'seed') };
    } catch {
      return null;
    }
  }
  return seedCache.set;
}

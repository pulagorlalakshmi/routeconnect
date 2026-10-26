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

function stationSet(graph, from) {
  const trackKm = trackKmByStation(graph);
  return {
    stations: graph.stations,
    from,
    trackKm,
    // 0..1: how large an interchange a station is (see above). Unknown stations get a neutral track share.
    importanceOf: station => 0.65 * Math.min(1, (trackKm.get(station?.code) ?? MAJOR_TRACK_KM * 0.3) / MAJOR_TRACK_KM)
      + (/junction|\bjn\b/i.test(station?.name ?? '') ? 0.35 : 0)
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

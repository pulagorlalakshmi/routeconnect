// Estimated Rail Connection explorer: GET /api/v2/rail-explorer.
//
// Given two points, finds mapped railway stations near each, the physically connected track between them (and one
// genuinely different alternative corridor when the map has one), and an illustrative travel-time RANGE.
//
// Never produced here: train numbers or names, departure/arrival clock times, running days, fares, seat availability or
// live status. Results are labelled "Estimated rail connection — not a scheduled train" and are kept out of the
// scheduled journey planner (/api/v2/plan) entirely.
import fs from 'fs';
import { haversineMeters } from '../routing/geo.js';
import { getRailNetworkConfig } from './railNetworkConfig.js';
import { loadRailGraph, shortestRailPath, describePath, simplify } from './railGraph.js';
import { estimateRailTime } from './estimateRailTime.js';

export const ESTIMATED_RAIL_LABEL = 'Estimated rail connection — not a scheduled train';
const DECIMAL = /^-?\d+(\.\d+)?$/;
const MAX_RESULTS = 2;
const ROAD_WEIGHT = 2; // a km to/from a station by road counts double a km of rail when choosing stations
const ALT_PENALTY = 3; // edge-cost multiplier on the best corridor while looking for a different one
const ALT_MAX_RATIO = 1.35;
const ALT_MAX_SHARED = 0.6;

export const ASSUMPTIONS = Object.freeze([
  'Built from railway track mapped in OpenStreetMap. Connected track does not mean a passenger train runs on it.',
  'Duration is a range from mapped distance and assumed average speeds with station-stop allowances, not a timetable.',
  'No train numbers, departure times, running days, fares or seat availability are known for this connection.',
  'Getting to and from the stations is not included in the estimate.'
]);

let cache = null; // { path, mtimeMs, graph }
export function getRailGraph(config = getRailNetworkConfig()) {
  let stat;
  try { stat = fs.statSync(config.graphPath); } catch { cache = null; return null; }
  if (cache && cache.path === config.graphPath && cache.mtimeMs === stat.mtimeMs) return cache.graph;
  const graph = loadRailGraph(config.graphPath);
  cache = { path: config.graphPath, mtimeMs: stat.mtimeMs, graph };
  return graph;
}
export function clearRailGraphCache() { cache = null; }

// state: ready | preparing | missing | failed | disabled. `reason` is shown to people as-is, so it is plain language.
export function railNetworkStatus({ config = getRailNetworkConfig(), getGraph = () => getRailGraph(config), now = new Date(), preparation = { state: 'idle' } } = {}) {
  if (!config.enabled) return { available: false, state: 'disabled', reason: 'Estimated rail connections are switched off on this server.' };
  let graph = null;
  try { graph = getGraph(); } catch (error) { return { available: false, state: 'failed', reason: `The railway network could not be loaded (${error.message}).` }; }
  if (!graph) {
    if (preparation.state === 'preparing') return { available: false, state: 'preparing', reason: 'The railway network is being prepared on the server. Try again in a minute.' };
    if (preparation.state === 'failed') return { available: false, state: 'failed', reason: 'The railway network could not be prepared on the server. An administrator can run "npm run rail:network:update".' };
    return { available: false, state: 'missing', reason: 'The railway network has not been set up on this server yet.' };
  }
  const snapshot = graph.meta.osmBaseTimestamp ?? graph.meta.retrievedAt;
  const ageDays = snapshot ? Math.floor((now - new Date(snapshot)) / 86400000) : null;
  return {
    available: true,
    state: 'ready',
    label: ESTIMATED_RAIL_LABEL,
    coverage: graph.meta.regions,
    snapshot,
    ageDays,
    needsRefresh: ageDays !== null && ageDays > config.refreshAfterDays,
    attribution: graph.meta.attribution,
    licence: graph.meta.licence,
    stations: graph.stations.length,
    trackKm: graph.report?.tracks?.km ?? null
  };
}

// Stations near a point: the nearest few plus the larger junctions within the radius.
export function nearbyStations(g, point, radiusMeters, { nearest = 3, junctions = 2 } = {}) {
  const within = [];
  g.stations.forEach((s, i) => {
    if (s.node === undefined || s.node === null) return;
    const m = haversineMeters(point.lat, point.lon, s.lat, s.lon);
    if (m <= radiusMeters) within.push({ i, m });
  });
  within.sort((a, b) => a.m - b.m || a.i - b.i);
  const chosen = within.slice(0, nearest);
  const isJunction = e => /junction|\bjn\b/i.test(g.stations[e.i].name) || /^(station)$/.test(g.stations[e.i].kind) && /terminus|central|city/i.test(g.stations[e.i].name);
  chosen.push(...within.slice(nearest).filter(isJunction).slice(0, junctions));
  return chosen;
}

// Share of polyline A (by length) lying within `meters` of polyline B.
export function sharedShare(a, b, meters = 400) {
  const near = (lat, lon) => {
    const k = Math.cos((lat * Math.PI) / 180);
    for (let i = 0; i < b.length - 1; i++) {
      const ax = b[i][1] * k, ay = b[i][0], bx = b[i + 1][1] * k, by = b[i + 1][0];
      const dx = bx - ax, dy = by - ay;
      const len2 = dx * dx + dy * dy;
      const t = len2 === 0 ? 0 : Math.max(0, Math.min(1, ((lon * k - ax) * dx + (lat - ay) * dy) / len2));
      if (haversineMeters(lat, lon, ay + t * dy, (ax + t * dx) / k) <= meters) return true;
    }
    return false;
  };
  let total = 0;
  let shared = 0;
  for (let i = 0; i < a.length - 1; i++) {
    const segment = haversineMeters(a[i][0], a[i][1], a[i + 1][0], a[i + 1][1]);
    // Sample the segment every ~2 km so long straight pieces are judged along their length.
    const samples = Math.max(1, Math.ceil(segment / 2000));
    for (let s = 0; s < samples; s++) {
      const t = (s + 0.5) / samples;
      const lat = a[i][0] + t * (a[i + 1][0] - a[i][0]);
      const lon = a[i][1] + t * (a[i + 1][1] - a[i][1]);
      total += segment / samples;
      if (near(lat, lon)) shared += segment / samples;
    }
  }
  return total === 0 ? 1 : shared / total;
}

function stationOut(s, meters, key) {
  return { name: s.name, code: s.code ?? null, lat: s.lat, lon: s.lon, [key]: Math.round(meters / 100) / 10 };
}

function buildConnection(g, from, to, path, model, { alternative }) {
  const d = describePath(g, path);
  const endpoints = new Set([g.stations[from.i].name, g.stations[to.i].name]);
  const intermediate = d.stations.filter(s => !endpoints.has(s.name) && s.km > 0.5 && s.km < d.km - 0.5);
  const estimate = estimateRailTime({ km: d.km, kmByClass: d.kmByClass, intermediateStations: intermediate.length, reversals: path.reversals }, model);
  const via = intermediate.filter(s => /junction|\bjn\b/i.test(s.name)).map(s => s.name);
  return {
    kind: 'estimated_rail_connection',
    label: ESTIMATED_RAIL_LABEL,
    alternative,
    startStation: stationOut(g.stations[from.i], from.m, 'distanceFromOriginKm'),
    endStation: stationOut(g.stations[to.i], to.m, 'distanceToDestinationKm'),
    corridor: { names: d.corridorNames.slice(0, 3), via: [...new Set(via)].slice(0, 4) },
    distanceKm: Math.round(d.km),
    trackKmByClass: d.kmByClass,
    estimatedDuration: estimate,
    intermediateStationCount: intermediate.length,
    intermediateStations: intermediate.map(({ name, code, km }) => ({ name, code, km })),
    reversals: path.reversals,
    geometry: simplify(d.coords),
    _edges: new Set(path.steps.map(s => s.edge))
  };
}

/**
 * @returns {{status:number, body:object}}
 */
export function handleRailExplorerRequest(query = {}, { config = getRailNetworkConfig(), getGraph = () => getRailGraph(config), now = new Date(), preparation } = {}) {
  const status = railNetworkStatus({ config, getGraph, now, preparation });
  if (!status.available) return { status: 503, body: { available: false, state: status.state, label: ESTIMATED_RAIL_LABEL, reason: status.reason } };
  const coord = (name, min, max) => {
    const v = query[name];
    if (typeof v !== 'string' || !DECIMAL.test(v)) return null;
    const n = Number(v);
    return n >= min && n <= max ? n : null;
  };
  const origin = { lat: coord('fromLat', -90, 90), lon: coord('fromLng', -180, 180) };
  const destination = { lat: coord('toLat', -90, 90), lon: coord('toLng', -180, 180) };
  if ([origin.lat, origin.lon, destination.lat, destination.lon].some(v => v === null)) {
    return { status: 400, body: { error: 'fromLat, fromLng, toLat and toLng are required decimal coordinates.' } };
  }
  const g = getGraph();
  const network = { attribution: status.attribution, licence: status.licence, coverage: status.coverage, snapshot: status.snapshot };
  const base = { available: true, label: ESTIMATED_RAIL_LABEL, assumptions: ASSUMPTIONS, network, model: config.model };
  const tripMeters = haversineMeters(origin.lat, origin.lon, destination.lat, destination.lon);
  if (tripMeters < 8000) return { status: 200, body: { ...base, connections: [], message: 'These places are too close together for a rail connection to be useful.' } };
  const radius = Math.min(40000, Math.max(5000, tripMeters * 0.4));
  const froms = nearbyStations(g, origin, radius);
  const tos = nearbyStations(g, destination, radius).filter(t => !froms.some(f => f.i === t.i));
  if (froms.length === 0 || tos.length === 0) {
    return { status: 200, body: { ...base, connections: [], message: `No mapped railway station was found near ${froms.length === 0 ? 'your start' : 'your destination'} within the covered area (${status.coverage.join(', ')}).` } };
  }

  const reversalKm = config.model.reversalMinutes * (config.model.faster.mainKph / 60);
  let best = null;
  let disconnected = 0;
  for (const f of froms) {
    for (const t of tos) {
      const sf = g.stations[f.i];
      const st = g.stations[t.i];
      if (sf.component !== st.component) { disconnected++; continue; }
      const path = shortestRailPath(g, sf.node, st.node, { reversalKm });
      if (!path) { disconnected++; continue; }
      const score = path.km + path.reversals * reversalKm + ROAD_WEIGHT * (f.m + t.m) / 1000;
      if (!best || score < best.score) best = { f, t, path, score };
    }
  }
  if (!best) {
    return { status: 200, body: { ...base, connections: [], message: 'The stations near these places are not connected by mapped railway track in the covered area.', disconnectedPairs: disconnected } };
  }

  const connections = [buildConnection(g, best.f, best.t, best.path, config.model, { alternative: false })];
  // One genuinely different corridor, if the map has one: penalise the best corridor's track and search again.
  const used = connections[0]._edges;
  const alt = shortestRailPath(g, g.stations[best.f.i].node, g.stations[best.t.i].node, { reversalKm, edgeCost: e => (used.has(e) ? ALT_PENALTY : 1) });
  if (alt && alt.km <= best.path.km * ALT_MAX_RATIO) {
    // Parallel up/down lines are different OSM ways but the SAME corridor: overlap is measured on the ground.
    const candidate = buildConnection(g, best.f, best.t, alt, config.model, { alternative: true });
    if (sharedShare(candidate.geometry, connections[0].geometry) <= ALT_MAX_SHARED) connections.push(candidate);
  }
  return {
    status: 200,
    body: { ...base, connections: connections.slice(0, MAX_RESULTS).map(({ _edges, ...c }, i) => ({ id: `erc_${i + 1}`, ...c })) }
  };
}

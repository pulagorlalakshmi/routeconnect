// Routing over the mapped railway infrastructure graph (from buildRailGraph.js).
//
// Shortest paths are EDGE-BASED with a turn restriction: a train can continue through a node only if the track does not
// bend back on itself by more than MAX_DEFLECTION_DEGREES. Turning back (a reversal) is allowed only at a station, and
// costs a time penalty. This stops "V-shaped" paths through a junction that no train could physically run.
import fs from 'fs';
import { haversineMeters } from '../routing/geo.js';

export const MAX_DEFLECTION_DEGREES = 60;

const angleDiff = (a, b) => { const d = Math.abs(((a - b) % 360) + 360) % 360; return d > 180 ? 360 - d : d; };

export function indexGraph(graph) {
  const adjacency = graph.nodes.map(() => []);
  graph.edges.forEach((e, i) => {
    adjacency[e.a].push({ edge: i, forward: true });
    adjacency[e.b].push({ edge: i, forward: false });
  });
  const stationAtNode = new Map();
  graph.stations.forEach((s, i) => { if (s.node !== undefined && s.node !== null) stationAtNode.set(s.node, i); });
  return { ...graph, adjacency, stationAtNode };
}

export function loadRailGraph(path) {
  return indexGraph(JSON.parse(fs.readFileSync(path, 'utf8')));
}

class Heap {
  constructor() { this.items = []; }
  push(cost, value) {
    const a = this.items; a.push([cost, value]);
    let i = a.length - 1;
    while (i > 0) { const p = (i - 1) >> 1; if (a[p][0] <= a[i][0]) break; [a[p], a[i]] = [a[i], a[p]]; i = p; }
  }
  pop() {
    const a = this.items; const top = a[0]; const last = a.pop();
    if (a.length > 0) {
      a[0] = last; let i = 0;
      for (;;) { const l = 2 * i + 1, r = l + 1; let m = i; if (l < a.length && a[l][0] < a[m][0]) m = l; if (r < a.length && a[r][0] < a[m][0]) m = r; if (m === i) break; [a[m], a[i]] = [a[i], a[m]]; i = m; }
    }
    return top;
  }
  get size() { return this.items.length; }
}

/**
 * Shortest physically runnable path between two graph nodes.
 * @param options { reversalKm: cost of one reversal in km-equivalent, edgeCost: (edgeIndex) => multiplier }
 * @returns { steps:[{edge, forward}], km, reversals } or null
 */
export function shortestRailPath(g, fromNode, toNode, { reversalKm = 20, edgeCost = null } = {}) {
  if (fromNode === toNode) return { steps: [], km: 0, reversals: 0 };
  // State = traversing edge e in a direction (2 states per edge), keyed edge*2 + (forward ? 0 : 1).
  const best = new Map();
  const prev = new Map();
  const heap = new Heap();
  const endOf = (e, forward) => (forward ? g.edges[e].b : g.edges[e].a);
  // Heading of travel when ARRIVING at the far end of the edge.
  const arrivalHeading = (e, forward) => ((forward ? g.edges[e].bB : g.edges[e].bA) + 180) % 360;
  const leavingBearing = (e, forward) => (forward ? g.edges[e].bA : g.edges[e].bB);
  const cost = e => g.edges[e].km * (edgeCost ? edgeCost(e) : 1);

  for (const { edge, forward } of g.adjacency[fromNode]) {
    const key = edge * 2 + (forward ? 0 : 1);
    const c = cost(edge);
    if (c < (best.get(key) ?? Infinity)) { best.set(key, c); prev.set(key, null); heap.push(c, [key, 0]); }
  }
  let goal = null;
  while (heap.size > 0) {
    const [c, [key, reversals]] = heap.pop();
    if (c > (best.get(key) ?? Infinity)) continue;
    const e = key >> 1;
    const forward = (key & 1) === 0;
    const node = endOf(e, forward);
    if (node === toNode) { goal = { key, cost: c, reversals }; break; }
    const heading = arrivalHeading(e, forward);
    const atStation = g.stationAtNode.has(node);
    for (const next of g.adjacency[node]) {
      if (next.edge === e && next.forward !== forward && !atStation) continue; // straight back along the same track
      const deflection = angleDiff(heading, leavingBearing(next.edge, next.forward));
      const reversal = deflection > MAX_DEFLECTION_DEGREES;
      if (reversal && !atStation) continue;
      const nk = next.edge * 2 + (next.forward ? 0 : 1);
      const nc = c + cost(next.edge) + (reversal ? reversalKm : 0);
      if (nc < (best.get(nk) ?? Infinity)) { best.set(nk, nc); prev.set(nk, key); heap.push(nc, [nk, reversals + (reversal ? 1 : 0)]); }
    }
  }
  if (!goal) return null;
  const steps = [];
  for (let k = goal.key; k !== null && k !== undefined; k = prev.get(k)) steps.push({ edge: k >> 1, forward: (k & 1) === 0 });
  steps.reverse();
  const km = steps.reduce((sum, s) => sum + g.edges[s.edge].km, 0);
  return { steps, km: Math.round(km * 10) / 10, reversals: goal.reversals };
}

// Geometry, track classes, names and the stations a path passes, in order.
export function describePath(g, path, { stationSnapMeters = 300 } = {}) {
  const coords = [];
  const kmByClass = { main: 0, branch: 0, unknown: 0 };
  const names = new Map();
  for (const { edge, forward } of path.steps) {
    const e = g.edges[edge];
    const geom = forward ? e.geom : [...e.geom].reverse();
    coords.push(...(coords.length > 0 ? geom.slice(1) : geom)); // consecutive edges share their joining vertex
    kmByClass[e.cls] += e.km;
    if (e.name) names.set(e.name, (names.get(e.name) ?? 0) + e.km);
  }
  // Cumulative distance per vertex, for ordering stations along the path.
  const cum = [0];
  for (let i = 1; i < coords.length; i++) cum.push(cum[i - 1] + haversineMeters(coords[i - 1][0], coords[i - 1][1], coords[i][0], coords[i][1]) / 1000);
  const lats = coords.map(c => c[0]);
  const lons = coords.map(c => c[1]);
  const pad = 0.01;
  const box = { minLat: Math.min(...lats) - pad, maxLat: Math.max(...lats) + pad, minLon: Math.min(...lons) - pad, maxLon: Math.max(...lons) + pad };
  const passed = [];
  g.stations.forEach(s => {
    if (s.lat < box.minLat || s.lat > box.maxLat || s.lon < box.minLon || s.lon > box.maxLon) return;
    let bestKm = 0;
    let bestM = Infinity;
    const k = Math.cos((s.lat * Math.PI) / 180);
    for (let i = 0; i < coords.length - 1; i++) {
      // Distance from the station to segment i (local equirectangular frame).
      const ax = coords[i][1] * k, ay = coords[i][0], bx = coords[i + 1][1] * k, by = coords[i + 1][0];
      const dx = bx - ax, dy = by - ay;
      const len2 = dx * dx + dy * dy;
      const t = len2 === 0 ? 0 : Math.max(0, Math.min(1, ((s.lon * k - ax) * dx + (s.lat - ay) * dy) / len2));
      const lat = ay + t * dy;
      const lon = (ax + t * dx) / k;
      const m = haversineMeters(s.lat, s.lon, lat, lon);
      if (m < bestM) { bestM = m; bestKm = cum[i] + t * (cum[i + 1] - cum[i]); }
    }
    // A station counts as "on the corridor" when it lies within the snap distance of the path's track (parallel up and
    // down lines are separate ways, so the station may be attached to the other line).
    if (bestM <= stationSnapMeters + (s.attach?.meters ?? 0)) passed.push({ name: s.name, code: s.code, km: Math.round(bestKm * 10) / 10, lat: s.lat, lon: s.lon });
  });
  passed.sort((a, b) => a.km - b.km);
  const corridorNames = [...names.entries()].sort((a, b) => b[1] - a[1]).filter(([, km]) => km >= 10).map(([name]) => name);
  return {
    coords,
    km: path.km,
    kmByClass: Object.fromEntries(Object.entries(kmByClass).map(([k, v]) => [k, Math.round(v * 10) / 10])),
    stations: passed,
    corridorNames
  };
}

// Douglas-Peucker simplification for display (tolerance in degrees, ~ 0.0005 = 50 m).
export function simplify(coords, tolerance = 0.0008) {
  if (coords.length <= 2) return coords;
  const keep = new Uint8Array(coords.length);
  keep[0] = keep[coords.length - 1] = 1;
  const stack = [[0, coords.length - 1]];
  while (stack.length) {
    const [s, e] = stack.pop();
    let maxD = 0; let idx = -1;
    const [ay, ax] = coords[s]; const [by, bx] = coords[e];
    for (let i = s + 1; i < e; i++) {
      const [py, px] = coords[i];
      const dx = bx - ax, dy = by - ay;
      const len2 = dx * dx + dy * dy;
      const t = len2 === 0 ? 0 : Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / len2));
      const d = Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
      if (d > maxD) { maxD = d; idx = i; }
    }
    if (maxD > tolerance && idx > 0) { keep[idx] = 1; stack.push([s, idx], [idx, e]); }
  }
  return coords.filter((_, i) => keep[i]);
}

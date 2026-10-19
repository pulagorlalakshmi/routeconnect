// Turns a raw OSM railway extract into a routable infrastructure graph (rail-network.json).
//
// Rules (each is a deliberate "do not assume"):
//   - Track is connected ONLY where two ways share an OSM node. Tracks that merely come close are never joined.
//   - At a mapped diamond crossing (railway=railway_crossing) tracks cross without connecting.
//   - Excluded: industrial / military / freight-only usage, sidings, spurs, sand drags; abandoned / disused / proposed /
//     construction track is never fetched (railway=* other than "rail"). Metro stations are excluded.
//   - A station is attached to the nearest usable track within ATTACH_MAX_METERS by projecting it onto that track; the
//     attachment distance is recorded. Stations farther away stay unattached and are reported, never guessed.
// Nothing here says anything about passenger SERVICE: a connected track is not a confirmed train service.
import { haversineMeters } from '../routing/geo.js';

export const ATTACH_MAX_METERS = 500;
const EXCLUDED_USAGE = new Set(['industrial', 'military', 'freight', 'tourism', 'test']);
const EXCLUDED_SERVICE = new Set(['siding', 'spur', 'sand_drag', 'safety_siding']);
const BEARING_SAMPLE_METERS = 80;

export function usableTrack(tags = {}) {
  if (tags.railway !== 'rail') return false;
  if (EXCLUDED_USAGE.has(tags.usage)) return false;
  if (EXCLUDED_SERVICE.has(tags.service)) return false;
  if (tags.gauge && tags.gauge !== '1676') return false; // Indian broad gauge only (metre/narrow gauge is a separate network)
  return true;
}

export function usableStation(tags = {}) {
  if (!/^(station|halt)$/.test(tags.railway ?? '')) return false;
  if (/^(subway|metro|light_rail|monorail|funicular)$/i.test(tags.station ?? '')) return false;
  if (tags.subway === 'yes' || tags.light_rail === 'yes' || tags.monorail === 'yes') return false;
  if (/\bmetro\b/i.test(tags.name ?? '') || /metro/i.test(tags.network ?? '')) return false;
  return Boolean(tags.name);
}

const toRad = d => (d * Math.PI) / 180;
export function bearing(a, b) {
  const y = Math.sin(toRad(b.lon - a.lon)) * Math.cos(toRad(b.lat));
  const x = Math.cos(toRad(a.lat)) * Math.sin(toRad(b.lat)) - Math.sin(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.cos(toRad(b.lon - a.lon));
  return (Math.atan2(y, x) * 180 / Math.PI + 360) % 360;
}

// Nearest point on segment AB to P, in a local equirectangular frame (fine at < 1 km).
function project(p, a, b) {
  const k = Math.cos(toRad(p.lat));
  const ax = a.lon * k, ay = a.lat, bx = b.lon * k, by = b.lat, px = p.lon * k, py = p.lat;
  const dx = bx - ax, dy = by - ay;
  const len2 = dx * dx + dy * dy;
  const t = len2 === 0 ? 0 : Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / len2));
  const point = { lat: ay + t * dy, lon: (ax + t * dx) / k };
  return { t, point, meters: haversineMeters(p.lat, p.lon, point.lat, point.lon) };
}

/**
 * @param raw  { elements, osmBaseTimestamp, retrievedAt, regions, attribution, licence }
 * @returns graph { meta, nodes:[{lat,lon}], edges:[{a,b,km,cls,geom:[[lat,lon]...],bA,bB,name}], stations:[...], report }
 */
export function buildRailGraph(raw) {
  const elements = raw.elements ?? [];
  const diamonds = new Set(elements.filter(e => e.type === 'node' && !e.tags).map(e => e.id));
  const ways = elements.filter(e => e.type === 'way' && usableTrack(e.tags) && Array.isArray(e.geometry) && e.geometry.length === e.nodes?.length && e.nodes.length >= 2);
  const excludedWays = elements.filter(e => e.type === 'way' && e.tags?.railway === 'rail').length - ways.length;

  // Per way: list of points { key, lat, lon }. A diamond-crossing node gets a per-way key so it never joins two ways.
  const wayPoints = ways.map(w => w.nodes.map((id, i) => ({
    key: diamonds.has(id) ? `${id}@${w.id}` : String(id),
    lat: w.geometry[i].lat, lon: w.geometry[i].lon
  })));

  // ---- stations ----
  const rawStations = elements.filter(e => usableStation(e.tags));
  const excludedStations = elements.filter(e => /^(station|halt)$/.test(e.tags?.railway ?? '')).length - rawStations.length;
  const nodeOnTrack = new Map();
  wayPoints.forEach((pts, w) => pts.forEach((p, i) => { if (!nodeOnTrack.has(p.key)) nodeOnTrack.set(p.key, { w, i }); }));

  // Segment grid for attachment (0.01° cells ≈ 1.1 km).
  const CELL = 0.01;
  const grid = new Map();
  const cell = (lat, lon) => `${Math.floor(lat / CELL)}:${Math.floor(lon / CELL)}`;
  wayPoints.forEach((pts, w) => {
    for (let i = 0; i < pts.length - 1; i++) {
      // Every cell the segment passes through (long straight segments can span many cells).
      const steps = Math.max(1, Math.ceil(Math.max(Math.abs(pts[i + 1].lat - pts[i].lat), Math.abs(pts[i + 1].lon - pts[i].lon)) / (CELL / 2)));
      const cells = new Set();
      for (let s = 0; s <= steps; s++) {
        const t = s / steps;
        cells.add(cell(pts[i].lat + t * (pts[i + 1].lat - pts[i].lat), pts[i].lon + t * (pts[i + 1].lon - pts[i].lon)));
      }
      for (const c of cells) { if (!grid.has(c)) grid.set(c, []); grid.get(c).push([w, i]); }
    }
  });

  const inserts = new Map(); // way index -> [{ i, t, key, lat, lon }]
  const stations = [];
  const unattached = [];
  for (const s of rawStations) {
    const lat = s.lat ?? s.center?.lat;
    const lon = s.lon ?? s.center?.lon;
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) continue;
    const base = { osm: `${s.type}/${s.id}`, name: s.tags.name, code: s.tags.ref ?? s.tags['railway:ref'] ?? null, kind: s.tags.railway, lat, lon };
    if (s.type === 'node' && nodeOnTrack.has(String(s.id))) {
      stations.push({ ...base, attach: { method: 'on_track', meters: 0, key: String(s.id) } });
      continue;
    }
    let best = null;
    const cy = Math.floor(lat / CELL), cx = Math.floor(lon / CELL);
    for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
      for (const [w, i] of grid.get(`${cy + dy}:${cx + dx}`) ?? []) {
        const pts = wayPoints[w];
        const pr = project({ lat, lon }, pts[i], pts[i + 1]);
        if (!best || pr.meters < best.meters) best = { w, i, ...pr };
      }
    }
    if (!best || best.meters > ATTACH_MAX_METERS) { unattached.push({ ...base, nearestTrackMeters: best ? Math.round(best.meters) : null }); continue; }
    // Projection onto (or within 2 m of) an existing track vertex: attach to that vertex, never a zero-length copy of it.
    const ends = [wayPoints[best.w][best.i], wayPoints[best.w][best.i + 1]];
    const vertex = ends.find(p => haversineMeters(p.lat, p.lon, best.point.lat, best.point.lon) < 2);
    if (vertex) { stations.push({ ...base, attach: { method: 'projected', meters: Math.round(best.meters), key: vertex.key } }); continue; }
    const key = `st:${s.type}/${s.id}`;
    if (!inserts.has(best.w)) inserts.set(best.w, []);
    inserts.get(best.w).push({ i: best.i, t: best.t, key, lat: best.point.lat, lon: best.point.lon });
    stations.push({ ...base, attach: { method: 'projected', meters: Math.round(best.meters), key } });
  }
  for (const [w, list] of inserts) {
    list.sort((a, b) => b.i - a.i || b.t - a.t); // insert from the end so indices stay valid
    for (const ins of list) wayPoints[w].splice(ins.i + 1, 0, { key: ins.key, lat: ins.lat, lon: ins.lon });
  }

  // ---- graph: important points = way ends, points shared by several ways, station attachments ----
  const useCount = new Map();
  for (const pts of wayPoints) for (const p of pts) useCount.set(p.key, (useCount.get(p.key) ?? 0) + 1);
  const stationKeys = new Set(stations.map(s => s.attach.key));
  const nodeIndex = new Map();
  const nodes = [];
  const nodeOf = p => {
    let idx = nodeIndex.get(p.key);
    if (idx === undefined) { idx = nodes.length; nodeIndex.set(p.key, idx); nodes.push({ lat: p.lat, lon: p.lon }); }
    return idx;
  };
  const sampleBearing = (pts, from, step) => {
    // Bearing leaving pts[from] towards a point ~80 m along the track (smooths short mapping zig-zags).
    let j = from + step;
    let meters = 0;
    while (j >= 0 && j < pts.length) {
      meters = haversineMeters(pts[from].lat, pts[from].lon, pts[j].lat, pts[j].lon);
      if (meters >= BEARING_SAMPLE_METERS || j === 0 || j === pts.length - 1) break;
      j += step;
    }
    j = Math.max(0, Math.min(pts.length - 1, j));
    return bearing(pts[from], pts[j]);
  };
  const edges = [];
  wayPoints.forEach((pts, w) => {
    const tags = ways[w].tags;
    const cls = tags.usage === 'branch' ? 'branch' : tags.usage === 'main' ? 'main' : 'unknown';
    let start = 0;
    for (let i = 1; i < pts.length; i++) {
      const important = i === pts.length - 1 || useCount.get(pts[i].key) > 1 || stationKeys.has(pts[i].key);
      if (!important) continue;
      let meters = 0;
      for (let k = start + 1; k <= i; k++) meters += haversineMeters(pts[k - 1].lat, pts[k - 1].lon, pts[k].lat, pts[k].lon);
      if (meters > 0) {
        edges.push({
          a: nodeOf(pts[start]), b: nodeOf(pts[i]), km: Math.round(meters) / 1000, cls,
          bA: Math.round(sampleBearing(pts, start, 1)),  // bearing leaving node a along the edge
          bB: Math.round(sampleBearing(pts, i, -1)),     // bearing leaving node b back along the edge
          geom: pts.slice(start, i + 1).map(p => [Math.round(p.lat * 1e5) / 1e5, Math.round(p.lon * 1e5) / 1e5]),
          name: tags.name ?? null, way: ways[w].id
        });
      }
      start = i;
    }
  });
  for (const s of stations) s.node = nodeIndex.get(s.attach.key);

  // ---- connected components (by shared nodes only) ----
  const parent = nodes.map((_, i) => i);
  const find = x => { while (parent[x] !== x) { parent[x] = parent[parent[x]]; x = parent[x]; } return x; };
  for (const e of edges) { const ra = find(e.a), rb = find(e.b); if (ra !== rb) parent[ra] = rb; }
  const compKm = new Map();
  for (const e of edges) compKm.set(find(e.a), (compKm.get(find(e.a)) ?? 0) + e.km);
  const ranked = [...compKm.entries()].sort((a, b) => b[1] - a[1]);
  const compId = new Map(ranked.map(([root], i) => [root, i]));
  for (const s of stations) s.component = compId.get(find(s.node)) ?? null;
  const stationsPerComponent = new Map();
  for (const s of stations) stationsPerComponent.set(s.component, (stationsPerComponent.get(s.component) ?? 0) + 1);

  return {
    meta: {
      source: 'OpenStreetMap', attribution: raw.attribution ?? '© OpenStreetMap contributors', licence: raw.licence ?? 'ODbL 1.0',
      regions: raw.regions ?? [], osmBaseTimestamp: raw.osmBaseTimestamp ?? null, retrievedAt: raw.retrievedAt ?? null, builtAt: new Date().toISOString()
    },
    nodes,
    edges,
    stations: stations.map(({ attach, ...s }) => ({ ...s, attach: { method: attach.method, meters: attach.meters } })),
    report: {
      tracks: { usable: ways.length, excluded: excludedWays, km: Math.round(edges.reduce((sum, e) => sum + e.km, 0)) },
      stations: { attached: stations.length, onTrack: stations.filter(s => s.attach.method === 'on_track').length, unattached: unattached.length, excluded: excludedStations, withCode: stations.filter(s => s.code).length },
      unattachedStations: unattached.map(s => ({ name: s.name, code: s.code, osm: s.osm, nearestTrackMeters: s.nearestTrackMeters })),
      components: ranked.slice(0, 15).map(([root, km], i) => ({ id: i, km: Math.round(km), stations: stationsPerComponent.get(i) ?? 0 })),
      componentCount: ranked.length,
      diamondCrossings: diamonds.size
    }
  };
}

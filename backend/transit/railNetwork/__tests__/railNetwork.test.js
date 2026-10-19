// Estimated Rail Connection: graph building, true connectivity, station matching, turn-restricted routing, the duration
// model, and the explorer's guarantees (no clock times, no train identity, separate from scheduled planning).
// All OSM data here is SYNTHETIC and placed on a test grid; real-network validation is in ../README.md.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildRailGraph, usableTrack, usableStation } from '../buildRailGraph.js';
import { indexGraph, shortestRailPath, describePath } from '../railGraph.js';
import { estimateRailTime } from '../estimateRailTime.js';
import { estimateModel } from '../railNetworkConfig.js';
import { buildOverpassQuery } from '../overpassExtract.js';
import { handleRailExplorerRequest, railNetworkStatus, ESTIMATED_RAIL_LABEL, sharedShare } from '../railExplorer.js';

// Points along latitude 16.x at longitude 80.0 + i * 0.01 (≈ 1.07 km per step).
const P = (i, lat = 16.0) => ({ lat, lon: 80 + i * 0.01 });
let nextNode = 1000;
const way = (id, points, tags = {}, nodeIds = null) => {
  const nodes = nodeIds ?? points.map(() => nextNode++);
  return { type: 'way', id, nodes, geometry: points, tags: { railway: 'rail', usage: 'main', gauge: '1676', ...tags } };
};
const station = (id, name, point, tags = {}) => ({ type: 'node', id, lat: point.lat, lon: point.lon, tags: { railway: 'station', name, ...tags } });

// Network:
//   main line M: nodes 1..5 along lat 16.00 (lon 80.00 .. 80.40), stations ALPHA (near start) and DELTA (near end)
//   branch B joins M at node 3 heading north-east (a junction), with station BRAVO at its end
//   line N runs parallel 10 m away from M but shares NO node: CHARLIE on it is NOT connected
//   a siding off M and an industrial line are excluded; a metro station is excluded
function fixture() {
  nextNode = 1000;
  const m = way(1, [P(0), P(10), P(20), P(30), P(40)], {}, [1, 2, 3, 4, 5]);
  const b = way(2, [P(20), { lat: 16.05, lon: 80.25 }, { lat: 16.1, lon: 80.3 }], { usage: 'branch' }, [3, 21, 22]);
  const n = way(3, [{ lat: 16.0001, lon: 80.5 }, { lat: 16.0001, lon: 80.7 }], {}, [31, 32]);
  const siding = way(4, [P(10), { lat: 15.99, lon: 80.12 }], { service: 'siding' }, [2, 41]);
  const industrial = way(5, [P(40), { lat: 15.95, lon: 80.45 }], { usage: 'industrial' }, [5, 51]);
  return {
    osmBaseTimestamp: '2026-10-19T00:00:00Z', retrievedAt: '2026-10-19T00:00:00Z', regions: ['Test Region'],
    attribution: '© OpenStreetMap contributors', licence: 'ODbL 1.0',
    elements: [m, b, n, siding, industrial,
      station(101, 'Alpha Junction', { lat: 16.0008, lon: 80.002 }, { ref: 'ALF' }),       // ~90 m from M: projected
      station(102, 'Delta', { lat: 15.9995, lon: 80.39 }, { ref: 'DLT' }),
      station(103, 'Bravo', { lat: 16.1, lon: 80.3 }, { ref: 'BRV', railway: 'halt' }),
      station(104, 'Charlie', { lat: 16.0004, lon: 80.6 }, { ref: 'CHR' }),
      station(105, 'Far Away', { lat: 16.2, lon: 80.0 }, { ref: 'FAR' }),                   // > 500 m from any track
      station(106, 'Some Metro Station', { lat: 16.0, lon: 80.11 }, { station: 'subway' })
    ]
  };
}
const graphOf = raw => indexGraph(buildRailGraph(raw));
const byCode = (g, code) => g.stations.find(s => s.code === code);

describe('extract and filters', () => {
  test('the Overpass query fetches only operational railway=rail track, stations and diamond crossings', () => {
    const q = buildOverpassQuery(['Andhra Pradesh', 'Telangana']);
    assert.match(q, /way\["railway"="rail"\]/);
    assert.doesNotMatch(q, /abandoned|disused|proposed|construction/);
    assert.match(q, /area\["name"="Andhra Pradesh"\]\["admin_level"="4"\]/);
  });

  test('excluded infrastructure: sidings, spurs, industrial / military / freight, other gauges, metro stations', () => {
    assert.equal(usableTrack({ railway: 'rail', usage: 'main' }), true);
    for (const tags of [{ railway: 'rail', service: 'siding' }, { railway: 'rail', service: 'spur' }, { railway: 'rail', usage: 'industrial' }, { railway: 'rail', usage: 'freight' }, { railway: 'rail', usage: 'military' }, { railway: 'rail', gauge: '1000' }, { railway: 'abandoned' }, { railway: 'disused' }, { railway: 'proposed' }]) {
      assert.equal(usableTrack(tags), false, JSON.stringify(tags));
    }
    assert.equal(usableStation({ railway: 'station', name: 'X', station: 'subway' }), false);
    assert.equal(usableStation({ railway: 'station', name: 'Ameerpet Metro Station' }), false);
    assert.equal(usableStation({ railway: 'halt', name: 'Y' }), true);
  });
});

describe('graph: true connectivity only', () => {
  const g = graphOf(fixture());

  test('stations are attached by projection, with the distance recorded; far stations stay unattached', () => {
    const alpha = byCode(g, 'ALF');
    assert.equal(alpha.attach.method, 'projected');
    assert.ok(alpha.attach.meters > 50 && alpha.attach.meters < 150, String(alpha.attach.meters));
    assert.ok(!byCode(g, 'FAR'), 'not attached');
    assert.deepEqual(g.report.unattachedStations.map(s => s.code), ['FAR']);
    assert.ok(!g.stations.some(s => /Metro/.test(s.name)));
  });

  test('a junction connects (shared node); a parallel track 10 m away does not', () => {
    assert.equal(byCode(g, 'ALF').component, byCode(g, 'BRV').component);
    assert.notEqual(byCode(g, 'ALF').component, byCode(g, 'CHR').component);
  });

  test('excluded siding and industrial track are not in the graph', () => {
    assert.ok(!g.edges.some(e => e.way === 4 || e.way === 5));
  });

  test('a diamond crossing does not connect the crossing tracks', () => {
    const raw = fixture();
    // A north-south line crossing M at node 4 (tagged railway_crossing).
    raw.elements.push(way(6, [{ lat: 15.9, lon: 80.3 }, P(30), { lat: 16.1, lon: 80.31 }], {}, [61, 4, 62]));
    raw.elements.push(station(107, 'Echo', { lat: 16.1, lon: 80.31 }, { ref: 'ECH' }));
    raw.elements.push({ type: 'node', id: 4, lat: 16.0, lon: 80.3 }); // diamonds come back untagged (out skel)
    const crossed = graphOf(raw);
    assert.notEqual(byCode(crossed, 'ECH').component, byCode(crossed, 'DLT').component);
    const joined = graphOf({ ...raw, elements: raw.elements.filter(e => !(e.type === 'node' && e.id === 4 && !e.tags)) });
    assert.equal(byCode(joined, 'ECH').component, byCode(joined, 'DLT').component, 'without the crossing tag the shared node is a junction');
  });
});

describe('routing', () => {
  const g = graphOf(fixture());

  test('distance along mapped track', () => {
    const path = shortestRailPath(g, byCode(g, 'ALF').node, byCode(g, 'DLT').node);
    // 0.002° .. 0.39° of longitude at 16°N ≈ 0.388 * 106.95 km ≈ 41.5 km
    assert.ok(Math.abs(path.km - 41.5) < 0.6, String(path.km));
    assert.equal(path.reversals, 0);
  });

  test('disconnected stations have no path', () => {
    assert.equal(shortestRailPath(g, byCode(g, 'ALF').node, byCode(g, 'CHR').node), null);
  });

  test('a train cannot turn back through a junction without a station (no V-shaped paths)', () => {
    // From DELTA (east of the junction) to BRAVO (branch heading north-east) means arriving westbound at node 3 and
    // leaving north-east: a sharp turn back, impossible at a plain junction. The only runnable path continues west to
    // the ALPHA station, reverses there, and comes back onto the branch.
    const path = shortestRailPath(g, byCode(g, 'DLT').node, byCode(g, 'BRV').node);
    assert.equal(path.reversals, 1);
    assert.ok(path.km > 70, `not the ~25 km V-turn: ${path.km}`);
    // From ALPHA (west) the branch is a gentle diverge: allowed, no reversal.
    assert.equal(shortestRailPath(g, byCode(g, 'ALF').node, byCode(g, 'BRV').node).reversals, 0);
    // Without any station to reverse at, there is no path at all.
    const raw = fixture();
    const noAlpha = graphOf({ ...raw, elements: raw.elements.filter(e => e.id !== 101) });
    assert.equal(shortestRailPath(noAlpha, byCode(noAlpha, 'DLT').node, byCode(noAlpha, 'BRV').node), null);
  });

  test('turning back is allowed at a station, and is counted as a reversal', () => {
    const raw = fixture();
    raw.elements.push(station(108, 'Junction Halt', P(20), { ref: 'JNH' })); // a station AT the junction node
    const withStation = graphOf(raw);
    const path = shortestRailPath(withStation, byCode(withStation, 'DLT').node, byCode(withStation, 'BRV').node);
    assert.ok(path);
    assert.equal(path.reversals, 1);
  });

  test('stations passed are listed in order with their distance', () => {
    const raw = fixture();
    raw.elements.push(station(109, 'Middle', { lat: 16.0005, lon: 80.2 }, { ref: 'MID' }));
    const g2 = graphOf(raw);
    const d = describePath(g2, shortestRailPath(g2, byCode(g2, 'ALF').node, byCode(g2, 'DLT').node));
    assert.deepEqual(d.stations.map(s => s.code), ['ALF', 'MID', 'DLT']);
    assert.ok(d.stations[1].km > 20 && d.stations[1].km < 22);
  });
});

describe('estimated duration model', () => {
  const model = estimateModel({});
  test('reproducible and explainable: the same corridor always gives the same range', () => {
    const corridor = { km: 300, kmByClass: { main: 300, branch: 0, unknown: 0 }, intermediateStations: 40, reversals: 0 };
    const a = estimateRailTime(corridor, model);
    assert.deepEqual(a, estimateRailTime(corridor, model));
    // faster: 300/65 h = 276.9 min + 5 stops * 3 = 291.9 -> 290; slower: 300/45 h = 400 min + 40 * 1.5 = 460
    assert.deepEqual([a.minMinutes, a.maxMinutes], [290, 460]);
    assert.equal(a.breakdown.faster.stops, 5);
  });
  test('branch lines are slower and reversals add time', () => {
    const base = { km: 100, kmByClass: { main: 0, branch: 100, unknown: 0 }, intermediateStations: 10, reversals: 0 };
    const r = estimateRailTime({ ...base, reversals: 1 }, model);
    assert.equal(r.minMinutes - estimateRailTime(base, model).minMinutes, 20);
    assert.ok(estimateRailTime(base, model).minMinutes > estimateRailTime({ ...base, kmByClass: { main: 100, branch: 0, unknown: 0 } }, model).minMinutes);
  });
});

describe('explorer response', () => {
  const g = graphOf(fixture());
  const config = { enabled: true, refreshAfterDays: 180, model: estimateModel({}), graphPath: 'unused' };
  const ask = (from, to) => handleRailExplorerRequest({ fromLat: String(from.lat), fromLng: String(from.lon), toLat: String(to.lat), toLng: String(to.lon) }, { config, getGraph: () => g, now: new Date('2026-10-20T00:00:00Z') });

  test('a connection between real mapped stations, labelled as an estimate', () => {
    const { status, body } = ask({ lat: 16.003, lon: 80.0 }, { lat: 15.998, lon: 80.4 });
    assert.equal(status, 200);
    const [c] = body.connections;
    assert.equal(c.label, ESTIMATED_RAIL_LABEL);
    assert.equal(c.startStation.code, 'ALF');
    assert.equal(c.endStation.code, 'DLT');
    assert.equal(c.distanceKm, 42);
    assert.ok(c.estimatedDuration.minMinutes < c.estimatedDuration.maxMinutes);
    assert.match(body.network.attribution, /OpenStreetMap contributors/);
  });

  test('never a clock time, a train number, a fare or availability', () => {
    const { body } = ask({ lat: 16.003, lon: 80.0 }, { lat: 15.998, lon: 80.4 });
    const text = JSON.stringify(body.connections);
    assert.doesNotMatch(text, /"(departureTime|arrivalTime|trainNumber|trainName|serviceNumber|fare|price|seats?|live|platform)"/i);
    assert.doesNotMatch(text, /T\d{2}:\d{2}|\b\d{1,2}:\d{2}\b/, 'no clock times anywhere');
  });

  test('stations that are not connected by track give no connection, with the reason', () => {
    // Only CHARLIE (on the unconnected parallel line) is near this destination; DELTA is out of range.
    const { body } = ask({ lat: 16.003, lon: 80.0 }, { lat: 16.0, lon: 80.75 });
    assert.deepEqual(body.connections, []);
    assert.match(body.message, /not connected by mapped railway track/);
  });

  test('too-short trips, bad input and a missing network are handled plainly', () => {
    assert.match(ask({ lat: 16.0, lon: 80.0 }, { lat: 16.0, lon: 80.05 }).body.message, /too close/);
    assert.equal(handleRailExplorerRequest({ fromLat: 'x' }, { config, getGraph: () => g }).status, 400);
    const missing = handleRailExplorerRequest({}, { config, getGraph: () => null });
    assert.equal(missing.status, 503);
    assert.equal(railNetworkStatus({ config: { ...config, enabled: false }, getGraph: () => g }).available, false);
  });

  test('an alternative corridor must be genuinely different on the ground', () => {
    const line = [[16, 80], [16, 80.5]];
    assert.ok(sharedShare([[16.0001, 80], [16.0001, 80.5]], line) > 0.95, 'a parallel track is the same corridor');
    assert.ok(sharedShare([[16.3, 80], [16.3, 80.5]], line) < 0.05);
  });
});

describe('separation from scheduled planning', () => {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
  test('the journey planner and the scheduled rail source never use the estimated network', () => {
    for (const file of ['multimodal/planMultimodal.js', 'multimodal/compose.js', 'multimodal/shortlist.js', 'sources/rail/railSource.js', 'rail/railSearch.js']) {
      assert.doesNotMatch(fs.readFileSync(path.join(root, file), 'utf8'), /railNetwork\//, file);
    }
  });
});

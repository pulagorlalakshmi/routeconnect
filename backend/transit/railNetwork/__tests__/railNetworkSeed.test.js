// Deployment of the railway network on hosts with an ephemeral disk (Render free tier), and the independence of
// scheduled trains (RailRadar) from the Estimated Rail explorer. No network access: Overpass and RailRadar are faked.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { getRailNetworkConfig } from '../railNetworkConfig.js';
import { ensureRailNetwork, readRailNetworkSeed } from '../railNetworkData.js';
import { getRailStations } from '../railStations.js';
import { railNetworkStatus } from '../railExplorer.js';
import { createRailRadarClient } from '../../rail/verification/railRadar.js';
import { createRailRadarSource } from '../../sources/rail/railRadarSource.js';
import { getCapabilities } from '../../rail/railStatus.js';

const tinyGraph = {
  meta: { source: 'OpenStreetMap', attribution: '© OpenStreetMap contributors', licence: 'ODbL 1.0', regions: ['Test'], osmBaseTimestamp: '2026-10-19T06:48:20Z' },
  nodes: [{ lat: 16.518, lon: 80.618 }, { lat: 16.300, lon: 80.442 }],
  edges: [{ a: 0, b: 1, km: 30, cls: 'main', geom: [[16.518, 80.618], [16.300, 80.442]], name: null, way: 1 }],
  stations: [
    { code: 'TSA', name: 'Test Alpha Junction', kind: 'station', lat: 16.518, lon: 80.618, node: 0 },
    { code: 'TSB', name: 'Test Beta Junction', kind: 'station', lat: 16.300, lon: 80.442, node: 1 }
  ],
  report: {}
};

function tempConfig({ seed = tinyGraph, env = {} } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rc-railnet-'));
  const seedPath = path.join(dir, 'seed', 'rail-network.json.gz');
  if (seed) {
    fs.mkdirSync(path.dirname(seedPath), { recursive: true });
    fs.writeFileSync(seedPath, zlib.gzipSync(JSON.stringify(seed)));
  }
  return getRailNetworkConfig({ ROUTECONNECT_RAIL_NETWORK_DIR: path.join(dir, 'work'), ROUTECONNECT_RAIL_NETWORK_SEED_PATH: seedPath, ...env });
}
const noOverpass = async () => { throw new Error('Overpass must not be called'); };
const railRadarClient = () => createRailRadarClient({ env: { RAILRADAR_API_KEY: 'rr_test_key' }, fetchImpl: async () => { throw new Error('no requests in this test'); } });

describe('railway network seed', () => {
  test('an empty disk installs the shipped seed: no Overpass request, explorer ready', async () => {
    const config = tempConfig();
    const result = await ensureRailNetwork(config, { allowExtract: true, extract: noOverpass });
    assert.deepEqual([result.ready, result.seeded], [true, true]);
    assert.ok(fs.existsSync(config.graphPath));
    const status = railNetworkStatus({ config });
    assert.deepEqual([status.available, status.state, status.attribution], [true, 'ready', '© OpenStreetMap contributors']);
  });

  test('a saved raw extract is preferred over the seed (an operator refresh wins)', async () => {
    const config = tempConfig();
    fs.mkdirSync(config.dir, { recursive: true });
    fs.writeFileSync(config.rawPath, JSON.stringify({ elements: [], attribution: '© OpenStreetMap contributors' }));
    const result = await ensureRailNetwork(config, { allowExtract: true, extract: noOverpass });
    assert.equal(result.seeded, undefined);
    assert.equal(result.built, true);
  });

  test('without a seed the old behaviour remains: one extract, and a failure is reported, not retried', async () => {
    const config = tempConfig({ seed: null });
    let calls = 0;
    const result = await ensureRailNetwork(config, { allowExtract: true, extract: async () => { calls++; throw new Error('HTTP 429'); } });
    assert.deepEqual([result.ready, result.reason, calls], [false, 'error', 1]);
  });

  test('a corrupt seed fails plainly instead of installing garbage', async () => {
    const config = tempConfig({ seed: { not: 'a graph' } });
    const result = await ensureRailNetwork(config, { allowExtract: false, extract: noOverpass });
    assert.equal(result.ready, false);
    assert.match(result.error, /not a railway graph/);
    assert.ok(!fs.existsSync(config.graphPath));
  });

  test('the shipped seed is a valid ODbL-attributed graph covering the stations the planner anchors on', () => {
    const graph = readRailNetworkSeed(getRailNetworkConfig({}));
    assert.equal(graph.meta.attribution, '© OpenStreetMap contributors');
    assert.match(graph.meta.licence, /ODbL/);
    const codes = new Set(graph.stations.map(s => s.code));
    for (const code of ['BZA', 'GNT', 'TEL', 'VSKP', 'SC', 'NRT']) assert.ok(codes.has(code), code);
    assert.ok(!JSON.stringify(graph.meta).match(/trainNumber|departure|fare/i));
  });
});

describe('scheduled trains do not depend on the explorer', () => {
  test('station locations come from the seed when no graph has been built (explorer off or failed)', () => {
    const config = tempConfig({ env: { ROUTECONNECT_RAIL_NETWORK_ENABLED: 'false' } });
    const found = getRailStations(config);
    assert.match(found.from, /^seed/);
    // The seed's stations are kept (the nationwide station reference is merged in alongside them).
    for (const code of ['TSA', 'TSB']) assert.ok(found.byCode.has(code), code);
  });

  test('RailRadar is configured with seed stations although the graph is missing', () => {
    const config = tempConfig();
    const source = createRailRadarSource({ client: railRadarClient(), getGraph: () => getRailStations(config) });
    assert.equal(source.status({ crowFliesMeters: 1e6 }).configured, true);
  });

  test('capabilities: Train stays scheduled and available while the explorer reports failed', () => {
    const config = tempConfig();
    const source = createRailRadarSource({ client: railRadarClient(), getGraph: () => getRailStations(config) });
    const failed = () => ({ available: false, state: 'failed', reason: 'The railway network could not be prepared on the server.' });
    const caps = getCapabilities({ env: {}, railRadar: source, railNetwork: failed });
    assert.deepEqual([caps.modes.train.available, caps.modes.train.provider, caps.modes.train.reason], [true, 'railradar', null]);
    assert.deepEqual([caps.estimatedRail.available, caps.estimatedRail.state], [false, 'failed']);
  });

  test('no RailRadar key and no approved timetable: the reason names the missing train source, not the explorer', () => {
    const caps = getCapabilities({ env: {}, railRadar: null, railNetwork: () => ({ available: false, state: 'failed' }) });
    assert.equal(caps.modes.train.available, false);
    assert.match(caps.modes.train.reason, /RailRadar key/);
  });
});

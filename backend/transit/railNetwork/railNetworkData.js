// Preparing the railway network graph: shared by the CLI (rail:network:*) and server start-up.
//
//   graph present            -> ready, nothing to do
//   raw extract present      -> build the graph from it (offline, ~1 s)
//   seed present             -> install the versioned graph shipped with the code (offline, no Overpass)
//   neither                  -> ONE Overpass extract, then build (only when auto-extract is allowed)
// Never retried in a loop: a failure is reported through railNetworkStatus() until the next start or CLI run.
import fs from 'fs';
import path from 'path';
import zlib from 'zlib';
import { getRailNetworkConfig } from './railNetworkConfig.js';
import { extractRailways } from './overpassExtract.js';
import { buildRailGraph } from './buildRailGraph.js';
import { clearRailGraphCache } from './railExplorer.js';

let preparation = { state: 'idle', error: null, startedAt: null };

export function railNetworkPreparation() {
  return { ...preparation };
}

function writeGraphJson(config, json) {
  fs.mkdirSync(config.dir, { recursive: true });
  fs.writeFileSync(`${config.graphPath}.tmp`, json);
  fs.renameSync(`${config.graphPath}.tmp`, config.graphPath);
  clearRailGraphCache();
}

export function buildRailNetworkFromRaw(config = getRailNetworkConfig()) {
  const raw = JSON.parse(fs.readFileSync(config.rawPath, 'utf8'));
  const graph = buildRailGraph(raw);
  writeGraphJson(config, JSON.stringify(graph));
  return graph;
}

// The seed is the built graph itself, so installing it is a decompress + validate + write.
export function readRailNetworkSeed(config = getRailNetworkConfig()) {
  const graph = JSON.parse(zlib.gunzipSync(fs.readFileSync(config.seedPath)).toString('utf8'));
  if (!graph?.meta || !Array.isArray(graph.stations) || !Array.isArray(graph.nodes) || !Array.isArray(graph.edges)) {
    throw new Error('The railway network seed is not a railway graph.');
  }
  return graph;
}

export function installRailNetworkSeed(config = getRailNetworkConfig()) {
  const graph = readRailNetworkSeed(config);
  writeGraphJson(config, JSON.stringify(graph));
  return graph;
}

// npm run rail:network:seed: refresh the shipped seed from the current graph (after rail:network:update).
export function writeRailNetworkSeed(config = getRailNetworkConfig()) {
  const json = fs.readFileSync(config.graphPath);
  fs.mkdirSync(path.dirname(config.seedPath), { recursive: true });
  fs.writeFileSync(`${config.seedPath}.tmp`, zlib.gzipSync(json, { level: 9 }));
  fs.renameSync(`${config.seedPath}.tmp`, config.seedPath);
  return fs.statSync(config.seedPath).size;
}

export async function ensureRailNetwork(config = getRailNetworkConfig(), { allowExtract = config.autoExtract, extract = extractRailways } = {}) {
  if (!config.enabled) return { ready: false, reason: 'disabled' };
  if (fs.existsSync(config.graphPath)) return { ready: true, built: false };
  preparation = { state: 'preparing', error: null, startedAt: new Date().toISOString() };
  try {
    if (!fs.existsSync(config.rawPath) && config.seedPath && fs.existsSync(config.seedPath)) {
      const graph = installRailNetworkSeed(config);
      preparation = { state: 'idle', error: null, startedAt: null };
      return { ready: true, built: false, seeded: true, report: graph.report };
    }
    if (!fs.existsSync(config.rawPath)) {
      if (!allowExtract) {
        preparation = { state: 'missing', error: null, startedAt: null };
        return { ready: false, reason: 'missing' };
      }
      await extract(config);
    }
    const graph = buildRailNetworkFromRaw(config);
    preparation = { state: 'idle', error: null, startedAt: null };
    return { ready: true, built: true, report: graph.report };
  } catch (error) {
    preparation = { state: 'failed', error: error.message, startedAt: null };
    return { ready: false, reason: 'error', error: error.message };
  }
}

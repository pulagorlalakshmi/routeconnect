// Preparing the railway network graph: shared by the CLI (rail:network:*) and server start-up.
//
//   graph present            -> ready, nothing to do
//   raw extract present      -> build the graph from it (offline, ~1 s)
//   neither                  -> ONE Overpass extract, then build (only when auto-extract is allowed)
// Never retried in a loop: a failure is reported through railNetworkStatus() until the next start or CLI run.
import fs from 'fs';
import { getRailNetworkConfig } from './railNetworkConfig.js';
import { extractRailways } from './overpassExtract.js';
import { buildRailGraph } from './buildRailGraph.js';
import { clearRailGraphCache } from './railExplorer.js';

let preparation = { state: 'idle', error: null, startedAt: null };

export function railNetworkPreparation() {
  return { ...preparation };
}

export function buildRailNetworkFromRaw(config = getRailNetworkConfig()) {
  const raw = JSON.parse(fs.readFileSync(config.rawPath, 'utf8'));
  const graph = buildRailGraph(raw);
  fs.mkdirSync(config.dir, { recursive: true });
  fs.writeFileSync(`${config.graphPath}.tmp`, JSON.stringify(graph));
  fs.renameSync(`${config.graphPath}.tmp`, config.graphPath);
  clearRailGraphCache();
  return graph;
}

export async function ensureRailNetwork(config = getRailNetworkConfig(), { allowExtract = config.autoExtract, extract = extractRailways } = {}) {
  if (!config.enabled) return { ready: false, reason: 'disabled' };
  if (fs.existsSync(config.graphPath)) return { ready: true, built: false };
  preparation = { state: 'preparing', error: null, startedAt: new Date().toISOString() };
  try {
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

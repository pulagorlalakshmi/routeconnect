// Railway station locations (code, name, coordinates) for the scheduled-train source (RailRadar).
//
// Scheduled trains must not depend on the Estimated Rail explorer being ready: the explorer may be switched off,
// still preparing, or have failed to build, and RailRadar only needs to know where stations are. So stations come from
// the built graph when there is one, otherwise straight from the seed shipped with the code (ODbL, seed/README.md).
import { getRailNetworkConfig } from './railNetworkConfig.js';
import { getRailGraph } from './railExplorer.js';
import { readRailNetworkSeed } from './railNetworkData.js';

let seedCache = null; // { path, stations }

export function getRailStations(config = getRailNetworkConfig()) {
  let graph = null;
  try { graph = getRailGraph(config); } catch { graph = null; }
  if (graph?.stations?.length) return { stations: graph.stations, from: 'graph' };
  if (!config.seedPath) return null;
  if (seedCache?.path !== config.seedPath) {
    try {
      seedCache = { path: config.seedPath, stations: readRailNetworkSeed(config).stations };
    } catch {
      return null;
    }
  }
  return { stations: seedCache.stations, from: 'seed' };
}

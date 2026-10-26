// Mapped railway infrastructure (OpenStreetMap, ODbL) for Estimated Rail Connections.
//
//   npm run rail:network:extract   ONE Overpass request for the configured regions (default: Andhra Pradesh, Telangana)
//   npm run rail:network:build     raw extract -> routable graph (rail-network.json); no network access
//   npm run rail:network:update    extract + build (run every few months; infrastructure changes slowly)
//   npm run rail:network:ensure    deploy builds: build if missing; install the shipped seed, or extract only if neither exists
//   npm run rail:network:seed      write the current graph to the shipped seed (commit it after a rail:network:update)
//   npm run rail:network:status    coverage, components, attribution
//   npm run rail:network:route -- --from-lat 16.50 --from-lon 80.65 --to-lat 17.39 --to-lon 78.47
import '../../env.js';
import fs from 'fs';
import { parseArgs } from './common.js';
import { getRailNetworkConfig } from '../railNetwork/railNetworkConfig.js';
import { extractRailways } from '../railNetwork/overpassExtract.js';
import { handleRailExplorerRequest, railNetworkStatus } from '../railNetwork/railExplorer.js';
import { buildRailNetworkFromRaw, ensureRailNetwork, writeRailNetworkSeed } from '../railNetwork/railNetworkData.js';

const command = process.argv[2];
const args = parseArgs(process.argv.slice(3));
const config = getRailNetworkConfig();

function build() {
  const graph = buildRailNetworkFromRaw(config);
  const r = graph.report;
  console.log(`Built: ${r.tracks.km} km of usable track (${r.tracks.usable} ways; ${r.tracks.excluded} excluded), ${r.stations.attached} stations attached, ${r.stations.unattached} unattached, ${r.componentCount} connected components (largest ${r.components[0]?.km ?? 0} km).`);
}

async function main() {
  if (command === 'extract' || command === 'update') {
    const result = await extractRailways(config);
    console.log(`Extracted ${result.elements} OSM elements (data as of ${result.osmBaseTimestamp}). Data © OpenStreetMap contributors, ODbL.`);
    if (command === 'extract') return;
  }
  if (command === 'build' || command === 'update') return build();
  if (command === 'ensure') {
    const result = await ensureRailNetwork(config, { allowExtract: true });
    console.log(result.ready ? `Railway network ready${result.built ? ' (built now)' : result.seeded ? ' (installed from the shipped seed)' : ''}.` : `Railway network not prepared: ${result.reason}${result.error ? ` (${result.error})` : ''}.`);
    if (!result.ready && result.reason === 'error') process.exitCode = 1;
    return;
  }
  if (command === 'seed') {
    const bytes = writeRailNetworkSeed(config);
    console.log(`Seed written: ${config.seedPath} (${Math.round(bytes / 1024)} KB). Data © OpenStreetMap contributors, ODbL.`);
    return;
  }
  if (command === 'status') {
    const status = railNetworkStatus({ config });
    const graph = status.available ? JSON.parse(fs.readFileSync(config.graphPath, 'utf8')) : null;
    console.log(JSON.stringify({ ...status, report: graph ? { ...graph.report, unattachedStations: graph.report.unattachedStations.length } : null }, null, 2));
    return;
  }
  if (command === 'route') {
    const { status, body } = handleRailExplorerRequest({ fromLat: String(args['from-lat']), fromLng: String(args['from-lon']), toLat: String(args['to-lat']), toLng: String(args['to-lon']) }, { config });
    console.log(status, JSON.stringify({ ...body, connections: (body.connections ?? []).map(({ geometry, intermediateStations, ...c }) => ({ ...c, geometryPoints: geometry.length, intermediateStations: intermediateStations.map(s => s.code ?? s.name) })) }, null, 2));
    return;
  }
  console.log('Usage: node backend/transit/cli/railNetwork.js <extract|build|update|ensure|seed|status|route>');
  process.exitCode = 1;
}

main().catch(error => {
  console.error(error.message);
  process.exitCode = 1;
});

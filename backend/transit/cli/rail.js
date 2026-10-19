// Railway timetable commands.
//
//   npm run rail:download                 download the configured rail feed (ROUTECONNECT_RAIL_GTFS_URL)
//   npm run rail:import                   validate + import it into rail.db (replaces the previous snapshot of that source)
//   npm run rail:update                   download a fresh copy, then import it
//   npm run rail:ensure                   (deploy builds) import once if ROUTECONNECT_RAIL_ENABLED=true and rail.db is missing
//   npm run rail:status                   provenance, freshness, coverage and import issues
//   npm run rail:search -- --from BZA --to GNT --date 2026-10-20 --time 06:00 [--window 360]
//                                         search between two station codes (or --from-lat/--from-lon/--to-lat/--to-lon)
import '../../env.js';
import { parseArgs } from './common.js';
import { getRailConfig } from '../rail/railConfig.js';
import { downloadRailFeed, importRailFeed, ensureRailData } from '../rail/railData.js';
import { getRailNetwork, railFreshness } from '../rail/railNetwork.js';
import { searchRail, toTrunk } from '../rail/railSearch.js';
import { isoToDayNumber, parseClockTime } from '../routing/serviceCalendar.js';

const command = process.argv[2];
const args = parseArgs(process.argv.slice(3));
const config = getRailConfig();

async function main() {
  if (command === 'download' || command === 'update') {
    const result = await downloadRailFeed(config, { force: command === 'update' || args.force === true });
    console.log(result.downloaded ? `Downloaded ${result.meta.bytes} bytes (sha256 ${result.meta.sha256}).` : `Archive already present at ${result.path} (use rail:update to refresh).`);
    if (command === 'download') return;
  }
  if (command === 'import' || command === 'update') {
    const result = importRailFeed(config);
    console.log(`Imported ${result.stats.trains} trains, ${result.stats.stations} stations, ${result.stats.stops} stops; calendars ${result.validFrom} .. ${result.validTo}.`);
    console.log('Issues:', result.stats.issueCounts);
    return;
  }
  if (command === 'ensure') {
    const result = await ensureRailData(config);
    console.log(result.ready ? `Rail timetable ready${result.imported ? ' (imported now)' : ''}.` : `Rail timetable not prepared: ${result.reason}${result.error ? ` (${result.error})` : ''}.`);
    return;
  }
  if (command === 'status') {
    const network = getRailNetwork({ config, force: true });
    if (!network) return console.log('No rail timetable imported. Run "npm run rail:download && npm run rail:import".');
    const { stats, ...dataset } = network.dataset;
    console.log(JSON.stringify({ enabled: config.enabled, dataset, stats, freshness: railFreshness(network.dataset, config.freshness), loadTimeMs: network.loadTimeMs }, null, 2));
    return;
  }
  if (command === 'search') {
    const network = getRailNetwork({ config });
    if (!network) throw new Error('No rail timetable imported.');
    const point = (code, lat, lon) => {
      if (code) {
        const s = network.stations[network.stationIndex.get(String(code).toUpperCase().split(',')[0])];
        if (!s) throw new Error(`Unknown station code ${code}`);
        return { lat: s.lat, lon: s.lon };
      }
      return { lat: Number(lat), lon: Number(lon) };
    };
    const date = args.date;
    const start = parseClockTime(args.time ?? '00:00');
    const window = Number(args.window ?? 360) * 60;
    const result = searchRail(network, {
      origin: point(args.from, args['from-lat'], args['from-lon']),
      destination: point(args.to, args['to-lat'], args['to-lon']),
      date, windowStartSeconds: start, windowEndSeconds: start + window
    }, { maxTransfers: args.direct ? 0 : 1, pareto: !args.all, maxResults: Number(args.max ?? 10), ...(args.from ? { originStationCodes: String(args.from).toUpperCase().split(','), destinationStationCodes: String(args.to).toUpperCase().split(',') } : {}) });
    const searchDay = isoToDayNumber(date);
    console.log(`origin stations: ${result.originStations.map(o => network.stations[o.s].code).join(', ')} | destination stations: ${result.destinationStations.map(d => network.stations[d.s].code).join(', ')}`);
    for (const journey of result.journeys) {
      console.log(`- ${journey.transfers === 0 ? 'direct' : `${journey.transfers} change`}`);
      for (const leg of journey.legs) {
        const t = toTrunk(network, leg, { searchDay, utcOffset: '+05:30', scheduleConfidence: 'published', source: null });
        const e = t.evidence;
        console.log(`    ${t.trainNumber} ${t.trainName}  ${e.fromCode} ${t.departureTime.slice(0, 16)} -> ${e.toCode} ${t.arrivalTime.slice(0, 16)}  (stops ${e.boardStopNumber}->${e.alightStopNumber}/${e.totalStops}, run starts ${e.runStartDate} ${e.runStartWeekday}, runs ${e.originRunningDays?.join(',')} from origin; at boarding ${t.daysOfOperation?.join(',')})`);
      }
    }
    console.log('stats', result.stats);
    return;
  }
  console.log('Usage: node backend/transit/cli/rail.js <download|import|update|status|search> [options]');
  process.exitCode = 1;
}

main().catch(error => {
  console.error(error.message);
  process.exitCode = 1;
});

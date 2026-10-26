// Nationwide railway station and place reference (OpenStreetMap, ODbL) - see railNetwork/stationReference.js.
//
//   npm run rail:stations:update   ONE Overpass extract for India (stations, halts, cities, towns) -> the shipped seed
//                                  railNetwork/seed/india-stations.json.gz (commit it). Run rarely: a few times a year.
//   npm run rail:stations:status   what the shipped seed holds (counts, snapshot date, attribution)
import '../../env.js';
import { extractStationReference, getStationIndex, STATION_SEED_PATH, writeStationSeed } from '../railNetwork/stationReference.js';

const command = process.argv[2];

async function main() {
  if (command === 'update') {
    const reference = await extractStationReference({ overpassUrl: process.env.ROUTECONNECT_OVERPASS_URL || undefined });
    const bytes = writeStationSeed(reference);
    console.log(`Seed written: ${STATION_SEED_PATH} (${Math.round(bytes / 1024)} KB): ${reference.meta.stations} stations, ${reference.meta.places} places, OSM data as of ${reference.meta.osmBaseTimestamp}. Data © OpenStreetMap contributors, ODbL.`);
    return;
  }
  if (command === 'status') {
    const index = getStationIndex();
    if (!index) { console.log('No station reference seed found.'); process.exitCode = 1; return; }
    console.log(JSON.stringify({ ...index.meta, servingCity: index.stations.filter(s => s.serves === 'city').length, servingTown: index.stations.filter(s => s.serves === 'town').length }, null, 2));
    return;
  }
  console.log('Usage: node backend/transit/cli/stations.js <update|status>');
  process.exitCode = 1;
}

main().catch(error => {
  console.error(error.message);
  process.exitCode = 1;
});

// One regional extract of mapped railway infrastructure from the OpenStreetMap Overpass API.
//
// Run rarely (rail:network:extract), never per user search: Overpass is a shared public service (fair use is roughly
// <10,000 requests and <1 GB per day). The result is stored on disk and turned into a graph by buildRailGraph.js.
// Data © OpenStreetMap contributors, available under the Open Database License (ODbL).
import fs from 'fs';
import path from 'path';

const USER_AGENT = 'RouteConnect-estimated-rail/1.0 (regional railway infrastructure extract; runs rarely)';

export function buildOverpassQuery(regions) {
  const areas = regions.map(name => `area["name"="${name.replace(/"/g, '')}"]["admin_level"="4"];`).join('');
  // Only operational railway=rail track: abandoned / disused / proposed / construction use other railway=* values and
  // are therefore never fetched. Metro / light rail use railway=subway|light_rail and are excluded too.
  return `[out:json][timeout:300][maxsize:536870912];
(${areas})->.region;
way["railway"="rail"](area.region)->.tracks;
node["railway"="railway_crossing"](area.region)->.diamonds;
nwr["railway"~"^(station|halt)$"](area.region)->.stations;
.tracks out body geom;
.diamonds out skel;
.stations out center tags;`;
}

export async function extractRailways(config, { fetchImpl = fetch, now = new Date() } = {}) {
  const query = buildOverpassQuery(config.regions);
  const response = await fetchImpl(config.overpassUrl, {
    method: 'POST',
    headers: { 'User-Agent': USER_AGENT, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: `data=${encodeURIComponent(query)}`,
    signal: AbortSignal.timeout(330000)
  });
  if (response.status === 429) throw new Error('Overpass is rate-limiting this address (HTTP 429). Try again later; do not loop.');
  if (!response.ok) throw new Error(`Overpass request failed: HTTP ${response.status}`);
  const body = await response.json();
  const raw = {
    source: 'OpenStreetMap via Overpass API',
    licence: 'ODbL 1.0 (https://opendatacommons.org/licenses/odbl/1-0/)',
    attribution: '© OpenStreetMap contributors',
    overpassUrl: config.overpassUrl,
    regions: config.regions,
    osmBaseTimestamp: body.osm3s?.timestamp_osm_base ?? null,
    retrievedAt: now.toISOString(),
    query,
    elements: body.elements ?? []
  };
  fs.mkdirSync(path.dirname(config.rawPath), { recursive: true });
  fs.writeFileSync(`${config.rawPath}.tmp`, JSON.stringify(raw));
  fs.renameSync(`${config.rawPath}.tmp`, config.rawPath);
  return { elements: raw.elements.length, osmBaseTimestamp: raw.osmBaseTimestamp };
}

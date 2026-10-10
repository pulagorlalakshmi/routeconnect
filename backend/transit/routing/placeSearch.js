// Place search over the GTFS stops: powers autocomplete and name -> coordinate resolution for /api/v2/plan.
//
// Only places that actually appear in the timetable are offered, so every suggestion is routable. Nothing is
// invented: if a name is not a stop in the imported dataset it is reported as not found.
//
// Stops with the same (normalised) name are merged into one "place" when they are within CLUSTER_RADIUS_METERS
// of each other, so "Vijayawada" is one suggestion while two unrelated villages with the same name stay apart.
import { haversineMeters } from './geo.js';

const CLUSTER_RADIUS_METERS = 4000;
const MAX_QUERY_LENGTH = 80;
const GENERIC_WORDS = /\b(bus station|bus stand|bus stop|bus complex|bus terminal|railway station|railway|station|junction|depot)\b/g;

export function normalizePlaceName(text) {
  const base = String(text ?? '').toLowerCase().replace(/[^a-z0-9\s]/g, ' ').replace(/\s+/g, ' ').trim();
  const stripped = base.replace(GENERIC_WORDS, ' ').replace(/\s+/g, ' ').trim();
  return stripped || base; // a name made only of generic words keeps its original form
}

function titleCase(text) {
  return String(text).toLowerCase().replace(/(^|[\s\-/(])([a-z])/g, (_, lead, letter) => lead + letter.toUpperCase());
}

const indexCache = new WeakMap();

function buildIndex(network) {
  const served = s => network.stopPatternOffsets[s + 1] - network.stopPatternOffsets[s];
  const byName = new Map();
  for (let s = 0; s < network.stopCount; s++) {
    if (served(s) === 0) continue; // unserved stops cannot start or end a journey
    const key = normalizePlaceName(network.stopNames[s]);
    if (!key) continue;
    if (!byName.has(key)) byName.set(key, []);
    byName.get(key).push(s);
  }

  const places = [];
  for (const [key, stops] of byName) {
    stops.sort((a, b) => served(b) - served(a) || a - b);
    const clusters = [];
    for (const stop of stops) {
      const home = clusters.find(cluster =>
        haversineMeters(network.stopLat[cluster.seed], network.stopLon[cluster.seed], network.stopLat[stop], network.stopLon[stop]) <= CLUSTER_RADIUS_METERS);
      if (home) home.stops.push(stop);
      else clusters.push({ seed: stop, stops: [stop] });
    }
    for (const cluster of clusters) {
      let weight = 0;
      let lat = 0;
      let lon = 0;
      for (const stop of cluster.stops) {
        const w = served(stop);
        weight += w;
        lat += network.stopLat[stop] * w;
        lon += network.stopLon[stop] * w;
      }
      places.push({
        id: `place:${network.stopSourceIds[cluster.seed]}`,
        name: titleCase(network.stopNames[cluster.seed]),
        key,
        words: key.split(' '),
        lat: lat / weight,
        lon: lon / weight,
        stopCount: cluster.stops.length,
        services: weight
      });
    }
  }
  return places;
}

function indexFor(network) {
  let index = indexCache.get(network);
  if (!index) indexCache.set(network, (index = buildIndex(network)));
  return index;
}

const RANK_NAMES = ['exact', 'prefix', 'word-prefix', 'contains'];

function matchRank(place, query, tokens) {
  if (place.key === query) return 0;
  if (place.key.startsWith(query)) return 1;
  if (tokens.every(token => place.words.some(word => word.startsWith(token)))) return 2;
  if (query.length >= 3 && place.key.includes(query)) return 3;
  return -1;
}

// Returns up to `limit` places, best match first (match quality, then number of services, then name).
export function searchPlaces(network, text, { limit = 8 } = {}) {
  const query = normalizePlaceName(String(text ?? '').slice(0, MAX_QUERY_LENGTH));
  if (query.length < 1) return [];
  const tokens = query.split(' ');
  const matches = [];
  for (const place of indexFor(network)) {
    const rank = matchRank(place, query, tokens);
    if (rank >= 0) matches.push({ place, rank });
  }
  matches.sort((a, b) => a.rank - b.rank || b.place.services - a.place.services || (a.place.name < b.place.name ? -1 : a.place.name > b.place.name ? 1 : 0));
  return matches.slice(0, limit).map(({ place, rank }) => ({
    id: place.id,
    name: place.name,
    lat: Math.round(place.lat * 1e5) / 1e5,
    lon: Math.round(place.lon * 1e5) / 1e5,
    stopCount: place.stopCount,
    services: place.services,
    matchedBy: RANK_NAMES[rank]
  }));
}

// Best place for a typed name, or null.
export function resolvePlace(network, text) {
  return searchPlaces(network, text, { limit: 1 })[0] ?? null;
}

// HTTP-facing wrapper for GET /api/v2/places?query=&limit=
export function handlePlaceSearch(rawQuery, getNetwork) {
  const query = rawQuery?.query;
  const limitText = rawQuery?.limit;
  if (Array.isArray(query) || Array.isArray(limitText)) return { status: 400, body: { error: 'Parameters must be provided once.' } };
  if (typeof query !== 'string' || query.trim().length < 1 || query.length > MAX_QUERY_LENGTH) {
    return { status: 400, body: { error: `query is required (1-${MAX_QUERY_LENGTH} characters).` } };
  }
  let limit = 8;
  if (limitText !== undefined && limitText !== '') {
    if (!/^\d+$/.test(String(limitText)) || Number(limitText) < 1 || Number(limitText) > 20) {
      return { status: 400, body: { error: 'limit must be an integer between 1 and 20.' } };
    }
    limit = Number(limitText);
  }

  let network;
  try {
    network = getNetwork();
  } catch (error) {
    console.error('Transit network load failed:', error.message);
    return { status: 500, body: { error: 'The transit network could not be loaded.' } };
  }
  if (!network) {
    console.warn('[Transit Diagnostics] Place search requested but transit network is not available in memory. Import a GTFS feed with "npm run transit:ensure" or "npm run transit:import".');
    return { status: 503, body: { error: 'Transit data is not available. Import a GTFS feed first.' } };
  }
  return { status: 200, body: { query: query.trim(), places: searchPlaces(network, query, { limit }) } };
}

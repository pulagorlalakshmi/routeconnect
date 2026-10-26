// Typed place names outside the bus timetable: Indian cities and towns, and railway stations by name, alias or official
// code ("Mumbai", "Bangalore", "MAS"), from the nationwide station reference (OpenStreetMap, ODbL; stationReference.js).
//
// The bus timetable (GTFS stops, placeSearch.js) stays first: its places are routable by bus. These names only give
// coordinates - a city name says nothing about which buses or trains serve it. Only whole-word matches are used
// (exact, prefix, word prefix): "Patna" never matches "Visakhapatnam".
import { getStationIndex } from '../railNetwork/stationReference.js';
import { normalizePlaceName } from './placeSearch.js';

const RANK_NAMES = ['exact', 'prefix', 'word-prefix'];
const KIND_ORDER = { city: 0, town: 1, station: 2 };
const cache = new WeakMap();

function entriesFor(index) {
  let entries = cache.get(index);
  if (entries) return entries;
  entries = [];
  const add = (names, base) => {
    for (const name of new Set(names.filter(Boolean))) {
      const key = normalizePlaceName(name);
      if (key) entries.push({ ...base, key, words: key.split(' ') });
    }
  };
  for (const p of index.places) {
    add([p.name, ...p.aliases], { kind: p.type === 'city' ? 'city' : 'town', name: p.name, lat: p.lat, lon: p.lon, code: null, population: p.population ?? 0 });
  }
  for (const s of index.stations) {
    add([s.name, ...s.aliases], { kind: 'station', name: s.name, lat: s.lat, lon: s.lon, code: s.code, population: 0 });
  }
  cache.set(index, entries);
  return entries;
}

function rankOf(entry, query, tokens) {
  if (entry.key === query) return 0;
  if (entry.key.startsWith(query)) return 1;
  if (tokens.every(token => entry.words.some(word => word.startsWith(token)))) return 2;
  return -1;
}

/** Cities, towns and stations matching `text`, best first: [{ id, name, kind, code, lat, lon, matchedBy, source }] */
export function searchNationalPlaces(text, { limit = 8, index = getStationIndex() } = {}) {
  if (!index) return [];
  const raw = String(text ?? '').trim().slice(0, 80);
  const query = normalizePlaceName(raw);
  if (!query) return [];
  const tokens = query.split(' ');
  const hits = [];
  // An official station code typed as such ("MAS", "NDLS") is an exact station match.
  // Only when typed in capitals: "Goa" is a place name, "GOA" is the station code.
  const asCode = /^[A-Z]{2,5}$/.test(raw) ? index.byCode.get(raw) : null;
  if (asCode) hits.push({ entry: { kind: 'station', name: asCode.name, lat: asCode.lat, lon: asCode.lon, code: asCode.code, population: 0 }, rank: 0, code: true });
  for (const entry of entriesFor(index)) {
    const rank = rankOf(entry, query, tokens);
    if (rank >= 0) hits.push({ entry, rank });
  }
  hits.sort((a, b) => a.rank - b.rank || Number(b.code ?? false) - Number(a.code ?? false) || KIND_ORDER[a.entry.kind] - KIND_ORDER[b.entry.kind]
    || (b.entry.population ?? 0) - (a.entry.population ?? 0) || a.entry.name.localeCompare(b.entry.name));
  const seen = new Set();
  const out = [];
  for (const { entry, rank } of hits) {
    const id = entry.code ? `station:${entry.code}` : `${entry.kind}:${entry.name}@${entry.lat.toFixed(3)},${entry.lon.toFixed(3)}`;
    if (seen.has(id)) continue;
    seen.add(id);
    out.push({
      id,
      name: entry.code ? `${entry.name} (${entry.code})` : entry.name,
      kind: entry.kind,
      code: entry.code,
      lat: entry.lat,
      lon: entry.lon,
      matchedBy: RANK_NAMES[rank],
      source: 'openstreetmap'
    });
    if (out.length >= limit) break;
  }
  return out;
}

// The place a journey is planned from: an exact name, alias or code; a prefix only for names of 5+ letters ("Visakha" ->
// Visakhapatnam), never for short ones ("Goa" must not become Goalpara). Autocomplete shows the wider list instead.
export function resolveNationalPlace(text, options) {
  const best = searchNationalPlaces(text, { ...options, limit: 1 })[0] ?? null;
  if (!best) return null;
  return best.matchedBy === 'exact' || normalizePlaceName(text).length >= 5 ? best : null;
}

// Nationwide railway STATION reference (India): where stations are, their official codes and names, and towns/cities
// for resolving typed place names. Station EXISTENCE only - this says nothing about which trains run (that comes
// from the timetable provider, RailRadar, per station pair and date).
//
// Source: OpenStreetMap (ODbL 1.0, "© OpenStreetMap contributors"), ONE Overpass extract for the whole country,
// refreshed rarely (npm run rail:stations:update) and shipped as seed/india-stations.json.gz, so no host downloads
// anything at start-up. Kept per station: code (ref / railway:ref), name and aliases, kind (station | halt), coordinates,
// and two explainable size signals: an official name marking a junction / terminus / central station, and whether the
// station has a Wikidata entry (major stations do; most wayside halts do not). Metro / light-rail stations are excluded.
import fs from 'fs';
import path from 'path';
import zlib from 'zlib';
import { haversineMeters } from '../routing/geo.js';
import { TRANSIT_ROOT } from '../config.js';

export const STATION_SEED_PATH = path.join(TRANSIT_ROOT, 'railNetwork', 'seed', 'india-stations.json.gz');
const USER_AGENT = 'RouteConnect-station-reference/1.0 (one nationwide station extract; runs rarely)';
const CODE = /^[A-Z]{1,5}$/;
const ALIAS_TAGS = ['name:en', 'official_name', 'alt_name', 'old_name', 'short_name', 'loc_name', 'official_name:en', 'alt_name:en'];

export function buildStationQuery() {
  return `[out:json][timeout:600][maxsize:536870912];
area["ISO3166-1"="IN"]["admin_level"="2"]->.in;
nwr["railway"~"^(station|halt)$"](area.in)->.stations;
node["place"~"^(city|town)$"](area.in)->.places;
.stations out center tags;
.places out body;`;
}

const isMetro = tags => /^(subway|metro|light_rail|monorail|funicular|tram)$/i.test(tags.station ?? '')
  || tags.subway === 'yes' || tags.light_rail === 'yes' || tags.monorail === 'yes'
  || /\bmetro\b/i.test(tags.name ?? '') || /metro|mrts?\b|monorail/i.test(tags.network ?? '');

const splitNames = value => String(value ?? '').split(';').map(s => s.trim()).filter(Boolean);
export const TERMINAL_NAME = /\b(junction|jn|terminus|terminal|central|cantt?|cantonment)\b/i;

/** Raw Overpass elements -> the compact reference (deterministic order, nothing but what the data says). */
export function buildStationReference(raw, { retrievedAt = raw.retrievedAt ?? null } = {}) {
  const byCode = new Map();
  const places = [];
  for (const el of raw.elements ?? []) {
    const tags = el.tags ?? {};
    const lat = el.lat ?? el.center?.lat;
    const lon = el.lon ?? el.center?.lon;
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) continue;
    if (tags.place) {
      if (!tags.name) continue;
      places.push({ n: tags['name:en'] || tags.name, a: [...new Set([tags.name, ...splitNames(tags['alt_name']), ...splitNames(tags['old_name'])].filter(x => x && x !== (tags['name:en'] || tags.name)))], t: tags.place, la: round(lat), lo: round(lon), p: Number(tags.population) || null });
      continue;
    }
    if (!/^(station|halt)$/.test(tags.railway ?? '') || isMetro(tags) || !tags.name) continue;
    const code = String(tags['railway:ref'] ?? tags.ref ?? '').trim().toUpperCase();
    if (!CODE.test(code)) continue;
    const name = tags['name:en'] || tags.name;
    const entry = {
      c: code, n: name,
      a: [...new Set(ALIAS_TAGS.flatMap(t => splitNames(tags[t])).concat(tags.name).filter(x => x && x !== name))],
      k: tags.railway, la: round(lat), lo: round(lon),
      w: tags.wikidata || tags.wikipedia ? 1 : 0
    };
    // One entry per code: a node and a station area for the same station collapse; the better-described one wins.
    const prev = byCode.get(code);
    if (!prev || (entry.w > prev.w) || (entry.k === 'station' && prev.k === 'halt')) byCode.set(code, entry);
  }
  const stations = [...byCode.values()].sort((a, b) => a.c.localeCompare(b.c));
  places.sort((a, b) => a.n.localeCompare(b.n) || a.la - b.la);
  return {
    meta: {
      source: 'OpenStreetMap via Overpass API', licence: 'ODbL 1.0 (https://opendatacommons.org/licenses/odbl/1-0/)',
      attribution: '© OpenStreetMap contributors', country: 'IN', osmBaseTimestamp: raw.osmBaseTimestamp ?? null, retrievedAt,
      stations: stations.length, places: places.length
    },
    stations, places
  };
}
const round = x => Math.round(x * 1e5) / 1e5;

export async function extractStationReference({ overpassUrl = 'https://overpass-api.de/api/interpreter', fetchImpl = fetch, now = new Date() } = {}) {
  const response = await fetchImpl(overpassUrl, {
    method: 'POST',
    headers: { 'User-Agent': USER_AGENT, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: `data=${encodeURIComponent(buildStationQuery())}`,
    signal: AbortSignal.timeout(650000)
  });
  if (response.status === 429) throw new Error('Overpass is rate-limiting this address (HTTP 429). Try again later; do not loop.');
  if (!response.ok) throw new Error(`Overpass request failed: HTTP ${response.status}`);
  const body = await response.json();
  return buildStationReference({ elements: body.elements ?? [], osmBaseTimestamp: body.osm3s?.timestamp_osm_base ?? null }, { retrievedAt: now.toISOString() });
}

export function writeStationSeed(reference, seedPath = STATION_SEED_PATH) {
  fs.mkdirSync(path.dirname(seedPath), { recursive: true });
  fs.writeFileSync(`${seedPath}.tmp`, zlib.gzipSync(JSON.stringify(reference), { level: 9 }));
  fs.renameSync(`${seedPath}.tmp`, seedPath);
  return fs.statSync(seedPath).size;
}

// ---------- the loaded reference: spatial grid + name index ----------
const CELL = 0.25; // degrees (~28 km): a radius query touches only a few cells

/** Grid index over stations ({ code, lat, lon }): nearby(lat, lon, radiusMeters) -> [{ station, meters }], nearest first. */
export function createSpatialIndex(stations) {
  const grid = new Map();
  const cellKey = (lat, lon) => `${Math.floor(lat / CELL)}|${Math.floor(lon / CELL)}`;
  for (const s of stations) {
    const key = cellKey(s.lat, s.lon);
    let list = grid.get(key);
    if (!list) grid.set(key, (list = []));
    list.push(s);
  }
  // Visits only the grid cells the radius can touch, never every station in the country.
  function nearby(lat, lon, radiusMeters) {
    const span = Math.ceil(radiusMeters / (CELL * 105000)) + 1;
    const gy = Math.floor(lat / CELL);
    const gx = Math.floor(lon / CELL);
    const out = [];
    for (let dy = -span; dy <= span; dy++) for (let dx = -span; dx <= span; dx++) {
      for (const s of grid.get(`${gy + dy}|${gx + dx}`) ?? []) {
        const meters = haversineMeters(lat, lon, s.lat, s.lon);
        if (meters <= radiusMeters) out.push({ station: s, meters });
      }
    }
    return out.sort((a, b) => a.meters - b.meters || a.station.code.localeCompare(b.station.code));
  }
  return { nearby };
}

// The first significant word of a name ("Nagpur Junction" -> "nagpur", "Pt. Deen Dayal..." -> "deen").
const firstWord = name => String(name ?? '').toLowerCase().replace(/\(.*?\)/g, ' ').split(/[^a-z]+/).find(w => w.length >= 4) ?? '';

export function createStationIndex(reference) {
  const stations = reference.stations.map(s => ({ code: s.c, name: s.n, aliases: s.a ?? [], kind: s.k, lat: s.la, lon: s.lo, wikidata: Boolean(s.w) }));
  const places = (reference.places ?? []).map(p => ({ code: p.n, name: p.n, aliases: p.a ?? [], type: p.t, lat: p.la, lon: p.lo, population: p.p ?? null }));
  // Station identity: a station NAMED after a city or town within 15 km is that place's own station (Nagpur Junction,
  // Bhubaneswar, Chennai Central). Computed once at load with a spatial index over the places.
  const placeIndex = createSpatialIndex(places);
  for (const s of stations) {
    const words = new Set([s.name, ...s.aliases].flatMap(n => String(n).toLowerCase().split(/[^a-z]+/)));
    let serves = null;
    for (const { station: place } of placeIndex.nearby(s.lat, s.lon, 15000)) {
      const word = firstWord(place.name);
      if (!word || !words.has(word)) continue;
      if (place.type === 'city') { serves = 'city'; break; }
      serves = 'town';
    }
    s.serves = serves;
  }
  return { meta: reference.meta, stations, places, byCode: new Map(stations.map(s => [s.code, s])), nearby: createSpatialIndex(stations).nearby, placesNearby: placeIndex.nearby };
}

let cached = null; // { path, mtimeMs, index }
export function getStationIndex(seedPath = STATION_SEED_PATH) {
  let stat;
  try { stat = fs.statSync(seedPath); } catch { return null; }
  if (cached && cached.path === seedPath && cached.mtimeMs === stat.mtimeMs) return cached.index;
  const reference = JSON.parse(zlib.gunzipSync(fs.readFileSync(seedPath)).toString('utf8'));
  const index = createStationIndex(reference);
  cached = { path: seedPath, mtimeMs: stat.mtimeMs, index };
  return index;
}

/**
 * How large an interchange a station is, 0..1, from explainable signals only:
 *   mapped track around it (AP/TS only, from the railway network; `trackImportance`), an official name marking a
 *   junction / terminus / central / cantonment station, being named after the city (or town) it is in, a Wikidata
 *   entry, station vs halt, and trains already seen at it in cached timetable answers (`seenTrains`).
 *   Never a claim about services.
 */
export function stationImportance(station, { trackImportance = null, seenTrains = 0 } = {}) {
  if (!station) return 0;
  const named = TERMINAL_NAME.test(station.name ?? '') ? 1 : 0;
  const serves = station.serves === 'city' ? 0.25 : station.serves === 'town' ? 0.12 : 0;
  const base = 0.3 * named + serves + 0.15 * (station.wikidata ? 1 : 0) + 0.1 * (station.kind === 'station' ? 1 : 0);
  const evidence = Math.min(1, seenTrains / 20) * 0.35; // 20+ trains seen between it and another station: a busy station
  const track = trackImportance === null ? 0 : trackImportance * 0.35;
  return Math.min(1, base + Math.max(evidence, track));
}

export const metersBetween = (a, b) => haversineMeters(a.lat, a.lon, b.lat, b.lon);

// Transfer-hub discovery for scheduled-train journeys (Bus + Train, Train + Bus, Bus + Train + Bus).
//
// The railway timetable provider (RailRadar) answers ONE question per request: "trains between station A and station B
// on date D". Asking every station pair is impossible (a free key has ~100 requests a month), so the planner asks about
// a few PROMISING pairs only. This module decides which, from data RouteConnect already holds:
//
//   stations          the OpenStreetMap railway stations (code, name, coordinates; ODbL) - railStations.js
//   bus side          the GTFS bus stops within walking/short-ride distance of each station, and their network strength
//                     (hubs.js: routes, trips, onward connectivity) - a station in a town with a big bus stand is a hub
//   bus reachability  ONE time-dependent RAPTOR run from the origin (a few ms): the earliest timetable arrival at every
//                     stop, so an origin-side hub is only proposed when buses really get there, and with a real time
//   station size      mapped track around the station (railStations.js: yards and several lines = a major station)
//   geometry          detour (origin -> hub -> destination vs direct) and progress toward the destination
//
// Nothing here calls the provider or invents a service: it only ranks station pairs to ask about. The trains themselves,
// and the buses to and from the stations, come from the timetables and are validated in time when journeys are composed.
import { haversineMeters } from '../routing/geo.js';
import { estimateLocalRide, estimateWalk } from '../routing/accessEgress.js';
import { getConnectivity, getHubMetrics } from '../routing/hubs.js';
import { buildServiceDays } from '../routing/planner.js';
import { createWorkspace, runRaptor } from '../routing/raptor.js';
import { INF } from '../routing/types.js';

export const HUB_DEFAULTS = Object.freeze({
  maxRideMeters: 40000,          // a ride-only (auto / cab) connection to a station beyond this is never proposed
  hubRadiusShare: 0.6,           // hubs are looked for within this share of the trip distance of each end ...
  hubMaxRadiusMeters: 350000,    // ... and never farther than this
  maxDetourRatio: 1.35,          // (origin -> hub -> destination) / (origin -> destination)
  stationBusRadiusMeters: 2500,  // GTFS stops this close to a station are its bus side (bus stand <-> station)
  minHubImportance: 0.5,         // a station beyond ride range must be at least this large (0..1, railStations.js)
  minBusSideStrength: 0.5,       // ... and have a bus side at least this strong (0..1, hubs.js)
  maxHubsPerEnd: 4,
  minRailMeters: 25000,          // shorter station pairs are not worth a train (or a request)
  busReachMaxTransfers: 2,
  busReachHorizonHours: 12,
  // Rough planning speeds, ONLY to order pairs before asking (never shown, never used as journey times).
  railPlanningKph: 55,
  busPlanningKph: 40,
  busPlanningWaitMinutes: 20,
  stationBufferMinutes: 30       // boarding + leaving the station
});

const JUNCTION = /junction|\bjn\b/i;
export const isJunction = station => JUNCTION.test(station?.name ?? '');

const busSideCache = new WeakMap();
// GTFS stops near a station (the bus side of an interchange) and how strong they are as bus hubs.
export function stationBusSide(network, station, radiusMeters = HUB_DEFAULTS.stationBusRadiusMeters) {
  if (!network) return { stops: [], strength: 0 };
  let byStation = busSideCache.get(network);
  if (!byStation) busSideCache.set(network, (byStation = new Map()));
  const key = `${station.code}|${station.lat}|${station.lon}|${radiusMeters}`;
  const hit = byStation.get(key);
  if (hit) return hit;
  const metrics = getHubMetrics(network);
  const stops = [];
  let strength = 0;
  for (const { stop, distanceMeters } of network.stopIndex.nearby(station.lat, station.lon, radiusMeters)) {
    if (!metrics.isServed(stop)) continue;
    stops.push({ stop, meters: distanceMeters });
    strength = Math.max(strength, metrics.strength[stop]);
  }
  const side = { stops, strength };
  byStation.set(key, side);
  return side;
}

/**
 * Earliest timetable-bus arrival at every stop from `point`, leaving at `timeSeconds` on `date` (one RAPTOR run).
 * Access to the first stop: walking within the walking radius, otherwise an estimated local ride to the nearest served
 * stops (as the bus planner does). Returns arrivalAtStation(station) -> { arrivalSeconds, viaStop } | null.
 */
export function busReachFrom(network, point, { date, timeSeconds, config, maxTransfers = HUB_DEFAULTS.busReachMaxTransfers, horizonHours = HUB_DEFAULTS.busReachHorizonHours }) {
  const started = performance.now();
  const metrics = getHubMetrics(network);
  const accessLegs = [];
  for (const { stop, distanceMeters } of network.stopIndex.nearby(point.lat, point.lon, config.walkAccessRadiusMeters)) {
    if (metrics.isServed(stop)) accessLegs.push({ stopIdx: stop, durationSeconds: estimateWalk(distanceMeters, config).durationSeconds });
    if (accessLegs.length >= 8) break;
  }
  if (accessLegs.length === 0) {
    const rideRadius = Math.max(...(config.feederStageRadiiMeters ?? [20000]));
    for (const { stop, distanceMeters } of network.stopIndex.nearby(point.lat, point.lon, rideRadius)) {
      if (metrics.isServed(stop)) accessLegs.push({ stopIdx: stop, durationSeconds: estimateLocalRide(distanceMeters, config).durationSeconds });
      if (accessLegs.length >= 5) break;
    }
  }
  const serviceDays = buildServiceDays(network, { date, timeSeconds, windowMinutes: 0 }, { ...config, maxJourneyHours: horizonHours });
  const workspace = createWorkspace(network, maxTransfers + 2);
  runRaptor(network, { accessLegs, departureTime: timeSeconds, maxTransfers, serviceDays, egressSeconds: null, horizonTime: timeSeconds + horizonHours * 3600 }, workspace);
  const tau = Int32Array.from(workspace.tauStar);
  return {
    departureSeconds: timeSeconds,
    ms: Math.round((performance.now() - started) * 10) / 10,
    reachedStops: tau.reduce((n, v) => n + (v < INF ? 1 : 0), 0),
    arrivalAtStation(station) {
      let best = null;
      for (const { stop, meters } of stationBusSide(network, station).stops) {
        if (tau[stop] >= INF) continue;
        const arrivalSeconds = tau[stop] + estimateWalk(meters, config).durationSeconds;
        if (!best || arrivalSeconds < best.arrivalSeconds) best = { arrivalSeconds, viaStop: stop };
      }
      return best;
    }
  };
}

// Served GTFS stops around a point, as connectivity components (to judge whether buses can link a station and a place).
function componentsNear(network, point, radiusMeters) {
  const { component } = getConnectivity(network);
  const metrics = getHubMetrics(network);
  const set = new Set();
  for (const { stop } of network.stopIndex.nearby(point.lat, point.lon, radiusMeters)) if (metrics.isServed(stop)) set.add(component[stop]);
  return set;
}

/**
 * Candidate stations at one end of the trip.
 * role 'origin': how soon the traveller can be at the station (bus reachability is time-dependent: one RAPTOR run).
 * role 'destination': how long from the station to the destination (ride, or timetable buses in the same network).
 * @returns [{ station, role, meters, minutes, via: 'walk'|'ride'|'bus', junction, strength, score }]
 */
const NEUTRAL_IMPORTANCE = () => 0.3;

export function hubCandidates({ stations, point, other, role, network = null, reach = null, busAllowed = true, config, options = HUB_DEFAULTS, exclude = new Set(), importanceOf = NEUTRAL_IMPORTANCE }) {
  const crow = haversineMeters(point.lat, point.lon, other.lat, other.lon);
  const radius = Math.min(options.hubMaxRadiusMeters, Math.max(options.maxRideMeters, options.hubRadiusShare * crow));
  const placeComponents = network && role === 'destination' ? componentsNear(network, point, Math.max(...(config.feederStageRadiiMeters ?? [20000]))) : null;
  const { component } = network ? getConnectivity(network) : { component: null };
  const seen = new Set();
  const out = [];
  for (const station of stations) {
    if (!station.code || seen.has(station.code) || exclude.has(station.code)) continue;
    const meters = haversineMeters(point.lat, point.lon, station.lat, station.lon);
    if (meters > radius) continue;
    const toOther = haversineMeters(station.lat, station.lon, other.lat, other.lon);
    if (crow > 0 && (meters + toOther) / crow > options.maxDetourRatio) continue;
    if (meters > 15000 && toOther >= crow) continue; // a far hub must make progress toward the other end
    const junction = isJunction(station);
    const importance = importanceOf(station);
    const side = stationBusSide(network, station);
    // Beyond ride range only genuine interchanges: a large station with a real bus side (never a wayside halt).
    if (meters > options.maxRideMeters && (station.kind === 'halt' || importance < options.minHubImportance || side.strength < options.minBusSideStrength)) continue;

    let via = null;
    let minutes = Infinity;
    if (meters <= options.maxRideMeters) {
      const leg = meters <= 1000 ? estimateWalk(meters, config) : estimateLocalRide(meters, config);
      via = meters <= 1000 ? 'walk' : 'ride';
      minutes = leg.durationSeconds / 60;
    }
    if (busAllowed && network && side.stops.length > 0) {
      let busMinutes = Infinity;
      if (role === 'origin' && reach) {
        const arrival = reach.arrivalAtStation(station);
        if (arrival) busMinutes = (arrival.arrivalSeconds - reach.departureSeconds) / 60;
      } else if (role === 'destination' && placeComponents?.size) {
        if (side.stops.some(({ stop }) => placeComponents.has(component[stop]))) {
          busMinutes = (meters / 1000 / options.busPlanningKph) * 60 + options.busPlanningWaitMinutes;
        }
      }
      // A bus connection is preferred over a long ride when it is not much slower (rides are a feeder, not the trip).
      if (busMinutes < Infinity && (via === null || via === 'ride' && busMinutes < minutes * 2.5 && meters > 10000)) {
        via = 'bus';
        minutes = busMinutes;
      }
    }
    if (via === null) continue;
    seen.add(station.code);
    // Lower is better: minutes to cover this end plus the rest of the trip at a planning rail speed, scaled by station
    // size (a large station is far more likely to have the trains that make a change worthwhile).
    const quality = 1.3 - 0.5 * importance - 0.1 * side.strength;
    const score = (minutes + (toOther / 1000 / options.railPlanningKph) * 60) * quality;
    out.push({ station, role, meters: Math.round(meters), minutes: Math.round(minutes), via, junction, importance: Math.round(importance * 100) / 100, strength: Math.round(side.strength * 100) / 100, score });
  }
  out.sort((a, b) => a.score - b.score || a.meters - b.meters || a.station.code.localeCompare(b.station.code));
  // One hub per town: stations within 3 km of one already chosen are the same interchange. The clearly larger station
  // wins when it is nearly as quick (a yard or a wayside halt next to a junction is not where trains are boarded).
  const chosen = [];
  for (const c of out) {
    const i = chosen.findIndex(k => haversineMeters(k.station.lat, k.station.lon, c.station.lat, c.station.lon) < 3000);
    if (i >= 0) {
      if (c.importance > chosen[i].importance + 0.15 && c.score <= chosen[i].score * 1.15) chosen[i] = c;
      continue;
    }
    if (chosen.length < options.maxHubsPerEnd) chosen.push(c);
  }
  return chosen;
}

/**
 * Station pairs to ask the timetable provider about, best first. The anchor pair (nearest suitable station at each
 * end, the direct-train search) always comes first; hub pairs follow by estimated door-to-door minutes.
 */
export function rankStationPairs({ anchor = null, origins, destinations, options = HUB_DEFAULTS }) {
  const pairs = [];
  const keyOf = (a, b) => `${a.station.code}>${b.station.code}`;
  const seen = new Set();
  if (anchor) {
    pairs.push({ ...anchor, role: 'anchor' });
    seen.add(keyOf(anchor.from, anchor.to));
  }
  for (const o of origins) {
    for (const d of destinations) {
      if (o.station.code === d.station.code) continue;
      const railMeters = haversineMeters(o.station.lat, o.station.lon, d.station.lat, d.station.lon);
      if (railMeters < options.minRailMeters) continue;
      const key = keyOf(o, d);
      if (seen.has(key)) continue;
      seen.add(key);
      const railMinutes = (railMeters * 1.25 / 1000 / options.railPlanningKph) * 60;
      const minutes = o.minutes + options.stationBufferMinutes + railMinutes + d.minutes;
      // Order by estimated minutes, preferring large stations at both ends (more trains, so a better chance of an answer).
      const priority = minutes * (1.2 - 0.1 * ((o.importance ?? 0.3) + (d.importance ?? 0.3)));
      pairs.push({ from: o, to: d, role: 'hub', estimatedMinutes: Math.round(minutes), priority: Math.round(priority) });
    }
  }
  const head = anchor ? pairs.slice(0, 1) : [];
  const rest = pairs.slice(head.length);
  rest.sort((a, b) => a.priority - b.priority || keyOf(a.from, a.to).localeCompare(keyOf(b.from, b.to)));
  return [...head, ...rest];
}

/** Junction stations between the two ends, for two-train itineraries (Train -> Train / Train -> Bus -> Train). */
export function viaJunctions({ stations, origin, destination, exclude = new Set(), options = HUB_DEFAULTS, max = 2, importanceOf = NEUTRAL_IMPORTANCE }) {
  const crow = haversineMeters(origin.lat, origin.lon, destination.lat, destination.lon);
  const out = [];
  for (const station of stations) {
    if (!station.code || exclude.has(station.code) || !isJunction(station) || importanceOf(station) < options.minHubImportance) continue;
    const a = haversineMeters(origin.lat, origin.lon, station.lat, station.lon);
    const b = haversineMeters(station.lat, station.lon, destination.lat, destination.lon);
    if (a < options.minRailMeters || b < options.minRailMeters || (a + b) / crow > 1.25) continue;
    const importance = importanceOf(station);
    out.push({ station, detour: (a + b) / crow, importance, score: (a + b) / crow - 0.3 * importance });
  }
  out.sort((x, y) => x.score - y.score || x.station.code.localeCompare(y.station.code));
  const chosen = [];
  for (const c of out) {
    if (chosen.some(k => k.station.code === c.station.code || haversineMeters(k.station.lat, k.station.lon, c.station.lat, c.station.lon) < 3000)) continue;
    chosen.push(c);
    if (chosen.length >= max) break;
  }
  return chosen;
}

// Access / egress candidate generation, for BOTH ends of a journey.
//
//   Walk candidates     nearest stops with service within the walking radius.
//   Local feeder        stops beyond walking distance, reached by an ESTIMATED generic local ride, up to the stage radius,
//                       ranked by hubScore (services in the window x network strength), progress toward the other end of
//                       the journey, and ride time. Budget: maxFeederCandidates.
//   Extended hubs       beyond the local-feeder range only stops with hub strength >= hubMinStrength are considered
//                       (budget: maxHubCandidates), so a far ride is only offered to somewhere that is genuinely a hub.
//
// Nothing here is hardcoded to a place. Candidate sets are small and bounded; RAPTOR then runs ONCE per stage with all
// candidates as sources/targets, so the final boarding/alighting stops are chosen by the best COMPLETE journey.
import { haversineMeters } from './geo.js';
import { estimateLocalRide, estimateWalk } from './accessEgress.js';
import { getHubMetrics, hubScore } from './hubs.js';

// Boardable departures from `stop` whose time falls in [from, to] (absolute seconds), across the active service days.
export function countDepartures(network, stop, serviceDays, from, to) {
  let count = 0;
  for (let e = network.stopPatternOffsets[stop]; e < network.stopPatternOffsets[stop + 1]; e++) {
    const pattern = network.patterns[network.stopPatternPattern[e]];
    const pos = network.stopPatternPos[e];
    if (pos >= pattern.n - 1 || pattern.pickup[pos] !== 1) continue;
    for (let j = 0; j < pattern.tripCount; j++) {
      const time = pattern.dep[j * pattern.n + pos];
      for (const day of serviceDays) {
        if (day.active[pattern.service[j]] !== 1) continue;
        const absolute = time + day.offsetSeconds;
        if (absolute >= from && absolute <= to) count++;
      }
    }
  }
  return count;
}

// Arrivals (alighting allowed) at `stop` inside [from, to].
export function countArrivals(network, stop, serviceDays, from, to) {
  let count = 0;
  for (let e = network.stopPatternOffsets[stop]; e < network.stopPatternOffsets[stop + 1]; e++) {
    const pattern = network.patterns[network.stopPatternPattern[e]];
    const pos = network.stopPatternPos[e];
    if (pos === 0 || pattern.dropOff[pos] !== 1) continue;
    for (let j = 0; j < pattern.tripCount; j++) {
      const time = pattern.arr[j * pattern.n + pos];
      for (const day of serviceDays) {
        if (day.active[pattern.service[j]] !== 1) continue;
        const absolute = time + day.offsetSeconds;
        if (absolute >= from && absolute <= to) count++;
      }
    }
  }
  return count;
}

// Per-query cache of window service counts: stages overlap, so each stop is counted at most once per role and window.
export function createServiceCounter(network, serviceDays) {
  const cache = new Map();
  const memo = (kind, fn) => (stop, from, to) => {
    const key = `${kind}|${stop}|${from}|${to}`;
    let value = cache.get(key);
    if (value === undefined) cache.set(key, (value = fn(network, stop, serviceDays, from, to)));
    return value;
  };
  return { departures: memo('d', countDepartures), arrivals: memo('a', countArrivals) };
}

/**
 * The ordered access stages: walking first, then progressively wider local-ride radii.
 * @returns {{index:number, name:string, kind:'walk'|'feeder'|'hub', radiusMeters:number}[]}
 */
export function buildAccessStages(config) {
  const stages = [{ index: 0, name: 'walk', kind: 'walk', radiusMeters: config.walkAccessRadiusMeters }];
  const feeder = [...(config.feederStageRadiiMeters ?? [])].filter(r => r > 0).sort((a, b) => a - b);
  const hub = [...(config.hubStageRadiiMeters ?? [])].filter(r => r > 0).sort((a, b) => a - b);
  for (const radiusMeters of feeder) stages.push({ index: stages.length, name: `feeder-${radiusMeters / 1000}km`, kind: 'feeder', radiusMeters });
  if (feeder.length > 0) for (const radiusMeters of hub) {
    if (radiusMeters > feeder.at(-1)) stages.push({ index: stages.length, name: `hub-${radiusMeters / 1000}km`, kind: 'hub', radiusMeters });
  }
  return stages;
}

// Walking candidates: the nearest stops that actually have service, within the walking radius.
export function selectWalkCandidates(network, point, { radiusMeters, maxCandidates, allowedComponents = null, components = null, config }) {
  const metrics = getHubMetrics(network);
  const legs = [];
  for (const { stop, distanceMeters } of network.stopIndex.nearby(point.lat, point.lon, radiusMeters)) {
    if (!metrics.isServed(stop)) continue;
    if (allowedComponents && !allowedComponents.has(components[stop])) continue;
    legs.push({ stopIdx: stop, ...estimateWalk(distanceMeters, config) });
    if (legs.length >= maxCandidates) break;
  }
  return legs;
}

/**
 * Local-ride candidates around `point` beyond the walking radius, up to the stage radius.
 * @param {'access'|'egress'} role
 * @returns {Object[]} legs: { stopIdx, mode:'local_ride', distanceMeters, durationSeconds, ..., hub:{services, score, progress, strength} }
 */
export function selectFeederCandidates(network, point, {
  role, stage, otherPoint, counter, windowStart, windowEnd, horizonSeconds, config, allowedComponents = null, components = null
}) {
  if (!stage || stage.kind === 'walk' || !(stage.radiusMeters > 0)) return [];

  const metrics = getHubMetrics(network);
  const localLimit = Math.max(0, ...(config.feederStageRadiiMeters ?? []));
  const directMeters = haversineMeters(point.lat, point.lon, otherPoint.lat, otherPoint.lon);
  const walkRadius = role === 'access' ? config.walkAccessRadiusMeters : config.walkEgressRadiusMeters;

  const local = [];
  const hubs = [];
  for (const { stop, distanceMeters } of network.stopIndex.nearby(point.lat, point.lon, stage.radiusMeters)) {
    if (distanceMeters <= walkRadius) continue; // a walking candidate (or too close to need a ride)
    if (!metrics.isServed(stop)) continue;
    if (allowedComponents && !allowedComponents.has(components[stop])) continue;
    const beyondLocal = distanceMeters > localLimit;
    if (beyondLocal && metrics.strength[stop] < config.hubMinStrength) continue; // cheap static filter first

    const ride = estimateLocalRide(distanceMeters, config);
    const services = role === 'access'
      ? counter.departures(stop, windowStart + ride.durationSeconds, windowEnd + ride.durationSeconds)
      : counter.arrivals(stop, windowStart, windowEnd + horizonSeconds);
    if (services < config.feederMinServicesInWindow) continue;

    const towardOther = directMeters > 0
      ? (directMeters - haversineMeters(network.stopLat[stop], network.stopLon[stop], otherPoint.lat, otherPoint.lon)) / directMeters
      : 0;
    const progress = Math.max(0, Math.min(1, towardOther));
    const strength = metrics.strength[stop];
    const score = (hubScore(strength, services) * (0.5 + progress)) / (1 + ride.durationSeconds / config.hubRideScaleSeconds);
    (beyondLocal ? hubs : local).push({ stopIdx: stop, ride, services, progress, strength, score, distanceMeters });
  }

  const byScore = (a, b) => b.score - a.score || a.distanceMeters - b.distanceMeters || a.stopIdx - b.stopIdx;
  local.sort(byScore);
  hubs.sort(byScore);

  // One stop per hub: skip candidates that sit right next to an already chosen, better-scoring stop.
  const picked = [];
  const take = (list, budget) => {
    let taken = 0;
    for (const candidate of list) {
      if (taken >= budget) break;
      const crowded = picked.some(chosen =>
        haversineMeters(network.stopLat[chosen.stopIdx], network.stopLon[chosen.stopIdx], network.stopLat[candidate.stopIdx], network.stopLon[candidate.stopIdx]) <= config.feederClusterRadiusMeters);
      if (crowded) continue;
      picked.push(candidate);
      taken++;
    }
  };
  take(local, config.maxFeederCandidates);
  take(hubs, config.maxHubCandidates);
  picked.sort(byScore);

  return picked.map(candidate => ({
    stopIdx: candidate.stopIdx,
    ...candidate.ride,
    hub: {
      services: candidate.services,
      score: Math.round(candidate.score * 100) / 100,
      progress: Math.round(candidate.progress * 100) / 100,
      strength: Math.round(candidate.strength * 100) / 100
    }
  }));
}

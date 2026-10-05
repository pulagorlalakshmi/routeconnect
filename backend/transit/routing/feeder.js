// Tier-2 access/egress: choosing which stops beyond walking distance are worth reaching by a local ride.
//
// Nothing here is hardcoded to any town: candidates come from the timetable network and are scored by
//   - service level: usable departures (access) or arrivals (egress) inside the search window,
//   - distance:      shorter local rides are better,
//   - direction:     stops that lie toward the other end of the journey are better.
// The candidate set is BOUNDED (maxFeederCandidates, de-clustered to one stop per hub). RAPTOR then runs ONCE with
// all candidates as sources/targets, so the final choice of boarding stop is made on the COMPLETE door-to-door
// journey, not on this heuristic. The heuristic only keeps the search small.
import { haversineMeters } from './geo.js';
import { estimateLocalRide } from './accessEgress.js';

// Boardable departures from `stop` whose time falls in [from, to] (absolute seconds), across the active service days.
function countDepartures(network, stop, serviceDays, from, to) {
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
function countArrivals(network, stop, serviceDays, from, to) {
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

/**
 * Local-ride candidates around `point` (beyond the walking radius).
 * @param {'access'|'egress'} role
 * @returns {Object[]} legs: { stopIdx, mode:'local_ride', distanceMeters, durationSeconds, ..., hub:{services, score, progress} }
 */
export function selectFeederCandidates(network, point, {
  role, radiusMeters, excludeWithinMeters, maxCandidates, otherPoint, serviceDays, windowStart, windowEnd, horizonSeconds, config
}) {
  if (!(radiusMeters > 0) || !(maxCandidates > 0)) return [];

  const directMeters = haversineMeters(point.lat, point.lon, otherPoint.lat, otherPoint.lon);
  const scored = [];
  for (const { stop, distanceMeters } of network.stopIndex.nearby(point.lat, point.lon, radiusMeters)) {
    if (distanceMeters <= excludeWithinMeters) continue; // already a walking candidate (or too close to need a ride)
    const ride = estimateLocalRide(distanceMeters, config);
    const services = role === 'access'
      ? countDepartures(network, stop, serviceDays, windowStart + ride.durationSeconds, windowEnd + ride.durationSeconds)
      : countArrivals(network, stop, serviceDays, windowStart, windowEnd + horizonSeconds);
    if (services < config.feederMinServicesInWindow) continue;

    const towardOther = directMeters > 0
      ? (directMeters - haversineMeters(network.stopLat[stop], network.stopLon[stop], otherPoint.lat, otherPoint.lon)) / directMeters
      : 0;
    const progress = Math.max(0, Math.min(1, towardOther));
    const score = (services * (0.5 + progress)) / (1 + ride.durationSeconds / 1800);
    scored.push({ stopIdx: stop, ride, services, progress, score, distanceMeters });
  }

  scored.sort((a, b) => b.score - a.score || a.distanceMeters - b.distanceMeters || a.stopIdx - b.stopIdx);

  // One stop per hub: skip candidates that sit right next to an already chosen, better-served stop.
  const picked = [];
  for (const candidate of scored) {
    if (picked.length >= maxCandidates) break;
    const crowded = picked.some(chosen =>
      haversineMeters(network.stopLat[chosen.stopIdx], network.stopLon[chosen.stopIdx], network.stopLat[candidate.stopIdx], network.stopLon[candidate.stopIdx]) <= config.feederClusterRadiusMeters);
    if (!crowded) picked.push(candidate);
  }

  return picked.map(candidate => ({
    stopIdx: candidate.stopIdx,
    ...candidate.ride,
    hub: { services: candidate.services, score: Math.round(candidate.score * 100) / 100, progress: Math.round(candidate.progress * 100) / 100 }
  }));
}

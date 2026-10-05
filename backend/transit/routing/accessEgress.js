// Access (origin -> stop) and egress (stop -> destination) legs.
//
// Two modes, both ESTIMATED and both kept apart from GTFS transit legs:
//  - walk:        straight-line distance x detour factor / walking speed
//  - local_ride:  a GENERIC auto / cab ride: straight-line distance x road factor / assumed speed + a pickup allowance.
//                 No provider is modelled, nothing is booked, and availability is never claimed.
// A real routing backend (OSRM / Valhalla) or an official provider integration could replace this module later
// without touching the algorithm.

export function estimateWalk(straightLineMeters, { walkSpeedMetersPerSecond, walkDetourFactor }) {
  const distanceMeters = Math.round(straightLineMeters * walkDetourFactor);
  return {
    mode: 'walk',
    straightLineMeters: Math.round(straightLineMeters),
    distanceMeters,
    durationSeconds: Math.round(distanceMeters / walkSpeedMetersPerSecond),
    dataConfidence: 'estimated'
  };
}

// Estimated local ride over `straightLineMeters`. durationSeconds includes the assumed pickup allowance.
export function estimateLocalRide(straightLineMeters, config) {
  const roadMeters = Math.round(straightLineMeters * config.localRideDistanceFactor);
  const metersPerSecond = (config.localRideSpeedKph * 1000) / 3600;
  const rideSeconds = Math.max(config.localRideMinSeconds, Math.round(roadMeters / metersPerSecond));
  return {
    mode: 'local_ride',
    straightLineMeters: Math.round(straightLineMeters),
    distanceMeters: roadMeters,
    rideSeconds,
    pickupWaitSeconds: config.localRidePickupWaitSeconds,
    durationSeconds: rideSeconds + config.localRidePickupWaitSeconds,
    dataConfidence: 'estimated'
  };
}

// Nearest stops around a point as walking legs: [{ stopIdx, mode:'walk', straightLineMeters, distanceMeters, durationSeconds, ... }]
export function findWalkLegs(stopIndex, point, { radiusMeters, maxStops, walkSpeedMetersPerSecond, walkDetourFactor }) {
  return stopIndex
    .nearby(point.lat, point.lon, radiusMeters, { limit: maxStops })
    .map(({ stop, distanceMeters }) => ({
      stopIdx: stop,
      ...estimateWalk(distanceMeters, { walkSpeedMetersPerSecond, walkDetourFactor })
    }));
}

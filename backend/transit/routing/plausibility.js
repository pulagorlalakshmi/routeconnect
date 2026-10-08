// Journey plausibility: a technically valid timetable journey is not always a USEFUL one.
//
// assessJourney() looks only at the public shape of a journey (legs, durations, transfers) and the straight-line
// trip it is meant to serve, so it can judge any journey the planner (or an older planner) produced.
//
// Checks (limits are stricter for short trips and looser for long intercity travel; all are named in config.js):
//   DISTANCE_DETOUR      the path (rides + bus stop sequences + walks) is much longer than the direct distance
//   DURATION_DETOUR      the door-to-door duration is out of proportion to the direct distance
//   FEEDER_SHARE         estimated local rides make up too much of the trip time
//   FEEDER_DISTANCE      the rides alone cover more ground than the whole trip (beyond a small allowance)
//   TRANSIT_ADDS_NO_VALUE  with rides, the bus does not cover clearly more ground than the rides, covers too little of the
//                        trip, or is too short to matter: a bus hop inserted only so the trip can be called "public transport"
//   EXCESSIVE_TRANSFERS  more changes than the trip length justifies
//   DETOUR_EXCURSION     the journey goes far off the line between origin and destination (direction regression)
import { haversineMeters } from './geo.js';

const clamp01 = x => Math.max(0, Math.min(1, x));

// Linear blend from the short-trip limit to the long-trip limit as the direct distance grows.
export function limitFor(crowMeters, shortValue, longValue, config) {
  const span = Math.max(1, config.longTripMeters - config.shortTripMeters);
  return shortValue + (longValue - shortValue) * clamp01((crowMeters - config.shortTripMeters) / span);
}

export function journeyMetrics(journey, origin, destination, config) {
  const crow = Math.max(1, haversineMeters(origin.lat, origin.lon, destination.lat, destination.lon));
  let pathMeters = 0, rideStraight = 0, rideSeconds = 0, transitSeconds = 0;
  let firstBoard = null, lastAlight = null;
  let excursion = 0;
  const visit = place => {
    if (!place || !Number.isFinite(place.lat)) return;
    const sum = haversineMeters(origin.lat, origin.lon, place.lat, place.lon) + haversineMeters(place.lat, place.lon, destination.lat, destination.lon);
    excursion = Math.max(excursion, sum - crow);
  };
  for (const leg of journey.legs) {
    if (leg.mode === 'local_ride') {
      const straight = leg.straightLineMeters ?? leg.distanceMeters / config.localRideDistanceFactor;
      pathMeters += straight; rideStraight += straight; rideSeconds += leg.durationSeconds;
    } else if (leg.mode === 'walk') {
      pathMeters += leg.straightLineMeters ?? leg.distanceMeters ?? 0;
    } else {
      pathMeters += leg.distanceMeters ?? haversineMeters(leg.fromStop.lat, leg.fromStop.lon, leg.toStop.lat, leg.toStop.lon);
      transitSeconds += leg.durationSeconds;
      firstBoard ??= leg.fromStop;
      lastAlight = leg.toStop;
      visit(leg.fromStop); visit(leg.toStop);
    }
  }
  const total = Math.max(1, journey.totalDurationSeconds);
  const displacement = firstBoard && lastAlight ? haversineMeters(firstBoard.lat, firstBoard.lon, lastAlight.lat, lastAlight.lon) : 0;
  return {
    crowMeters: crow,
    pathMeters,
    distanceDetour: pathMeters / Math.max(crow, config.detourMinDirectMeters),
    durationRatio: total / Math.max(1, crow / ((config.idealBusKph * 1000) / 3600)),
    feederShare: rideSeconds / total,
    rideStraightMeters: rideStraight,
    transitSeconds,
    transitDisplacementMeters: displacement,
    excursionMeters: excursion,
    transfers: journey.transfers
  };
}

/**
 * @returns {{ok:boolean, reasons:string[], metrics:Object}}
 */
export function assessJourney(journey, { origin, destination, config, maxTransfers }) {
  const m = journeyMetrics(journey, origin, destination, config);
  const reasons = [];
  const at = (shortKey, longKey) => limitFor(m.crowMeters, config[shortKey], config[longKey], config);

  if (m.distanceDetour > at('maxDistanceDetourShort', 'maxDistanceDetourLong')) reasons.push('DISTANCE_DETOUR');

  const idealSeconds = m.crowMeters / ((config.idealBusKph * 1000) / 3600);
  if (journey.totalDurationSeconds > config.detourDurationBaseSeconds + at('maxDurationFactorShort', 'maxDurationFactorLong') * idealSeconds) reasons.push('DURATION_DETOUR');

  const transferCap = Math.min(maxTransfers, Math.floor(limitFor(m.crowMeters, config.maxTransfersShortTrip, maxTransfers, config) + 1e-9));
  if (journey.transfers > transferCap) reasons.push('EXCESSIVE_TRANSFERS');

  if (m.excursionMeters > config.excursionAllowanceMeters + at('maxExcursionShareShort', 'maxExcursionShareLong') * m.crowMeters) reasons.push('DETOUR_EXCURSION');

  if (m.rideStraightMeters > 0) {
    if (m.feederShare > at('maxFeederShareShort', 'maxFeederShareLong')) reasons.push('FEEDER_SHARE');
    if (m.rideStraightMeters > Math.max(config.localRideAllowanceMeters, config.maxLocalRideToDirectRatio * m.crowMeters)) reasons.push('FEEDER_DISTANCE');
    if (
      m.transitDisplacementMeters < config.minTransitToRideRatio * m.rideStraightMeters
      || m.transitDisplacementMeters < config.minTransitShareOfDirect * m.crowMeters
      || m.transitSeconds < config.minTransitSeconds
    ) reasons.push('TRANSIT_ADDS_NO_VALUE');
  }
  return { ok: reasons.length === 0, reasons, metrics: m };
}

// Why a search found nothing. Backend-only detail: the frontend maps the failure code to a short, plain message.
//
//   NO_ACCESS_CANDIDATE            no stop with service within the maximum access range of the origin
//   NO_TIMETABLE_SERVICE           stops exist near the origin but none has a usable departure in the searched windows
//   NO_DESTINATION_EGRESS          no stop with service within range of the destination, or none receives a service in time
//   DATASET_COVERAGE_LIMITATION    the stops near the origin and near the destination are not connected by ANY timetable
//                                  service in this dataset (at any time of day): the feed itself does not cover this corridor
//   NO_CONNECTION                  both ends have service and are connected in the dataset, but no journey was found for
//                                  this date / time / transfer limit (even after widening the time window)
//
// Nothing here fabricates a journey; it only describes where the search stopped.
import { getHubMetrics, getConnectivity } from './hubs.js';
import { estimateLocalRide } from './accessEgress.js';

export const FAILURE_CODES = Object.freeze({
  NO_ACCESS_CANDIDATE: 'NO_ACCESS_CANDIDATE',
  NO_TIMETABLE_SERVICE: 'NO_TIMETABLE_SERVICE',
  NO_DESTINATION_EGRESS: 'NO_DESTINATION_EGRESS',
  DATASET_COVERAGE_LIMITATION: 'DATASET_COVERAGE_LIMITATION',
  NO_CONNECTION: 'NO_CONNECTION'
});

// Served stops around a point within `radiusMeters`: count, nearest, and the connected components they belong to.
export function analyseReach(network, point, radiusMeters) {
  const metrics = getHubMetrics(network);
  const { component } = getConnectivity(network);
  const components = new Set();
  let servedCount = 0;
  let nearest = null;
  for (const { stop, distanceMeters } of network.stopIndex.nearby(point.lat, point.lon, radiusMeters)) {
    if (!metrics.isServed(stop)) continue;
    servedCount++;
    components.add(component[stop]);
    if (!nearest) nearest = { stopIdx: stop, distanceMeters };
  }
  return { servedCount, nearest, components };
}

// Staged time windows: the requested one first, then the configured wider ones (never beyond maxWindowMinutes).
export function buildWindows(requestedMinutes, config) {
  const windows = [requestedMinutes];
  for (const minutes of config.windowExpansionMinutes ?? []) {
    const capped = Math.min(minutes, config.maxWindowMinutes);
    if (capped > windows.at(-1)) windows.push(capped);
  }
  return windows;
}

function describeHub(network, hub, config, role, counter, windowStart, windowEnd, horizonSeconds) {
  if (!hub) return null;
  const ride = estimateLocalRide(hub.distanceMeters, config);
  const services = role === 'access'
    ? counter.departures(hub.stopIdx, windowStart, windowEnd)
    : counter.arrivals(hub.stopIdx, windowStart, windowEnd + horizonSeconds);
  return {
    stopId: network.stopSourceIds[hub.stopIdx],
    name: network.stopNames[hub.stopIdx],
    distanceMeters: Math.round(hub.distanceMeters),
    estimatedLocalRideMinutes: Math.round(ride.durationSeconds / 60),
    servicesInSearchedWindow: services,
    hasOnwardService: role === 'access' ? services > 0 : undefined,
    hasArrivingService: role === 'egress' ? services > 0 : undefined
  };
}

/**
 * @returns {{failureCode:string, reasons:string[], origin:Object, destination:Object, sameNetwork:boolean|null, searched:Object}}
 */
export function diagnoseNoRoute(network, {
  config, counter, windowStart, windowEnd, horizonSeconds, originReach, destinationReach, sharedComponents,
  finalAccess, finalEgress, searchedWindowsMinutes, maxRadiusMeters
}) {
  const { component } = getConnectivity(network);
  const reasons = [];
  let failureCode;
  // Candidates that actually have a usable departure (access) / arrival (egress) somewhere in the widest searched window.
  const accessWithService = finalAccess.filter(leg => counter.departures(leg.stopIdx, windowStart + leg.durationSeconds, windowEnd + leg.durationSeconds) > 0);
  const egressWithService = finalEgress.filter(leg => counter.arrivals(leg.stopIdx, windowStart, windowEnd + horizonSeconds) > 0);

  const originHub = describeHub(network, originReach.nearest, config, 'access', counter, windowStart, windowEnd, horizonSeconds);
  const destinationHub = describeHub(network, destinationReach.nearest, config, 'egress', counter, windowStart, windowEnd, horizonSeconds);

  if (originReach.servedCount === 0) {
    failureCode = FAILURE_CODES.NO_ACCESS_CANDIDATE;
    reasons.push(`No stop with timetable service within ${Math.round(maxRadiusMeters / 1000)} km of the origin.`);
    if (destinationReach.servedCount === 0) reasons.push(`No stop with timetable service within ${Math.round(maxRadiusMeters / 1000)} km of the destination either.`);
  } else if (destinationReach.servedCount === 0) {
    failureCode = FAILURE_CODES.NO_DESTINATION_EGRESS;
    reasons.push(`No stop with timetable service within ${Math.round(maxRadiusMeters / 1000)} km of the destination.`);
  } else if (sharedComponents.size === 0) {
    failureCode = FAILURE_CODES.DATASET_COVERAGE_LIMITATION;
    reasons.push('No timetable service in this dataset connects the stops near the origin with the stops near the destination, at any time of day.');
  } else if (accessWithService.length === 0) {
    failureCode = FAILURE_CODES.NO_TIMETABLE_SERVICE;
    reasons.push('Stops near the origin exist, but none has a departure on this date inside the searched time windows.');
  } else if (egressWithService.length === 0) {
    failureCode = FAILURE_CODES.NO_DESTINATION_EGRESS;
    reasons.push('Stops near the destination exist, but no service arrives at them on this date inside the searched time windows.');
  } else {
    failureCode = FAILURE_CODES.NO_CONNECTION;
    reasons.push('Both ends have timetable service and are connected in the dataset, but no journey fits this date, time and transfer limit.');
  }

  const stopsOf = legs => [...new Set(legs.map(leg => component[leg.stopIdx]))].length;
  return {
    failureCode,
    reasons,
    sameNetwork: originReach.servedCount > 0 && destinationReach.servedCount > 0 ? sharedComponents.size > 0 : null,
    origin: { servedStopsInRange: originReach.servedCount, nearestServedStop: originHub, candidatesTried: finalAccess.length, candidatesWithService: accessWithService.length, candidateNetworks: stopsOf(finalAccess) },
    destination: { servedStopsInRange: destinationReach.servedCount, nearestServedStop: destinationHub, candidatesTried: finalEgress.length, candidatesWithService: egressWithService.length, candidateNetworks: stopsOf(finalEgress) },
    searched: { maxRadiusMeters, windowsMinutes: searchedWindowsMinutes }
  };
}

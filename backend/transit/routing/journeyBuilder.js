// Turns RAPTOR labels into complete, explainable journeys.
//   reconstructChain()     walk the parent pointers back from a stop/round
//   extractRunCandidates() one best journey per round (Pareto in arrival time vs transfers) for a single run
//   assembleJourney()      times, legs, metrics, fare ranges, stable id and per-leg confidence
import crypto from 'crypto';
import { INF, PARENT, TIME_QUALITY_NAMES, TIME_QUALITY_CODE } from './types.js';
import { dayNumberToIso, formatLocalDateTime } from './serviceCalendar.js';
import { formatGtfsTime } from '../gtfs/time.js';
import { CONFIDENCE, capConfidence, weakestConfidence } from '../confidence.js';
import { effectiveConfidence } from '../datasetMetadata.js';
import { haversineMeters } from './geo.js';
import { providerOptionsForRide } from '../localRide/providerCoverage.js';
import { journeyTracking, trackingOptionsFor } from '../tracking/trackingOptions.js';
import { operatorIdentity } from '../sources/operators.js';
import { serviceNumberFor } from '../sources/gtfs/serviceNumbers.js';
import { estimateBusFare, estimateLocalRideFare, estimateJourneyFare } from '../fare/fareEstimator.js';
import { getFareConfig } from '../fare/fareConfig.js';

// Follow parent pointers from (round, stop) back to the origin access leg.
// Returns { accessStop, segments } with segments in travel order.
//
// Labels are copied forward between rounds, so every label remembers the round it was SET in (pRound):
//  - a transit parent set in round s boarded using the previous round's label (s - 1);
//  - a walking parent was derived from a stop improved by transit in that same round.
export function reconstructChain(network, ws, round, stop) {
  const reversed = [];
  let r = round;
  let current = stop;
  for (let guard = 0; guard < 64; guard++) {
    const type = ws.pType[r][current];
    const setRound = ws.pRound[r][current];

    if (type === PARENT.TRANSIT) {
      const patternIdx = ws.pPattern[r][current];
      const boardPos = ws.pBoard[r][current];
      reversed.push({
        kind: 'transit',
        pattern: patternIdx,
        trip: ws.pTrip[r][current],
        offIdx: ws.pOffIdx[r][current],
        boardPos,
        alightPos: ws.pAlight[r][current]
      });
      current = network.patterns[patternIdx].stops[boardPos];
      r = setRound - 1;
      if (r < 0) throw new Error('Journey reconstruction ran past round 0.');
    } else if (type === PARENT.FOOT) {
      const from = ws.pFrom[r][current];
      reversed.push({ kind: 'foot', from, to: current });
      current = from;
      r = setRound;
    } else if (type === PARENT.ACCESS) {
      return { accessStop: current, segments: reversed.reverse() };
    } else {
      throw new Error('Journey reconstruction hit a stop without a parent label.');
    }
  }
  throw new Error('Journey reconstruction did not terminate.');
}

// One best journey per round for a single RAPTOR run; only rounds that improve the final arrival are kept
// (that is the Pareto front of arrival time vs number of transfers for this departure time).
// Every candidate has at least one transit trip by construction: round k >= 1 labels exist only after boarding.
export function extractRunCandidates(network, run, ctx) {
  const { ws, lastRound } = run;
  const candidates = [];
  let bestSoFar = INF;
  for (let k = 1; k <= lastRound; k++) {
    let bestStop = -1;
    let bestTotal = INF;
    let bestWalk = INF;
    for (const egress of ctx.egressLegs) {
      const s = egress.stopIdx;
      if (ws.tau[k][s] < ws.tau[k - 1][s]) { // improved by a trip in this round
        const total = ws.tau[k][s] + egress.durationSeconds;
        if (total < bestTotal || (total === bestTotal && egress.durationSeconds < bestWalk)) {
          bestTotal = total;
          bestStop = s;
          bestWalk = egress.durationSeconds;
        }
      }
    }
    if (bestStop >= 0 && bestTotal < bestSoFar) {
      bestSoFar = bestTotal;
      candidates.push({ chain: reconstructChain(network, ws, k, bestStop), egressStop: bestStop, round: k });
    }
  }
  return candidates;
}

const stopRef = (network, s) => ({
  type: 'stop',
  stopId: network.stopSourceIds[s],
  name: network.stopNames[s],
  lat: network.stopLat[s],
  lon: network.stopLon[s]
});

// How far a stop-time quality limits confidence: interpolated -> inferred, unknown -> estimated.
function qualityCap(code) {
  if (code >= TIME_QUALITY_CODE.unknown) return CONFIDENCE.ESTIMATED;
  if (code >= TIME_QUALITY_CODE.interpolated) return CONFIDENCE.INFERRED;
  return CONFIDENCE.PUBLISHED; // exact / approximate times of a published timetable
}

function footLeg(network, segment) {
  for (let e = network.footOffsets[segment.from]; e < network.footOffsets[segment.from + 1]; e++) {
    if (network.footTo[e] === segment.to) return { seconds: network.footSeconds[e], meters: network.footMeters[e] };
  }
  return { seconds: 0, meters: 0 };
}

// Straight-line length of the stop sequence between two positions of a pattern.
function stopSequenceMeters(network, pattern, boardPos, alightPos) {
  let meters = 0;
  for (let i = boardPos; i < alightPos; i++) {
    const a = pattern.stops[i];
    const b = pattern.stops[i + 1];
    meters += haversineMeters(network.stopLat[a], network.stopLon[a], network.stopLat[b], network.stopLon[b]);
  }
  return Math.round(meters);
}

// Leg identity, kept as separate fields so nothing is mislabelled:
//   operatorInfo   who runs it - from the feed's agency.txt only; never inferred from a code or a place
//   routeId/tripId the feed's own identifiers (internal; shown only as "Route <code>" when nothing better exists)
//   serviceNumber  a PUBLIC service number, set only when the feed's code is in a format proven to be one
//                  (see sources/gtfs/serviceNumbers.js); this is what trackers are given
//   displayName    "APSRTC service 3846" / "APSRTC route 952054" / "Route 952054"
// There are no vehicle registrations in the feed, so the vehicle number stays null; nothing ever invents a plate.
export function busIdentity(route, dataset) {
  const info = operatorIdentity(route.agencyName ?? null, { source: route.agencyName ? 'gtfs:agency.txt' : 'gtfs', confidence: 'published' });
  const code = route.shortName ?? route.sourceId ?? null;
  const { serviceNumber, serviceNumberSource } = serviceNumberFor(code, info.name);
  const identity = {
    operator: info.name,                 // display name or null ("Operator not identified")
    operatorInfo: info,
    routeId: route.sourceId ?? null,
    routeCode: code,                     // the feed's route_short_name as published (e.g. "03846")
    serviceNumber,                       // e.g. "3846", or null
    serviceNumberSource,                 // 'tracker_verified' | 'feed_format' | null
    displayName: serviceNumber
      ? `${info.name} service ${serviceNumber}`
      : `${info.name ? `${info.name} route` : 'Route'} ${code ?? ''}`.trim(),
    vehicleNumber: null,                 // string | null
    vehicleNumberSource: null,           // 'apsrtc' | 'external_tracker' | null
    vehicleNumberConfidence: 'unknown'   // 'live' | 'published' | 'unknown'
  };
  // External tracker OPTIONS (never live data): only for a real service number; nothing is queried.
  return { ...identity, tracking: trackingOptionsFor(identity) };
}

// ROUTE / SCHEDULE trust of a transit leg: "is this bus in our timetable, and how sure is the time?". It is derived only
// from the dataset and the leg's own confidence, never from live-tracking status (a bus a tracker does not know is still
// a timetable bus). "verified" / "live" are not schedule-source levels here, so they are reported as at most "published".
const SCHEDULE_TRUST = Object.freeze({ live: 'published', verified: 'published', published: 'published', inferred: 'inferred', estimated: 'estimated', unknown: 'unknown' });

export function routeTrust(dataset, legConfidence) {
  return {
    sourceType: 'gtfs',
    sourceName: dataset?.name ?? null,
    scheduleConfidence: SCHEDULE_TRUST[legConfidence] ?? 'unknown',
    timetableBacked: true // every transit leg is a trip of the imported GTFS timetable
  };
}

// First/last-mile leg: a walk, or a GENERIC local ride (never a named provider, never "available").
function endLeg(kind, leg, from, to, departureSeconds, fmt, fareConfig) {
  const arrivalSeconds = departureSeconds + leg.durationSeconds;
  if (leg.mode === 'local_ride') {
    return {
      mode: 'local_ride',
      kind,
      label: 'Estimated local ride',
      from,
      to,
      distanceMeters: leg.distanceMeters,
      straightLineMeters: leg.straightLineMeters,
      durationSeconds: leg.durationSeconds,
      rideSeconds: leg.rideSeconds,
      pickupWaitSeconds: leg.pickupWaitSeconds,
      departureTime: fmt(departureSeconds),
      arrivalTime: fmt(arrivalSeconds),
      dataConfidence: 'estimated',
      durationConfidence: 'estimated',
      providerIntegration: false,
      availabilityStatus: 'unknown',
      isRealtime: false,
      // Possible ride services in this city (published city-level coverage only; never availability, never priced).
      ...(({ city, providerOptions }) => ({ providerCity: city, providerOptions }))(providerOptionsForRide(from, to)),
      fare: estimateLocalRideFare({ roadDistanceKm: leg.distanceMeters / 1000 }, fareConfig)
    };
  }
  return {
    mode: 'walk',
    kind,
    from,
    to,
    distanceMeters: leg.distanceMeters,
    straightLineMeters: leg.straightLineMeters,
    durationSeconds: leg.durationSeconds,
    departureTime: fmt(departureSeconds),
    arrivalTime: fmt(arrivalSeconds),
    dataConfidence: 'estimated'
  };
}

/**
 * @param network
 * @param {{chain:{accessStop:number, segments:Object[]}, egressStop:number}} candidate
 * @param ctx  { anchorDayNumber, serviceDays, dataset, config, fareConfig, origin, destination, accessByStop, egressByStop, datasetConfidence }
 */
export function assembleJourney(network, candidate, ctx) {
  const { chain, egressStop } = candidate;
  const { anchorDayNumber, serviceDays, dataset, config } = ctx;
  const fareConfig = ctx.fareConfig ?? getFareConfig();
  const fmt = seconds => formatLocalDateTime(anchorDayNumber, seconds, config.utcOffset);

  const access = ctx.accessByStop.get(chain.accessStop);
  const egress = ctx.egressByStop.get(egressStop);

  // Absolute times of every transit segment (seconds from the anchor day's midnight).
  const timed = chain.segments.map(segment => {
    if (segment.kind === 'foot') return { ...segment, ...footLeg(network, segment) };
    const pattern = network.patterns[segment.pattern];
    const day = serviceDays[segment.offIdx];
    const base = segment.trip * pattern.n;
    return {
      ...segment,
      depAbs: pattern.dep[base + segment.boardPos] + day.offsetSeconds,
      arrAbs: pattern.arr[base + segment.alightPos] + day.offsetSeconds,
      day
    };
  });
  const transitSegments = timed.filter(segment => segment.kind === 'transit');
  if (transitSegments.length === 0) {
    // A journey made only of local rides / walking is never produced: feeders exist only to reach timetable transit.
    throw new Error('A journey must contain at least one timetable (GTFS) transit leg.');
  }

  // Leave the origin as late as possible while still catching the first vehicle.
  const accessSeconds = access?.durationSeconds ?? 0;
  const originDeparture = transitSegments[0].depAbs - accessSeconds;

  const legs = [];
  const transitConfidences = [];
  const allConfidences = [];
  const idParts = [];
  let walkingSeconds = 0;
  let waitingSeconds = 0;
  let rideSeconds = 0;
  let rideCount = 0;
  let rideStraightMeters = 0;
  let transitStraightMeters = 0;
  let worstQuality = 0;

  if (access && accessSeconds > 0) {
    const from = { type: 'origin', name: 'Origin', lat: ctx.origin.lat, lon: ctx.origin.lon };
    legs.push(endLeg('access', access, from, stopRef(network, chain.accessStop), originDeparture, fmt, fareConfig));
    allConfidences.push(CONFIDENCE.ESTIMATED);
    if (access.mode === 'local_ride') { rideSeconds += accessSeconds; rideCount++; rideStraightMeters += access.straightLineMeters; }
    else walkingSeconds += accessSeconds;
  }

  let clock = originDeparture + accessSeconds; // when the traveller is standing at the current stop
  let transitSeen = false;
  for (const segment of timed) {
    if (segment.kind === 'foot') {
      legs.push({
        mode: 'walk',
        kind: 'transfer',
        from: stopRef(network, segment.from),
        to: stopRef(network, segment.to),
        distanceMeters: segment.meters,
        durationSeconds: segment.seconds,
        departureTime: fmt(clock),
        arrivalTime: fmt(clock + segment.seconds),
        dataConfidence: 'estimated'
      });
      walkingSeconds += segment.seconds;
      allConfidences.push(CONFIDENCE.ESTIMATED);
      clock += segment.seconds;
      continue;
    }

    const pattern = network.patterns[segment.pattern];
    const route = network.routes[pattern.routeIdx];
    const base = segment.trip * pattern.n;

    if (transitSeen) waitingSeconds += Math.max(0, segment.depAbs - clock); // waiting at a transfer, never at the origin
    transitSeen = true;

    let worst = 0;
    for (let i = segment.boardPos; i <= segment.alightPos; i++) worst = Math.max(worst, pattern.quality[base + i]);
    worstQuality = Math.max(worstQuality, worst);

    // Confidence is judged for the service date the trip actually runs on, then limited by time quality.
    const serviceDate = dayNumberToIso(segment.day.dayNumber);
    const confidence = capConfidence(effectiveConfidence(dataset, serviceDate), qualityCap(worst));
    transitConfidences.push(confidence);
    allConfidences.push(confidence);

    const boardStop = pattern.stops[segment.boardPos];
    const alightStop = pattern.stops[segment.alightPos];
    const sequenceMeters = stopSequenceMeters(network, pattern, segment.boardPos, segment.alightPos);
    transitStraightMeters += haversineMeters(network.stopLat[boardStop], network.stopLon[boardStop], network.stopLat[alightStop], network.stopLon[alightStop]);
    legs.push({
      mode: route.mode,
      routeId: route.sourceId,
      routeShortName: route.shortName,
      routeLongName: route.longName,
      ...busIdentity(route, dataset),
      tripId: pattern.tripSourceIds[segment.trip],
      headsign: pattern.headsigns[segment.trip],
      fromStop: stopRef(network, boardStop),
      toStop: stopRef(network, alightStop),
      departureTime: fmt(segment.depAbs),
      arrivalTime: fmt(segment.arrAbs),
      gtfsDepartureTime: formatGtfsTime(pattern.dep[base + segment.boardPos]),
      gtfsArrivalTime: formatGtfsTime(pattern.arr[base + segment.alightPos]),
      serviceDate,
      scheduleBasis: segment.day.extrapolated ? 'extrapolated_weekly_pattern' : 'published_calendar',
      durationSeconds: segment.arrAbs - segment.depAbs,
      distanceMeters: sequenceMeters, // straight-line length along the stop sequence (a lower bound of the road distance)
      intermediateStopCount: Math.max(0, segment.alightPos - segment.boardPos - 1),
      datasetId: dataset?.id ?? null,
      dataConfidence: confidence,
      routeTrust: routeTrust(dataset, confidence),
      timeQuality: TIME_QUALITY_NAMES[worst],
      // Estimated range: the feed has no fares or service class. Never an exact amount.
      fare: route.mode === 'bus' ? estimateBusFare({ distanceKm: sequenceMeters / 1000 }, fareConfig) : null
    });
    idParts.push([
      pattern.tripSourceIds[segment.trip],
      network.stopSourceIds[boardStop],
      network.stopSourceIds[alightStop],
      serviceDate,
      pattern.dep[base + segment.boardPos]
    ].join('|'));
    clock = segment.arrAbs;
  }

  const finalArrival = clock;
  const egressSeconds = egress?.durationSeconds ?? 0;
  if (egress && egressSeconds > 0) {
    const to = { type: 'destination', name: 'Destination', lat: ctx.destination.lat, lon: ctx.destination.lon };
    legs.push(endLeg('egress', egress, stopRef(network, egressStop), to, finalArrival, fmt, fareConfig));
    allConfidences.push(CONFIDENCE.ESTIMATED);
    if (egress.mode === 'local_ride') { rideSeconds += egressSeconds; rideCount++; rideStraightMeters += egress.straightLineMeters; }
    else walkingSeconds += egressSeconds;
  }

  const arrival = finalArrival + egressSeconds;

  // Access / egress are part of the identity: the same buses reached on foot vs by ride are different journeys.
  idParts.unshift(`A:${access?.mode ?? 'none'}:${network.stopSourceIds[chain.accessStop]}`);
  idParts.push(`E:${egress?.mode ?? 'none'}:${network.stopSourceIds[egressStop]}`);

  return {
    // Deterministic: derived only from access/egress, trips, boarding/alighting stops, service dates and scheduled times.
    id: 'jr_' + crypto.createHash('sha1').update(idParts.join('>')).digest('hex').slice(0, 16),
    labels: [],
    departureTime: fmt(originDeparture),
    arrivalTime: fmt(arrival),
    totalDurationSeconds: arrival - originDeparture,
    walkingDurationSeconds: walkingSeconds,
    waitingDurationSeconds: waitingSeconds,
    localRideDurationSeconds: rideSeconds,
    localRideCount: rideCount,
    transfers: transitSegments.length - 1,
    transitLegCount: transitSegments.length,
    transitDistanceMeters: Math.round(transitStraightMeters),
    localRideDistanceMeters: Math.round(rideStraightMeters),
    datasetConfidence: ctx.datasetConfidence,
    scheduleConfidence: weakestConfidence(transitConfidences), // transit legs only
    confidence: weakestConfidence(allConfidences),             // weakest leg overall (walking / local rides are estimated)
    timeQuality: TIME_QUALITY_NAMES[worstQuality],
    tracking: journeyTracking(legs), // live-tracking summary; independent of scheduleConfidence
    fare: null, // no PUBLISHED fare exists; estimated ranges live in fareEstimate and on each leg
    fareEstimate: estimateJourneyFare(legs, fareConfig),
    legs,
    // internal numeric times for ranking; removed from the API response
    _departureSeconds: originDeparture,
    _arrivalSeconds: arrival
  };
}

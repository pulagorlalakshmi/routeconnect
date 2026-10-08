// Builds complete door-to-door journeys around TRUNK legs from non-GTFS sources (trains, flights):
//
//   origin --[walk | estimated local ride | GTFS bus]--> station/airport --(buffer)--> TRUNK... --(buffer)--> station/airport
//          --[walk | estimated local ride]--> destination
//
// Bounded on purpose: one trunk sequence per journey (a train, or one flight offer with its connections), at most
// `maxTrunks` sequences per source, and at most one transit-access alternative per trunk. Nothing is added that the
// sources did not provide: the access/egress legs are the same ESTIMATED walk / local-ride model the bus planner uses.
import crypto from 'node:crypto';
import { haversineMeters } from '../routing/geo.js';
import { estimateWalk, estimateLocalRide } from '../routing/accessEgress.js';
import { estimateLocalRideFare, estimateJourneyFare } from '../fare/fareEstimator.js';
import { providerOptionsForRide } from '../localRide/providerCoverage.js';
import { weakestConfidence } from '../confidence.js';
import { formatLocalDateTime, isoToDayNumber } from '../routing/serviceCalendar.js';

export const COMPOSE_DEFAULTS = Object.freeze({
  maxTrunks: 6,
  walkMaxMeters: 1000,
  // Time to be at the station/airport before departure, and to get out after arrival (estimated, shown as waiting).
  bufferBeforeSeconds: Object.freeze({ rail: 15 * 60, air: 75 * 60 }),
  bufferAfterSeconds: Object.freeze({ rail: 5 * 60, air: 20 * 60 })
});

const SOURCE_TYPE = { rail: 'rail_timetable', air: 'flight_api' };
const toMs = iso => Date.parse(iso);
const shiftIso = (iso, seconds, utcOffset) => {
  // Re-express (iso + seconds) in the search's local offset, the format every other leg uses.
  const ms = toMs(iso) + seconds * 1000;
  const offsetMinutes = (() => { const m = /([+-])(\d{2}):(\d{2})$/.exec(utcOffset); return m ? (m[1] === '-' ? -1 : 1) * (Number(m[2]) * 60 + Number(m[3])) : 0; })();
  const local = new Date(ms + offsetMinutes * 60000);
  const day = isoToDayNumber(local.toISOString().slice(0, 10));
  const secondOfDay = local.getUTCHours() * 3600 + local.getUTCMinutes() * 60 + local.getUTCSeconds();
  return formatLocalDateTime(day, secondOfDay, utcOffset);
};

function endLeg(kind, point, from, to, config, fareConfig) {
  const straight = haversineMeters(from.lat, from.lon, to.lat, to.lon);
  if (straight <= COMPOSE_DEFAULTS.walkMaxMeters) {
    const walk = estimateWalk(straight, config);
    return { mode: 'walk', kind, from, to, distanceMeters: walk.distanceMeters, straightLineMeters: walk.straightLineMeters, durationSeconds: walk.durationSeconds, dataConfidence: 'estimated' };
  }
  const ride = estimateLocalRide(straight, config);
  return {
    mode: 'local_ride', kind, label: 'Estimated local ride', from, to,
    distanceMeters: ride.distanceMeters, straightLineMeters: ride.straightLineMeters, durationSeconds: ride.durationSeconds,
    rideSeconds: ride.rideSeconds, pickupWaitSeconds: ride.pickupWaitSeconds,
    dataConfidence: 'estimated', durationConfidence: 'estimated', providerIntegration: false, availabilityStatus: 'unknown', isRealtime: false,
    ...(({ city, providerOptions }) => ({ providerCity: city, providerOptions }))(providerOptionsForRide(from, to)),
    fare: estimateLocalRideFare({ roadDistanceKm: ride.distanceMeters / 1000 }, fareConfig)
  };
}

function trunkLeg(trunk, index) {
  const scheduleConfidence = trunk.scheduleConfidence ?? 'inferred';
  return {
    mode: trunk.mode,
    routeId: trunk.trainNumber ?? trunk.flightNumber ?? null,
    routeShortName: trunk.trainNumber ?? trunk.flightNumber ?? null,
    routeLongName: trunk.trainName ?? null,
    operator: trunk.operator ?? null,
    operatorInfo: trunk.operatorInfo,
    routeCode: trunk.trainNumber ?? trunk.flightNumber ?? null,
    serviceNumber: null, // train/flight numbers are their own fields; "service number" is the APSRTC concept
    serviceNumberSource: null,
    trainNumber: trunk.trainNumber ?? null,
    trainName: trunk.trainName ?? null,
    flightNumber: trunk.flightNumber ?? null,
    displayName: trunk.displayName,
    daysOfOperation: trunk.daysOfOperation ?? null,
    intermediateStops: trunk.intermediateStops ?? null,
    tripId: `${trunk.trainNumber ?? trunk.flightNumber ?? trunk.offerId ?? 'trunk'}@${trunk.departureTime}`,
    headsign: null,
    fromStop: trunk.from,
    toStop: trunk.to,
    departureTime: trunk.departureTime,
    arrivalTime: trunk.arrivalTime,
    serviceDate: trunk.departureTime.slice(0, 10),
    scheduleBasis: 'published_timetable',
    durationSeconds: trunk.durationSeconds,
    intermediateStopCount: trunk.intermediateStopCount ?? 0,
    datasetId: null,
    dataConfidence: scheduleConfidence,
    timeQuality: trunk.timeQuality ?? 'approximate',
    routeTrust: { sourceType: SOURCE_TYPE[trunk.mode] ?? 'other', sourceName: trunk.source?.name ?? null, scheduleConfidence, timetableBacked: true },
    tracking: null, // no tracker integration for trains / flights
    fare: trunk.fare ?? null,
    // Connecting flight segments are priced as one offer, on the first segment.
    ...(index > 0 && trunk.mode === 'air' ? { fareIncludedWithLeg: true } : {}),
    source: trunk.source ?? null
  };
}

/**
 * @param trunks   one trunk sequence (array of trunk legs from one source)
 * @param ctx      { origin:{lat,lon,name?}, destination:{lat,lon,name?}, utcOffset, config, fareConfig, transitAccess? }
 * @returns journeys (0..2): ride/walk access, and optionally a GTFS-bus access alternative
 */
export function composeAroundTrunk(trunks, ctx) {
  const first = trunks[0];
  const last = trunks.at(-1);
  const mode = first.mode;
  const before = COMPOSE_DEFAULTS.bufferBeforeSeconds[mode] ?? 0;
  const after = COMPOSE_DEFAULTS.bufferAfterSeconds[last.mode] ?? 0;
  const originPlace = { type: 'origin', name: ctx.origin.name ?? 'Origin', lat: ctx.origin.lat, lon: ctx.origin.lon };
  const destinationPlace = { type: 'destination', name: ctx.destination.name ?? 'Destination', lat: ctx.destination.lat, lon: ctx.destination.lon };

  const egress = endLeg('egress', null, last.to, destinationPlace, ctx.config, ctx.fareConfig);
  const egressStart = shiftIso(last.arrivalTime, after, ctx.utcOffset);
  const egressLeg = { ...egress, departureTime: egressStart, arrivalTime: shiftIso(egressStart, egress.durationSeconds, ctx.utcOffset) };
  const trunkLegs = trunks.map(trunkLeg);

  const variants = [];
  const access = endLeg('access', null, originPlace, first.from, ctx.config, ctx.fareConfig);
  const accessArrive = shiftIso(first.departureTime, -before, ctx.utcOffset);
  variants.push([{ ...access, departureTime: shiftIso(accessArrive, -access.durationSeconds, ctx.utcOffset), arrivalTime: accessArrive }]);

  // Optional: reach the station by timetable bus instead (bus + train). Bounded: at most one alternative, and only when
  // the station is too far to walk.
  if (ctx.transitAccess && access.mode === 'local_ride') {
    const legs = ctx.transitAccess(originPlace, first.from, toMs(accessArrive));
    if (Array.isArray(legs) && legs.length > 0) variants.push(legs);
  }

  return variants.map(accessLegs => buildJourney([...accessLegs, ...trunkLegs, egressLeg], { trunkLegs, ctx }));
}

function buildJourney(legs, { trunkLegs, ctx }) {
  const vehicle = legs.filter(leg => leg.mode !== 'walk' && leg.mode !== 'local_ride');
  const departure = legs[0].departureTime;
  const arrival = legs.at(-1).arrivalTime;
  const total = Math.round((toMs(arrival) - toMs(departure)) / 1000);
  const moving = legs.reduce((sum, leg) => sum + (leg.durationSeconds ?? 0), 0);
  const walking = legs.filter(leg => leg.mode === 'walk').reduce((sum, leg) => sum + leg.durationSeconds, 0);
  const rides = legs.filter(leg => leg.mode === 'local_ride');
  const confidences = vehicle.map(leg => leg.dataConfidence);
  const idParts = legs.map(leg => `${leg.mode}:${leg.tripId ?? leg.kind ?? ''}:${leg.departureTime}`);
  return {
    id: 'jr_' + crypto.createHash('sha1').update(idParts.join('>')).digest('hex').slice(0, 16),
    labels: [],
    departureTime: departure,
    arrivalTime: arrival,
    totalDurationSeconds: total,
    walkingDurationSeconds: walking,
    waitingDurationSeconds: Math.max(0, total - moving), // includes the station/airport buffers
    localRideDurationSeconds: rides.reduce((sum, leg) => sum + leg.durationSeconds, 0),
    localRideCount: rides.length,
    transfers: Math.max(0, vehicle.length - 1),
    transitLegCount: vehicle.length,
    transitDistanceMeters: Math.round(trunkLegs.reduce((sum, leg) => sum + haversineMeters(leg.fromStop.lat, leg.fromStop.lon, leg.toStop.lat, leg.toStop.lon), 0)),
    datasetConfidence: weakestConfidence(confidences),
    scheduleConfidence: weakestConfidence(confidences),
    confidence: weakestConfidence([...confidences, ...(rides.length || walking ? ['estimated'] : [])]),
    timeQuality: vehicle.every(leg => leg.timeQuality === 'exact') ? 'exact' : 'approximate',
    fare: null,
    fareEstimate: estimateJourneyFare(legs, ctx.fareConfig), // connecting segments priced once (fareIncludedWithLeg)
    tracking: { busLegs: 0, verifiedLegs: 0, notFoundLegs: 0, allVerified: false },
    legs
  };
}

// Journey planner: ties the pieces together. No SQL here (the network is already in memory) and no Express.
//
//   planJourneys(network, query, options)   -> response body for a validated query
//   handlePlanRequest(rawQuery, options)    -> { status, body } for GET /api/v2/plan
//
// Range query strategy ("repeated RAPTOR over a departure window"): every trip that can be caught from a nearby
// stop inside [time, time + window] defines a candidate origin-departure time. RAPTOR runs once per candidate
// (capped) plus once at the requested time; journeys are de-duplicated by their deterministic id, filtered to the
// window, Pareto-reduced and labelled.
import { performance } from 'node:perf_hooks';
import { getRoutingConfig } from './config.js';
import { getTransitNetwork } from './dataLoader.js';
import { parsePlanQuery } from './planQuery.js';
import { findWalkLegs } from './accessEgress.js';
import { selectFeederCandidates } from './feeder.js';
import { getFareConfig } from '../fare/fareConfig.js';
import { createWorkspace, runRaptor } from './raptor.js';
import { assembleJourney, extractRunCandidates } from './journeyBuilder.js';
import { rankJourneys } from './ranking.js';
import { haversineMeters } from './geo.js';
import { resolvePlace } from './placeSearch.js';
import { isoToDayNumber, resolveActiveServices, isDayWithinValidity } from './serviceCalendar.js';
import { effectiveConfidence, getValidity, todayInTimezone } from '../datasetMetadata.js';
import { SECONDS_PER_DAY } from './types.js';

// Shown only after walking AND local-ride access, and RAPTOR itself, have all been tried. The planner never substitutes an
// alternative (no ride-hailing, no ride-only "journey", no guesses).
export const NO_ROUTE_MESSAGE = 'No timetable-supported public-transport journey was found within the configured access range.';

const round1 = value => Math.round(value * 10) / 10;

// Calendar service days that can contribute trips to this search: D-k .. D+m (see serviceCalendar.js).
export function buildServiceDays(network, query, config) {
  const dataset = network.dataset ?? {};
  const anchor = isoToDayNumber(query.date);
  const firstDay = -Math.floor(network.maxTripTimeSeconds / SECONDS_PER_DAY);
  const lastDay = Math.floor((query.timeSeconds + query.windowMinutes * 60 + config.maxJourneyHours * 3600) / SECONDS_PER_DAY);
  const serviceDays = [];
  for (let d = firstDay; d <= lastDay; d++) {
    const dayNumber = anchor + d;
    const outside = !isDayWithinValidity(dayNumber, dataset.valid_from, dataset.valid_to);
    const extrapolated = config.extrapolateOutsideValidity && outside;
    serviceDays.push({
      offsetSeconds: d * SECONDS_PER_DAY,
      dayNumber,
      extrapolated,
      active: resolveActiveServices(network.serviceIndex, dayNumber, { extrapolate: extrapolated })
    });
  }
  return serviceDays;
}

// Origin-departure times at which a different first trip becomes catchable, inside [windowStart, windowEnd].
function candidateDepartures(network, accessLegs, serviceDays, windowStart, windowEnd, maxRuns) {
  const times = new Set([windowStart]);
  for (const leg of accessLegs) {
    const s = leg.stopIdx;
    for (let e = network.stopPatternOffsets[s]; e < network.stopPatternOffsets[s + 1]; e++) {
      const pattern = network.patterns[network.stopPatternPattern[e]];
      const pos = network.stopPatternPos[e];
      if (pos >= pattern.n - 1 || pattern.pickup[pos] !== 1) continue;
      for (let j = 0; j < pattern.tripCount; j++) {
        for (const day of serviceDays) {
          if (day.active[pattern.service[j]] !== 1) continue;
          const origin = pattern.dep[j * pattern.n + pos] + day.offsetSeconds - leg.durationSeconds;
          if (origin >= windowStart && origin <= windowEnd) times.add(origin);
        }
      }
    }
  }
  const sorted = [...times].sort((a, b) => a - b);
  if (sorted.length <= maxRuns) return sorted;
  // Too many: keep the first and last and an even deterministic spread in between.
  const picked = new Set([0, sorted.length - 1]);
  for (let i = 1; i < maxRuns - 1; i++) picked.add(Math.round((i * (sorted.length - 1)) / (maxRuns - 1)));
  return [...picked].sort((a, b) => a - b).map(index => sorted[index]);
}

function datasetSummary(network, query, config, now) {
  const dataset = network.dataset ?? {};
  const bounds = { validFrom: dataset.valid_from, validTo: dataset.valid_to };
  const forSearch = getValidity(bounds, query.date);
  const today = getValidity(bounds, todayInTimezone(config.timezone, now));
  return {
    id: dataset.id ?? null,
    name: dataset.name ?? null,
    sourceType: dataset.source_type ?? null,
    license: dataset.license ?? 'unknown',
    verified: dataset.verified === 1 || dataset.verified === true,
    confidence: dataset.confidence_default ?? 'unknown',
    effectiveConfidence: effectiveConfidence(dataset, query.date),
    validFrom: dataset.valid_from ?? null,
    validTo: dataset.valid_to ?? null,
    retrievedAt: dataset.retrieved_at ?? null,
    importedAt: dataset.imported_at ?? null,
    coversSearchDate: forSearch.currentlyValid,
    feedCurrentlyValid: today.currentlyValid,
    scheduleBasis: forSearch.currentlyValid || !config.extrapolateOutsideValidity ? 'published_calendar' : 'extrapolated_weekly_pattern'
  };
}

// How this works (tiered access, complete-journey selection):
//
//   Tier 1  WALK     candidates: stops within walkAccessRadius / walkEgressRadius (nearest N).
//   Tier 2  FEEDER   candidates: stops beyond the walking radius, up to feederAccessRadius / feederEgressRadius,
//                    scored from the timetable and bounded (see feeder.js). Reached by an ESTIMATED generic local ride.
//
// Each tier runs RAPTOR ONCE per departure time with ALL of its candidates as sources/targets, so the boarding and
// alighting stops are chosen by the best COMPLETE door-to-door journey, never by "nearest stop". Tier 2 contains the
// tier-1 candidates as well. A ride-assisted journey is offered only when no walk-only journey exists in the window or
// when it arrives at least feederMinimumGainSeconds earlier than the best walk-only one: a local ride has to earn its
// place. Every journey contains at least one GTFS transit leg (rounds >= 1); a ride-only journey cannot exist.
export function planJourneys(network, query, { config = getRoutingConfig(), fareConfig = getFareConfig(), now = new Date(), resolved = null } = {}) {
  const startedAt = performance.now();
  const dataset = network.dataset ?? {};
  const info = datasetSummary(network, query, config, now);
  const warnings = [];
  const warn = (code, severity, message) => warnings.push({ code, severity, message });

  const baseResponse = {
    query: {
      fromLat: query.fromLat, fromLng: query.fromLng, toLat: query.toLat, toLng: query.toLng,
      date: query.date, time: query.time, maxTransfers: query.maxTransfers, windowMinutes: query.windowMinutes,
      timezone: config.timezone
    },
    dataset: info
  };

  // ---- Dataset honesty ----
  let datasetWarning = null;
  if (!info.coversSearchDate && dataset.valid_to) {
    datasetWarning = `Transit schedule is based on a community dataset last valid through ${dataset.valid_to}.`
      + (config.extrapolateOutsideValidity ? ` The weekly pattern is extrapolated to ${query.date}, so times are inferred, not published.` : '');
    warn('SEARCH_DATE_OUTSIDE_FEED_VALIDITY', 'warning', datasetWarning);
  } else if (!info.feedCurrentlyValid && dataset.valid_to) {
    datasetWarning = `Transit schedule is based on a community dataset last valid through ${dataset.valid_to}.`;
    warn('FEED_EXPIRED', 'warning', datasetWarning);
  }
  warn('UNVERIFIED_DATASET', 'info', 'Schedule data comes from a community-maintained dataset and has not been verified by the transit operator.');

  const origin = { lat: query.fromLat, lon: query.fromLng };
  const destination = { lat: query.toLat, lon: query.toLng };
  const serviceDays = buildServiceDays(network, query, config);
  const anchorDayNumber = isoToDayNumber(query.date);
  const windowStart = query.timeSeconds;
  const windowEnd = windowStart + query.windowMinutes * 60;
  const horizonSeconds = config.maxJourneyHours * 3600;

  // ---- Tier 1: walking candidates ----
  const walking = { walkSpeedMetersPerSecond: config.walkSpeedMetersPerSecond, walkDetourFactor: config.walkDetourFactor };
  const walkAccess = findWalkLegs(network.stopIndex, origin, { ...walking, radiusMeters: config.walkAccessRadiusMeters, maxStops: config.maxWalkAccessCandidates });
  const walkEgress = findWalkLegs(network.stopIndex, destination, { ...walking, radiusMeters: config.walkEgressRadiusMeters, maxStops: config.maxWalkEgressCandidates });

  // ---- Tier 2: bounded local-ride candidates beyond walking distance ----
  const feederBase = { serviceDays, windowStart, windowEnd, horizonSeconds, config };
  const feederAccess = selectFeederCandidates(network, origin, {
    ...feederBase, role: 'access', radiusMeters: config.feederAccessRadiusMeters, excludeWithinMeters: config.walkAccessRadiusMeters,
    maxCandidates: config.maxFeederCandidates, otherPoint: destination
  });
  const feederEgress = selectFeederCandidates(network, destination, {
    ...feederBase, role: 'egress', radiusMeters: config.feederEgressRadiusMeters, excludeWithinMeters: config.walkEgressRadiusMeters,
    maxCandidates: config.maxFeederCandidates, otherPoint: origin
  });

  const describe = leg => ({
    stopId: network.stopSourceIds[leg.stopIdx],
    name: network.stopNames[leg.stopIdx],
    roadDistanceMeters: leg.distanceMeters,
    estimatedMinutes: Math.round(leg.durationSeconds / 60),
    servicesInWindow: leg.hub?.services ?? null
  });
  const accessInfo = {
    walkRadiusMeters: config.walkAccessRadiusMeters,
    feederRadiusMeters: Math.max(config.feederAccessRadiusMeters, config.feederEgressRadiusMeters),
    walkOriginStops: walkAccess.length,
    walkDestinationStops: walkEgress.length,
    feederOriginCandidates: feederAccess.map(describe),
    feederDestinationCandidates: feederEgress.map(describe),
    usedLocalRide: false
  };

  const performanceBlock = {
    networkLoadTimeMs: network.loadInfo?.loadTimeMs ?? network.stats.buildTimeMs,
    networkCached: (network.loadInfo?.requestsServed ?? 0) > 0,
    queryTimeMs: 0,
    rangeSearches: 0,
    roundsExecuted: 0,
    patternsScanned: 0,
    journeysGenerated: 0,
    journeysAfterDedupe: 0,
    journeysReturned: 0,
    accessStops: walkAccess.length + feederAccess.length,
    egressStops: walkEgress.length + feederEgress.length
  };
  const noWinners = { fastest: null, leastTransfers: null, bestBalanced: null, lowerEstimatedCost: null };
  const finish = (journeys, winners = noWinners) => {
    performanceBlock.queryTimeMs = round1(performance.now() - startedAt);
    performanceBlock.journeysReturned = journeys.length;
    accessInfo.usedLocalRide = journeys.some(journey => journey.localRideCount > 0);
    if (journeys.length > 0 && !journeys.some(journey => journey.fareEstimate)) {
      warn('NO_FARE_DATA', 'info', 'Fares are unavailable for these journeys.');
    }
    return {
      ...baseResponse,
      resolved,
      access: accessInfo,
      message: journeys.length === 0 ? NO_ROUTE_MESSAGE : null,
      datasetWarning,
      warnings,
      winners,
      journeys,
      performance: performanceBlock
    };
  };

  const crowFlies = haversineMeters(query.fromLat, query.fromLng, query.toLat, query.toLng);
  if (crowFlies < config.directWalkWarningMeters) {
    warn('ORIGIN_DESTINATION_WALKABLE', 'info', `Origin and destination are only ${Math.round(crowFlies)} m apart; walking may be quicker than any transit journey.`);
  }
  const accessReach = Math.max(config.walkAccessRadiusMeters, config.feederAccessRadiusMeters);
  const egressReach = Math.max(config.walkEgressRadiusMeters, config.feederEgressRadiusMeters);
  if (walkAccess.length + feederAccess.length === 0) {
    warn('NO_STOPS_NEAR_ORIGIN', 'warning', `No usable transit stop within ${accessReach} m of the origin.`);
    warn('NO_JOURNEY_FOUND', 'warning', 'Walking and local-ride access were both tried; neither reached a stop with usable service.');
    return finish([]);
  }
  if (walkEgress.length + feederEgress.length === 0) {
    warn('NO_STOPS_NEAR_DESTINATION', 'warning', `No usable transit stop within ${egressReach} m of the destination.`);
    warn('NO_JOURNEY_FOUND', 'warning', 'Walking and local-ride egress were both tried; neither reached a stop with usable service.');
    return finish([]);
  }

  // ---- Range search: RAPTOR once per departure time, all candidates of a tier at once ----
  const workspace = createWorkspace(network, query.maxTransfers + 2);
  const searchTier = (accessLegs, egressLegs) => {
    const unique = new Map();
    const fromEarliestRun = new Set();
    if (accessLegs.length === 0 || egressLegs.length === 0) return { unique, fromEarliestRun };

    const accessByStop = new Map(accessLegs.map(leg => [leg.stopIdx, leg]));
    const egressByStop = new Map(egressLegs.map(leg => [leg.stopIdx, leg]));
    const egressSeconds = new Int32Array(network.stopCount).fill(-1);
    for (const leg of egressLegs) egressSeconds[leg.stopIdx] = leg.durationSeconds;
    const ctx = {
      anchorDayNumber, serviceDays, dataset, config, fareConfig, origin, destination,
      accessByStop, egressByStop, egressLegs, datasetConfidence: info.effectiveConfidence
    };

    const departures = candidateDepartures(network, accessLegs, serviceDays, windowStart, windowEnd, config.maxRangeSearches);
    for (const departure of departures) {
      const run = runRaptor(network, {
        accessLegs, departureTime: departure, maxTransfers: query.maxTransfers, serviceDays, egressSeconds,
        horizonTime: departure + horizonSeconds, boardingBufferSeconds: config.boardingBufferSeconds
      }, workspace);
      performanceBlock.rangeSearches++;
      performanceBlock.roundsExecuted += run.stats.roundsExecuted;
      performanceBlock.patternsScanned += run.stats.patternsScanned;

      for (const candidate of extractRunCandidates(network, run, ctx)) {
        const journey = assembleJourney(network, candidate, ctx);
        performanceBlock.journeysGenerated++;
        // A local ride is a FEEDER: the bus must cover clearly more ground than the ride, or the "journey" is really a taxi trip.
        if (journey.localRideCount > 0 && journey.transitDistanceMeters < config.minTransitToRideRatio * journey.localRideDistanceMeters) continue;
        if (!unique.has(journey.id)) unique.set(journey.id, journey);
        if (departure === windowStart) fromEarliestRun.add(journey.id);
      }
    }
    return { unique, fromEarliestRun };
  };

  const walkOnly = searchTier(walkAccess, walkEgress);
  const withRides = (feederAccess.length > 0 || feederEgress.length > 0)
    ? searchTier([...walkAccess, ...feederAccess], [...walkEgress, ...feederEgress])
    : { unique: new Map(), fromEarliestRun: new Set() };
  performanceBlock.journeysAfterDedupe = new Set([...walkOnly.unique.keys(), ...withRides.unique.keys()]).size;

  // Walk-only journeys come first; a ride-assisted journey must earn its place (see header comment).
  const inWindow = journey => journey._departureSeconds <= windowEnd;
  const pool = (walkList, otherList) => {
    const reference = walkList.length ? Math.min(...walkList.map(j => j._arrivalSeconds)) : Infinity;
    const out = new Map(walkList.map(j => [j.id, j]));
    for (const journey of otherList) {
      const earnsPlace = journey.localRideCount === 0 || reference === Infinity || journey._arrivalSeconds <= reference - config.feederMinimumGainSeconds;
      if (earnsPlace) out.set(journey.id, journey);
    }
    return [...out.values()];
  };

  let candidates = pool(
    [...walkOnly.unique.values()].filter(inWindow),
    [...withRides.unique.values()].filter(inWindow)
  );
  if (candidates.length === 0) {
    candidates = pool(
      [...walkOnly.unique.values()].filter(j => walkOnly.fromEarliestRun.has(j.id)),
      [...withRides.unique.values()].filter(j => withRides.fromEarliestRun.has(j.id))
    );
    if (candidates.length > 0) {
      warn('NO_DEPARTURE_IN_WINDOW', 'warning', 'No journey leaves inside the requested time window; showing the earliest available journey after it.');
    }
  }
  if (candidates.length === 0) {
    warn('NO_JOURNEY_FOUND', 'warning',
      `Walking${feederAccess.length + feederEgress.length > 0 ? ' and local-ride access' : ''} to timetable stops was tried; no journey within ${query.maxTransfers} transfer(s) was found for this date and time.`);
    return finish([]);
  }

  const ranked = rankJourneys(candidates, config.ranking);
  const journeys = ranked.journeys.map(({ _departureSeconds, _arrivalSeconds, ...journey }) => journey);

  if (journeys.some(journey => journey.timeQuality !== 'exact')) {
    warn('APPROXIMATE_TIMES', 'info', 'Stop times in this dataset are approximate (not exact timepoints); allow some margin.');
  }
  if (journeys.some(journey => journey.walkingDurationSeconds > 0)) {
    warn('WALKING_ESTIMATED', 'info', 'Walking legs are straight-line estimates, not road routing.');
  }
  if (journeys.some(journey => journey.localRideCount > 0)) {
    warn('LOCAL_RIDE_ESTIMATED', 'info', 'Local ride legs are estimates connecting you to a timetable bus. No ride provider is connected: availability is not verified, and duration and fare are approximate.');
  }
  if (journeys.some(journey => journey.fareEstimate)) {
    warn('FARE_ESTIMATED', 'info', 'Fares are approximate ranges estimated from route distance, not published fares. Bus service class is not in the dataset; actual fares may vary.');
  }
  return finish(journeys, ranked.winners);
}

const MAX_PLACE_TEXT = 80;

// HTTP-facing wrapper: place resolution + validation + network lookup + planning. Returns { status, body }.
//
// Each end of the journey is given either as coordinates (fromLat/fromLng, toLat/toLng) or as a place name
// (from / to). Names are resolved against the imported GTFS stops; coordinates win when both are present.
export function handlePlanRequest(rawQuery, { config = getRoutingConfig(), now = new Date(), getNetwork = getTransitNetwork } = {}) {
  const raw = { ...(rawQuery ?? {}) };

  let network = null;
  const obtainNetwork = () => {
    if (network) return null;
    try {
      network = getNetwork({ config });
    } catch (error) {
      console.error('Transit network load failed:', error.message);
      return { status: 500, body: { error: 'The transit network could not be loaded.' } };
    }
    if (!network) {
      return {
        status: 503,
        body: { error: 'Transit data is not available. Import a GTFS feed first (npm run transit:download, then npm run transit:import).' }
      };
    }
    return null;
  };

  const resolved = { from: null, to: null };
  for (const [end, latKey, lngKey] of [['from', 'fromLat', 'fromLng'], ['to', 'toLat', 'toLng']]) {
    if (raw[end] === undefined || raw[end] === '' || raw[latKey] !== undefined || raw[lngKey] !== undefined) continue;
    if (typeof raw[end] !== 'string' || raw[end].trim().length === 0 || raw[end].length > MAX_PLACE_TEXT) {
      return { status: 400, body: { error: 'Invalid query parameters', details: [`${end} must be a single place name of up to ${MAX_PLACE_TEXT} characters`] } };
    }
    const failure = obtainNetwork();
    if (failure) return failure;
    const text = raw[end].trim();
    const place = resolvePlace(network, text);
    if (!place) {
      return {
        status: 404,
        body: { error: `"${text}" is not a stop in the currently available transit dataset.`, code: 'PLACE_NOT_FOUND', place: end, query: text }
      };
    }
    raw[latKey] = String(place.lat);
    raw[lngKey] = String(place.lon);
    resolved[end] = { query: text, name: place.name, lat: place.lat, lon: place.lon, matchedBy: place.matchedBy, stopCount: place.stopCount };
  }

  const parsed = parsePlanQuery(raw, config, now);
  if (!parsed.ok) return { status: 400, body: { error: 'Invalid query parameters', details: parsed.errors } };

  const failure = obtainNetwork();
  if (failure) return failure;

  try {
    const body = planJourneys(network, parsed.value, { config, now, resolved: resolved.from || resolved.to ? resolved : null });
    if (network.loadInfo) network.loadInfo.requestsServed = (network.loadInfo.requestsServed ?? 0) + 1;
    return { status: 200, body };
  } catch (error) {
    console.error('Journey planning failed:', error);
    return { status: 500, body: { error: 'Journey planning failed.' } };
  }
}

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
import { buildAccessStages, createServiceCounter, selectFeederCandidates, selectWalkCandidates } from './feeder.js';
import { getConnectivity } from './hubs.js';
import { analyseReach, buildWindows, diagnoseNoRoute } from './diagnostics.js';
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

// How this works (progressive access search, complete-journey selection):
//
//   Stage 0  WALK     stops within the walking radius (nearest N that have service).
//   Stage k  FEEDER   stops beyond walking distance reached by an ESTIMATED generic local ride, with a radius that grows
//                     stage by stage (feederStageRadiiMeters, then hubStageRadiiMeters for strong hubs only). Candidates
//                     are chosen on BOTH sides of the journey from the timetable (hubScore, progress, ride time) and are
//                     bounded; see feeder.js.
//
// Every stage runs RAPTOR once per departure time with ALL of its candidates as sources/targets, so the boarding and
// alighting stops are chosen by the best COMPLETE door-to-door journey, never by "nearest stop". The search stops at the
// first stage whose journeys are acceptable (so large radii are only used when needed). If the requested time window yields
// nothing, it is widened in configured steps. A journey with more local rides must earn its place by arriving clearly
// earlier than the best journey with fewer; rides may not dominate a journey. Every journey contains at least one GTFS transit
// leg (rounds >= 1); a ride-only journey cannot exist.
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
  const horizonSeconds = config.maxJourneyHours * 3600;
  const stages = buildAccessStages(config);
  const windows = buildWindows(query.windowMinutes, config);
  const maxRadiusMeters = stages.at(-1).radiusMeters;
  const components = getConnectivity(network).component;
  const walking = { walkSpeedMetersPerSecond: config.walkSpeedMetersPerSecond, walkDetourFactor: config.walkDetourFactor };

  // Where can each end possibly reach? (Served stops within the largest radius, and which timetable networks they belong to.)
  const originReach = analyseReach(network, origin, Math.max(maxRadiusMeters, config.walkAccessRadiusMeters));
  const destinationReach = analyseReach(network, destination, Math.max(maxRadiusMeters, config.walkEgressRadiusMeters));
  const sharedComponents = new Set([...originReach.components].filter(c => destinationReach.components.has(c)));
  const allowedComponents = sharedComponents.size > 0 ? sharedComponents : null;

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
    accessStops: 0,
    egressStops: 0
  };
  const search = {
    windowRequestedMinutes: query.windowMinutes,
    windowsTriedMinutes: [],
    windowUsedMinutes: null,
    windowExpanded: false,
    maxRadiusMeters,
    stageUsed: null,
    radiusUsedMeters: null,
    stages: []
  };
  let finalAccess = { walk: [], feeder: [], all: [] };
  let finalEgress = { walk: [], feeder: [], all: [] };
  const noWinners = { fastest: null, leastTransfers: null, bestBalanced: null, lowerEstimatedCost: null, bestPath: null };
  let diagnostics = null;

  const describe = leg => ({
    stopId: network.stopSourceIds[leg.stopIdx],
    name: network.stopNames[leg.stopIdx],
    roadDistanceMeters: leg.distanceMeters,
    estimatedMinutes: Math.round(leg.durationSeconds / 60),
    servicesInWindow: leg.hub?.services ?? null,
    hubStrength: leg.hub?.strength ?? null
  });
  const finish = (journeys, winners = noWinners) => {
    performanceBlock.queryTimeMs = round1(performance.now() - startedAt);
    performanceBlock.journeysReturned = journeys.length;
    performanceBlock.accessStops = finalAccess.all.length;
    performanceBlock.egressStops = finalEgress.all.length;
    if (journeys.length > 0 && !journeys.some(journey => journey.fareEstimate)) {
      warn('NO_FARE_DATA', 'info', 'Fares are unavailable for these journeys.');
    }
    return {
      ...baseResponse,
      resolved,
      access: {
        walkRadiusMeters: config.walkAccessRadiusMeters,
        feederRadiusMeters: search.radiusUsedMeters ?? maxRadiusMeters,
        walkOriginStops: finalAccess.walk.length,
        walkDestinationStops: finalEgress.walk.length,
        feederOriginCandidates: finalAccess.feeder.map(describe),
        feederDestinationCandidates: finalEgress.feeder.map(describe),
        usedLocalRide: journeys.some(journey => journey.localRideCount > 0)
      },
      search,
      diagnostics,
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

  const widestWindowEnd = windowStart + windows.at(-1) * 60;
  const failWith = () => {
    if (search.windowsTriedMinutes.length === 0) search.windowsTriedMinutes = [windows[0]];
    diagnostics = diagnoseNoRoute(network, {
      config, counter: createServiceCounter(network, serviceDays), windowStart, windowEnd: widestWindowEnd, horizonSeconds,
      originReach, destinationReach, sharedComponents, finalAccess: finalAccess.all, finalEgress: finalEgress.all,
      searchedWindowsMinutes: search.windowsTriedMinutes, maxRadiusMeters
    });
  };

  // Cheap, exact early exits: nothing in range, or the two areas are not connected by any service at all.
  if (originReach.servedCount === 0) {
    warn('NO_STOPS_NEAR_ORIGIN', 'warning', `No usable transit stop within ${Math.round(maxRadiusMeters)} m of the origin.`);
    warn('NO_JOURNEY_FOUND', 'warning', 'Walking and local-ride access were both tried; neither reached a stop with usable service.');
    failWith();
    return finish([]);
  }
  if (destinationReach.servedCount === 0) {
    warn('NO_STOPS_NEAR_DESTINATION', 'warning', `No usable transit stop within ${Math.round(maxRadiusMeters)} m of the destination.`);
    warn('NO_JOURNEY_FOUND', 'warning', 'Walking and local-ride egress were both tried; neither reached a stop with usable service.');
    failWith();
    return finish([]);
  }
  if (sharedComponents.size === 0) {
    warn('NO_JOURNEY_FOUND', 'warning', 'No timetable service in the dataset connects the stops near the origin with the stops near the destination.');
    failWith();
    return finish([]);
  }

  // ---- Range search: RAPTOR once per departure time, all candidates of a stage at once ----
  const workspace = createWorkspace(network, query.maxTransfers + 2);
  const pool = new Map();           // journey id -> journey (all stages / windows so far)
  const fromEarliestRun = new Set();

  const searchStage = (accessLegs, egressLegs, windowEnd) => {
    const accessByStop = new Map(accessLegs.map(leg => [leg.stopIdx, leg]));
    const egressByStop = new Map(egressLegs.map(leg => [leg.stopIdx, leg]));
    const egressSeconds = new Int32Array(network.stopCount).fill(-1);
    for (const leg of egressLegs) egressSeconds[leg.stopIdx] = leg.durationSeconds;
    const ctx = {
      anchorDayNumber, serviceDays, dataset, config, fareConfig, origin, destination,
      accessByStop, egressByStop, egressLegs, datasetConfidence: info.effectiveConfidence
    };

    for (const departure of candidateDepartures(network, accessLegs, serviceDays, windowStart, windowEnd, config.maxRangeSearches)) {
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
        if (journey.localRideCount > 0) {
          // A local ride is a FEEDER, never the main event. HARD rule: the bus must cover at least as much ground as the rides,
          // or the "journey" is really a taxi trip with a bus hop in the middle. SOFT rules: rides should not make up most of
          // the duration, nor exceed the direct door-to-door distance (beyond a small allowance); ride-heavy journeys are used only when nothing better exists (see selectJourneys).
          if (journey.transitDistanceMeters < config.minTransitToRideRatio * journey.localRideDistanceMeters) continue;
          journey._rideHeavy = journey.localRideDurationSeconds > config.maxLocalRideDurationShare * journey.totalDurationSeconds
            || journey.localRideDistanceMeters > Math.max(config.localRideAllowanceMeters, config.maxLocalRideToDirectRatio * crowFlies);
        }
        if (!pool.has(journey.id)) pool.set(journey.id, journey);
        if (departure === windowStart) fromEarliestRun.add(journey.id);
      }
    }
  };

  // Walk-first selection across ride counts: a journey with more local rides is kept only if no journey with fewer rides
  // exists, or it arrives at least feederMinimumGainSeconds before the best one with fewer.
  const selectJourneys = all => {
    const strict = all.filter(journey => !journey._rideHeavy);
    const journeys = strict.length > 0 ? strict : all; // ride-heavy journeys only as a last resort
    const byRides = new Map();
    for (const journey of journeys) {
      const list = byRides.get(journey.localRideCount) ?? [];
      list.push(journey);
      byRides.set(journey.localRideCount, list);
    }
    const kept = [];
    let reference = Infinity;
    for (const rides of [...byRides.keys()].sort((a, b) => a - b)) {
      const earned = byRides.get(rides).filter(journey => reference === Infinity || journey._arrivalSeconds <= reference - config.feederMinimumGainSeconds);
      kept.push(...earned);
      for (const journey of earned) reference = Math.min(reference, journey._arrivalSeconds);
    }
    return kept;
  };
  const inWindow = windowEnd => [...pool.values()].filter(journey => journey._departureSeconds <= windowEnd);

  const idealSeconds = crowFlies / ((config.idealBusKph * 1000) / 3600);
  const acceptableSeconds = config.acceptableDurationFactor * idealSeconds + config.acceptableBaseSeconds;
  // "Acceptable" is judged on what the traveller experiences: time from the requested departure to arrival, including any wait.
  const isAcceptable = journeys => journeys.some(journey => !journey._rideHeavy && journey._arrivalSeconds - windowStart <= acceptableSeconds);

  let candidates = [];
  let bestArrival = Infinity;   // best arrival so far, and the stage that first reached it (diminishing-returns stop rule)
  let bestStage = null;
  let stagnantStages = 0;
  let usedWindowEnd = windowStart + windows[0] * 60;
  progressive:
  for (let w = 0; w < windows.length; w++) {
    const windowEnd = windowStart + windows[w] * 60;
    usedWindowEnd = windowEnd;
    search.windowsTriedMinutes.push(windows[w]);
    const counter = createServiceCounter(network, serviceDays);
    const stageList = w === 0 ? stages : [stages.at(-1)]; // a wider window re-tries once, with the full candidate set
    let previousKey = null;

    for (const stage of stageList) {
      const side = (role, point, other) => {
        const walk = selectWalkCandidates(network, point, {
          radiusMeters: role === 'access' ? config.walkAccessRadiusMeters : config.walkEgressRadiusMeters,
          maxCandidates: role === 'access' ? config.maxWalkAccessCandidates : config.maxWalkEgressCandidates,
          allowedComponents, components, config: walking
        });
        const feeder = selectFeederCandidates(network, point, {
          role, stage, otherPoint: other, counter, windowStart, windowEnd, horizonSeconds, config, allowedComponents, components
        });
        return { walk, feeder, all: [...walk, ...feeder] };
      };
      const access = side('access', origin, destination);
      const egress = side('egress', destination, origin);
      finalAccess = access;
      finalEgress = egress;

      const key = `${access.all.map(leg => leg.stopIdx).join(',')}|${egress.all.map(leg => leg.stopIdx).join(',')}`;
      const record = { name: stage.name, radiusMeters: stage.radiusMeters, windowMinutes: windows[w], accessCandidates: access.all.length, egressCandidates: egress.all.length, searched: false, acceptable: false };
      search.stages.push(record);
      if (access.all.length === 0 || egress.all.length === 0 || key === previousKey) continue; // nothing new to search at this stage
      previousKey = key;

      searchStage(access.all, egress.all, windowEnd);
      record.searched = true;
      candidates = selectJourneys(inWindow(windowEnd));
      record.acceptable = isAcceptable(candidates);
      if (candidates.length > 0) {
        const best = Math.min(...candidates.map(journey => journey._arrivalSeconds));
        if (best <= bestArrival - config.feederMinimumGainSeconds) { bestStage = stage; stagnantStages = 0; }
        else stagnantStages++;
        bestArrival = Math.min(bestArrival, best);
      }
      if (record.acceptable) {
        search.stageUsed = stage.name;
        search.radiusUsedMeters = stage.radiusMeters;
        break progressive;
      }
      // Stop widening when it has stopped paying off, or the total search budget is spent: a wider radius cannot create
      // timetable service that does not exist.
      if (candidates.length > 0 && (stagnantStages >= config.stageStagnationLimit || performanceBlock.rangeSearches >= config.maxTotalRangeSearches)) break;
    }
    if (candidates.length > 0) break; // something usable at this window: do not widen further
  }
  search.windowUsedMinutes = Math.round((usedWindowEnd - windowStart) / 60);
  search.windowExpanded = search.windowUsedMinutes > query.windowMinutes;
  if (candidates.length > 0 && search.stageUsed === null) {
    // Best available, though not "acceptable": report the stage that produced the best journey.
    const last = bestStage ?? [...search.stages].reverse().find(stage => stage.searched);
    search.stageUsed = last?.name ?? null;
    search.radiusUsedMeters = last?.radiusMeters ?? null;
  }
  performanceBlock.journeysAfterDedupe = pool.size;

  if (candidates.length === 0) {
    candidates = selectJourneys([...pool.values()].filter(journey => fromEarliestRun.has(journey.id)));
    if (candidates.length > 0) {
      warn('NO_DEPARTURE_IN_WINDOW', 'warning', 'No journey leaves inside the searched time window; showing the earliest available journey after it.');
    }
  }
  if (candidates.length === 0) {
    warn('NO_JOURNEY_FOUND', 'warning',
      `Walking${maxRadiusMeters > config.walkAccessRadiusMeters ? ' and local-ride access' : ''} to timetable stops was tried; no journey within ${query.maxTransfers} transfer(s) was found for this date and time.`);
    failWith();
    return finish([]);
  }
  if (search.windowExpanded) {
    warn('SEARCH_WINDOW_EXPANDED', 'info', `Few services run in the requested window, so the search was widened to ${search.windowUsedMinutes / 60} hours.`);
  }

  const rideHeavy = candidates.some(journey => journey._rideHeavy);
  const ranked = rankJourneys(candidates, config.ranking);
  const journeys = ranked.journeys.map(({ _departureSeconds, _arrivalSeconds, _rideHeavy, ...journey }) => journey);

  if (journeys.some(journey => journey.timeQuality !== 'exact')) {
    warn('APPROXIMATE_TIMES', 'info', 'Stop times in this dataset are approximate (not exact timepoints); allow some margin.');
  }
  if (journeys.some(journey => journey.walkingDurationSeconds > 0)) {
    warn('WALKING_ESTIMATED', 'info', 'Walking legs are straight-line estimates, not road routing.');
  }
  if (journeys.some(journey => journey.localRideCount > 0)) {
    warn('LOCAL_RIDE_ESTIMATED', 'info', 'Local ride legs are estimates connecting you to a timetable bus. No ride provider is connected: availability is not verified, and duration and fare are approximate.');
  }
  if (rideHeavy) {
    warn('LOCAL_RIDE_HEAVY', 'info', 'Local rides make up much of this journey: no timetable alternative with shorter rides was found in the dataset.');
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
      console.warn('[Transit Diagnostics] Journey planner requested but transit network is not available in memory. Import a GTFS feed with "npm run transit:ensure" or "npm run transit:import".');
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

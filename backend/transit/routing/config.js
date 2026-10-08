// All tunable routing parameters live here (no magic numbers deep inside the algorithm).
// Every value can be overridden through the environment: ROUTECONNECT_ROUTING_<UPPER_SNAKE_NAME>=<number>.

export const ROUTING_DEFAULTS = Object.freeze({
  // Local-time semantics. Asia/Kolkata has no DST, so wall-clock arithmetic with a fixed offset is exact.
  timezone: 'Asia/Kolkata',
  utcOffset: '+05:30',

  // ---- Walking (ESTIMATED: straight-line distance x detour factor / speed; not road routing) ----
  walkSpeedMetersPerSecond: 1.25,   // 4.5 km/h
  walkDetourFactor: 1.3,            // straight line -> typical walked path
  walkAccessRadiusMeters: 1200,     // tier 1: origin -> boarding stop reachable on foot (straight line)
  walkEgressRadiusMeters: 1200,     // tier 1: alighting stop -> destination reachable on foot
  maxWalkAccessCandidates: 8,
  maxWalkEgressCandidates: 8,
  directWalkWarningMeters: 1000,    // below this the trip is probably walkable

  // ---- First / last mile by generic local ride (auto / cab). ESTIMATED, never provider-backed ----
  // Progressive access search (both ends of the journey). Stage 0 is walking only; each following stage widens the radius
  // within which stops are reachable by an estimated local ride. The search STOPS at the first stage that yields an
  // acceptable journey, so the largest radius is only used when it is actually needed. An empty list disables rides.
  feederStageRadiiMeters: [5000, 10000, 20000, 30000],  // local-feeder stages (stops chosen by timetable usefulness)
  hubStageRadiiMeters: [40000, 50000],                  // extended stages: only strong hubs are considered beyond the feeder range
  maxFeederCandidates: 10,          // local-feeder candidates per side (RAPTOR runs ONCE per stage with all candidates)
  maxHubCandidates: 6,              // extra strong-hub candidates per side in the extended stages
  hubMinStrength: 0.7,              // extended stages: a stop must rank in the top 30% of the network (hub strength 0..1)
  feederClusterRadiusMeters: 300,   // candidates this close are one hub: keep only the best-scoring stop
  feederMinServicesInWindow: 1,     // a candidate needs at least this many usable departures/arrivals in the search window (1: sparse areas count)
  feederMinimumGainSeconds: 900,    // a journey with more local rides must arrive this much earlier than the best with fewer
  minTransitToRideRatio: 1.0,       // plausibility: net bus progress must be at least this x the total straight-line ride distance
  maxLocalRideToDirectRatio: 1.0,   // plausibility: rides alone may not cover more than this x the direct distance...
  localRideAllowanceMeters: 5000,   // ...unless they total no more than this (short rides are always fine)
  hubRideScaleSeconds: 1800,        // candidate score halves for every this-many seconds of local ride to reach it
  // ---- Journey plausibility (plausibility.js): limits blend from the SHORT-trip value to the LONG-trip value ----
  plausibilityEnabled: true,        // false: return every timetable-valid journey (diagnostics / "raw" coverage measurement)
  shortTripMeters: 20000,           // direct distance at or below which the strict (short) limits apply
  longTripMeters: 100000,           // direct distance at or above which the loose (long, intercity) limits apply
  detourMinDirectMeters: 1000,      // direct distances below this are treated as this long when forming distance ratios
  maxDistanceDetourShort: 2.0,      // path length / direct distance
  maxDistanceDetourLong: 3.0,
  maxDurationFactorShort: 3.0,      // duration <= detourDurationBaseSeconds + factor x (direct distance at idealBusKph)
  maxDurationFactorLong: 5.0,
  detourDurationBaseSeconds: 3600,
  maxFeederShareShort: 0.5,         // share of door-to-door time spent in estimated local rides
  maxFeederShareLong: 0.6,
  maxTransfersShortTrip: 1,         // transfers allowed on a short trip (long trips may use the query's maximum)
  minTransitSeconds: 300,           // with local rides, the bus part must be at least this long...
  minTransitShareOfDirect: 0.25,    // ...and its net progress at least this share of the direct distance
  maxExcursionShareShort: 0.6,      // how far off the origin-destination line a stop may lie: (d_origin + d_dest - direct)
  maxExcursionShareLong: 1.2,       //   <= allowance + share x direct distance
  excursionAllowanceMeters: 3000,
  acceptableMaxFeederShare: 0.5,    // stopping rule: a journey this ride-heavy is not "good enough" to stop widening the search
  idealBusKph: 40,                  // a journey is "acceptable" when no longer than factor x (straight line / this) + base
  acceptableDurationFactor: 2.5,
  acceptableBaseSeconds: 3600,
  localRideDistanceFactor: 1.35,    // straight line -> road distance
  localRideSpeedKph: 25,            // expected average speed of a local ride (not live, not traffic-aware)
  localRidePickupWaitSeconds: 300,  // assumed time to find / wait for a ride (availability is NOT verified)
  localRideMinSeconds: 240,

  // ---- Transfers ----
  minTransferSeconds: 300,          // bus-to-bus minimum (5 min); a transfers table overrides it per stop
  boardingBufferSeconds: 0,         // slack between arriving at the first stop on foot and boarding
  transferRadiusMeters: 250,        // derive walking transfers between nearby stops (0 disables)
  maxFootpathsPerStop: 8,
  defaultMaxTransfers: 3,
  transferExpansionLimits: [4, 5], // diagnostic retries when nothing practical exists at the requested limit (still plausibility-checked)
  maxMaxTransfers: 5,

  // ---- Range query ----
  defaultWindowMinutes: 180,
  maxWindowMinutes: 720,
  windowExpansionMinutes: [540, 720], // staged widening when a sparse timetable yields nothing in the requested window
  allowDeparturesAfterWindow: true, // when nothing departs inside any window, show the earliest later journey (with a warning)
  maxRangeSearches: 40,             // cap on repeated RAPTOR runs per request
  maxJourneyHours: 24,              // search horizon after leaving the origin
  maxTotalRangeSearches: 160,       // budget across all access stages / windows of one request (stops widening once spent)
  stageStagnationLimit: 2,          // stop widening after this many consecutive stages that improved nothing by the minimum gain

  // ---- Timetable data quality ----
  maxTripDurationSeconds: 24 * 3600, // trips longer than this are treated as bad data and excluded
  extrapolateOutsideValidity: true,  // outside the feed's calendar window, reuse the weekly pattern (flagged "inferred")

  // ---- Ranking (generalized cost, seconds-equivalent) ----
  ranking: Object.freeze({
    transferPenaltySeconds: 900,    // each transfer "costs" 15 extra minutes
    walkingExtraWeight: 1.0,        // walking seconds count (1 + weight) times
    waitingExtraWeight: 0.5,        // waiting seconds count (1 + weight) times
    localRidePenaltySeconds: 600,   // each estimated local ride: unverified availability costs "10 extra minutes"
    localRideExtraWeight: 0.5,      // local-ride seconds count (1 + weight) times
    lowerCostMinGapPercent: 10,     // "lower estimated cost" only if the dearer ranges start >10% above this one's end
    maxJourneys: 10
  })
});

const ENV_PREFIX = 'ROUTECONNECT_ROUTING_';

function toEnvName(key) {
  return ENV_PREFIX + key.replace(/([A-Z])/g, '_$1').toUpperCase();
}

function overrideNumbers(defaults, env, prefixKeys = []) {
  const result = {};
  for (const [key, value] of Object.entries(defaults)) {
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      result[key] = overrideNumbers(value, env, [...prefixKeys, key]);
    } else if (Array.isArray(value) && value.every(item => typeof item === 'number')) {
      // Numeric lists: ROUTECONNECT_ROUTING_<NAME>=5000,10000 (an empty value keeps the default; "none" empties the list).
      const raw = env[toEnvName([...prefixKeys, key].join('_'))];
      const parsed = raw === undefined || raw === '' ? null : raw.trim().toLowerCase() === 'none' ? [] : raw.split(',').map(Number);
      result[key] = parsed && parsed.every(Number.isFinite) ? parsed : [...value];
    } else if (typeof value === 'number') {
      const envName = toEnvName([...prefixKeys, key].join('_'));
      const raw = env[envName];
      const parsed = raw === undefined || raw === '' ? NaN : Number(raw);
      result[key] = Number.isFinite(parsed) ? parsed : value;
    } else {
      result[key] = value;
    }
  }
  return result;
}

// Returns a plain config object: defaults, then environment overrides, then explicit overrides.
export function getRoutingConfig(overrides = {}, env = process.env) {
  const merged = overrideNumbers(ROUTING_DEFAULTS, env);
  return {
    ...merged,
    ...overrides,
    ranking: { ...merged.ranking, ...(overrides.ranking ?? {}) }
  };
}

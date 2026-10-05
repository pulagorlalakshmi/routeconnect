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
  // Tier 2: only stops BEYOND the walking radius, within this radius, are considered (0 disables local rides).
  feederAccessRadiusMeters: 25000,
  feederEgressRadiusMeters: 25000,
  maxFeederCandidates: 8,           // bounded candidate set per side (RAPTOR runs ONCE with all candidates, not per candidate)
  feederClusterRadiusMeters: 300,   // candidates this close are one hub: keep only the best-served stop
  feederMinServicesInWindow: 2,     // a hub needs at least this many usable departures/arrivals in the search window
  feederMinimumGainSeconds: 900,    // a ride-assisted journey must beat the best walk-only arrival by this much
  minTransitToRideRatio: 1.0,       // straight-line bus distance must be at least this x the local-ride distance
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
  maxMaxTransfers: 5,

  // ---- Range query ----
  defaultWindowMinutes: 180,
  maxWindowMinutes: 720,
  maxRangeSearches: 40,             // cap on repeated RAPTOR runs per request
  maxJourneyHours: 24,              // search horizon after leaving the origin

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

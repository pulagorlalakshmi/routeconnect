// All tunable parameters of the Best Path Rating live here. Nothing in pathRating.js is a magic number.
// Scores are 0..10. The rating is relative for time and cost (compared with the other journeys of the SAME search)
// and absolute for transfers, first/last mile and schedule confidence.

export const RATING_DEFAULTS = Object.freeze({
  // Overall = weighted mean of the available parameters. A parameter that is N/A is dropped and the rest re-normalised.
  // Route quality first (time, cost, transfers, first/last mile, schedule, convenience = 95%); tracking is a small
  // extra (5%). Convenience rewards direct services and penalises fragile connections (see convenienceScore), so a
  // direct bus beats a transfer chain unless the chain is substantially faster.
  weights: Object.freeze({
    time: 0.28,
    cost: 0.20,
    transfers: 0.12,
    firstLastMile: 0.12,
    schedule: 0.09,
    tracking: 0.05,
    convenience: 0.14
  }),

  // Time and cost compare a journey with the best one of the search. With nothing to compare against (a single
  // journey, or a single journey with a fare estimate) a neutral, good-but-not-excellent score is used.
  soleComparisonScore: 8.0,
  // Exponents on (best / this): 1 = proportional; higher spreads near-equal options further apart. The fastest / cheapest journey scores 10.
  timeExponent: 1.5,
  costExponent: 1.5,

  // Transfer convenience by number of transfers (index 0..n; more than the last index uses the last value).
  transferScores: Object.freeze([10, 8.8, 7.5, 6.2, 4.5, 3.5]),
  // Waiting at transfers: points lost per hour of waiting, capped.
  transferWaitPenaltyPerHour: 1.0,
  transferWaitPenaltyMax: 2.5,

  // First/last mile. Starts at 10 and loses points for walking and for each estimated local ride.
  walkFreeMeters: 300,              // walking up to this far costs nothing
  walkPenaltyPer100Meters: 0.2,     // beyond that
  walkPenaltyMax: 3,
  rideBasePenalty: 1.2,             // needing a feeder at all
  ridePenaltyPerKm: 0.12,
  ridePenaltyMaxPerRide: 3.5,       // a long rural feeder is capped, not punished without limit
  firstLastMileMaxPenalty: 6,       // the score never falls below 10 - this

  // Schedule confidence by the existing data-confidence level.
  scheduleScores: Object.freeze({
    live: 10,
    verified: 9.5,
    published: 9,
    inferred: 7,
    estimated: 5.5,
    unknown: 4
  }),

  // Tracking confidence by the leg's tracking status (trackerChecks.js); a journey averages its APSRTC bus legs.
  // A journey with no APSRTC leg has no tracking score (N/A, weight re-normalised).
  // options_available (the normal, unchecked case) is only a little below verified, so missing checks do not drag
  // ratings down.
  trackingScores: Object.freeze({
    verified: 10,
    options_available: 7,
    not_found: 4
  }),

  // Convenience / directness. Starts at 10 for a single vehicle door-to-door trunk and loses points for:
  convenience: Object.freeze({
    perTransfer: 3.0,                 // every change of vehicle
    tightConnectionSeconds: 20 * 60,  // a connection shorter than this...
    tightConnectionPenalty: 1.5,      // ...on a timetable that is not exact (approximate / inferred) is fragile
    perModeChange: 1.0                // changing between bus / train / flight
  }),

  // Labels, highest first: a score at or above `min` gets the label.
  labels: Object.freeze([
    { min: 9.0, label: 'Excellent' },
    { min: 8.0, label: 'Very Good' },
    { min: 7.0, label: 'Good' },
    { min: 6.0, label: 'Fair' },
    { min: 0, label: 'Limited' }
  ]),

  // Thresholds for the short explanation points.
  explain: Object.freeze({
    strong: 8.5,   // a parameter at or above this is reported as a strength
    weak: 6.0      // at or below this it is reported as a caution
  }),
  maxReasons: 4
});

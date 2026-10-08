// Best Path Rating: an explainable 0.0-10.0 score per journey, computed only from the journey's own data and the other
// journeys of the SAME search. Deterministic: no randomness, no clock, no external calls.
//
//   time          total door-to-door duration (travel + waiting + feeder) relative to the fastest option
//   cost          midpoint of the ESTIMATED fare range relative to the cheapest option; unknown fare => N/A
//   transfers     number of bus changes, minus a penalty for long waits at transfers
//   firstLastMile walking and estimated local rides at both ends
//   schedule      the existing data-confidence level of the timetable
//   tracking      whether a public live tracker is known to recognise each APSRTC bus (small weight; N/A without one)
//   convenience   directness: transfers, fragile (tight, non-exact) connections and changes of vehicle type
//
// The overall score is the weighted mean of the available parameters. A parameter that is N/A is removed and the
// remaining weights are re-normalised. No bonus points are ever added.
import { RATING_DEFAULTS } from './ratingConfig.js';

export const PARAMETERS = Object.freeze(['time', 'cost', 'transfers', 'firstLastMile', 'schedule', 'tracking', 'convenience']);

const clamp = (value, lo = 0, hi = 10) => Math.min(hi, Math.max(lo, value));
const round1 = value => Math.round(value * 10) / 10;

export function ratingLabel(score, config = RATING_DEFAULTS) {
  for (const { min, label } of config.labels) if (score >= min) return label;
  return config.labels[config.labels.length - 1].label;
}

// Midpoint of the estimated fare range, or null when the fare is unknown or only partly known.
// Unknown is never treated as zero; a partial fare would understate the cost, so it is treated as unknown too.
export function fareMidpoint(journey) {
  const fare = journey.fareEstimate;
  if (!fare || !fare.complete) return null;
  if (!Number.isFinite(fare.min) || !Number.isFinite(fare.max) || fare.max <= 0) return null;
  return (fare.min + fare.max) / 2;
}

function relativeScore(best, value, exponent) {
  if (!(value > 0)) return null;
  return clamp(10 * Math.pow(best / value, exponent));
}

function timeScores(journeys, config) {
  const best = Math.min(...journeys.map(j => j.totalDurationSeconds));
  return journeys.map(j => (journeys.length < 2 ? config.soleComparisonScore : relativeScore(best, j.totalDurationSeconds, config.timeExponent)));
}

function costScores(journeys, config) {
  const mids = journeys.map(fareMidpoint);
  const known = mids.filter(m => m !== null);
  const best = known.length ? Math.min(...known) : null;
  return mids.map(mid => {
    if (mid === null) return null;
    if (known.length < 2) return config.soleComparisonScore;
    return relativeScore(best, mid, config.costExponent);
  });
}

export function transferScore(journey, config = RATING_DEFAULTS) {
  const table = config.transferScores;
  const base = table[Math.min(Math.max(0, journey.transfers ?? 0), table.length - 1)];
  const waitHours = (journey.waitingDurationSeconds ?? 0) / 3600;
  const penalty = journey.transfers > 0 ? Math.min(config.transferWaitPenaltyMax, waitHours * config.transferWaitPenaltyPerHour) : 0;
  return clamp(base - penalty);
}

export function firstLastMileScore(journey, config = RATING_DEFAULTS) {
  let walkMeters = 0;
  let ridePenalty = 0;
  for (const leg of journey.legs ?? []) {
    if (leg.mode === 'walk') walkMeters += leg.distanceMeters ?? 0;
    else if (leg.mode === 'local_ride') {
      ridePenalty += Math.min(config.ridePenaltyMaxPerRide, config.rideBasePenalty + ((leg.distanceMeters ?? 0) / 1000) * config.ridePenaltyPerKm);
    }
  }
  const walkPenalty = Math.min(config.walkPenaltyMax, (Math.max(0, walkMeters - config.walkFreeMeters) / 100) * config.walkPenaltyPer100Meters);
  return clamp(10 - Math.min(config.firstLastMileMaxPenalty, walkPenalty + ridePenalty));
}

export function scheduleScore(journey, config = RATING_DEFAULTS) {
  const score = config.scheduleScores[journey.scheduleConfidence];
  return score === undefined ? config.scheduleScores.unknown : score;
}

export function trackingScore(journey, config = RATING_DEFAULTS) {
  const legs = (journey.legs ?? []).filter(leg => leg.tracking);
  if (legs.length === 0) return null;
  const table = config.trackingScores;
  const total = legs.reduce((sum, leg) => sum + (table[leg.tracking.status] ?? table.options_available), 0);
  return total / legs.length;
}

const isVehicleLeg = leg => leg.mode !== 'walk' && leg.mode !== 'local_ride' && leg.mode !== 'buffer';
const modeFamily = leg => (/rail|train|subway|metro|tram/.test(leg.mode) ? 'rail' : /air|flight/.test(leg.mode) ? 'air' : 'bus');

// Fragile connections: changes with little slack between legs whose times are not exact (approximate stop times or an
// inferred schedule). Returns the number of such connections.
export function tightConnections(journey, config = RATING_DEFAULTS) {
  const legs = (journey.legs ?? []).filter(isVehicleLeg);
  let count = 0;
  for (let i = 1; i < legs.length; i++) {
    const slack = (Date.parse(legs[i].departureTime) - Date.parse(legs[i - 1].arrivalTime)) / 1000;
    const exact = [legs[i - 1], legs[i]].every(leg => leg.timeQuality === 'exact' && leg.dataConfidence !== 'inferred');
    if (Number.isFinite(slack) && slack < config.convenience.tightConnectionSeconds && !exact) count++;
  }
  return count;
}

export function convenienceScore(journey, config = RATING_DEFAULTS) {
  const legs = (journey.legs ?? []).filter(isVehicleLeg);
  if (legs.length === 0) return null;
  const c = config.convenience;
  let modeChanges = 0;
  for (let i = 1; i < legs.length; i++) if (modeFamily(legs[i]) !== modeFamily(legs[i - 1])) modeChanges++;
  const transfers = Math.max(0, legs.length - 1);
  return clamp(10 - transfers * c.perTransfer - tightConnections(journey, config) * c.tightConnectionPenalty - modeChanges * c.perModeChange);
}

function combine(scores, weights) {
  let weighted = 0;
  let total = 0;
  for (const key of PARAMETERS) {
    const score = scores[key];
    if (score === null || score === undefined || !Number.isFinite(score)) continue;
    weighted += score * weights[key];
    total += weights[key];
  }
  return total > 0 ? weighted / total : null;
}

// 2-4 short points, each derived from one real metric of this journey.
function reasonsFor(journey, scores, config) {
  const { strong, weak } = config.explain;
  const positives = [];
  const cautions = [];
  const push = (list, metric, score, text) => list.push({ metric, score, text });

  const { time, cost, transfers, firstLastMile, schedule } = scores;
  if (time !== null && time >= strong) push(positives, 'time', time, time >= 9.5 ? 'Fast journey' : 'Close to the fastest option');
  else if (time !== null && time <= weak) push(cautions, 'time', time, 'Takes noticeably longer than the fastest option');

  if (journey.transfers === 0) push(positives, 'transfers', transfers, 'No transfers');
  else if (transfers >= strong) push(positives, 'transfers', transfers, 'Only one transfer');
  else push(cautions, 'transfers', transfers, `${journey.transfers} transfer${journey.transfers === 1 ? "" : "s"}`);

  const tight = tightConnections(journey, config);
  if (tight > 0) push(cautions, 'convenience', scores.convenience, tight === 1 ? 'Tight connection on an approximate timetable' : `${tight} tight connections on approximate timetables`);

  if (cost === null) push(cautions, 'cost', null, 'Fare could not be estimated, so cost is not rated');
  else if (cost >= strong) push(positives, 'cost', cost, 'Good estimated cost');
  else if (cost <= weak) push(cautions, 'cost', cost, 'Higher estimated fare than other options');

  const rides = journey.localRideCount ?? 0;
  if (rides > 0) push(cautions, 'firstLastMile', firstLastMile, rides === 1 ? 'Needs an estimated local ride to or from the bus' : 'Needs estimated local rides at both ends');
  else if (firstLastMile >= strong) push(positives, 'firstLastMile', firstLastMile, 'Bus stops are close by');
  else if (firstLastMile <= weak) push(cautions, 'firstLastMile', firstLastMile, 'Longer walk to or from the bus stop');

  if (schedule >= 9) push(positives, 'schedule', schedule, 'Based on a published timetable');
  else if (schedule < 8) {
    const text = { inferred: 'Schedule inferred', estimated: 'Schedule estimated', unknown: 'Schedule source unverified' }[journey.scheduleConfidence] ?? 'Schedule is not fully confirmed';
    push(cautions, 'schedule', schedule, text);
  }

  positives.sort((a, b) => b.score - a.score);
  // Tracking is a minor factor: it is mentioned only when every bus is trackable, and only after the route reasons.
  if (journey.tracking?.allVerified) positives.push({ metric: 'tracking', score: 0, text: 'Live tracking verified' });
  // The schedule caution is always kept (it is the honesty-critical one); the rest are ordered weakest first.
  cautions.sort((a, b) => (b.metric === 'schedule') - (a.metric === 'schedule') || (a.score ?? -1) - (b.score ?? -1));
  const keepCautions = cautions.slice(0, 2);
  const keepPositives = positives.slice(0, config.maxReasons - keepCautions.length);
  return [
    ...keepPositives.map(r => ({ type: 'positive', metric: r.metric, text: r.text })),
    ...keepCautions.map(r => ({ type: 'caution', metric: r.metric, text: r.text }))
  ];
}

const SUMMARY = {
  Excellent: 'Excellent balance of time, cost and convenience.',
  'Very Good': 'Strong balance of time, cost and convenience.',
  Good: 'A solid option with reasonable trade-offs.',
  Fair: 'Workable, with some trade-offs.',
  Limited: 'Has notable trade-offs; compare with the other options.'
};

/**
 * Rates every journey of one search against the others. Returns an array parallel to `journeys`:
 *   { score, raw, label, summary, parameters: { time: {score, weight}, ... }, reasons: [{type, metric, text}], comparedWith }
 * `score` is rounded to one decimal; `raw` keeps the unrounded value for exact-tie detection.
 * A parameter score of null means N/A (it is excluded and the weights re-normalised).
 */
export function rateJourneys(journeys, overrides = {}) {
  const config = { ...RATING_DEFAULTS, ...overrides, weights: { ...RATING_DEFAULTS.weights, ...(overrides.weights ?? {}) } };
  if (journeys.length === 0) return [];
  const time = timeScores(journeys, config);
  const cost = costScores(journeys, config);
  return journeys.map((journey, i) => {
    const scores = {
      time: time[i],
      cost: cost[i],
      transfers: transferScore(journey, config),
      firstLastMile: firstLastMileScore(journey, config),
      schedule: scheduleScore(journey, config),
      tracking: trackingScore(journey, config),
      convenience: convenienceScore(journey, config)
    };
    const raw = combine(scores, config.weights);
    const score = round1(raw);
    const label = ratingLabel(score, config);
    const parameters = {};
    for (const key of PARAMETERS) parameters[key] = { score: scores[key] === null ? null : round1(scores[key]), weight: config.weights[key] };
    return {
      score,
      raw,
      label,
      summary: SUMMARY[label],
      parameters,
      reasons: reasonsFor(journey, scores, config),
      comparedWith: journeys.length
    };
  });
}

// Ids sharing the highest raw score (an exact tie is the only way two journeys both get "Best Path").
export function bestPathIds(journeys, ratings) {
  let best = -Infinity;
  ratings.forEach(rating => { if (rating.raw > best) best = rating.raw; });
  return journeys.filter((_, i) => ratings[i].raw === best).map(j => j.id);
}

// Transparent fare ESTIMATION. Replaceable: swap estimateLegFare() for an authoritative fare source later.
//
// Rules (mandatory):
//  - An estimate is ALWAYS a range { min < max }; it is never returned as a single exact amount.
//  - Only a fare that comes from a published source may be exact ({ type: 'published', amount }).
//  - An unknown cost is never treated as zero: it makes the journey total "partial" (complete: false).
//  - No provider names, no service-class claims.
import { getFareConfig } from './fareConfig.js';

const roundDown = (value, step) => Math.floor(value / step) * step;
const roundUp = (value, step) => Math.ceil(value / step) * step;

// Turns a model range into a rounded, strictly increasing { min, max } in rupees.
function finishRange(rawMin, rawMax, config) {
  const step = config.fareRoundingStep;
  const min = roundDown(Math.max(0, rawMin), step);
  let max = roundUp(Math.max(rawMax, rawMin), step);
  if (max <= min) max = min + step; // a range, never a point
  return { min, max };
}

function estimatedRange({ min, max }, extra, config) {
  return {
    type: 'estimated_range',
    min,
    max,
    currency: config.currency,
    confidence: 'estimated',
    ...extra
  };
}

// Distance uncertainty: the true distance lies somewhere in [d * (1 - u), d * (1 + u)].
function distanceBounds(distanceKm, config) {
  const u = config.fareUncertaintyPercent / 100;
  return { low: Math.max(0, distanceKm * (1 - u)), high: distanceKm * (1 + u) };
}

// Bus leg without a published fare. distanceKm is the straight-line length along the stop sequence.
export function estimateBusFare({ distanceKm }, configOrOverrides = {}) {
  const config = configOrOverrides.currency ? configOrOverrides : getFareConfig(configOrOverrides);
  if (!Number.isFinite(distanceKm) || distanceKm <= 0) return null;
  const road = distanceKm * config.busRoadDistanceFactor;
  const { low, high } = distanceBounds(road, config);
  const range = finishRange(
    Math.max(config.busMinimumFareMin, low * config.busFarePerKmMin),
    Math.max(config.busMinimumFareMax, high * config.busFarePerKmMax),
    config
  );
  return estimatedRange(range, {
    basis: 'distance_model',
    serviceClass: 'unknown', // the dataset does not identify Express / Palle Velugu / Ultra Deluxe / ...
    distanceKm: Math.round(road * 10) / 10,
    note: 'Estimated from route distance. Service class is not available in the dataset; actual fare may vary.'
  }, config);
}

// Generic local ride (auto / cab). roadDistanceKm is the estimated ROAD distance of the ride.
export function estimateLocalRideFare({ roadDistanceKm }, configOrOverrides = {}) {
  const config = configOrOverrides.currency ? configOrOverrides : getFareConfig(configOrOverrides);
  if (!Number.isFinite(roadDistanceKm) || roadDistanceKm <= 0) return null;
  const { low, high } = distanceBounds(roadDistanceKm, config);
  const range = finishRange(
    Math.max(config.localRideMinimumFareMin, config.localRideBaseFareMin + low * config.localRidePerKmMin),
    Math.max(config.localRideMinimumFareMax, config.localRideBaseFareMax + high * config.localRidePerKmMax),
    config
  );
  return estimatedRange(range, {
    basis: 'distance_model',
    distanceKm: Math.round(roadDistanceKm * 10) / 10,
    note: 'Generic auto / cab range from estimated road distance. Not a provider quote; actual fare may vary.'
  }, config);
}

// Fare of one journey leg, or null when it cannot responsibly be estimated.
//  - walk legs are free and are not fare components (they return null and are skipped by the aggregator);
//  - a published fare, if a leg ever carries one, is returned exactly and labelled "published".
export function estimateLegFare(leg, configOrOverrides = {}) {
  const config = configOrOverrides.currency ? configOrOverrides : getFareConfig(configOrOverrides);
  if (leg.publishedFare && Number.isFinite(leg.publishedFare.amount)) {
    return { type: 'published', amount: leg.publishedFare.amount, currency: leg.publishedFare.currency ?? config.currency, confidence: 'published' };
  }
  if (leg.mode === 'bus') return estimateBusFare({ distanceKm: (leg.distanceMeters ?? 0) / 1000 }, config);
  if (leg.mode === 'local_ride') return estimateLocalRideFare({ roadDistanceKm: (leg.distanceMeters ?? 0) / 1000 }, config);
  return null;
}

const isFareBearing = leg => leg.mode !== 'walk';

// Aggregates leg fares into a total range.
// Returns null when the journey has no fare-bearing legs at all.
// complete=false means at least one fare-bearing leg could not be estimated: the min/max then cover ONLY the legs that
// could, the missing ones are listed in unknownComponents, and nothing is silently added as zero.
export function estimateJourneyFare(legs, configOrOverrides = {}) {
  const config = configOrOverrides.currency ? configOrOverrides : getFareConfig(configOrOverrides);
  const components = [];
  const unknownComponents = [];
  let min = 0;
  let max = 0;
  let allPublished = true;

  legs.forEach((leg, legIndex) => {
    if (!isFareBearing(leg)) return;
    const fare = leg.fare ?? estimateLegFare(leg, config);
    if (!fare) {
      unknownComponents.push({ legIndex, mode: leg.mode, kind: leg.kind ?? null });
      return;
    }
    const low = fare.type === 'published' ? fare.amount : fare.min;
    const high = fare.type === 'published' ? fare.amount : fare.max;
    min += low;
    max += high;
    if (fare.type !== 'published') allPublished = false;
    components.push({ legIndex, mode: leg.mode, kind: leg.kind ?? null, min: low, max: high, confidence: fare.confidence, basis: fare.basis ?? null });
  });

  if (components.length === 0 && unknownComponents.length === 0) return null;
  if (components.length === 0) {
    return { min: null, max: null, currency: config.currency, confidence: 'unknown', complete: false, components, unknownComponents };
  }

  const complete = unknownComponents.length === 0;
  if (allPublished && complete) {
    return { min, max, currency: config.currency, confidence: 'published', complete, components, unknownComponents };
  }
  // Components are already rounded; their sum is a range by construction (every estimate has min < max).
  return {
    min,
    max,
    currency: config.currency,
    confidence: 'estimated',
    basis: 'distance_model',
    complete,
    components,
    unknownComponents,
    note: complete
      ? 'Estimated from route distance and available transit data. Service class is not in the dataset; actual fare may vary.'
      : 'Partial estimate: some parts of this journey could not be priced and are not included.'
  };
}

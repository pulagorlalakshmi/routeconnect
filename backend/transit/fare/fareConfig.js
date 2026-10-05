// Fare-estimation assumptions. ALL numbers live here (never inside RAPTOR or the planner), and every value can be
// overridden through the environment: ROUTECONNECT_FARE_<UPPER_SNAKE_NAME>=<number>.
//
// HONESTY NOTE: these are MODEL ASSUMPTIONS, not an APSRTC tariff and not provider prices.
//  - The imported GTFS feed has no fares and no service class (Palle Velugu / Express / Ultra Deluxe / ...), so the
//    per-km band deliberately spans ordinary to deluxe service. The only fare fact used from public reporting is that
//    the minimum fare on rural ordinary services is about Rs 10.
//  - Local ride (auto / cab) values are a generic, provider-independent range for short road trips in India; no
//    provider (Uber, Rapido, Ola, ...) is modelled or implied.
// When authoritative fare data exists, replace estimateLegFare() in fareEstimator.js; nothing else needs to change.

export const FARE_DEFAULTS = Object.freeze({
  currency: 'INR',

  // Applied to the DISTANCE (route-length uncertainty); ranges are never narrower than this implies.
  fareUncertaintyPercent: 10,
  // Fares are rounded outwards (minimum down, maximum up) to this many rupees.
  fareRoundingStep: 5,

  // Bus: straight-line distance along the stop sequence is multiplied to approximate road distance.
  busRoadDistanceFactor: 1.15,
  busFarePerKmMin: 1.1,
  busFarePerKmMax: 1.8,
  busMinimumFareMin: 10,
  busMinimumFareMax: 20,

  // Generic local ride (auto / cab) used for first/last mile.
  localRideBaseFareMin: 30,
  localRideBaseFareMax: 50,
  localRidePerKmMin: 11,
  localRidePerKmMax: 16,
  localRideMinimumFareMin: 40,
  localRideMinimumFareMax: 80
});

const ENV_PREFIX = 'ROUTECONNECT_FARE_';
const toEnvName = key => ENV_PREFIX + key.replace(/([A-Z])/g, '_$1').toUpperCase();

export function getFareConfig(overrides = {}, env = process.env) {
  const merged = {};
  for (const [key, value] of Object.entries(FARE_DEFAULTS)) {
    if (typeof value === 'number') {
      const raw = env[toEnvName(key)];
      const parsed = raw === undefined || raw === '' ? NaN : Number(raw);
      merged[key] = Number.isFinite(parsed) ? parsed : value;
    } else {
      merged[key] = value;
    }
  }
  return { ...merged, ...overrides };
}

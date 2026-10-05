// Data-confidence vocabulary shared by the transit pipeline and (later) the routing engine.
//
// Ordered from weakest to strongest trust:
//   unknown    - nothing is known about where the value came from
//   estimated  - computed by RouteConnect from a formula (distance x speed, fare per km, ...)
//   inferred   - derived from real data but extrapolated (e.g. an expired timetable, interpolated stop times)
//   published  - taken from a published timetable/feed within its stated validity
//   verified   - independently confirmed with the operator (NOTHING in the project is verified today)
//   live       - real-time data from a provider API
//
// "verified" and "live" must never be assigned to community or formula-derived data.

export const CONFIDENCE = Object.freeze({
  UNKNOWN: 'unknown',
  ESTIMATED: 'estimated',
  INFERRED: 'inferred',
  PUBLISHED: 'published',
  VERIFIED: 'verified',
  LIVE: 'live'
});

// Weakest -> strongest
export const CONFIDENCE_LEVELS = Object.freeze([
  CONFIDENCE.UNKNOWN,
  CONFIDENCE.ESTIMATED,
  CONFIDENCE.INFERRED,
  CONFIDENCE.PUBLISHED,
  CONFIDENCE.VERIFIED,
  CONFIDENCE.LIVE
]);

export function isConfidence(value) {
  return CONFIDENCE_LEVELS.includes(value);
}

function rank(level) {
  const index = CONFIDENCE_LEVELS.indexOf(level);
  return index === -1 ? 0 : index;
}

// A journey is only as trustworthy as its weakest leg.
export function weakestConfidence(...levels) {
  const flat = levels.flat();
  if (flat.length === 0) return CONFIDENCE.UNKNOWN;
  return flat.reduce((weakest, level) => (rank(level) < rank(weakest) ? level : weakest));
}

// Cap a confidence level at `ceiling` (never raises it).
export function capConfidence(level, ceiling) {
  return weakestConfidence(level, ceiling);
}

// Levels that require independent confirmation or a live provider connection.
export function requiresVerification(level) {
  return level === CONFIDENCE.VERIFIED || level === CONFIDENCE.LIVE;
}

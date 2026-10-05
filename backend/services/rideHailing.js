// Ride-hailing (Uber / Rapido) honesty rules.
//
// RouteConnect has NO integration with Uber or Rapido. Every ride-hailing option is a formula
// (distance x constant) shown as a convenience, so it must never be presented as live availability,
// a live fare, a live duration, or compete with timetable-backed public transport for "fastest",
// "cheapest/budget" or "recommended".

// PRODUCT DECISION: ride-hailing is OFF. RouteConnect has no provider integration for Uber or Rapido, so the
// legacy planner no longer generates (or prices) ride-hailing options at all, and the v2 planner never has.
// The generation code is kept only behind this development switch, to be reintroduced in a future phase if a
// legitimate provider integration becomes available. Never enable it for end users.
export function isLegacyRideHailingEnabled(env = process.env) {
  return env.ROUTECONNECT_LEGACY_RIDE_HAILING === '1';
}

export const RIDE_HAILING_MODES = Object.freeze(['uber', 'rapido']);

export const RIDE_HAILING_NOTE =
  'Estimated ride option. Availability, fare and duration are not provider-backed. ' +
  'Check the provider app for live availability and the final fare.';

// Structured metadata stamped on every estimated ride-hailing leg and on the routes that contain one.
export const RIDE_HAILING_ESTIMATE_METADATA = Object.freeze({
  providerIntegration: false,
  availabilityStatus: 'unknown',
  dataConfidence: 'estimated',
  fareConfidence: 'estimated',
  durationConfidence: 'estimated',
  isRealtime: false
});

export const RIDE_HAILING_RANKING_CLASS = 'estimated_ride_hailing';

export function isRideHailingMode(mode) {
  return RIDE_HAILING_MODES.includes(mode);
}

export function isRideHailingSegment(segment) {
  return Boolean(segment) && isRideHailingMode(segment.mode);
}

// True for pure ride options AND for mixed routes that contain an estimated ride leg (e.g. "Uber + Train").
export function isRideHailingRoute(route) {
  return Boolean(route?.segments?.some(isRideHailingSegment));
}

export function stampRideHailingSegment(segment) {
  if (!isRideHailingSegment(segment)) return segment;
  return {
    ...segment,
    ...RIDE_HAILING_ESTIMATE_METADATA,
    estimated: true,
    estimatedNote: RIDE_HAILING_NOTE
  };
}

// Marks a route as an estimated ride-hailing option: honest metadata, no trusted-ranking tags.
export function stampRideHailingRoute(route) {
  if (!isRideHailingRoute(route)) return route;
  return {
    ...route,
    segments: route.segments.map(stampRideHailingSegment),
    ...RIDE_HAILING_ESTIMATE_METADATA,
    rankingClass: RIDE_HAILING_RANKING_CLASS,
    rideHailingNote: RIDE_HAILING_NOTE,
    tag: null,
    isFastest: false,
    isBudget: false
  };
}

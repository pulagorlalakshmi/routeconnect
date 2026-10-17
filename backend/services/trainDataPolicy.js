// Train data policy for the LEGACY planner (/api/planner, /api/routes/stored).
//
// The legacy planner shipped hand-written train services (STATIC_TRAIN_SERVICES, seeded `segments` / `route_segments`
// rows, placeholder stations such as "Town X Railway Station"). None of it comes from a verified, licensed timetable,
// so no legacy endpoint may return a train leg. Train routing will only return once a genuine timetable provider is
// connected through the v2 rail source (backend/transit/sources/rail/railSource.js).
//
// Bus, walking and other non-train legs are untouched: a route is removed only when it contains a train leg.

export const LEGACY_TRAIN_DATA_ENABLED = false;

export const TRAIN_DATA_UNAVAILABLE = Object.freeze({
  code: 'TRAIN_DATA_UNAVAILABLE',
  error: 'Train journeys are not available yet: no verified railway timetable source is connected.'
});

const TRAIN_MODES = new Set(['train', 'rail', 'railway']);

export function isTrainSegment(segment) {
  return TRAIN_MODES.has(String(segment?.mode ?? '').toLowerCase()) || Boolean(segment?.trainNumber || segment?.train_number);
}

export function stripTrainRoutes(routes) {
  if (!Array.isArray(routes)) return [];
  return routes.filter(route => !(route?.segments ?? []).some(isTrainSegment));
}

// True when a request explicitly asks for train-only routing (?mode=train or ?modes=train), which cannot be served.
export function requestsTrainOnly(query = {}) {
  const requested = [query.mode, query.modes]
    .filter(value => typeof value === 'string' && value.trim() !== '')
    .flatMap(value => value.split(','))
    .map(value => value.trim().toLowerCase());
  return requested.length > 0 && requested.every(value => TRAIN_MODES.has(value));
}

import type { RouteResult, RouteSegment } from './routeService';

// RouteConnect has no Uber/Rapido integration: these options are formula-based estimates.
// They must never be shown as live availability and never earn "Fastest" / "Budget Route" / "Recommended".

export const RIDE_HAILING_NOTE = 'Check the provider app for live availability and the final fare.';

export const isRideHailingSegment = (segment: Pick<RouteSegment, 'mode'>): boolean =>
  segment.mode === 'uber' || segment.mode === 'rapido';

// True for standalone Uber/Rapido options and for mixed routes that contain an estimated ride leg.
export const isRideHailingRoute = (route: RouteResult): boolean =>
  route.rankingClass === 'estimated_ride_hailing' || route.segments.some(isRideHailingSegment);

// A route that is only an Uber/Rapido ride (no timetable-backed leg at all).
export const isStandaloneRideRoute = (route: RouteResult): boolean =>
  route.segments.length === 1 && isRideHailingSegment(route.segments[0]);

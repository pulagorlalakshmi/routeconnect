// Two separate trust questions for every APSRTC bus leg:
//   1. ROUTE trust:    is this bus in our timetable, and how sure is the time?   (leg.routeTrust)
//   2. TRACKING:       can it be tracked? Trackers exist for every APSRTC bus ("options"); a few services were also
//                      checked by hand ("verified" / "not_found").                (leg.tracking.status)
// They never feed each other: a bus no tracker knows is still a timetable bus and is never hidden for that reason.
import type { Journey, Leg, RouteTrust, ScheduleTrust, TrackingStatus, TransitLeg } from '../services/planService';
import { isTransitLeg } from '../services/planService';
import { APSRTC_TRACKERS } from '../config/apsrtcTrackers';
import type { ApsrtcTracker } from '../config/apsrtcTrackers';

export const SCHEDULE_TRUST_TEXT: Record<ScheduleTrust, string> = {
  published: 'Published schedule',
  inferred: 'Schedule inferred',
  estimated: 'Schedule estimated',
  unknown: 'Schedule unconfirmed'
};

export const TRACKING_TEXT: Record<TrackingStatus, string> = {
  verified: 'Live tracking verified',
  options_available: 'Live tracking options',
  not_found: 'No verified live tracker'
};

const DATASET_TOOLTIP = 'Schedule is based on the current APSRTC transit dataset used by RouteConnect.';
const INFERRED_TOOLTIP = 'Schedule is based on an expired community dataset and extrapolated timetable pattern.';

export function scheduleTooltip(trust: Pick<RouteTrust, 'scheduleConfidence'>): string {
  return trust.scheduleConfidence === 'inferred' ? INFERRED_TOOLTIP : DATASET_TOOLTIP;
}

// Older responses had no routeTrust: every transit leg is still a timetable trip, and its schedule level comes from the
// leg's own confidence (never shown as more than "published").
export function routeTrustOf(leg: TransitLeg): RouteTrust {
  if (leg.routeTrust) return leg.routeTrust;
  const level = leg.dataConfidence;
  const scheduleConfidence: ScheduleTrust = level === 'inferred' || level === 'estimated' || level === 'unknown' ? level : 'published';
  return { sourceType: 'gtfs', sourceName: null, scheduleConfidence, timetableBacked: true };
}

// null for a leg that has no tracking options at all (not an APSRTC bus, or no service number).
export function trackingStatusOf(leg: Pick<TransitLeg, 'operator' | 'tracking'>): TrackingStatus | null {
  if (!leg.operator || leg.operator.toUpperCase() !== 'APSRTC' || !leg.tracking) return null;
  const status = leg.tracking.status as string | undefined;
  // Anything not explicitly verified / not_found (including older responses) is the normal "options" state.
  return status === 'verified' || status === 'not_found' ? status : 'options_available';
}

const byId = (id: string) => APSRTC_TRACKERS.find(tracker => tracker.id === id) ?? null;

// Trackers that RECOGNISED this service: the preferred one first, then by registry priority. Empty unless verified,
// so "Track Bus" can never point at a tracker that is not known to work for this service.
export function verifiedTrackers(leg: Pick<TransitLeg, 'operator' | 'tracking'>): ApsrtcTracker[] {
  if (trackingStatusOf(leg) !== 'verified' || !leg.tracking) return [];
  const preferred = leg.tracking.preferredProvider;
  return leg.tracking.providers
    .filter(p => p.recognized === true)
    .map(p => byId(p.id))
    .filter((t): t is ApsrtcTracker => t !== null)
    .sort((a, b) => (b.id === preferred ? 1 : 0) - (a.id === preferred ? 1 : 0) || a.priority - b.priority);
}

export function verifiedTrackerNames(leg: Pick<TransitLeg, 'operator' | 'tracking'>): string[] {
  return verifiedTrackers(leg).map(t => t.name);
}

export function trackingTooltip(leg: Pick<TransitLeg, 'operator' | 'tracking'>): string {
  const status = trackingStatusOf(leg);
  const checked = leg.tracking?.checkedOn ? ` (checked ${leg.tracking.checkedOn})` : '';
  if (status === 'verified') return `Recognised by ${verifiedTrackerNames(leg).join(', ')}${checked}. The live position depends on the bus's GPS.`;
  if (status === 'not_found') return `Checked on APSRTC Official, redBus and AbhiBus${checked}; none listed this service. The bus is still in the timetable.`;
  return 'APSRTC Official, redBus and AbhiBus offer APSRTC live tracking. Pick one to look up this service.';
}

const busLegs = (journey: Pick<Journey, 'legs'>) => journey.legs.filter(isTransitLeg).filter(leg => trackingStatusOf(leg) !== null);

// One line each for the "Why this rating?" trust section.
export function journeyTrustSummary(journey: Pick<Journey, 'legs'>): { route: string; tracking: string } {
  const transit = journey.legs.filter((leg: Leg): leg is TransitLeg => isTransitLeg(leg));
  const levels = transit.map(leg => routeTrustOf(leg).scheduleConfidence);
  const order: ScheduleTrust[] = ['unknown', 'estimated', 'inferred', 'published'];
  const weakest = levels.length ? order.find(level => levels.includes(level))! : 'unknown';
  const route = `${transit.length > 0 ? 'Timetable-backed · ' : ''}${SCHEDULE_TRUST_TEXT[weakest]}`;

  const legs = busLegs(journey);
  if (legs.length === 0) return { route, tracking: 'Not applicable' };
  const verified = legs.filter(leg => trackingStatusOf(leg) === 'verified');
  if (verified.length === legs.length) {
    const names = [...new Set(verified.flatMap(verifiedTrackerNames))];
    return { route, tracking: `Verified on ${names.join(', ')}` };
  }
  if (verified.length > 0) return { route, tracking: `Verified for ${verified.length} of ${legs.length} buses` };
  if (legs.every(leg => trackingStatusOf(leg) === 'not_found')) return { route, tracking: 'No verified live tracker' };
  return { route, tracking: 'Live tracking options (APSRTC Official, redBus, AbhiBus)' };
}

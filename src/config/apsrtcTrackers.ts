// APSRTC tracking OPTIONS, in priority order. Every URL lives here and nowhere else.
//
// RouteConnect has no live bus data. These are public third-party pages the user may open; nothing is fetched, scraped
// or submitted for them, and no query parameters are ever added (none is documented by any of the three sites).
//
// Verified by hand in a browser on 2026-10-08:
//   apsrtc  - https://apsrtclivetrack.com/ is the "web portal" that APSRTC's own IT-initiatives page names for public
//             GPS tracking ("All services Time Table & Tracking"). It works in a desktop browser and has a
//             "Search By Service No/Vehicle Number" form. A result page exists (/#/trip_details?serviceDocId=...&oprsNo=...)
//             but serviceDocId is an internal id that cannot be derived, so it is NOT used. The page footer says it is
//             powered by AbhiBus.
//   redbus  - https://www.redbus.in/live-tracking/apsrtc/ has a "Service number" box and a "Track bus" button.
//   abhibus - https://www.abhibus.com/apsrtc-live-track/service-no is the "Track Bus by Reservation Service No" page.
// None of the three documents a direct service-number link, so the number is copied and the page is opened as-is.
//
// Coverage check, by hand in Chrome on 2026-10-08, typing 15 service numbers from RouteConnect journeys (8 corridors,
// direct and 1-2 transfer, morning to night) into each tracker's own search box:
//   recognised by all three:  35169, 51527, 27092, 27159               (4 / 15)
//   recognised by none:       05408 03873 03414 03772 03551 06356 08310 03146 03507 03675 09567   (11 / 15)
// The three gave identical answers for every number (the official portal and AbhiBus share AbhiBus's backend), so the
// official APSRTC portal stays the default and redBus/AbhiBus remain one click away in the menu. These are options to
// try, not a promise that any bus has active GPS.

export type TrackerId = 'apsrtc' | 'redbus' | 'abhibus';

export interface ApsrtcTracker {
  id: TrackerId;
  name: string;
  // "official" is APSRTC's own portal; "external" is a third party.
  type: 'official' | 'external';
  priority: number; // 1 = first
  url: string;
  // The tracker has a field where a service number is entered, so RouteConnect copies the number before opening it.
  supportsServiceNumber: boolean;
}

export const APSRTC_TRACKERS: readonly ApsrtcTracker[] = Object.freeze([
  Object.freeze({ id: 'apsrtc', name: 'APSRTC Official', type: 'official', priority: 1, url: 'https://apsrtclivetrack.com/', supportsServiceNumber: true }),
  Object.freeze({ id: 'redbus', name: 'redBus', type: 'external', priority: 2, url: 'https://www.redbus.in/live-tracking/apsrtc/', supportsServiceNumber: true }),
  Object.freeze({ id: 'abhibus', name: 'AbhiBus', type: 'external', priority: 3, url: 'https://www.abhibus.com/apsrtc-live-track/service-no', supportsServiceNumber: true })
] as ApsrtcTracker[]);

export const TRACKER_LINK_REL = 'noopener noreferrer';
export const TRACKER_INFO = 'Tracking provided by APSRTC/external partners.';

// The trackers to offer for a leg, best first. When the backend sent `tracking.providers`, only those ids are offered;
// otherwise an APSRTC leg gets the whole registry.
export function trackersForLeg(leg: {
  operator?: string | null;
  tracking?: { providers: { id: string; availableAsExternalOption: boolean }[] } | null;
}): ApsrtcTracker[] {
  if (!leg.operator || leg.operator.toUpperCase() !== 'APSRTC') return [];
  const allowed = leg.tracking ? new Set(leg.tracking.providers.filter(p => p.availableAsExternalOption).map(p => p.id)) : null;
  return APSRTC_TRACKERS.filter(tracker => !allowed || allowed.has(tracker.id)).slice().sort((a, b) => a.priority - b.priority);
}

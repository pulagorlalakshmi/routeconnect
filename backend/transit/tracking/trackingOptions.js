// Live-tracking status for a transit leg, kept apart from route/schedule trust (see routeTrust in journeyBuilder.js).
//
// Two different facts:
//   1. Public APSRTC trackers exist (APSRTC Official, redBus, AbhiBus) - true for every APSRTC bus.
//   2. This EXACT service was checked on them - only for services in trackerChecks.js.
// So the status is:
//   verified          - a tracker was seen to recognise this service
//   options_available - the default: trackers exist, this service has not been (fully) checked
//   not_found         - every supported tracker was checked and none recognised it
// RouteConnect never queries a tracker and never reports a live position. The URLs live in the frontend registry
// (src/config/apsrtcTrackers.ts); the backend names providers by id only.
import { TRACKER_CHECKS, TRACKER_CHECKS_DATE } from './trackerChecks.js';

export const APSRTC_TRACKER_IDS = Object.freeze(['apsrtc', 'redbus', 'abhibus']);
export const TRACKING_STATUS = Object.freeze({ VERIFIED: 'verified', OPTIONS_AVAILABLE: 'options_available', NOT_FOUND: 'not_found' });

// The status is derived from the evidence, so an entry can never claim more than it shows: "verified" needs a provider
// that recognised the service, and "not_found" needs every supported provider to have been checked.
export function trackingStatusFor(serviceNumber, checks = TRACKER_CHECKS) {
  const entry = Object.prototype.hasOwnProperty.call(checks, serviceNumber) ? checks[serviceNumber] : null;
  const recognised = new Set((entry?.providers ?? []).filter(id => APSRTC_TRACKER_IDS.includes(id)));
  const checked = new Set([...(entry?.checked ?? []), ...recognised]);

  let status = TRACKING_STATUS.OPTIONS_AVAILABLE;
  if (recognised.size > 0) status = TRACKING_STATUS.VERIFIED;
  else if (entry && APSRTC_TRACKER_IDS.every(id => checked.has(id))) status = TRACKING_STATUS.NOT_FOUND;

  const providers = APSRTC_TRACKER_IDS.map(id => ({
    id,
    // true / false from a manual check; null when that tracker was not checked for this service
    recognized: recognised.has(id) ? true : checked.has(id) ? false : null,
    availableAsExternalOption: true
  }));
  return {
    status,
    providers,
    // The highest-priority tracker that recognised the service; null unless verified.
    preferredProvider: APSRTC_TRACKER_IDS.find(id => recognised.has(id)) ?? null,
    checkedOn: entry ? TRACKER_CHECKS_DATE : null
  };
}

/**
 * @param {{ operator: string|null, serviceNumber: string|null, vehicleNumber?: string|null }} identity
 * @returns {null | { serviceNumber, vehicleNumber, status, providers, preferredProvider, checkedOn }}
 */
export function trackingOptionsFor(identity, checks = TRACKER_CHECKS) {
  if (identity.operator !== 'APSRTC' || !identity.serviceNumber) return null;
  return {
    serviceNumber: identity.serviceNumber,
    vehicleNumber: identity.vehicleNumber ?? null,
    ...trackingStatusFor(identity.serviceNumber, checks)
  };
}

// Journey-level summary over its APSRTC bus legs.
export function journeyTracking(legs) {
  const tracked = legs.filter(leg => leg.tracking);
  const count = status => tracked.filter(leg => leg.tracking.status === status).length;
  return {
    busLegs: tracked.length,
    verifiedLegs: count(TRACKING_STATUS.VERIFIED),
    notFoundLegs: count(TRACKING_STATUS.NOT_FOUND),
    allVerified: tracked.length > 0 && tracked.every(leg => leg.tracking.status === TRACKING_STATUS.VERIFIED)
  };
}

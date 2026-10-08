// What the APSRTC GTFS identifiers are, and when one may be shown as a public SERVICE NUMBER.
//
// Audit of the imported community feed (2026-10-08):
//   - route_id, route_short_name, route_long_name, trip_id and trip_headsign are ALL the same code, e.g. "03846";
//     there is exactly one trip per route. So the feed has one identifier per scheduled departure, nothing else.
//   - Typed into APSRTC's own tracker (apsrtclivetrack.com) as given, "03846" is "No service found". Typed WITHOUT
//     the leading zero ("3846") it is listed. The feed zero-pads 4-digit service numbers to 5 characters.
//   - Checked by hand on the APSRTC Official tracker:
//       0dddd codes, zero stripped ...... 14 of 14 listed  (3565 3589 3657 4369 5408 3846 3873 3414 6356 9567 3675 9594 2709 3507)
//       5-digit codes 1xxxx-8xxxx ........ 9 of 10 listed (35169 51527 27092 27159 44039 51524 50101 35289 23545; not 21212)
//       9xxxx codes ...................... 0 of 2  (95083, 98509)
//       6-digit codes .................... 0 of 1  (952054)
// Policy:
//   - 0dddd and [1-8]dddd codes are APSRTC service numbers in this feed's format. They are shown as "Service No."
//     with the leading zero removed, marked 'feed_format' (or 'tracker_verified' when that exact number was checked).
//   - Any other shape (9xxxx, 6+ digits, letters) has no evidence of being a public service number: it is shown as
//     "Route <code>" and is NOT offered to trackers.
//   - Evidence about one exact code beats the format rule: a code APSRTC's tracker was seen NOT to list (21212) is a
//     route code only, even though its shape usually is a service number.
// The policy applies only to a feed whose agency is APSRTC; any other feed gets route codes only until audited.
import { TRACKER_CHECKS, UNRECOGNISED_FEED_CODES } from '../../tracking/trackerChecks.js';

export const SERVICE_NUMBER_POLICY = Object.freeze({
  operator: 'APSRTC',
  formats: Object.freeze([
    { pattern: /^0(\d{4})$/, group: 1, evidence: '14 of 14 sampled zero-padded codes are listed by APSRTC\'s tracker without the zero' },
    { pattern: /^([1-8]\d{4})$/, group: 1, evidence: '9 of 10 sampled 5-digit codes are listed by APSRTC\'s tracker' }
  ])
});

/**
 * @param {string|null} routeCode   the feed's route_short_name (falls back to route_id)
 * @param {string|null} operatorName operator from the feed's agency
 * @returns {{ serviceNumber: string|null, serviceNumberSource: 'tracker_verified'|'feed_format'|null }}
 */
export function serviceNumberFor(routeCode, operatorName, policy = SERVICE_NUMBER_POLICY, checks = TRACKER_CHECKS, unrecognised = UNRECOGNISED_FEED_CODES) {
  const code = typeof routeCode === 'string' ? routeCode.trim() : '';
  if (!code || operatorName !== policy.operator) return { serviceNumber: null, serviceNumberSource: null };
  if (Object.prototype.hasOwnProperty.call(unrecognised, code)) return { serviceNumber: null, serviceNumberSource: null };
  for (const format of policy.formats) {
    const match = format.pattern.exec(code);
    if (!match) continue;
    const number = match[format.group];
    const verified = Object.prototype.hasOwnProperty.call(checks, number) && checks[number].status === 'verified';
    return { serviceNumber: number, serviceNumberSource: verified ? 'tracker_verified' : 'feed_format' };
  }
  return { serviceNumber: null, serviceNumberSource: null };
}

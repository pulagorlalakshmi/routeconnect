// Manual tracker checks: EXPLICIT results only. Each entry records what a person saw after typing the PUBLIC SERVICE
// NUMBER into a tracker's own search box. Nothing here is fetched, scraped or inferred.
//
// Keys are the public service number as the trackers know it - WITHOUT the leading zero the GTFS feed adds
// (feed route code "03846" is service "3846"; see backend/transit/sources/gtfs/serviceNumbers.js).
//
//   status     'verified'  - at least one tracker listed this exact service (`providers` names them)
//              'not_found' - every supported tracker was checked and none listed it
//   providers  trackers that recognised the service
//   checked    trackers that were actually tried
//
// A service with NO entry resolves to 'options_available'. Missing data is never treated as a failure.
// "Recognised" means the tracker knows the service; it does not promise that a given bus has working GPS right now.
//
// History (all by hand in Chrome, 2026-10-08):
//   - Round 1/2 checked 5-digit services that have no leading zero (35169, 51527, ...): still valid, kept below.
//   - Rounds 1/2 also "failed" 05408, 03846, 09594, ... - but those were typed WITH the feed's leading zero. Typed as
//     the trackers expect (5408, 3846, 9594, ...) every one of them is recognised. The zero-padded results were
//     therefore not evidence and have been removed.
//   - Round 3 re-checked zero-stripped numbers on APSRTC Official (and some on AbhiBus).
// redBus would not accept input during rounds 2-3, so it is only listed where it was actually checked.

export const TRACKER_CHECKS_DATE = '2026-10-08';

const ALL = Object.freeze(['apsrtc', 'redbus', 'abhibus']);
const OFFICIAL_AND_ABHIBUS = Object.freeze(['apsrtc', 'abhibus']);
const OFFICIAL = Object.freeze(['apsrtc']);

const verified = (providers, checked = providers) => Object.freeze({ status: 'verified', providers, checked });

export const TRACKER_CHECKS = Object.freeze({
  // Round 1 - all three trackers.
  35169: verified(ALL), // Guntur -> Narasaraopet
  51527: verified(ALL), // Guntur -> Narasaraopet
  27092: verified(ALL), // Srikakulam -> Visakhapatnam
  27159: verified(ALL), // Srikakulam -> Visakhapatnam
  44039: verified(['redbus', 'abhibus']),

  // Rounds 2-3 - APSRTC Official and AbhiBus.
  51524: verified(OFFICIAL_AND_ABHIBUS),
  50101: verified(OFFICIAL_AND_ABHIBUS),
  35289: verified(OFFICIAL_AND_ABHIBUS),
  3589: verified(OFFICIAL_AND_ABHIBUS), // Vijayawada -> Hyderabad (feed code 03589)
  5408: verified(OFFICIAL_AND_ABHIBUS), // Guntur -> Vijayawada (feed code 05408)

  // Round 3 - APSRTC Official, zero-stripped feed codes.
  3565: verified(OFFICIAL), // Vijayawada -> Hyderabad
  3657: verified(OFFICIAL), // Vijayawada -> Hyderabad
  4369: verified(OFFICIAL), // Vijayawada -> Hyderabad
  3846: verified(OFFICIAL),
  3873: verified(OFFICIAL),
  3414: verified(OFFICIAL),
  6356: verified(OFFICIAL),
  9567: verified(OFFICIAL),
  3675: verified(OFFICIAL),
  9594: verified(OFFICIAL),
  2709: verified(OFFICIAL),
  3507: verified(OFFICIAL),
  23545: verified(OFFICIAL)
});

// Feed route codes that the APSRTC Official tracker did NOT list (round 3). Kept as audit evidence: they show that the
// 9xxxx / 6-digit code shapes are not confirmed public service numbers (see serviceNumbers.js). 21212 is a 5-digit
// code that was not listed; it still resolves to "options_available" because the other trackers were not checked.
export const UNRECOGNISED_FEED_CODES = Object.freeze({
  952054: OFFICIAL, // Vijayawada -> Hyderabad
  95083: OFFICIAL_AND_ABHIBUS, // Vijayawada -> Nandigama
  98509: OFFICIAL, // Vijayawada -> Hyderabad
  21212: OFFICIAL  // Vijayawada -> Hyderabad
});

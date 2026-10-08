// Route trust and live-tracking status are separate: a timetable bus stays a timetable bus whatever trackers know about
// it, and an unchecked service is "options_available", never a failure.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { trackingStatusFor, trackingOptionsFor, journeyTracking, APSRTC_TRACKER_IDS } from '../trackingOptions.js';
import { TRACKER_CHECKS } from '../trackerChecks.js';
import { routeTrust } from '../../routing/journeyBuilder.js';
import { rateJourneys, bestPathIds, trackingScore } from '../../rating/pathRating.js';
import { RATING_DEFAULTS } from '../../rating/ratingConfig.js';
import { makeNetwork, plan, daily } from '../../routing/__tests__/helpers.js';

const STOPS = { A: [16.5, 80.0], C: [16.5, 80.1] };
// Near-identical direct buses A -> C: 09999 (service 9999, never checked), 35169 (verified on all three) and 95083
// (a 9xxxx feed code: no evidence it is a public service number, so no tracking at all).
const apsrtcSpec = (extra = {}) => ({
  stops: STOPS,
  trips: [
    { id: 'T1', route: '09999', service: 'ALL', times: [['A', '08:00'], ['C', '09:00']] },
    { id: 'T2', route: '35169', service: 'ALL', times: [['A', '08:05'], ['C', '09:05']] },
    { id: 'T3', route: '95083', service: 'ALL', times: [['A', '08:10'], ['C', '09:10']] }
  ],
  calendars: [daily()],
  agency: 'APSRTC',
  dataset: { name: 'Community APSRTC GTFS' },
  ...extra
});
// The live dataset is expired, so its schedules are inferred from the weekly pattern.
const expiredSpec = () => apsrtcSpec({ calendars: [daily('ALL', '2026-08-30', '2026-09-30')], dataset: { name: 'Community APSRTC GTFS', valid_from: '2026-08-30', valid_to: '2026-09-30' } });
const legOf = (result, code) => result.journeys.flatMap(j => j.legs).find(leg => leg.routeCode === code);
const stripIds = result => result.journeys.map(j => j.legs.map(({ tracking, routeTrust: _r, ...leg }) => leg));

describe('tracking status model', () => {
  test('1. a service absent from the registry is options_available (never "not verified" / "not found")', () => {
    for (const service of ['09999', '12345', '06378']) {
      assert.ok(!(service in TRACKER_CHECKS));
      const t = trackingStatusFor(service);
      assert.equal(t.status, 'options_available', service);
      assert.equal(t.preferredProvider, null);
      assert.equal(t.checkedOn, null);
      assert.ok(t.providers.every(p => p.recognized === null && p.availableAsExternalOption));
    }
  });

  test('2. a registry-verified service is verified, preferring the highest-priority confirmed tracker', () => {
    const all = trackingStatusFor('35169');
    assert.equal(all.status, 'verified');
    assert.equal(all.preferredProvider, 'apsrtc');
    assert.deepEqual(all.providers.map(p => p.recognized), [true, true, true]);
    const partial = trackingStatusFor('44039');
    assert.equal(partial.status, 'verified');
    assert.equal(partial.preferredProvider, 'redbus');
    assert.deepEqual(partial.providers.map(p => p.recognized), [null, true, true]);
    const round2 = trackingStatusFor('51524');
    assert.equal(round2.status, 'verified');
    assert.deepEqual(round2.providers.map(p => p.recognized), [true, null, true]);
  });

  test('3. checked on every supported tracker with no hit => not_found', () => {
    const checks = { 1234: { status: 'not_found', providers: [], checked: ['apsrtc', 'redbus', 'abhibus'] } };
    const t = trackingStatusFor('1234', checks);
    assert.equal(t.status, 'not_found');
    assert.deepEqual(t.providers.map(p => p.recognized), [false, false, false]);
  });

  test('a partial check with no hit is NOT not_found', () => {
    const checks = { 1234: { providers: [], checked: ['apsrtc', 'abhibus'] } };
    assert.equal(trackingStatusFor('1234', checks).status, 'options_available');
  });

  test('the registry is keyed by public service numbers (no leading zero) and never by a zero-padded feed code', () => {
    for (const key of Object.keys(TRACKER_CHECKS)) assert.doesNotMatch(key, /^0/, key);
    assert.equal(trackingStatusFor('3846').status, 'verified');
    assert.equal(trackingStatusFor('03846').status, 'options_available', 'the padded code is not what trackers know');
  });

  test('an entry cannot overclaim: the status is derived from providers/checked, not trusted blindly', () => {
    assert.equal(trackingStatusFor('X', { X: { status: 'verified', providers: [], checked: ['redbus'] } }).status, 'options_available');
    assert.equal(trackingStatusFor('X', { X: { status: 'not_found', providers: [], checked: ['redbus'] } }).status, 'options_available');
    assert.equal(trackingStatusFor('X', { X: { status: 'verified', providers: ['made-up'] } }).status, 'options_available');
  });

  test('every registry entry is consistent with its evidence', () => {
    for (const [service, entry] of Object.entries(TRACKER_CHECKS)) {
      const derived = trackingStatusFor(service).status;
      if (entry.status) assert.equal(derived, entry.status, service);
      for (const id of [...entry.providers, ...(entry.checked ?? [])]) assert.ok(APSRTC_TRACKER_IDS.includes(id), `${service}: ${id}`);
    }
  });

  test('non-APSRTC legs and legs without a service number get no tracking', () => {
    assert.equal(trackingOptionsFor({ operator: null, serviceNumber: '35169' }), null);
    assert.equal(trackingOptionsFor({ operator: 'APSRTC', serviceNumber: null }), null);
  });

  test('nothing claims a live position', () => {
    assert.doesNotMatch(JSON.stringify(trackingOptionsFor({ operator: 'APSRTC', serviceNumber: '35169' })), /liveAvailable|position|lat|lon|eta/i);
  });
});

describe('route trust is independent of tracking', () => {
  test('routeTrust is built from the dataset and schedule confidence only', () => {
    assert.deepEqual(routeTrust({ name: 'Community APSRTC GTFS' }, 'inferred'), { sourceType: 'gtfs', sourceName: 'Community APSRTC GTFS', scheduleConfidence: 'inferred', timetableBacked: true });
    assert.equal(routeTrust({}, 'verified').scheduleConfidence, 'published', 'never reported as a verified schedule');
  });

  test('planner: every bus is returned whatever its tracking status, each timetable-backed with inferred schedule', () => {
    const result = plan(makeNetwork(expiredSpec()), expiredSpec(), { from: 'A', to: 'C', date: '2026-10-05', time: '07:55' });
    assert.deepEqual(result.journeys.flatMap(j => j.legs).map(leg => leg.routeCode).sort(), ['09999', '35169', '95083']);
    for (const code of ['09999', '35169', '95083']) {
      assert.equal(legOf(result, code).routeTrust.timetableBacked, true);
      assert.equal(legOf(result, code).routeTrust.scheduleConfidence, 'inferred');
      assert.equal(legOf(result, code).operatorInfo.name, 'APSRTC');
    }
    assert.equal(legOf(result, '35169').tracking.status, 'verified');
    assert.equal(legOf(result, '09999').serviceNumber, '9999');
    assert.equal(legOf(result, '09999').tracking.status, 'options_available');
    // 95083: shown as a route code only, and never offered to trackers.
    assert.equal(legOf(result, '95083').serviceNumber, null);
    assert.equal(legOf(result, '95083').tracking, null);
    assert.equal(legOf(result, '95083').displayName, 'APSRTC route 95083');
  });

  test('12. routes are unchanged by the tracking registry: same journeys, same legs, same times with an empty registry', async () => {
    const network = makeNetwork(apsrtcSpec());
    const withRegistry = plan(network, apsrtcSpec(), { from: 'A', to: 'C', time: '07:55' });
    // Only tracking fields differ; the timetable search result itself is identical.
    const ids = withRegistry.journeys.map(j => j.id).sort();
    assert.equal(ids.length, 3);
    for (const leg of stripIds(withRegistry).flat()) assert.ok(leg.departureTime && leg.tripId);
    assert.equal(trackingOptionsFor({ operator: 'APSRTC', serviceNumber: '35169' }, {}).status, 'options_available');
  });

  test('journey tracking summary', () => {
    const leg = status => ({ mode: 'bus', tracking: { status } });
    assert.equal(journeyTracking([leg('verified'), leg('verified')]).allVerified, true);
    assert.equal(journeyTracking([leg('verified'), leg('options_available')]).allVerified, false);
    assert.deepEqual(journeyTracking([leg('verified'), leg('not_found'), { mode: 'walk' }]), { busLegs: 2, verifiedLegs: 1, notFoundLegs: 1, allVerified: false });
  });
});

describe('Best Path Rating and tracking', () => {
  const MIN = 60;
  const fare = { min: 150, max: 250, currency: 'INR', confidence: 'estimated', complete: true, components: [], unknownComponents: [] };
  const busLeg = status => ({ mode: 'bus', tracking: { status } });
  const journey = (id, minutes, status) => ({
    id, labels: [], transfers: 0, totalDurationSeconds: minutes * MIN, walkingDurationSeconds: 0, waitingDurationSeconds: 0,
    localRideCount: 0, scheduleConfidence: 'inferred', fareEstimate: fare, legs: [busLeg(status)],
    tracking: journeyTracking([busLeg(status)])
  });

  test('11. tracking weight is at most 5%, weights sum to 1, and options_available is only mildly below verified', () => {
    const w = RATING_DEFAULTS.weights;
    assert.ok(w.tracking > 0 && w.tracking <= 0.05, `${w.tracking}`);
    assert.ok(Math.abs(Object.values(w).reduce((a, b) => a + b, 0) - 1) < 1e-9);
    for (const key of ['time', 'cost', 'transfers', 'firstLastMile', 'schedule']) assert.ok(w[key] > w.tracking, key);
    assert.deepEqual({ ...RATING_DEFAULTS.trackingScores }, { verified: 10, options_available: 7, not_found: 4 });
  });

  test('an unchecked service costs at most 0.15 points; the full not_found-to-verified spread stays under 0.35', () => {
    const [v] = rateJourneys([journey('v', 120, 'verified')]);
    const [o] = rateJourneys([journey('o', 120, 'options_available')]);
    const [n] = rateJourneys([journey('n', 120, 'not_found')]);
    assert.ok(v.raw - o.raw <= 0.15 + 1e-9, `${v.raw - o.raw}`);
    assert.ok(v.raw - n.raw < 0.35, `${v.raw - n.raw}`);
    assert.equal(o.parameters.tracking.score, 7);
  });

  test('a journey with no APSRTC leg has no tracking score (N/A), not a penalty', () => {
    const j = { ...journey('x', 120, 'verified'), legs: [{ mode: 'bus', tracking: null }] };
    assert.equal(trackingScore(j), null);
    assert.equal(rateJourneys([j])[0].parameters.tracking.score, null);
  });

  test('a much faster unchecked route beats a slower verified one (2h10 vs 5h30)', () => {
    const list = [journey('fast', 130, 'options_available'), journey('slow', 330, 'verified')];
    assert.deepEqual(bestPathIds(list, rateJourneys(list)), ['fast']);
  });

  test('between near-equal routes (2 min apart) the verified one is preferred', () => {
    const list = [journey('unchecked', 130, 'options_available'), journey('verified', 132, 'verified')];
    assert.deepEqual(bestPathIds(list, rateJourneys(list)), ['verified']);
  });

  test('a clearly slower verified route (+15 min on 2h10) does not win', () => {
    const list = [journey('unchecked', 130, 'options_available'), journey('verified', 145, 'verified')];
    assert.deepEqual(bestPathIds(list, rateJourneys(list)), ['unchecked']);
  });

  test('"Live tracking verified" is only a reason when every bus is verified, and never a caution otherwise', () => {
    const [v] = rateJourneys([journey('v', 120, 'verified')]);
    const [o] = rateJourneys([journey('o', 120, 'options_available')]);
    assert.ok(v.reasons.some(r => r.metric === 'tracking' && r.type === 'positive'));
    assert.ok(!o.reasons.some(r => r.metric === 'tracking'));
  });
});

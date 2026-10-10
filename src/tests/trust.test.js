// Route trust vs live-tracking status in the journey card and the rating explanation.
// An unchecked APSRTC service is the NORMAL case: "Live tracking options" + "Check Live Tracking", never a failure.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { bundle, sourceRoot } from './harness.js';

globalThis.localStorage = { getItem: () => null, setItem: () => {}, removeItem: () => {} };

const ui = bundle(`
  import { createElement } from 'react';
  import { renderToStaticMarkup } from 'react-dom/server';
  import { MemoryRouter } from 'react-router-dom';
  import { AuthProvider } from './context/AuthContext';
  import JourneyCard from './components/JourneyCard';
  import { RatingBreakdown } from './components/PathRating';
  import { BusSummaryRow, LegTrust, TrackBus, TrackerMenu } from './components/BusIdentity';
  import { trackersForLeg } from './config/apsrtcTrackers';
  import * as trust from './utils/trackingTrust';
  export const render = (Component, props) => renderToStaticMarkup(createElement(Component, props));
  export const renderCard = props => renderToStaticMarkup(
    createElement(MemoryRouter, null, createElement(AuthProvider, null, createElement(JourneyCard, props))));
  export { RatingBreakdown, BusSummaryRow, LegTrust, TrackBus, TrackerMenu, trackersForLeg, trust };
`, 'trust');

const strip = markup => markup.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
const hrefs = markup => [...markup.matchAll(/href="([^"]+)"/g)].map(m => m[1]);
const URLS = { apsrtc: 'https://apsrtclivetrack.com/', redbus: 'https://www.redbus.in/live-tracking/apsrtc/', abhibus: 'https://www.abhibus.com/apsrtc-live-track/service-no' };

const tracking = (service, status, recognized = {}) => ({
  serviceNumber: service, vehicleNumber: null, status,
  providers: ['apsrtc', 'redbus', 'abhibus'].map(id => ({ id, recognized: recognized[id] ?? null, availableAsExternalOption: true })),
  preferredProvider: ['apsrtc', 'redbus', 'abhibus'].find(id => recognized[id] === true) ?? null,
  checkedOn: Object.keys(recognized).length ? '2026-10-08' : null
});
const VERIFIED_44039 = tracking('44039', 'verified', { redbus: true, abhibus: true });
const OPTIONS_09594 = tracking('09594', 'options_available');
const NOT_FOUND_05408 = tracking('05408', 'not_found', { apsrtc: false, redbus: false, abhibus: false });

const leg = (service, trackingInfo, extra = {}) => ({
  mode: 'bus', routeId: `r${service}`, routeShortName: service, routeLongName: null, operator: 'APSRTC', serviceNumber: service,
  vehicleNumber: null, vehicleNumberSource: null, vehicleNumberConfidence: 'unknown', tripId: `t${service}`, headsign: null,
  fromStop: { type: 'stop', name: 'Guntur', lat: 16.3, lon: 80.45 }, toStop: { type: 'stop', name: 'Narasaraopet', lat: 16.2, lon: 80.1 },
  departureTime: '2026-10-09T10:33:00+05:30', arrivalTime: '2026-10-09T12:25:00+05:30', gtfsDepartureTime: '10:33:00', gtfsArrivalTime: '12:25:00',
  serviceDate: '2026-10-09', scheduleBasis: 'extrapolated_weekly_pattern', durationSeconds: 6720, intermediateStopCount: 6, datasetId: 1,
  dataConfidence: 'inferred', timeQuality: 'approximate', fare: null,
  routeTrust: { sourceType: 'gtfs', sourceName: 'Community APSRTC GTFS', scheduleConfidence: 'inferred', timetableBacked: true },
  tracking: trackingInfo, ...extra
});
const rating = () => ({
  score: 8.6, raw: 8.6, label: 'Very Good', summary: 'Strong balance of time, cost and convenience.', comparedWith: 2,
  parameters: { time: { score: 9, weight: 0.3325 }, cost: { score: 8, weight: 0.2375 }, transfers: { score: 10, weight: 0.1425 },
    firstLastMile: { score: 10, weight: 0.1425 }, schedule: { score: 7, weight: 0.095 }, tracking: { score: 7, weight: 0.05 } },
  reasons: [{ type: 'positive', metric: 'transfers', text: 'No transfers' }]
});
const journey = (legs, extra = {}) => ({
  id: `jr_${legs.map(l => l.serviceNumber).join('_')}`, labels: ['BEST_PATH'], departureTime: legs[0].departureTime, arrivalTime: legs.at(-1).arrivalTime,
  totalDurationSeconds: 6720, walkingDurationSeconds: 0, waitingDurationSeconds: 0, transfers: legs.length - 1, transitLegCount: legs.length,
  datasetConfidence: 'inferred', scheduleConfidence: 'inferred', confidence: 'inferred', timeQuality: 'approximate',
  localRideDurationSeconds: 0, localRideCount: 0, fare: null,
  fareEstimate: { min: 150, max: 295, currency: 'INR', confidence: 'estimated', complete: true, components: [], unknownComponents: [] },
  rating: rating(), legs, ...extra
});
const card = j => ui.renderCard({ journey: j, index: 1, from: 'Guntur', to: 'Narasaraopet' });

describe('tracking status in the journey card', () => {
  test('4/7. an untested service (09594) shows "Live tracking options" and a "Check Live Tracking" dropdown', () => {
    const text = strip(ui.render(ui.BusSummaryRow, { leg: leg('09594', OPTIONS_09594) }));
    assert.match(text, /Service No\. 09594/);
    assert.match(text, /Timetable-backed Schedule inferred · Live tracking options Check Live Tracking/);
    assert.doesNotMatch(text, /not verified|Track Bus|No verified/i);
    const control = ui.render(ui.TrackBus, { leg: leg('09594', OPTIONS_09594), mode: 'check' });
    assert.match(control, /aria-haspopup="menu"/);
    // The dropdown offers every APSRTC tracker, none marked as a default.
    const menu = ui.render(ui.TrackerMenu, { trackers: ui.trackersForLeg(leg('09594', OPTIONS_09594)), serviceNumber: '09594', onLaunch: () => {}, onResult: () => {}, markDefault: false });
    assert.equal(strip(menu), 'Track with APSRTC Official redBus AbhiBus');
    assert.deepEqual(hrefs(menu), [URLS.apsrtc, URLS.redbus, URLS.abhibus]);
  });

  test('an older response with no status, or the retired "unverified", is treated as options_available', () => {
    assert.equal(ui.trust.trackingStatusOf(leg('09594', { ...OPTIONS_09594, status: undefined })), 'options_available');
    assert.equal(ui.trust.trackingStatusOf(leg('09594', { ...OPTIONS_09594, status: 'unverified' })), 'options_available');
  });

  test('5/8. a verified service shows "Live tracking verified" and Track Bus opens the preferred verified provider', () => {
    const text = strip(ui.render(ui.BusSummaryRow, { leg: leg('44039', VERIFIED_44039) }));
    assert.match(text, /Timetable-backed Schedule inferred · Live tracking verified Track Bus/);
    const control = ui.render(ui.TrackBus, { leg: leg('44039', VERIFIED_44039) });
    assert.deepEqual(hrefs(control), [URLS.redbus], 'redBus is the preferred verified provider for 44039');
    assert.deepEqual(ui.trust.verifiedTrackers(leg('44039', VERIFIED_44039)).map(t => t.id), ['redbus', 'abhibus'], 'only confirmed providers');
  });

  test('6. a checked-and-failed service shows "No verified live tracker" and no tracker button', () => {
    const markup = ui.render(ui.BusSummaryRow, { leg: leg('05408', NOT_FOUND_05408) });
    assert.match(strip(markup), /Timetable-backed Schedule inferred · No verified live tracker$/);
    assert.doesNotMatch(strip(markup), /Track Bus|Check Live Tracking/);
    assert.equal(hrefs(markup).length, 0);
  });

  test('no Track Bus button for anything that is not verified', () => {
    for (const t of [OPTIONS_09594, NOT_FOUND_05408, null]) assert.equal(ui.render(ui.TrackBus, { leg: leg('x', t) }), '');
  });

  test('12. tracking stays secondary: small muted text, no warning styling, route trust first', () => {
    const markup = ui.render(ui.LegTrust, { leg: leg('09594', OPTIONS_09594) });
    assert.ok(strip(markup).indexOf('Timetable-backed') < strip(markup).indexOf('Live tracking options'));
    assert.doesNotMatch(markup, /amber|red-|bg-red|text-red|AlertTriangle|⚠/);
  });

  test('a whole card with only untested buses has no negative tracking wording', () => {
    const text = strip(ui.renderCard({ journey: journey([leg('09594', OPTIONS_09594), leg('51524', OPTIONS_09594)]), index: 1, from: 'Guntur', to: 'Narasaraopet', initialShowDetails: true }));
    assert.doesNotMatch(text, /not verified|No verified|No public|Tracking failed|Untrusted/i);
    assert.equal((text.match(/Live tracking options/g) || []).length, 2);
  });

  test('route trust is shown independently, with the schedule source tooltip', () => {
    for (const t of [VERIFIED_44039, OPTIONS_09594, NOT_FOUND_05408]) {
      const markup = ui.render(ui.LegTrust, { leg: leg(t.serviceNumber, t) });
      assert.match(strip(markup), /^Timetable-backed Schedule inferred/);
      assert.match(markup, /title="Schedule is based on an expired community dataset and extrapolated timetable pattern\."/);
    }
  });
});

describe('"Why this rating?" trust section', () => {
  test('route confidence and tracking side by side', () => {
    const text = strip(ui.render(ui.RatingBreakdown, { rating: rating(), trust: ui.trust.journeyTrustSummary(journey([leg('44039', VERIFIED_44039)])) }));
    assert.match(text, /Route confidence Timetable-backed · Schedule inferred Tracking Verified on redBus, AbhiBus/);
    assert.match(text, /Tracking Confidence 7\.0 \/ 10/);
  });

  test('summaries for options, not found and mixed journeys', () => {
    assert.equal(ui.trust.journeyTrustSummary(journey([leg('09594', OPTIONS_09594)])).tracking, 'Live tracking options (APSRTC Official, redBus, AbhiBus)');
    assert.equal(ui.trust.journeyTrustSummary(journey([leg('05408', NOT_FOUND_05408)])).tracking, 'No verified live tracker');
    assert.equal(ui.trust.journeyTrustSummary(journey([leg('44039', VERIFIED_44039), leg('09594', OPTIONS_09594)])).tracking, 'Verified for 1 of 2 buses');
  });
});

describe('trackable-only filter removed', () => {
  const results = readFileSync(path.join(sourceRoot, 'pages', 'SearchResults.tsx'), 'utf8');

  test('9. the results page has no "Trackable buses only" filter', () => {
    assert.doesNotMatch(results, /Trackable buses only|trackableOnly|applyTrackableFilter/);
    assert.equal(ui.trust.applyTrackableFilter, undefined);
  });

  test('10. no tracking count such as "(0)" is rendered next to the results heading', () => {
    assert.doesNotMatch(results, /trackableCount/);
    // ("Direct (0)" is the transfer count and is fine; no tracking count may appear.)
    assert.doesNotMatch(strip(card(journey([leg('09594', OPTIONS_09594)]))), /Trackable|[Tt]racking[^.]{0,30}\(0\)/);
  });
});

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { bundle } from './harness.js';

// A browser-less stand-in for localStorage (AuthProvider reads it on render).
globalThis.localStorage = { getItem: () => null, setItem: () => {}, removeItem: () => {} };

const ui = bundle(`
  import { createElement } from 'react';
  import { renderToStaticMarkup } from 'react-dom/server';
  import { MemoryRouter } from 'react-router-dom';
  import { AuthProvider } from './context/AuthContext';
  import JourneyCard from './components/JourneyCard';
  import PathRating, { RatingBreakdown } from './components/PathRating';
  import { BusSummaryRow, VehicleLine, TrackBus, TrackerMenu } from './components/BusIdentity';
  import RideProviders from './components/RideProviders';
  import { RIDE_COVERAGE_NOTE, rideProviderLink } from './config/externalServices';
  import { APSRTC_TRACKERS, TRACKER_INFO, trackersForLeg } from './config/apsrtcTrackers';
  import { copyText, serviceNumberOf, vehicleNumberOf, operatorBusName, trackingPlan, runTrackingClick } from './utils/busIdentity';
  import { headerLabels } from './utils/journeyBadges';

  export const render = (Component, props) => renderToStaticMarkup(createElement(Component, props));
  export const renderCard = props => renderToStaticMarkup(
    createElement(MemoryRouter, null, createElement(AuthProvider, null, createElement(JourneyCard, props))));
  export { PathRating, RatingBreakdown, BusSummaryRow, VehicleLine, TrackBus, TrackerMenu, RideProviders, RIDE_COVERAGE_NOTE,
    rideProviderLink, APSRTC_TRACKERS, TRACKER_INFO, trackersForLeg, trackingPlan, runTrackingClick, copyText, serviceNumberOf, vehicleNumberOf, operatorBusName, headerLabels };
`, 'ui');

const strip = markup => markup.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();

const leg = (extra = {}) => ({
  mode: 'bus', routeId: 'r1', routeShortName: '03846', routeLongName: null, operator: 'APSRTC', serviceNumber: '03846',
  vehicleNumber: null, vehicleNumberSource: null, vehicleNumberConfidence: 'unknown',
  tripId: 't1', headsign: 'Narasaraopet',
  fromStop: { type: 'stop', name: 'Kunchanapalli Cross Road', lat: 16, lon: 80 }, toStop: { type: 'stop', name: 'Narasaraopet', lat: 16.2, lon: 80.1 },
  departureTime: '2026-10-05T08:00:00+05:30', arrivalTime: '2026-10-05T09:30:00+05:30', gtfsDepartureTime: '08:00:00', gtfsArrivalTime: '09:30:00',
  serviceDate: '2026-10-05', scheduleBasis: 'extrapolated_weekly_pattern', durationSeconds: 5400, intermediateStopCount: 4, datasetId: 1,
  dataConfidence: 'inferred', timeQuality: 'approximate', fare: null,
  // A tracking-verified service (recognised by all three trackers), so Track Bus is offered.
  tracking: { serviceNumber: '03846', vehicleNumber: null, status: 'verified', preferredProvider: 'apsrtc', checkedOn: '2026-10-08',
    providers: ['apsrtc', 'redbus', 'abhibus'].map(id => ({ id, recognized: true, availableAsExternalOption: true })) },
  ...extra
});
const rideLeg = kind => ({
  mode: 'local_ride', kind, label: 'Estimated local ride', from: { type: 'origin', name: 'Origin', lat: 16, lon: 80 }, to: { type: 'stop', name: 'Kunchanapalli Cross Road', lat: 16, lon: 80 },
  distanceMeters: 3000, durationSeconds: 900, rideSeconds: 600, pickupWaitSeconds: 300, departureTime: '2026-10-05T07:45:00+05:30', arrivalTime: '2026-10-05T08:00:00+05:30',
  dataConfidence: 'estimated', durationConfidence: 'estimated', providerIntegration: false, availabilityStatus: 'unknown', isRealtime: false, fare: null
});
const rating = (overrides = {}) => ({
  score: 8.7, label: 'Very Good', summary: 'Strong balance of time, cost and convenience.', comparedWith: 3,
  parameters: {
    time: { score: 9.1, weight: 0.35 }, cost: { score: 8.4, weight: 0.25 }, transfers: { score: 10, weight: 0.15 },
    firstLastMile: { score: 7.8, weight: 0.15 }, schedule: { score: 6.5, weight: 0.1 }
  },
  reasons: [
    { type: 'positive', metric: 'time', text: 'Fast journey' },
    { type: 'positive', metric: 'transfers', text: 'No transfers' },
    { type: 'caution', metric: 'schedule', text: 'Schedule inferred' }
  ],
  ...overrides
});
const journey = (extra = {}) => ({
  id: 'jr_1', labels: ['BEST_PATH', 'FASTEST', 'LEAST_TRANSFERS', 'BEST_BALANCED', 'LOWER_ESTIMATED_COST'],
  departureTime: '2026-10-05T07:45:00+05:30', arrivalTime: '2026-10-05T09:30:00+05:30', totalDurationSeconds: 6300, walkingDurationSeconds: 0,
  waitingDurationSeconds: 0, transfers: 0, transitLegCount: 1, datasetConfidence: 'inferred', scheduleConfidence: 'inferred', confidence: 'estimated',
  timeQuality: 'approximate', localRideDurationSeconds: 900, localRideCount: 1, fare: null,
  fareEstimate: { min: 150, max: 300, currency: 'INR', confidence: 'estimated', complete: true, components: [], unknownComponents: [] },
  rating: rating(), legs: [rideLeg('access'), leg()], ...extra
});
const card = extra => ui.renderCard({ journey: journey(extra), index: 1, from: 'Kunchanapalli', to: 'Narasaraopet' });

describe('bus identification', () => {
  test('1. the service number is displayed, labelled as a service number', () => {
    const text = strip(ui.render(ui.BusSummaryRow, { leg: leg() }));
    assert.match(text, /Service No\. 03846/);
  });

  test('2. the service number is not presented as a vehicle number', () => {
    const markup = ui.render(ui.VehicleLine, { leg: leg() });
    assert.doesNotMatch(strip(markup), /Vehicle:.*03846/);
    assert.equal(ui.vehicleNumberOf(leg()), null);
    assert.equal(ui.serviceNumberOf(leg()), '03846');
  });

  test('3. a missing vehicle number renders nothing (no line, no placeholder plate)', () => {
    assert.equal(ui.render(ui.VehicleLine, { leg: leg() }), '');
    assert.doesNotMatch(strip(ui.render(ui.BusSummaryRow, { leg: leg() })), /Vehicle/);
  });

  test('4. a known vehicle number from a trustworthy source is shown, separately from the service number', () => {
    const known = leg({ vehicleNumber: 'AP16Z0461', vehicleNumberSource: 'apsrtc', vehicleNumberConfidence: 'published' });
    const text = strip(ui.render(ui.VehicleLine, { leg: known }));
    assert.match(text, /Vehicle No. AP16Z0461/);
    assert.doesNotMatch(text, /03846/);
  });

  test('a vehicle number with no named source is not trusted or shown', () => {
    const unsourced = leg({ vehicleNumber: 'AP16Z0461', vehicleNumberSource: null });
    assert.equal(ui.vehicleNumberOf(unsourced), null);
    assert.equal(ui.render(ui.VehicleLine, { leg: unsourced }), '');
  });

  test('5. no AP-style registration number is ever fabricated from a service number', () => {
    const everything = card() + ui.render(ui.BusSummaryRow, { leg: leg() }) + ui.render(ui.VehicleLine, { leg: leg() });
    assert.doesNotMatch(strip(everything), /\bAP\s?\d{2}\s?[A-Z]{1,2}\s?\d{3,4}\b/);
  });

  test('card title says "APSRTC Bus" instead of "Bus 03846"', () => {
    const text = strip(card());
    assert.match(text, /Local ride \+ .*APSRTC Bus/);
    assert.doesNotMatch(text, /Bus 03846/);
    assert.match(text, /Kunchanapalli Cross Road → Narasaraopet/);
  });

  test('operator naming', () => {
    assert.equal(ui.operatorBusName('APSRTC'), 'APSRTC Bus');
    assert.equal(ui.operatorBusName('APSRTC', 2), '2 APSRTC buses');
    assert.equal(ui.operatorBusName(null), 'Bus');
  });
});

describe('best path rating UI', () => {
  test('25/26. the breakdown is collapsed by default and the full table is not in the card', () => {
    const text = strip(card());
    assert.match(text, /Why this rating\?/);
    assert.match(card(), /aria-expanded="false"/);
    for (const row of ['Time Efficiency', 'Cost Efficiency', 'Transfer Convenience', 'First / Last Mile', 'Schedule Confidence']) {
      assert.ok(!text.includes(row), `"${row}" must not be visible by default`);
    }
  });

  test('8/9. the default rating is only title, score and label: no emoji chips, no mini metric row', () => {
    const markup = ui.render(ui.PathRating, { rating: rating(), isBest: true });
    const text = strip(markup);
    assert.match(text, /Best Path 8\.7 \/ 10 · Very Good/);
    assert.equal((markup.match(/<li /g) || []).length, 0, 'no chip list');
    assert.doesNotMatch(markup, /⚡|₹|🔁|⭐|rounded-full/);
    assert.doesNotMatch(text, /Time|Cost|Transfers/);
    assert.ok(markup.length < 1500, `rating strip should stay small (${markup.length} chars)`);
  });

  test('a non-best journey is not called Best Path', () => {
    assert.doesNotMatch(strip(ui.render(ui.PathRating, { rating: rating({ score: 7.4, label: 'Good' }), isBest: false })), /Best Path/);
  });

  test('unknown fare shows N/A, never zero', () => {
    const r = rating();
    r.parameters.cost = { score: null, weight: 0.25 };
    assert.match(strip(ui.render(ui.RatingBreakdown, { rating: r })), /Cost Efficiency N\/A/);
  });

  test('"Why this rating?" shows the five parameters and the short reasons', () => {
    const text = strip(ui.render(ui.RatingBreakdown, { rating: rating() }));
    for (const row of ['Time Efficiency 9.1 / 10', 'Cost Efficiency 8.4 / 10', 'Transfer Convenience 10 / 10', 'First / Last Mile 7.8 / 10', 'Schedule Confidence 6.5 / 10']) {
      assert.ok(text.includes(row), row);
    }
    assert.ok(text.includes('Fast journey') && text.includes('Schedule inferred'));
  });

  test('27. the rating strip stays small relative to the whole card', () => {
    const whole = card();
    const strip = ui.render(ui.PathRating, { rating: rating(), isBest: true });
    assert.ok(strip.length / whole.length < 0.25, `rating share ${(strip.length / whole.length).toFixed(2)}`);
  });

  test('28. no badge overload: at most two header badges, and Best Path only once', () => {
    const labels = ['BEST_PATH', 'FASTEST', 'LEAST_TRANSFERS', 'BEST_BALANCED', 'LOWER_ESTIMATED_COST'];
    assert.deepEqual(ui.headerLabels(labels), ['FASTEST']);
    assert.deepEqual(ui.headerLabels(['FASTEST', 'LEAST_TRANSFERS', 'BEST_BALANCED']), ['FASTEST', 'LEAST_TRANSFERS']);
    assert.deepEqual(ui.headerLabels(['BEST_PATH']), []);
    assert.deepEqual(ui.headerLabels(['BEST_BALANCED', 'LEAST_TRANSFERS']), ['LEAST_TRANSFERS', 'BEST_BALANCED']);
    const text = strip(card());
    assert.equal((text.match(/Best Path/g) || []).length, 1, 'Best Path appears once');
    assert.equal((text.match(/Best balanced|Lower estimated cost|Fewest transfers/g) || []).length, 0);
  });

  test('29. the tracker control is visually secondary (small outlined link, not a filled button)', () => {
    const markup = ui.render(ui.TrackBus, { leg: leg() });
    assert.match(markup, /text-\[11px\]/);
    assert.match(markup, /border /);
    assert.doesNotMatch(markup, /bg-\[#146B5B\]|bg-emerald|bg-blue|text-white/);
  });

  test('route information stays before the rating in the card', () => {
    const whole = card();
    assert.ok(whole.indexOf('Departs') < whole.indexOf('aria-label="Path rating"'));
    assert.ok(whole.indexOf('Travel time') < whole.indexOf('aria-label="Path rating"'));
  });
});

describe('rating UI simplification', () => {
  test('10/11. detailed metrics are hidden by default and the expandable explanation is still offered', () => {
    const markup = card();
    assert.match(strip(markup), /Why this rating\?/);
    assert.match(markup, /aria-expanded="false"/);
    assert.doesNotMatch(strip(markup), /Time Efficiency|Cost Efficiency|Transfer Convenience/);
    const open = strip(ui.render(ui.RatingBreakdown, { rating: rating() }));
    assert.match(open, /Time Efficiency 9\.1 \/ 10/);
    assert.match(open, /Fast journey/);
    assert.match(open, /Schedule inferred/);
  });

  test('12. no decorative emojis anywhere in the rating, collapsed or expanded', () => {
    const emoji = /[\u{1F300}-\u{1FAFF}☀-➿⭐₹]/u;
    assert.doesNotMatch(strip(ui.render(ui.PathRating, { rating: rating(), isBest: true })), emoji);
    assert.doesNotMatch(strip(ui.render(ui.RatingBreakdown, { rating: rating() })), emoji);
  });
});

describe('local ride provider awareness', () => {
  const options = [
    { name: 'Uber', coverage: 'published_city_coverage', realtimeAvailable: false },
    { name: 'Rapido', coverage: 'published_city_coverage', realtimeAvailable: false }
  ];
  const fare = { type: 'estimated_range', min: 100, max: 180, currency: 'INR', confidence: 'estimated' };
  const expanded = extra => strip(ui.renderCard({
    journey: journey({ legs: [{ ...rideLeg('access'), fare, ...extra }, leg()] }), index: 1, from: 'a', to: 'b', initialShowDetails: true
  }));

  test('17/21. providers are shown only as possible options, with the coverage note', () => {
    const text = strip(ui.render(ui.RideProviders, { city: 'Guntur', options }));
    assert.match(text, /Possible ride services in Guntur ?: Uber · Rapido/);
    assert.ok(text.includes(ui.RIDE_COVERAGE_NOTE));
    assert.equal(ui.RIDE_COVERAGE_NOTE, 'City-level coverage only. Check provider apps for live availability and final fare.');
    assert.doesNotMatch(text, /is available|are available|available now|₹/i);
  });

  test('14. with no known providers nothing is rendered, not even an empty section', () => {
    assert.equal(ui.render(ui.RideProviders, { city: null, options: [] }), '');
    assert.equal(ui.render(ui.RideProviders, { city: null, options: undefined }), '');
    const text = expanded({ providerCity: null, providerOptions: [] });
    assert.doesNotMatch(text, /Possible ride services/);
    assert.match(text, /Estimated local ride/);
  });

  test('16. the leg stays a generic local ride and is never branded', () => {
    const text = expanded({ providerCity: 'Guntur', providerOptions: options });
    assert.match(text, /Estimated local ride to the bus stop/);
    assert.match(text, /Possible ride services in Guntur ?: Uber · Rapido/);
    assert.doesNotMatch(text, /(Uber|Ola|Rapido) (ride|trip|booking)/i);
    assert.doesNotMatch(text, /Ola/);
  });

  test('18/19/20. one generic estimated fare range; no provider-specific fare; nobody marked Available', () => {
    const text = expanded({ providerCity: 'Guntur', providerOptions: options });
    assert.match(text, /Approx\. local ride fare ₹100–₹180 estimated/);
    assert.equal((text.match(/₹/g) || []).length >= 1, true);
    assert.doesNotMatch(text, /(Uber|Rapido|Ola)[^.]{0,20}₹/);
    assert.doesNotMatch(text, /(Uber|Rapido|Ola)[^.]{0,30}(available|Available)/);
  });

  test('22. provider links are plain official links that open only on click', () => {
    const markup = ui.render(ui.RideProviders, { city: 'Guntur', options });
    assert.equal((markup.match(/<a /g) || []).length, 2);
    assert.match(markup, /href="https:\/\/www\.uber\.com\/in\/en\/"/);
    assert.match(markup, /href="https:\/\/www\.rapido\.bike\/"/);
    assert.equal((markup.match(/target="_blank"/g) || []).length, 2);
    assert.equal((markup.match(/rel="noopener noreferrer"/g) || []).length, 2);
    assert.ok(!markup.match(/href="[^"]+"/g).join('').includes('?'), 'no query data on provider links');
    assert.equal(ui.rideProviderLink('Unknown'), null);
  });
});

const TRACKER_URLS = {
  apsrtc: 'https://apsrtclivetrack.com/',
  redbus: 'https://www.redbus.in/live-tracking/apsrtc/',
  abhibus: 'https://www.abhibus.com/apsrtc-live-track/service-no'
};
const hrefs = markup => [...markup.matchAll(/href="([^"]+)"/g)].map(match => match[1]);

describe('APSRTC tracker registry', () => {
  test('3. the registry lists official APSRTC, redBus and AbhiBus in that priority order, all in one place', () => {
    const sorted = [...ui.APSRTC_TRACKERS].sort((a, b) => a.priority - b.priority);
    assert.deepEqual(sorted.map(t => t.id), ['apsrtc', 'redbus', 'abhibus']);
    assert.deepEqual(sorted.map(t => t.priority), [1, 2, 3]);
    assert.equal(sorted[0].type, 'official');
    assert.deepEqual(sorted.slice(1).map(t => t.type), ['external', 'external']);
    for (const tracker of sorted) assert.equal(tracker.url, TRACKER_URLS[tracker.id]);
  });

  test('4/5/6. the official tracker comes first, with redBus and AbhiBus as fallbacks', () => {
    const order = ui.trackersForLeg(leg()).map(t => t.id);
    assert.equal(order[0], 'apsrtc');
    assert.ok(order.includes('redbus') && order.includes('abhibus'));
    assert.ok(order.indexOf('redbus') < order.indexOf('abhibus'));
  });

  test('only providers the backend offers are shown, and only for APSRTC legs', () => {
    const some = leg({ tracking: { serviceNumber: '03846', vehicleNumber: null, providers: [{ id: 'redbus', availableAsExternalOption: true }, { id: 'abhibus', availableAsExternalOption: false }] } });
    assert.deepEqual(ui.trackersForLeg(some).map(t => t.id), ['redbus']);
    assert.deepEqual(ui.trackersForLeg(leg({ operator: null })), []);
  });

  test('7. no query parameters or fragments are invented on any tracker URL', () => {
    for (const tracker of ui.APSRTC_TRACKERS) {
      assert.ok(!tracker.url.includes('?') && !tracker.url.includes('#'), tracker.url);
      assert.ok(!tracker.url.includes('03846'));
    }
  });

  test('the model has no liveAvailable claim anywhere in the registry or the backend options', () => {
    assert.doesNotMatch(JSON.stringify(ui.APSRTC_TRACKERS), /liveAvailable/);
  });
});

describe('Track Bus control', () => {
  test('1. the service number is shown and Track Bus is a compact control beside it', () => {
    const markup = ui.render(ui.BusSummaryRow, { leg: leg() });
    const text = strip(markup);
    assert.match(text, /Service No\. 03846/);
    assert.match(text, /Track Bus/);
    assert.ok(text.indexOf('Service No. 03846') < text.indexOf('Track Bus'));
    assert.match(markup, /aria-label="Copy service number 03846"/);
  });

  test('the main action opens the best tracker; the menu is closed by default', () => {
    const markup = ui.render(ui.TrackBus, { leg: leg() });
    assert.deepEqual(hrefs(markup), [TRACKER_URLS.apsrtc]);
    assert.match(markup, /aria-haspopup="menu"/);
    assert.match(markup, /aria-expanded="false"/);
    assert.ok(!markup.includes('role="menu"'));
    assert.doesNotMatch(markup, /redbus|abhibus/i);
  });

  test('9. the menu lists "Track with" the trackers in priority order', () => {
    const markup = ui.render(ui.TrackerMenu, { trackers: ui.trackersForLeg(leg()), serviceNumber: '03846', onLaunch: () => {}, onResult: () => {} });
    assert.match(markup, /role="menu"/);
    const text = strip(markup);
    assert.match(text, /Track with APSRTC Official Default redBus AbhiBus/);
    assert.deepEqual(hrefs(markup), [TRACKER_URLS.apsrtc, TRACKER_URLS.redbus, TRACKER_URLS.abhibus]);
  });

  test('10. every provider link opens the right URL in a new tab with noopener noreferrer, and nothing else is sent', () => {
    const markup = ui.render(ui.TrackerMenu, { trackers: ui.trackersForLeg(leg()), serviceNumber: '03846', onLaunch: () => {}, onResult: () => {} });
    assert.equal((markup.match(/target="_blank"/g) || []).length, 3);
    assert.equal((markup.match(/rel="noopener noreferrer"/g) || []).length, 3);
    for (const href of hrefs(markup)) {
      assert.ok(!href.includes('?') && !href.includes('#'));
      assert.doesNotMatch(href, /lat|lon|lng|user|session|token|email|03846|Narasaraopet|Kunchanapalli/i);
    }
  });

  test('8. rendering never navigates or makes a request; links only work when clicked', () => {
    let calls = 0;
    const originalFetch = globalThis.fetch;
    globalThis.fetch = () => { calls++; return Promise.reject(new Error('no requests expected')); };
    globalThis.window = { open: () => { calls++; }, location: { assign: () => { calls++; } } };
    try { card(); ui.render(ui.TrackBus, { leg: leg() }); assert.equal(calls, 0); } finally { globalThis.fetch = originalFetch; delete globalThis.window; }
  });

  test('the service number is copied before opening (success path): the toast is short', async () => {
    const copied = [];
    const plan = ui.trackingPlan(ui.APSRTC_TRACKERS[1], '03846');
    assert.equal(plan.copyFirst, true);
    assert.equal(plan.url, TRACKER_URLS.redbus);
    const message = await ui.runTrackingClick(plan, '03846', async text => { copied.push(text); return true; });
    assert.deepEqual(copied, ['03846']);
    assert.equal(message, 'Service 03846 copied');
  });

  test('copy failure path: the toast shows the number so it can be typed in', async () => {
    const plan = ui.trackingPlan(ui.APSRTC_TRACKERS[0], '03846');
    assert.equal(await ui.runTrackingClick(plan, '03846', async () => false), 'Service number: 03846');
  });

  test('every tracker copies the service number first; a leg without one copies nothing', async () => {
    for (const tracker of ui.APSRTC_TRACKERS) {
      const withNumber = ui.trackingPlan(tracker, '03846');
      assert.equal(withNumber.copyFirst, true);
      assert.equal(withNumber.url, tracker.url, 'the tracker URL is opened as configured');
    }
    let calls = 0;
    const none = await ui.runTrackingClick(ui.trackingPlan(ui.APSRTC_TRACKERS[0], null), null, async () => { calls++; return true; });
    assert.equal(none, null);
    assert.equal(calls, 0);
  });

  test('2. copy action works through the clipboard helper', async () => {
    const written = [];
    assert.equal(await ui.copyText('03846', { clipboard: { writeText: async value => { written.push(value); } } }), true);
    assert.deepEqual(written, ['03846']);
    assert.equal(await ui.copyText('03846', { clipboard: null, fallback: () => false }), false);
  });

  test('14. the card stays compact: no warning paragraphs, only a tiny info tooltip', () => {
    const text = strip(card());
    assert.doesNotMatch(text, /may not|might not|not be available for every|Why tracking/i);
    assert.ok(!text.includes(ui.TRACKER_INFO), 'the info text is a tooltip only, not body text');
    const markup = ui.render(ui.TrackBus, { leg: leg() });
    assert.ok(markup.includes(`title="${ui.TRACKER_INFO}"`));
    assert.equal(ui.TRACKER_INFO, 'Tracking provided by APSRTC/external partners.');
    assert.ok(markup.length < 2200, `control stays small (${markup.length})`);
  });

  test('13. no guarantee of tracking, and no claim that RouteConnect has live bus data', () => {
    const text = strip(card()) + strip(ui.render(ui.TrackBus, { leg: leg() }));
    assert.doesNotMatch(text, /guaranteed|always (available|trackable)|every (bus|service) (is|can be) tracked|RouteConnect (live|real-time)|live now|currently tracking/i);
  });

  test('12. the vehicle number is never fabricated; the Not-available line is gone', () => {
    const text = strip(card());
    assert.doesNotMatch(text, /Vehicle number|Not available/);
    assert.doesNotMatch(text, /\bAP\s?\d{2}\s?[A-Z]{1,2}\s?\d{3,4}\b/);
  });

  test('a card with two buses shows one compact control per bus and no duplicated disclaimers', () => {
    const markup = card({ legs: [leg(), leg({ serviceNumber: '47567', routeShortName: '47567', tripId: 't2' })] });
    assert.equal((markup.match(/Track Bus/g) || []).length, 2);
    assert.equal((markup.match(/title="Tracking provided by APSRTC\/external partners\."/g) || []).length, 2, 'one tooltip per control, no body text');
  });
});

// Train results in the UI: Train choices unlock only from the server's capabilities, train legs show their genuine
// timetable evidence, an unknown train fare reads "Fare unavailable", and nothing claims to be live or official.
// The journey below is SYNTHETIC (test train 90001, test station codes TSA/TSB); it only mirrors the planner's shape.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { bundle } from './harness.js';

globalThis.localStorage = { getItem: () => null, setItem: () => {}, removeItem: () => {} };

const ui = bundle(`
  import { createElement } from 'react';
  import { renderToStaticMarkup } from 'react-dom/server';
  import { MemoryRouter } from 'react-router-dom';
  import { AuthProvider } from './context/AuthContext';
  import JourneyCard, { journeyTitle } from './components/JourneyCard';
  import PreferenceModal from './components/PreferenceModal';
  import { dataPolicySections } from './pages/AboutData';
  export * as prefs from './utils/travelPreferences';
  export * as caps from './services/capabilities';
  export const render = (Component, props) => renderToStaticMarkup(createElement(Component, props));
  export const renderCard = props => renderToStaticMarkup(createElement(MemoryRouter, null, createElement(AuthProvider, null, createElement(JourneyCard, props))));
  export { PreferenceModal, journeyTitle, dataPolicySections };
`, 'trainui');

const strip = markup => markup.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
const noop = () => {};

const station = (code, name, lat, lon) => ({ type: 'station', name, code, lat, lon });
const railLeg = (extra = {}) => ({
  mode: 'rail', routeId: '90001', routeShortName: '90001', routeLongName: 'TEST SF EXP', operator: 'Indian Railways',
  operatorInfo: { name: 'Indian Railways', type: 'rail', source: 'rail:Synthetic rail', confidence: 'inferred' },
  routeCode: '90001', serviceNumber: null, serviceNumberSource: null, trainNumber: '90001', trainName: 'TEST SF EXP', flightNumber: null,
  displayName: '90001 TEST SF EXP', daysOfOperation: ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'], intermediateStops: ['Test Mid'],
  tripId: '90001@2026-10-20T06:25:00+05:30', headsign: 'TEST B', fromStop: station('TSA', 'TEST A JN', 16.5, 80.6), toStop: station('TSB', 'TEST B JN', 17.4, 78.5),
  departureTime: '2026-10-20T06:25:00+05:30', arrivalTime: '2026-10-20T12:40:00+05:30', serviceDate: '2026-10-20', scheduleBasis: 'published_timetable',
  durationSeconds: 22500, intermediateStopCount: 9, datasetId: null, dataConfidence: 'inferred', timeQuality: 'exact',
  routeTrust: { sourceType: 'rail_timetable', sourceName: 'Synthetic rail (unofficial)', scheduleConfidence: 'inferred', timetableBacked: true },
  tracking: null, fare: null,
  source: { id: 'rail', name: 'Synthetic rail (unofficial)', type: 'community', snapshotDate: '2026-08-30' },
  scheduleEvidence: {
    trainNumber: '90001', trainName: 'TEST SF EXP', fromCode: 'TSA', toCode: 'TSB', boardStopNumber: 1, alightStopNumber: 11, totalStops: 11,
    scheduledDeparture: '06:25', scheduledArrival: '12:40', departureRunDay: 1, arrivalRunDay: 1, runStartDate: '2026-10-20', runStartWeekday: 'Tue',
    originRunningDays: ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'], calendarValidFrom: '2026-06-01', calendarValidTo: '2027-08-30', distanceKm: 350, snapshotDate: '2026-08-30'
  },
  ...extra
});
const walk = (kind, from, to, dep, arr) => ({ mode: 'walk', kind, from, to, distanceMeters: 500, durationSeconds: 400, departureTime: dep, arrivalTime: arr, dataConfidence: 'estimated' });
const trainJourney = (extra = {}) => ({
  id: 'jr_train', labels: ['FASTEST'], departureTime: '2026-10-20T05:58:00+05:30', arrivalTime: '2026-10-20T12:57:00+05:30',
  totalDurationSeconds: 25140, walkingDurationSeconds: 800, waitingDurationSeconds: 1800, transfers: 0, transitLegCount: 1,
  datasetConfidence: 'inferred', scheduleConfidence: 'inferred', confidence: 'estimated', timeQuality: 'exact', localRideDurationSeconds: 0, localRideCount: 0, fare: null,
  fareEstimate: { min: null, max: null, currency: 'INR', confidence: 'unknown', complete: false, components: [], unknownComponents: [{ legIndex: 1, mode: 'rail', kind: null }] },
  tracking: { busLegs: 0, verifiedLegs: 0, notFoundLegs: 0, allVerified: false },
  legs: [
    walk('access', { type: 'origin', name: 'Origin' }, station('TSA', 'TEST A JN', 16.5, 80.6), '2026-10-20T05:58:00+05:30', '2026-10-20T06:05:00+05:30'),
    railLeg(),
    walk('egress', station('TSB', 'TEST B JN', 17.4, 78.5), { type: 'destination', name: 'Destination' }, '2026-10-20T12:50:00+05:30', '2026-10-20T12:57:00+05:30')
  ],
  ...extra
});
const openCard = journey => strip(ui.renderCard({ journey, index: 1, from: 'Origin', to: 'Destination', initialShowDetails: true }));

describe('capabilities decide whether Train can be chosen', () => {
  test('server answer parsing: anything but an explicit "available: true" keeps trains off', () => {
    assert.deepEqual(ui.caps.capabilitiesFromResponse({ modes: { train: { available: true, snapshotDate: '2026-08-30', freshness: 'stale' } } }).availableModes, ['bus', 'train']);
    assert.deepEqual(ui.caps.capabilitiesFromResponse({ modes: { train: { available: 'yes' } } }).availableModes, ['bus']);
    assert.deepEqual(ui.caps.capabilitiesFromResponse(null).availableModes, ['bus']);
    assert.equal(ui.caps.DEFAULT_CAPABILITIES.train.available, false);
  });

  test('with trains available, Train only and Bus + Train can be chosen and remembered', () => {
    const available = ['bus', 'train'];
    assert.deepEqual(ui.prefs.modeChoicesFor(available).map(c => [c.id, c.available]), [['any', true], ['bus', true], ['train', true], ['bus_train', true]]);
    assert.deepEqual(ui.prefs.normalizePreferences({ modes: ['train', 'bus'], ranking: 'fastest' }, available), { modes: ['bus', 'train'], ranking: 'fastest' });
    assert.deepEqual(ui.prefs.normalizePreferences({ modes: ['train'] }), { modes: [], ranking: 'best' }, 'default: buses only');
    assert.equal(ui.prefs.writePreferenceParams({ modes: ['train'], ranking: 'best' }, new URLSearchParams(), available).toString(), 'modes=train');
  });

  test('with a scheduled-train provider, the ONE Train choice searches scheduled trains (no extra or "Coming soon" cards)', () => {
    const markup = ui.render(ui.PreferenceModal, { open: true, initial: { modes: ['train'], ranking: 'best' }, onConfirm: noop, onClose: noop, availableModes: ['bus', 'train'], trainSourceName: 'RailRadar' });
    const text = strip(markup);
    assert.doesNotMatch(text, /Coming soon|Bus \+ scheduled train|Estimated rail/);
    assert.equal((markup.match(/<input[^>]*type="radio"[^>]*name="pref-mode/g) || []).length, 3);
    const trainInput = markup.match(/<input[^>]*value="train"[^>]*>/)[0];
    assert.doesNotMatch(trainInput, /disabled/);
    assert.match(trainInput, /checked/, 'a remembered Train choice comes back');
    assert.match(text, /Train Scheduled trains/);
    assert.match(text, /Train times are scheduled timetable times from RailRadar, not live running status\./);
    assert.deepEqual(ui.prefs.travelChoicesFor({ availableModes: ['bus', 'train'] }).map(c => [c.id, c.view, c.modes]), [['any', 'planned', []], ['bus', 'planned', ['bus']], ['train', 'planned', ['train']]]);
    // Without one, Train follows the railway-network readiness (estimated suggestions) instead.
    assert.equal(ui.prefs.travelChoicesFor({ estimatedRail: { available: true } }).find(c => c.id === 'train').view, 'estimated_rail');
  });
});

describe('train journey cards', () => {
  test('the title names the operator for a train journey and stays short when mixed with a bus', () => {
    assert.equal(ui.journeyTitle(trainJourney()), '🚆 Indian Railways Train');
    const bus = { mode: 'bus', operator: 'APSRTC', operatorInfo: { name: 'APSRTC' }, tripId: 'b', fromStop: {}, toStop: {} };
    assert.equal(ui.journeyTitle(trainJourney({ legs: [bus, railLeg()] })), '🚌 Bus + 🚆 Train');
  });

  test('More details shows the genuine train number, name, station codes, stop positions and schedule source', () => {
    const text = openCard(trainJourney());
    assert.match(text, /Train 90001 TEST SF EXP/);
    assert.match(text, /Scheduled TSA 06:25 → TSB 12:40/);
    assert.match(text, /Stop 1 to 11 of 11 · about 350 km/);
    assert.match(text, /Runs Daily from TEST A JN/);
    assert.match(text, /Synthetic rail \(unofficial\), snapshot .* · scheduled, not live/);
  });

  test('an unknown train fare reads "Fare unavailable", never a price', () => {
    const text = openCard(trainJourney());
    assert.match(text, /Fare unavailable/);
    assert.doesNotMatch(text, /90001[^|]*₹/);
    assert.match(text, /no train fare is estimated/);
  });

  test('data quality: scheduled, unofficial, not live; the bus disclaimer only when a bus is in the journey', () => {
    const text = openCard(trainJourney());
    assert.match(text, /Train times are scheduled times from an unofficial copy of the Indian Railways timetable taken on/);
    assert.match(text, /not live running status/);
    assert.doesNotMatch(text, /Bus times come from/);
    assert.doesNotMatch(text, /\bLive tracking verified\b|\bon time\b|\bdelayed\b|seats? available|book now/i);
  });

  test('a day-2 departure shows its journey day', () => {
    const leg = railLeg({ scheduleEvidence: { ...railLeg().scheduleEvidence, scheduledDeparture: '01:32', departureRunDay: 2, arrivalRunDay: 2, runStartDate: '2026-10-19' } });
    const text = openCard(trainJourney({ legs: [trainJourney().legs[0], leg, trainJourney().legs[2]] }));
    assert.match(text, /TSA 01:32 \(day 2\)/);
    assert.match(text, /Leaves its first station on/);
  });
});

describe('data & policies follows the live capability', () => {
  const trains = sections => sections.find(s => s.id === 'trains');
  test('unavailable by default', () => {
    assert.match(trains(ui.dataPolicySections()).summary, /not available yet/);
  });
  test('available: scheduled, not live, not official', () => {
    const section = trains(ui.dataPolicySections({ available: true, reason: null, snapshotDate: '2026-08-30', freshness: 'stale', sourceName: 'Community Indian Railways GTFS (unofficial)', official: false, live: false }));
    assert.equal(section.summary, 'Train journeys use scheduled timetable times. They are not live and not official.');
  });
});

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
  import JourneyCard, { journeyTitle } from './components/JourneyCard';
  import { BusSummaryRow, LegIdentifier, TrackBus } from './components/BusIdentity';
  import { serviceNumberOf, routeLabelOf, operatorLabelOf, vehicleTitleOf } from './utils/busIdentity';
  import JourneySimulation from './components/JourneySimulation';
  export const render = (Component, props) => renderToStaticMarkup(createElement(Component, props));
  export const renderCard = props => renderToStaticMarkup(
    createElement(MemoryRouter, null, createElement(AuthProvider, null, createElement(JourneyCard, props))));
  export { journeyTitle, BusSummaryRow, LegIdentifier, TrackBus, serviceNumberOf, routeLabelOf, operatorLabelOf, vehicleTitleOf, JourneySimulation };
`, 'mmui');

const strip = markup => markup.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
const op = (name, type = 'state_transport') => ({ name, type, source: 'gtfs:agency.txt', confidence: name ? 'published' : 'unknown' });
const stop = name => ({ type: 'stop', name, lat: 16.5, lon: 80.6 });
const base = {
  routeLongName: null, headsign: null, gtfsDepartureTime: '08:00:00', gtfsArrivalTime: '13:00:00', serviceDate: '2026-10-09',
  scheduleBasis: 'extrapolated_weekly_pattern', durationSeconds: 18000, intermediateStopCount: 10, datasetId: 1, dataConfidence: 'inferred',
  timeQuality: 'approximate', fare: null, vehicleNumber: null, vehicleNumberSource: null, vehicleNumberConfidence: 'unknown',
  departureTime: '2026-10-09T08:00:00+05:30', arrivalTime: '2026-10-09T13:00:00+05:30',
  routeTrust: { sourceType: 'gtfs', sourceName: 'Community APSRTC GTFS', scheduleConfidence: 'inferred', timetableBacked: true }
};
const serviceLeg = { ...base, mode: 'bus', routeId: '03589', routeShortName: '03589', routeCode: '03589', serviceNumber: '3589', serviceNumberSource: 'tracker_verified',
  operator: 'APSRTC', operatorInfo: op('APSRTC'), displayName: 'APSRTC service 3589', tripId: '03589', fromStop: stop('VIJAYAWADA'), toStop: stop('HYDERABAD MGBS'),
  tracking: { serviceNumber: '3589', vehicleNumber: null, status: 'verified', preferredProvider: 'apsrtc', checkedOn: '2026-10-08',
    providers: [{ id: 'apsrtc', recognized: true, availableAsExternalOption: true }, { id: 'redbus', recognized: null, availableAsExternalOption: true }, { id: 'abhibus', recognized: true, availableAsExternalOption: true }] } };
const routeOnlyLeg = { ...base, mode: 'bus', routeId: '95083', routeShortName: '95083', routeCode: '95083', serviceNumber: null, serviceNumberSource: null,
  operator: 'APSRTC', operatorInfo: op('APSRTC'), displayName: 'APSRTC route 95083', tripId: '95083', fromStop: stop('VIJAYAWADA'), toStop: stop('NANDIGAMA'), tracking: null };
const unknownOperatorLeg = { ...routeOnlyLeg, operator: null, operatorInfo: op(null, 'unknown'), displayName: 'Route 95083' };
const trainLeg = { ...base, mode: 'rail', routeId: '99001', routeShortName: '99001', routeCode: '99001', serviceNumber: null, trainNumber: '99001', trainName: 'Test Express',
  operator: 'Indian Railways', operatorInfo: op('Indian Railways', 'rail'), displayName: '99001 Test Express', daysOfOperation: ['Mon', 'Wed'],
  tripId: '99001@x', fromStop: { type: 'station', name: 'Test Station A', lat: 16.5, lon: 80.6 }, toStop: { type: 'station', name: 'Test Station B', lat: 17.4, lon: 78.5 },
  scheduleBasis: 'published_timetable', timeQuality: 'exact', tracking: null,
  routeTrust: { sourceType: 'rail_timetable', sourceName: 'Test rail fixture', scheduleConfidence: 'inferred', timetableBacked: true } };
const flightLeg = { ...trainLeg, mode: 'air', trainNumber: null, trainName: null, flightNumber: 'ZZ101', routeCode: 'ZZ101', operator: 'Test Air', operatorInfo: op('Test Air', 'airline'),
  displayName: 'Test Air ZZ101', daysOfOperation: null, fromStop: { type: 'airport', name: 'TAA Test Airport', lat: 16.5, lon: 80.8 }, toStop: { type: 'airport', name: 'TAB Test Airport', lat: 17.2, lon: 78.4 },
  routeTrust: { sourceType: 'flight_api', sourceName: 'Duffel', scheduleConfidence: 'published', timetableBacked: true } };
const ride = kind => ({ mode: 'local_ride', kind, label: 'Estimated local ride', from: { type: 'origin', name: 'Origin', lat: 16.5, lon: 80.6 }, to: { type: 'station', name: 'Test Station A', lat: 16.5, lon: 80.6 },
  distanceMeters: 5000, durationSeconds: 1200, rideSeconds: 900, pickupWaitSeconds: 300, departureTime: '2026-10-09T07:20:00+05:30', arrivalTime: '2026-10-09T07:40:00+05:30',
  dataConfidence: 'estimated', durationConfidence: 'estimated', providerIntegration: false, availabilityStatus: 'unknown', isRealtime: false, fare: null });
const journey = legs => ({ id: 'jr_t', labels: [], departureTime: legs[0].departureTime, arrivalTime: legs.at(-1).arrivalTime, totalDurationSeconds: 20000, walkingDurationSeconds: 0,
  waitingDurationSeconds: 0, transfers: legs.filter(l => l.mode !== 'local_ride').length - 1, transitLegCount: 1, datasetConfidence: 'inferred', scheduleConfidence: 'inferred',
  confidence: 'inferred', timeQuality: 'approximate', localRideDurationSeconds: 0, localRideCount: legs.filter(l => l.mode === 'local_ride').length, fare: null, fareEstimate: null, legs });

describe('identifiers and operators in the UI', () => {
  test('a proven service number is shown as "Service No." (without the feed zero) and offered to trackers', () => {
    const text = strip(ui.render(ui.BusSummaryRow, { leg: serviceLeg }));
    assert.match(text, /Service No\. 3589/);
    assert.doesNotMatch(text, /03589/);
    assert.match(text, /APSRTC/);
    assert.match(text, /Track Bus/);
  });

  test('a route code that is not a proven service number is "Route <code>", with no copy-as-service and no tracker', () => {
    const markup = ui.render(ui.BusSummaryRow, { leg: routeOnlyLeg });
    const text = strip(markup);
    assert.match(text, /Route 95083/);
    assert.doesNotMatch(text, /Service No|Track Bus|Check Live Tracking/);
    assert.equal(ui.serviceNumberOf(routeOnlyLeg), null);
    assert.equal(ui.serviceNumberOf({ serviceNumber: null, routeShortName: '03846' }), null, 'a route code is never promoted');
  });

  test('an unknown operator says so and is never shown as APSRTC', () => {
    const text = strip(ui.render(ui.BusSummaryRow, { leg: unknownOperatorLeg }));
    assert.match(text, /Operator not identified/);
    assert.doesNotMatch(text, /APSRTC/);
    assert.equal(ui.operatorLabelOf(unknownOperatorLeg), 'Operator not identified');
  });

  test('train and flight legs show their own identifiers and operators', () => {
    assert.equal(ui.routeLabelOf(trainLeg), 'Train 99001 Test Express');
    assert.equal(ui.routeLabelOf(flightLeg), 'Flight ZZ101');
    assert.equal(ui.vehicleTitleOf(trainLeg), 'Indian Railways Train');
    assert.equal(ui.vehicleTitleOf(flightLeg), 'Test Air Flight');
    assert.equal(ui.vehicleTitleOf(unknownOperatorLeg), 'Bus');
    const text = strip(ui.render(ui.BusSummaryRow, { leg: trainLeg }));
    assert.match(text, /Train 99001 Test Express Indian Railways Test Station A → Test Station B/);
    assert.doesNotMatch(text, /Service No|Track Bus/);
  });
});

describe('mode-aware cards', () => {
  test('titles follow the real legs', () => {
    assert.equal(ui.journeyTitle(journey([serviceLeg])), '🚌 APSRTC Bus');
    assert.equal(ui.journeyTitle(journey([ride('access'), trainLeg, ride('egress')])), '🚕 Local ride + 🚆 Indian Railways Train + 🚕 Local ride');
    assert.equal(ui.journeyTitle(journey([serviceLeg, trainLeg])), '🚌 Bus + 🚆 Train');
    assert.equal(ui.journeyTitle(journey([ride('access'), flightLeg, ride('egress')])), '🚕 Local ride + ✈️ Test Air Flight + 🚕 Local ride');
    assert.equal(ui.journeyTitle(journey([unknownOperatorLeg])), '🚌 Bus');
  });

  test('a train journey card shows the train, its running days, and the simulation with a train icon', () => {
    const markup = ui.renderCard({ journey: journey([ride('access'), trainLeg, ride('egress')]), index: 1, from: 'A', to: 'B', initialShowDetails: true });
    const text = strip(markup);
    assert.match(text, /Indian Railways Train/);
    assert.match(text, /Train 99001 Test Express/);
    assert.match(text, /Runs Mon, Wed/);
    assert.match(text, /Transfers Direct/);
    assert.match(markup, /data-icon="train-front"/);
  });

  test('the results page talks about travel options and lists the sources searched', () => {
    const page = readFileSync(path.join(sourceRoot, 'pages', 'SearchResults.tsx'), 'utf8');
    assert.match(page, /Travel options \(/);
    assert.doesNotMatch(page, /Bus options|Searching published bus timetables/);
    assert.match(page, /aria-label="Sources searched"/);
    assert.match(page, /no data source yet/);
    assert.match(page, /Private buses: no licensed source/);
  });
});

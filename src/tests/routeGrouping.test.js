// Tests for route grouping and departure selection:
// 1. Identical routes with different departure times appear as one route card.
// 2. All valid departure times remain available and sorted chronologically.
// 3. Different routes remain separate (different stops, stop order, route IDs, transfer points).
// 4. Bus, train, and combined journeys are handled correctly.
// 5. Selecting a departure time displays the correct trip details.
// 6. UI rendering of route card shows corridor, stops/transfer, travel mode, distance, and departure pills.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { bundle } from './harness.js';

globalThis.localStorage = { getItem: () => null, setItem: () => {}, removeItem: () => {} };

// Bundle the TypeScript modules through esbuild
const ui = bundle(`
  import { createElement } from 'react';
  import { renderToStaticMarkup } from 'react-dom/server';
  import { MemoryRouter } from 'react-router-dom';
  import { AuthProvider } from './context/AuthContext';
  import JourneyCard from './components/JourneyCard';
  import {
    computeRouteSignature,
    isSameRoute,
    groupJourneysByRoute,
    getRouteCorridor,
    getRouteDistanceMeters,
    getRouteStopsSummary,
    getRouteTravelMode
  } from './utils/routeGrouping';

  export const renderCard = props => renderToStaticMarkup(
    createElement(MemoryRouter, null, createElement(AuthProvider, null, createElement(JourneyCard, props)))
  );

  export {
    JourneyCard,
    computeRouteSignature,
    isSameRoute,
    groupJourneysByRoute,
    getRouteCorridor,
    getRouteDistanceMeters,
    getRouteStopsSummary,
    getRouteTravelMode
  };
`, 'routeGroupingTest');

const strip = markup => markup.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
const place = (name, type = 'stop') => ({ type, name, lat: 16.3, lon: 80.4, stopId: `id_${name}` });
const t = (hhmm, day = '09') => `2026-10-${day}T${hhmm}:00+05:30`;

const busLeg = (routeId, from, to, dep, arr, intermediateStops = ['Stop M1', 'Stop M2']) => ({
  mode: 'bus',
  routeId,
  routeShortName: routeId,
  operator: 'APSRTC',
  serviceNumber: routeId.replace(/^0+/, ''),
  tripId: `trip_${routeId}_${dep}`,
  fromStop: place(from),
  toStop: place(to),
  departureTime: t(dep),
  arrivalTime: t(arr),
  durationSeconds: 3600,
  distanceMeters: 45000,
  intermediateStopCount: intermediateStops.length,
  intermediateStops,
  dataConfidence: 'inferred',
  timeQuality: 'approximate'
});

const trainLeg = (trainNum, trainName, from, to, dep, arr, intermediateStops = ['Tenali Jn', 'Ongole']) => ({
  mode: 'rail',
  routeId: trainNum,
  trainNumber: trainNum,
  trainName,
  operator: 'Indian Railways',
  tripId: `train_${trainNum}_${dep}`,
  fromStop: { type: 'station', code: from, name: `${from} Station`, lat: 16.5, lon: 80.6 },
  toStop: { type: 'station', code: to, name: `${to} Station`, lat: 13.0, lon: 80.2 },
  departureTime: t(dep),
  arrivalTime: t(arr),
  durationSeconds: 18000,
  distanceMeters: 430000,
  intermediateStopCount: intermediateStops.length,
  intermediateStops,
  dataConfidence: 'published',
  timeQuality: 'exact'
});

const walkLeg = (from, to, dep, arr) => ({
  mode: 'walk',
  kind: 'access',
  from: place(from, 'origin'),
  to: place(to),
  distanceMeters: 500,
  durationSeconds: 300,
  departureTime: t(dep),
  arrivalTime: t(arr),
  dataConfidence: 'estimated'
});

const rideLeg = (from, to, dep, arr) => ({
  mode: 'local_ride',
  kind: 'access',
  label: 'Local ride',
  from: place(from, 'origin'),
  to: place(to),
  distanceMeters: 4000,
  durationSeconds: 600,
  rideSeconds: 600,
  pickupWaitSeconds: 0,
  departureTime: t(dep),
  arrivalTime: t(arr),
  dataConfidence: 'estimated',
  durationConfidence: 'estimated',
  providerIntegration: false,
  availabilityStatus: 'unknown',
  isRealtime: false,
  fare: null
});

const makeJourney = (id, legs, labels = []) => ({
  id,
  labels,
  departureTime: legs[0].departureTime,
  arrivalTime: legs.at(-1).arrivalTime,
  totalDurationSeconds: Math.round((Date.parse(legs.at(-1).arrivalTime) - Date.parse(legs[0].departureTime)) / 1000),
  walkingDurationSeconds: legs.filter(l => l.mode === 'walk').reduce((s, l) => s + l.durationSeconds, 0),
  waitingDurationSeconds: 0,
  transfers: legs.filter(l => l.mode !== 'walk' && l.mode !== 'local_ride').length - 1,
  transitLegCount: legs.filter(l => l.mode !== 'walk' && l.mode !== 'local_ride').length,
  datasetConfidence: 'inferred',
  scheduleConfidence: 'inferred',
  confidence: 'inferred',
  timeQuality: 'approximate',
  localRideDurationSeconds: legs.filter(l => l.mode === 'local_ride').reduce((s, l) => s + l.durationSeconds, 0),
  localRideCount: legs.filter(l => l.mode === 'local_ride').length,
  fare: null,
  fareEstimate: { min: 80, max: 120, currency: 'INR', confidence: 'estimated', complete: true, components: [], unknownComponents: [] },
  legs
});

describe('Route signature and equivalence logic', () => {
  test('identical routes with different departure times have the EXACT same signature', () => {
    const j1 = makeJourney('j1', [busLeg('03846', 'Guntur', 'Narasaraopet', '08:00', '09:30')]);
    const j2 = makeJourney('j2', [busLeg('03846', 'Guntur', 'Narasaraopet', '10:15', '11:45')]);
    const j3 = makeJourney('j3', [busLeg('03846', 'Guntur', 'Narasaraopet', '14:00', '15:30')]);

    assert.equal(ui.isSameRoute(j1, j2), true);
    assert.equal(ui.isSameRoute(j2, j3), true);
    assert.equal(ui.computeRouteSignature(j1), ui.computeRouteSignature(j2));
  });

  test('different route IDs between same origin and destination are NOT merged', () => {
    const j1 = makeJourney('j1', [busLeg('03846', 'Guntur', 'Narasaraopet', '08:00', '09:30')]);
    const j2 = makeJourney('j2', [busLeg('05999', 'Guntur', 'Narasaraopet', '08:00', '09:30')]);

    assert.equal(ui.isSameRoute(j1, j2), false);
    assert.notEqual(ui.computeRouteSignature(j1), ui.computeRouteSignature(j2));
  });

  test('different intermediate stops (e.g. express vs ordinary) are NOT merged', () => {
    const ordinary = makeJourney('ord', [busLeg('03846', 'Guntur', 'Narasaraopet', '08:00', '09:30', ['Stop 1', 'Stop 2', 'Stop 3'])]);
    const express = makeJourney('exp', [busLeg('03846', 'Guntur', 'Narasaraopet', '08:00', '09:10', [])]);

    assert.equal(ui.isSameRoute(ordinary, express), false);
  });

  test('different stop order (different route path) are NOT merged', () => {
    const routeA = makeJourney('rA', [busLeg('03846', 'Guntur', 'Narasaraopet', '08:00', '09:30', ['A', 'B', 'C'])]);
    const routeB = makeJourney('rB', [busLeg('03846', 'Guntur', 'Narasaraopet', '08:00', '09:30', ['A', 'C', 'B'])]);

    assert.equal(ui.isSameRoute(routeA, routeB), false);
  });

  test('different boarding or alighting stops are NOT merged', () => {
    const j1 = makeJourney('j1', [busLeg('03846', 'Guntur Bus Stand', 'Narasaraopet', '08:00', '09:30')]);
    const j2 = makeJourney('j2', [busLeg('03846', 'Guntur Railway Station', 'Narasaraopet', '08:00', '09:30')]);

    assert.equal(ui.isSameRoute(j1, j2), false);
  });

  test('bus vs train journeys between same cities are NOT merged', () => {
    const busJourney = makeJourney('bus_j', [busLeg('03846', 'Guntur', 'Vijayawada', '08:00', '09:00')]);
    const trainJourney = makeJourney('train_j', [trainLeg('12711', 'Pinakini', 'Guntur', 'Vijayawada', '08:00', '08:45')]);

    assert.equal(ui.isSameRoute(busJourney, trainJourney), false);
  });

  test('direct route vs transfer journey between same cities are NOT merged', () => {
    const direct = makeJourney('dir', [busLeg('03846', 'A', 'C', '08:00', '10:00')]);
    const transfer = makeJourney('trans', [busLeg('03846', 'A', 'B', '08:00', '09:00'), busLeg('05111', 'B', 'C', '09:15', '10:00')]);

    assert.equal(ui.isSameRoute(direct, transfer), false);
  });
});

describe('groupJourneysByRoute function', () => {
  test('groups identical routes with different departure times into ONE route card', () => {
    const j1 = makeJourney('j1', [busLeg('03846', 'Guntur', 'Narasaraopet', '08:00', '09:30')]);
    const j2 = makeJourney('j2', [busLeg('03846', 'Guntur', 'Narasaraopet', '09:30', '11:00')]);
    const j3 = makeJourney('j3', [busLeg('03846', 'Guntur', 'Narasaraopet', '11:15', '12:45')]);

    const groups = ui.groupJourneysByRoute([j1, j2, j3]);
    assert.equal(groups.length, 1);
    assert.equal(groups[0].departures.length, 3);
  });

  test('preserves all valid departure times in chronological order', () => {
    // Input in scrambled order: 14:00, 08:00, 10:30
    const jLate = makeJourney('j3', [busLeg('03846', 'Guntur', 'Narasaraopet', '14:00', '15:30')]);
    const jEarly = makeJourney('j1', [busLeg('03846', 'Guntur', 'Narasaraopet', '08:00', '09:30')]);
    const jMid = makeJourney('j2', [busLeg('03846', 'Guntur', 'Narasaraopet', '10:30', '12:00')]);

    const groups = ui.groupJourneysByRoute([jLate, jEarly, jMid]);
    assert.equal(groups.length, 1);

    const times = groups[0].departures.map(d => d.departureTime);
    assert.deepEqual(times, [t('08:00'), t('10:30'), t('14:00')]);
  });

  test('keeps genuinely different routes separate while grouping identical ones', () => {
    // Route 1 (Bus 03846): 2 departures
    const r1_t1 = makeJourney('r1_1', [busLeg('03846', 'Guntur', 'Narasaraopet', '08:00', '09:30')]);
    const r1_t2 = makeJourney('r1_2', [busLeg('03846', 'Guntur', 'Narasaraopet', '10:00', '11:30')]);

    // Route 2 (Bus 05111 - different route): 2 departures
    const r2_t1 = makeJourney('r2_1', [busLeg('05111', 'Guntur', 'Narasaraopet', '08:30', '10:15')]);
    const r2_t2 = makeJourney('r2_2', [busLeg('05111', 'Guntur', 'Narasaraopet', '12:00', '13:45')]);

    // Route 3 (Train 12711): 1 departure
    const r3_t1 = makeJourney('r3_1', [trainLeg('12711', 'Pinakini', 'Guntur', 'Chennai', '06:00', '12:00')]);

    const groups = ui.groupJourneysByRoute([r1_t1, r2_t1, r1_t2, r3_t1, r2_t2]);
    assert.equal(groups.length, 3, 'three distinct routes');

    const bus3846Group = groups.find(g => g.representativeJourney.legs[0].routeId === '03846');
    const bus5111Group = groups.find(g => g.representativeJourney.legs[0].routeId === '05111');
    const trainGroup = groups.find(g => g.representativeJourney.legs[0].trainNumber === '12711');

    assert.ok(bus3846Group);
    assert.ok(bus5111Group);
    assert.ok(trainGroup);

    assert.equal(bus3846Group.departures.length, 2);
    assert.equal(bus5111Group.departures.length, 2);
    assert.equal(trainGroup.departures.length, 1);
  });

  test('handles multimodal journeys with transfers correctly', () => {
    // Multimodal trip 1: Local ride -> Bus 03846 -> Train 12711
    const mm1 = makeJourney('mm1', [
      rideLeg('Home', 'Guntur', '06:30', '06:50'),
      busLeg('03846', 'Guntur', 'Vijayawada', '07:00', '08:00'),
      trainLeg('12711', 'Pinakini', 'Vijayawada', 'Chennai', '08:30', '14:00')
    ]);

    // Multimodal trip 2: Identical sequence at later time
    const mm2 = makeJourney('mm2', [
      rideLeg('Home', 'Guntur', '08:30', '08:50'),
      busLeg('03846', 'Guntur', 'Vijayawada', '09:00', '10:00'),
      trainLeg('12711', 'Pinakini', 'Vijayawada', 'Chennai', '10:30', '16:00')
    ]);

    // Multimodal trip 3: Different transfer point (transfers at Tenali instead of Vijayawada)
    const mm3 = makeJourney('mm3', [
      rideLeg('Home', 'Guntur', '06:30', '06:50'),
      busLeg('03846', 'Guntur', 'Tenali', '07:00', '07:45'),
      trainLeg('12711', 'Pinakini', 'Tenali', 'Chennai', '08:30', '14:00')
    ]);

    const groups = ui.groupJourneysByRoute([mm1, mm2, mm3]);
    assert.equal(groups.length, 2, 'mm1 and mm2 merge, mm3 stays separate');

    const mergedGroup = groups.find(g => g.departures.length === 2);
    assert.ok(mergedGroup);
    assert.equal(mergedGroup.departures.length, 2);
    assert.equal(mergedGroup.travelMode, 'combined');
  });
});

describe('JourneyCard UI rendering and departure options selection', () => {
  test('displays all available departure times inside one card', () => {
    const j1 = makeJourney('j1', [busLeg('03846', 'Guntur', 'Narasaraopet', '08:00', '09:30')]);
    const j2 = makeJourney('j2', [busLeg('03846', 'Guntur', 'Narasaraopet', '10:15', '11:45')]);
    const j3 = makeJourney('j3', [busLeg('03846', 'Guntur', 'Narasaraopet', '14:00', '15:30')]);

    const groups = ui.groupJourneysByRoute([j1, j2, j3]);
    const [group] = groups;

    const markup = ui.renderCard({
      journey: group.representativeJourney,
      departures: group.departures,
      routeInfo: group,
      index: 1,
      from: 'Guntur',
      to: 'Narasaraopet'
    });

    const text = strip(markup);

    // Header and route info
    assert.match(text, /Guntur/);
    assert.match(text, /Narasaraopet/);
    assert.match(text, /APSRTC Bus/);
    assert.match(text, /45\.0 km/);

    // Available departure times section
    assert.match(markup, /aria-label="Available departure times"/);
    assert.match(text, /Available departures \(3\)/);
    assert.match(text, /08:00/);
    assert.match(text, /10:15/);
    assert.match(text, /14:00/);
    assert.match(text, /arr 09:30/);
    assert.match(text, /arr 11:45/);
    assert.match(text, /arr 15:30/);

    // Initial selected departure shows 08:00 -> 09:30
    assert.match(text, /Depart → Arrive 08:00 → 09:30/);
  });

  test('card clearly shows stops/transfer summary, distance, and duration', () => {
    const leg1 = busLeg('03846', 'Guntur', 'Narasaraopet', '08:00', '09:30', ['Perecherla', 'Phirangipuram']);
    const j = makeJourney('j_stops', [leg1]);
    const [group] = ui.groupJourneysByRoute([j]);

    const markup = ui.renderCard({
      journey: group.representativeJourney,
      departures: group.departures,
      routeInfo: group,
      index: 1,
      from: 'Guntur',
      to: 'Narasaraopet'
    });

    const text = strip(markup);
    assert.match(text, /Direct · 2 stops/);
    assert.match(text, /45\.0 km/);
    assert.match(text, /Total time 1 h 30 min/);
  });

  test('transfer journey card shows transfer station and combined mode', () => {
    const leg1 = busLeg('03846', 'Guntur', 'Vijayawada', '07:00', '08:00');
    const leg2 = trainLeg('12711', 'Pinakini', 'Vijayawada', 'Chennai', '08:30', '14:00');
    const mm = makeJourney('mm_trans', [leg1, leg2]);
    const [group] = ui.groupJourneysByRoute([mm]);

    const markup = ui.renderCard({
      journey: group.representativeJourney,
      departures: group.departures,
      routeInfo: group,
      index: 1,
      from: 'Guntur',
      to: 'Chennai'
    });

    const text = strip(markup);
    assert.match(text, /Change at Vijayawada/);
    assert.match(text, /Bus \+.*Train/);
    assert.match(text, /Transfers 1 transfer/);
  });
});

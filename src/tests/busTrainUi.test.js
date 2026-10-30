// Bus + Train journeys in the Travel Options UI: the card says what kind of journey it is and how many changes, the
// budget never passes a bus-only total for the whole trip, the bus-stand-to-station walk is named plainly, and the
// journey animation runs continuously across bus -> walk -> train -> bus. Journeys are TEST FIXTURES ONLY.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { bundle } from './harness.js';

globalThis.localStorage = { getItem: () => null, setItem: () => {}, removeItem: () => {} };

const ui = bundle(`
  import { createElement } from 'react';
  import { renderToStaticMarkup } from 'react-dom/server';
  import { MemoryRouter } from 'react-router-dom';
  import { AuthProvider } from './context/AuthContext';
  import JourneyCard, { journeyTitle, journeyHeading } from './components/JourneyCard';
  export * as sim from './utils/journeySimulation';
  export const renderCard = props => renderToStaticMarkup(createElement(MemoryRouter, null, createElement(AuthProvider, null, createElement(JourneyCard, props))));
  export { journeyTitle, journeyHeading };
`, 'bustrainui');

const strip = markup => markup.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
const op = (name, type = 'state_transport') => ({ name, type, source: 'gtfs:agency.txt', confidence: 'published' });
const station = (code, name) => ({ type: 'station', name, code, lat: 16.5, lon: 80.6 });
const stop = name => ({ type: 'stop', name, lat: 16.5, lon: 80.6 });
const t = hhmm => `2026-10-05T${hhmm}:00+05:30`;

const bus = (number, from, to, dep, arr, fare = { min: 60, max: 90, currency: 'INR', confidence: 'estimated' }) => ({
  mode: 'bus', routeId: number, routeShortName: number, routeCode: number, serviceNumber: number.replace(/^0/, ''), serviceNumberSource: 'feed_format',
  routeLongName: null, headsign: null, operator: 'APSRTC', operatorInfo: op('APSRTC'), displayName: `APSRTC service ${number}`, tripId: `${number}@${dep}`,
  fromStop: stop(from), toStop: stop(to), departureTime: t(dep), arrivalTime: t(arr), durationSeconds: (Date.parse(t(arr)) - Date.parse(t(dep))) / 1000,
  serviceDate: '2026-10-05', scheduleBasis: 'published_calendar', intermediateStopCount: 4, datasetId: 1, dataConfidence: 'inferred', timeQuality: 'approximate',
  fare, tracking: null, routeTrust: { sourceType: 'gtfs', sourceName: 'Community APSRTC GTFS', scheduleConfidence: 'inferred', timetableBacked: true }
});
const train = (number, from, to, dep, arr) => ({
  mode: 'rail', routeId: number, routeShortName: number, routeLongName: 'TEST COAST EXP', routeCode: number, serviceNumber: null, serviceNumberSource: null,
  trainNumber: number, trainName: 'TEST COAST EXP', flightNumber: null, operator: 'Indian Railways', operatorInfo: op('Indian Railways', 'rail'),
  displayName: `${number} TEST COAST EXP`, daysOfOperation: ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'], intermediateStops: null, headsign: null,
  tripId: `${number}@${t(dep)}`, fromStop: from, toStop: to, departureTime: t(dep), arrivalTime: t(arr), serviceDate: '2026-10-05',
  scheduleBasis: 'published_timetable', durationSeconds: (Date.parse(t(arr)) - Date.parse(t(dep))) / 1000, intermediateStopCount: 6, datasetId: null,
  dataConfidence: 'published', timeQuality: 'exact', tracking: null, fare: null,
  routeTrust: { sourceType: 'rail_timetable', sourceName: 'RailRadar', scheduleConfidence: 'published', timetableBacked: true },
  source: { id: 'railradar', name: 'RailRadar', type: 'third_party_api', snapshotDate: null },
  scheduleEvidence: { trainNumber: number, trainName: 'TEST COAST EXP', fromCode: from.code, toCode: to.code, scheduledDeparture: dep, scheduledArrival: arr, departureRunDay: 1, arrivalRunDay: 1, runStartDate: '2026-10-05', runStartWeekday: 'Mon', originRunningDays: ['Mon'], distanceKm: 350, snapshotDate: null, provider: 'RailRadar' }
});
const walk = (kind, from, to, dep, arr) => ({ mode: 'walk', kind, from, to, distanceMeters: 600, durationSeconds: (Date.parse(t(arr)) - Date.parse(t(dep))) / 1000, departureTime: t(dep), arrivalTime: t(arr), dataConfidence: 'estimated' });

// Bus -> walk (stand to station) -> Train -> walk -> Bus: the shape the planner builds for a village beyond a station.
const TJN = station('TJN', 'Test Hub Junction');
const TDS = station('TDS', 'Test Delta');
const busTrainBus = () => ({
  id: 'jr_mixed', labels: [], departureTime: t('07:00'), arrivalTime: t('17:10'), totalDurationSeconds: 36600,
  walkingDurationSeconds: 1200, waitingDurationSeconds: 5400, transfers: 2, transitLegCount: 3, localRideDurationSeconds: 0, localRideCount: 0,
  datasetConfidence: 'inferred', scheduleConfidence: 'inferred', confidence: 'estimated', timeQuality: 'approximate', fare: null,
  fareEstimate: { min: 120, max: 180, currency: 'INR', confidence: 'estimated', complete: false, components: [], unknownComponents: [{ legIndex: 2, mode: 'rail', kind: null }] },
  tracking: { busLegs: 2, verifiedLegs: 0, notFoundLegs: 0, allVerified: false },
  legs: [
    bus('01001', 'Test Town', 'Test Hub Bus Stand', '07:00', '08:30'),
    walk('transfer', stop('Test Hub Bus Stand'), TJN, '08:30', '08:38'),
    train('22101', TJN, TDS, '09:00', '15:00'),
    walk('transfer', TDS, stop('Test City Bus Stand'), '15:10', '15:18'),
    bus('01004', 'Test City Bus Stand', 'Test Village', '16:10', '17:10')
  ]
});

describe('a bus + train journey card', () => {
  test('the heading names the kinds and the number of changes; single-mode titles are unchanged', () => {
    assert.equal(ui.journeyHeading(busTrainBus()), '🚌 Bus + 🚆 Train + 🚌 Bus — 2 transfers');
    const one = { ...busTrainBus(), transfers: 1, legs: busTrainBus().legs.slice(0, 3) };
    assert.equal(ui.journeyHeading(one), '🚌 Bus + 🚆 Train — 1 transfer');
    assert.equal(ui.journeyTitle(one), '🚌 Bus + 🚆 Train', 'the shared title helper is untouched');
  });

  test('the budget is a partial bus estimate and says the train fare is extra and unknown', () => {
    const text = strip(ui.renderCard({ journey: busTrainBus(), index: 1, from: 'Test Town', to: 'Test Village' }));
    assert.match(text, /₹120.{0,6}180\s*\+/);
    assert.match(text, /\+ train fare \(not known\)/);
    assert.doesNotMatch(text, /₹0\b/);
  });

  test('details give each leg its real boarding and alighting points, train number and station codes', () => {
    const text = strip(ui.renderCard({ journey: busTrainBus(), index: 1, from: 'Test Town', to: 'Test Village', initialShowDetails: true }));
    assert.match(text, /22101/);
    assert.match(text, /TJN/);
    assert.match(text, /TDS/);
    assert.match(text, /Local ride from Test Hub Bus Stand to Test Hub Junction/);
    assert.match(text, /board at Test Hub Junction/);
    assert.match(text, /get off at Test Delta/);
  });
});

describe('21. the journey animation is continuous across bus -> walk -> train -> walk -> bus', () => {
  test('one segment per real leg, each starting where the previous one ended', () => {
    const journey = busTrainBus();
    const model = ui.sim.buildSimulation(journey);
    assert.deepEqual(model.segments.map(s => s.mode), ['bus', 'walk', 'train', 'walk', 'bus']);
    assert.equal(model.nodes.length, model.segments.length + 1);
    assert.deepEqual([model.nodes[0].kind, model.nodes.at(-1).kind], ['origin', 'destination']);
    assert.equal(model.nodes[0].name, 'Test Town');
    assert.equal(model.nodes.at(-1).name, 'Test Village');
    // The wait for the train is shown at the station node (20 minutes after the walk arrives).
    const atStation = model.nodes.find(n => n.name === 'Test Hub Junction');
    assert.ok(atStation && atStation.waitSeconds >= 20 * 60);
  });

  test('the timeline covers the whole loop and the vehicle position never jumps backwards', () => {
    const model = ui.sim.buildSimulation(busTrainBus());
    const timeline = ui.sim.buildTimeline(model);
    let last = -1;
    let modes = new Set();
    // Progress runs over [0, 1): at 1 the loop starts again by design.
    for (let i = 0; i < 200; i++) {
      const state = ui.sim.stateAt(timeline, model.segments, i / 200);
      assert.ok(state.position >= last - 1e-9, `position went backwards at ${i}`);
      last = state.position;
      if (state.mode) modes.add(state.mode);
    }
    assert.ok(last > 0.99, 'reaches the destination');
    for (const mode of ['bus', 'walk', 'train']) assert.ok(modes.has(mode), `the ${mode} part is animated`);
  });
});

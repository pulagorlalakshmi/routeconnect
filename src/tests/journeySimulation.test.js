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
  import JourneySimulation, { SIM_SLOT_MS } from './components/JourneySimulation';
  import { buildSimulation, simulationModeOf, segmentWeight, shortPlaceName } from './utils/journeySimulation';
  export const render = (Component, props) => renderToStaticMarkup(createElement(Component, props));
  export const renderCard = props => renderToStaticMarkup(
    createElement(MemoryRouter, null, createElement(AuthProvider, null, createElement(JourneyCard, props))));
  export { JourneySimulation, SIM_SLOT_MS, buildSimulation, simulationModeOf, segmentWeight, shortPlaceName };
`, 'sim');

const strip = markup => markup.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
const place = (name, type = 'stop') => ({ type, name, lat: 16, lon: 80 });
const t = hhmm => `2026-10-09T${hhmm}:00+05:30`;

const bus = (service, from, to, dep, arr, mode = 'bus', extra = {}) => ({
  mode, routeId: service, routeShortName: service, routeLongName: null, operator: 'APSRTC', serviceNumber: service, tripId: `t${service}`,
  headsign: null, fromStop: place(from), toStop: place(to), departureTime: t(dep), arrivalTime: t(arr), gtfsDepartureTime: `${dep}:00`,
  gtfsArrivalTime: `${arr}:00`, serviceDate: '2026-10-09', scheduleBasis: 'extrapolated_weekly_pattern',
  durationSeconds: (Number(arr.slice(0, 2)) * 60 + Number(arr.slice(3)) - Number(dep.slice(0, 2)) * 60 - Number(dep.slice(3))) * 60,
  intermediateStopCount: 3, datasetId: 1, dataConfidence: 'inferred', timeQuality: 'approximate', fare: null,
  routeTrust: { sourceType: 'gtfs', sourceName: 'Community APSRTC GTFS', scheduleConfidence: 'inferred', timetableBacked: true },
  tracking: { serviceNumber: service, vehicleNumber: null, status: 'options_available', providers: [], preferredProvider: null, checkedOn: null },
  ...extra
});
const ride = (kind, from, to, dep, minutes, extra = {}) => ({
  mode: 'local_ride', kind, label: 'Estimated local ride', from, to, distanceMeters: 4000, durationSeconds: minutes * 60, rideSeconds: minutes * 60,
  pickupWaitSeconds: 0, departureTime: t(dep), arrivalTime: t(dep), dataConfidence: 'estimated', durationConfidence: 'estimated',
  providerIntegration: false, availabilityStatus: 'unknown', isRealtime: false, fare: null, ...extra
});
const walk = (kind, from, to, seconds) => ({ mode: 'walk', kind, from, to, distanceMeters: 300, durationSeconds: seconds, departureTime: t('08:00'), arrivalTime: t('08:05'), dataConfidence: 'estimated' });

const direct = { legs: [bus('03846', 'GUNTUR', 'NARASARAOPET', '10:33', '12:25')] };
const rideBus = { legs: [ride('access', place('Origin', 'origin'), place('KUNCHANAPALLI CROSS ROAD NEAR APSDMA'), '07:45', 17), bus('03675', 'KUNCHANAPALLI CROSS ROAD NEAR APSDMA', 'GUNTUR', '08:10', '08:45')] };
const twoBuses = { legs: [bus('03772', 'VIJAYAWADA', 'YARRAVARAM', '21:45', '01:50'), bus('03551', 'YERRAVARAM', 'VISAKHAPATNAM', '02:10', '05:30')] };
const trainRide = { legs: [ride('access', place('Origin', 'origin'), place('Vijayawada Jn'), '06:00', 15), bus('12711', 'Vijayawada Jn', 'Chennai Central', '06:30', '13:00', 'rail', { operator: null })] };
const flight = { legs: [ride('access', place('Origin', 'origin'), place('Gannavaram Airport'), '05:00', 40), bus('6E101', 'Gannavaram Airport', 'Delhi', '06:30', '09:00', 'air', { operator: null })] };
const scooter = { legs: [ride('access', place('Origin', 'origin'), place('GUNTUR'), '07:00', 10, { vehicleType: 'scooter' }), bus('35169', 'GUNTUR', 'NARASARAOPET', '07:30', '08:30')] };

const icons = markup => [...markup.matchAll(/data-icon="([^"]+)"/g)].map(m => m[1]);
const nodes = markup => [...markup.matchAll(/data-node="([^"]+)"/g)].map(m => m[1]);

describe('journey simulation', () => {
  test('1. renders for a direct bus journey: origin, one bus segment, destination', () => {
    const markup = ui.render(ui.JourneySimulation, { journey: direct });
    assert.deepEqual(icons(markup), ['bus']);
    assert.deepEqual(nodes(markup), ['origin', 'destination']);
    assert.match(strip(markup), /Guntur 1 h 52 min Narasaraopet/);
  });

  test('2. each mode gets its own icon: local ride, bus, train, flight, walk, bike/scooter', () => {
    assert.deepEqual(icons(ui.render(ui.JourneySimulation, { journey: rideBus })), ['car-taxi-front', 'bus']);
    assert.deepEqual(icons(ui.render(ui.JourneySimulation, { journey: trainRide })), ['car-taxi-front', 'train-front']);
    assert.deepEqual(icons(ui.render(ui.JourneySimulation, { journey: flight })), ['car-taxi-front', 'plane']);
    assert.deepEqual(icons(ui.render(ui.JourneySimulation, { journey: scooter })), ['bike', 'bus']);
    const walking = { legs: [walk('access', place('Origin', 'origin'), place('GUNTUR'), 600), ...direct.legs.map(l => ({ ...l, fromStop: place('GUNTUR') }))] };
    assert.deepEqual(icons(ui.render(ui.JourneySimulation, { journey: walking })), ['footprints', 'bus']);
    for (const [mode, expected] of [['rail', 'train'], ['subway', 'train'], ['tram', 'train'], ['air', 'flight'], ['ferry', 'ferry'], ['bus', 'bus'], ['trolleybus', 'bus']]) {
      assert.equal(ui.simulationModeOf({ mode }), expected, mode);
    }
  });

  test('3/4. a two-bus journey shows two segments and a transfer point between them', () => {
    const markup = ui.render(ui.JourneySimulation, { journey: twoBuses });
    assert.deepEqual(icons(markup), ['bus', 'bus']);
    assert.deepEqual(nodes(markup), ['origin', 'transfer', 'destination']);
    assert.match(strip(markup), /Yarravaram Transfer/);
    assert.match(markup, /rc-sim-pulse/);
  });

  test('a local ride -> bus change is a mode change, not a transfer', () => {
    assert.deepEqual(nodes(ui.render(ui.JourneySimulation, { journey: rideBus })), ['origin', 'change', 'destination']);
  });

  test('7 (no invented segments). exactly one segment per real leg; trivial walks are skipped', () => {
    const withTinyWalk = { legs: [walk('access', place('Origin', 'origin'), place('GUNTUR'), 10), ...direct.legs] };
    const sim = ui.buildSimulation(withTinyWalk);
    assert.equal(sim.segments.length, 1);
    assert.equal(sim.nodes.length, 2);
    assert.equal(ui.buildSimulation(twoBuses).segments.length, 2);
    assert.equal(ui.buildSimulation(rideBus).segments.length, 2);
    assert.equal(ui.buildSimulation({ legs: [] }).segments.length, 0);
    assert.equal(ui.render(ui.JourneySimulation, { journey: { legs: [] } }), '');
  });

  test('5. without motion (server render, reduced motion, off-screen) the strip is static: no moving runner', () => {
    const markup = ui.render(ui.JourneySimulation, { journey: twoBuses, animate: false });
    assert.match(markup, /data-motion="off"/);
    assert.match(markup, /rc-sim-static/);
    assert.doesNotMatch(markup, /rc-sim-runner/);
    const css = readFileSync(path.join(sourceRoot, 'index.css'), 'utf8');
    const reduced = css.slice(css.lastIndexOf('@media (prefers-reduced-motion: reduce)'));
    for (const cls of ['.rc-sim-runner', '.rc-sim-glow', '.rc-sim-pulse']) assert.ok(reduced.includes(cls), cls);
    assert.match(reduced, /animation: none !important/);
    assert.match(css, /\.rc-sim-static \.rc-sim-pulse, \.rc-sim-static \.rc-sim-glow \{ animation: none; \}/);
  });

  test('the relay is slow (seconds per leg); only the small chip moves, inside a layout-contained track', () => {
    assert.ok(ui.SIM_SLOT_MS >= 2000 && ui.SIM_SLOT_MS <= 4000, `${ui.SIM_SLOT_MS}`);
    const css = readFileSync(path.join(sourceRoot, 'index.css'), 'utf8');
    const travel = css.slice(css.indexOf('@keyframes rc-sim-travel'), css.indexOf('@keyframes rc-sim-breathe'));
    assert.match(travel, /left: 0%/);
    assert.match(travel, /left: 100%/);
    assert.doesNotMatch(travel, /width:|height:|top:/);
    const markup = ui.render(ui.JourneySimulation, { journey: twoBuses, animate: true });
    assert.equal((markup.match(/rc-sim-runner/g) || []).length, 0, 'nothing moves until the client decides motion is allowed');
  });

  test('6. accessible: a summary for the whole route and a sentence per segment; decorative parts hidden', () => {
    const markup = ui.render(ui.JourneySimulation, { journey: rideBus });
    assert.match(markup, /role="group" aria-label="Route: Origin, local ride to KUNCHANAPALLI CROSS ROAD NEAR APSDMA, then apsrtc bus to GUNTUR\."/);
    assert.match(markup, /aria-label="Local ride from Origin to KUNCHANAPALLI CROSS ROAD NEAR APSDMA, 17 min \(estimated\)"/);
    assert.match(markup, /aria-label="APSRTC bus 03675 from KUNCHANAPALLI CROSS ROAD NEAR APSDMA to GUNTUR, 35 min"/);
    assert.match(markup, /title="KUNCHANAPALLI CROSS ROAD NEAR APSDMA"/, 'full name available when the label is shortened');
  });

  test('8. mobile: segments keep a minimum width and the strip scrolls horizontally instead of breaking the card', () => {
    const markup = ui.render(ui.JourneySimulation, { journey: twoBuses });
    assert.match(markup, /overflow-x-auto/);
    assert.match(markup, /min-w-\[112px\]/);
    assert.match(markup, /overflow-y-hidden/);
    assert.match(markup, /min-w-max/);
    assert.equal(ui.shortPlaceName('KUNCHANAPALLI CROSS ROAD NEAR APSDMA'), 'Kunchanapalli…');
    assert.equal(ui.shortPlaceName('Guntur'), 'Guntur');
    assert.ok(ui.segmentWeight(17 * 60) < ui.segmentWeight(120 * 60));
    assert.equal(ui.segmentWeight(0), 1);
  });

  test('9. no map data needed: the model uses names, modes and times only', () => {
    const noCoords = { legs: direct.legs.map(l => ({ ...l, fromStop: { type: 'stop', name: 'GUNTUR' }, toStop: { type: 'stop', name: 'NARASARAOPET' } })) };
    assert.equal(ui.buildSimulation(noCoords).segments.length, 1);
    const source = readFileSync(path.join(sourceRoot, 'components', 'JourneySimulation.tsx'), 'utf8') + readFileSync(path.join(sourceRoot, 'utils', 'journeySimulation.ts'), 'utf8');
    assert.doesNotMatch(source, /leaflet|mapbox|google\.maps|maplibre|\.lat\b|\.lon\b|fetch\(/i);
  });

  test('the detailed (expanded) strip adds times at the nodes', () => {
    assert.match(strip(ui.render(ui.JourneySimulation, { journey: twoBuses, detailed: true })), /Vijayawada 21:45 .*Visakhapatnam 05:30/);
  });
});

describe('journey card with the simulation', () => {
  const journey = (legs, extra = {}) => ({
    id: 'jr_x', labels: [], departureTime: legs[0].departureTime, arrivalTime: legs.at(-1).arrivalTime, totalDurationSeconds: 6720,
    walkingDurationSeconds: 0, waitingDurationSeconds: 0, transfers: legs.filter(l => l.serviceNumber).length - 1, transitLegCount: 1,
    datasetConfidence: 'inferred', scheduleConfidence: 'inferred', confidence: 'inferred', timeQuality: 'approximate',
    localRideDurationSeconds: 0, localRideCount: 0, fare: null, fareEstimate: null, legs, ...extra
  });
  const card = j => ui.renderCard({ journey: j, index: 1, from: 'A', to: 'B' });

  test('the card shows a route preview above the key facts', () => {
    const markup = card(journey(direct.legs));
    assert.match(markup, /aria-label="Route preview"/);
    assert.ok(markup.indexOf('Route preview') < markup.indexOf('Departs'));
  });

  test('7. concise text: no "Walking none" / "Waiting none" / "Schedule:" / "Local transport:" prose', () => {
    const text = strip(card(journey(rideBus.legs, { localRideCount: 1, localRideDurationSeconds: 17 * 60, waitingDurationSeconds: 0 })));
    assert.doesNotMatch(text, /Walking none|Waiting none|Schedule: |Local transport:|\(approx\.\)|availability not verified\)/);
    assert.match(text, /Local ride ≈ 17 min/);
    assert.match(text, /Approx\. stop times/);
  });

  test('waiting and walking appear as short chips only when they apply', () => {
    const text = strip(card(journey(twoBuses.legs, { waitingDurationSeconds: 20 * 60, walkingDurationSeconds: 5 * 60 })));
    assert.match(text, /Walk ≈ 5 min Waiting 20 min Approx\. stop times/);
    const exact = strip(card(journey(direct.legs, { timeQuality: 'exact' })));
    assert.doesNotMatch(exact, /Journey facts|Waiting|Walk ≈|Approx\. stop/);
  });

  test('10. no route logic in the component: it only reads the legs it is given', () => {
    const source = readFileSync(path.join(sourceRoot, 'utils', 'journeySimulation.ts'), 'utf8');
    assert.doesNotMatch(source, /raptor|planJourneys|fetchPlan|rankJourneys/i);
  });
});

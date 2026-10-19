// Train (estimated railway suggestions) in the search experience:
//   - the dialog offers exactly Any transport, Bus, Train; Train follows the railway network's real readiness;
//   - Train calls /api/v2/rail-explorer (never the bus planner) under the normal discovery animation;
//   - Any transport shows bus journeys AND train suggestions on one Travel options page, with All / Bus / Train tabs,
//     train cards clearly labelled and never ranked against bus journeys; Bus shows no train suggestions;
//   - no fabricated train service: no train numbers, clock times, fares, booking, tracking or mixed bus+train itinerary.
// The data below is SYNTHETIC (test stations ALF/DLT, test bus route 9999).
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
  import PreferenceModal from './components/PreferenceModal';
  import SearchResults from './pages/SearchResults';
  import { EstimatedRailCard, EstimatedRailList, RailCorridorStrip, RailCorridorMap } from './components/EstimatedRailSection';
  export * as prefs from './utils/travelPreferences';
  export * as caps from './services/capabilities';
  export * as explorer from './services/railExplorer';
  export * as planRequest from './services/planRequest';
  export const render = (Component, props) => renderToStaticMarkup(createElement(Component, props));
  export const renderAt = url => renderToStaticMarkup(createElement(MemoryRouter, { initialEntries: [url] }, createElement(AuthProvider, null, createElement(SearchResults))));
  export { PreferenceModal, EstimatedRailCard, EstimatedRailList, RailCorridorStrip, RailCorridorMap };
`, 'estrail');

const strip = markup => markup.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
const read = (...parts) => readFileSync(path.join(sourceRoot, ...parts), 'utf8');
const noop = () => {};
const READY = { available: true, state: 'ready', reason: null };
const connection = (extra = {}) => ({
  id: 'erc_1', kind: 'estimated_rail_connection', label: 'Estimated rail connection — not a scheduled train', alternative: false,
  startStation: { name: 'Alpha Junction', code: 'ALF', lat: 16.0, lon: 80.0, distanceFromOriginKm: 4.4 },
  endStation: { name: 'Delta', code: 'DLT', lat: 17.0, lon: 81.0, distanceToDestinationKm: 1.1 },
  corridor: { names: ['Test Main Line'], via: ['Beta Junction'] },
  distanceKm: 350, trackKmByClass: { main: 350, branch: 0, unknown: 0 },
  estimatedDuration: { minMinutes: 340, maxMinutes: 555, breakdown: { faster: { runningMinutes: 323, stops: 5, stopMinutes: 15, mainKph: 65, branchKph: 50 }, slower: { runningMinutes: 467, stops: 60, stopMinutes: 90, mainKph: 45, branchKph: 35 }, reversals: 0, reversalMinutes: 0 } },
  intermediateStationCount: 60, intermediateStations: [{ name: 'Beta Junction', code: 'BTJ', km: 120 }], reversals: 0,
  geometry: [[16.0, 80.0], [16.5, 80.4], [17.0, 81.0]], ...extra
});
const ASSUMPTIONS = ['Built from railway track mapped in OpenStreetMap. Connected track does not mean a passenger train runs on it.'];
const answer = { available: true, label: 'x', assumptions: ASSUMPTIONS, network: { attribution: '© OpenStreetMap contributors', licence: 'ODbL', coverage: ['Test'], snapshot: null }, connections: [connection()] };
const modal = extra => ui.render(ui.PreferenceModal, { open: true, initial: { modes: [], ranking: 'best' }, onConfirm: noop, onClose: noop, ...extra });
const radios = markup => (markup.match(/<input[^>]*>/g) ?? []).filter(i => /type="radio"/.test(i) && /name="pref-mode/.test(i));
const radio = (markup, value) => radios(markup).find(i => i.includes(`value="${value}"`));

describe('1-4. the dialog: Any transport, Bus, Train', () => {
  test('exactly three choices; no duplicate train cards and no "Coming soon"', () => {
    const markup = modal({ estimatedRail: READY });
    assert.deepEqual(radios(markup).map(i => /value="([^"]+)"/.exec(i)[1]), ['any', 'bus', 'train']);
    const text = strip(markup);
    assert.match(text, /Travel by Any transport Buses and estimated train suggestions Bus Timetabled buses Train Railway connections near you/);
    assert.doesNotMatch(text, /Coming soon|Scheduled train|Estimated rail\b/);
  });

  test('ready: Train is selectable, with the one concise explanation', () => {
    const markup = modal({ estimatedRail: READY });
    assert.doesNotMatch(radio(markup, 'train'), /disabled/);
    assert.match(strip(markup), /Train suggestions are estimated from mapped railway connections\. Schedules are not verified\./);
  });

  test('a remembered Train choice comes back selected, and "Show first" (bus ranking) is not asked for it', () => {
    const markup = modal({ estimatedRail: READY, initialView: 'estimated_rail' });
    assert.match(radio(markup, 'train'), /checked/);
    assert.doesNotMatch(strip(markup), /Show first/);
    assert.match(strip(modal({ estimatedRail: READY })), /Show first/);
  });

  test('preparing / failed / not checked: a short, meaningful state; Bus stays usable', () => {
    const preparing = modal({ estimatedRail: { available: false, state: 'preparing', reason: 'The railway network is being prepared on the server. Try again in a minute.' }, initialView: 'estimated_rail' });
    assert.match(radio(preparing, 'train'), /disabled/);
    assert.match(strip(preparing), /Train Preparing…/);
    assert.match(strip(preparing), /Train: The railway network is being prepared on the server\. Try again in a minute\. Bus search still works\./);
    assert.match(radio(preparing, 'any'), /checked/, 'falls back to Any transport');
    assert.doesNotMatch(radio(preparing, 'bus'), /disabled/);
    const failed = strip(modal({ estimatedRail: { available: false, state: 'failed', reason: 'The railway network could not be prepared on the server.' } }));
    assert.match(failed, /Train Unavailable/);
    assert.match(failed, /The railway network could not be prepared on the server\./);
    const unknown = strip(modal({ estimatedRail: { available: false, state: 'unknown', reason: 'Train availability could not be checked with the route server.' } }));
    assert.match(unknown, /Train Not checked/);
  });

  test('an unreachable or outdated server is reported as "not checked", never silently as unavailable, and re-asked soon', async () => {
    const realFetch = globalThis.fetch;
    const realWarn = console.warn;
    console.warn = () => {};
    globalThis.fetch = async () => new Response('Cannot GET /api/v2/capabilities', { status: 404 });
    try {
      const first = await ui.caps.fetchCapabilities({ force: true });
      assert.equal(first.estimatedRail.state, 'unknown');
      assert.match(first.estimatedRail.reason, /could not be checked/);
      globalThis.fetch = async () => new Response(JSON.stringify({ estimatedRail: { available: true, state: 'ready' }, modes: {} }), { status: 200 });
      const realNow = Date.now;
      Date.now = () => realNow() + 5000; // a few seconds later
      try {
        const second = await ui.caps.fetchCapabilities();
        assert.equal(second.estimatedRail.available, true, 'a not-ready answer is re-asked within seconds, not cached for minutes');
      } finally { Date.now = realNow; }
    } finally { globalThis.fetch = realFetch; console.warn = realWarn; }
  });

  test('choice model and URL: Train is the estimated-rail view; Bus never includes it', () => {
    const choices = ui.prefs.travelChoicesFor({ estimatedRail: READY });
    assert.deepEqual(choices.map(c => [c.id, c.view, c.modes]), [['any', 'planned', []], ['bus', 'planned', ['bus']], ['train', 'estimated_rail', []]]);
    assert.equal(ui.prefs.writeViewParam(new URLSearchParams('from=A&modes=bus&explore=rail'), 'estimated_rail').toString(), 'from=A&view=estimated-rail');
    assert.equal(ui.prefs.readViewParam(new URLSearchParams('view=estimated-rail')), 'estimated_rail');
    assert.equal(ui.prefs.viewSummary('estimated_rail', []), 'Train (estimated)');
    assert.equal(ui.prefs.viewSummary('planned', []), 'Any transport');
  });
});

describe('5-6. the search flow', () => {
  const dashboard = read('pages', 'Dashboard.tsx');

  test('Train queries the railway API and never the bus planner; the choice travels with the search', () => {
    assert.match(dashboard, /searchView === 'estimated_rail'\s*\?\s*resolveRailCoords\(url, controller\.signal\)\.then\(coords => fetchRailExplorer\(coords, controller\.signal\)\)/);
    assert.match(dashboard, /: runPlanSearch\(planParamsFromSearch\(url\), controller\.signal\)/);
    assert.match(dashboard, /startSearch\(preferences, pending\.params, choice\.view\)/);
    assert.match(dashboard, /capabilities\.refresh\(\);\s*setPending\(/, 'availability is re-checked each time the dialog opens');
    assert.match(dashboard, /useCapabilities\(\{ poll: pending !== null \}\)/);
  });

  test('the request carries the searched coordinates to /api/v2/rail-explorer', async () => {
    const urls = [];
    const realFetch = globalThis.fetch;
    globalThis.fetch = async url => { urls.push(String(url)); return new Response(JSON.stringify(answer), { status: 200 }); };
    try {
      await ui.explorer.fetchRailExplorer({ fromLat: 16.50889, fromLng: 80.6166, toLat: 16.29606, toLng: 80.4563 });
    } finally { globalThis.fetch = realFetch; }
    const sent = new URL(urls[0], 'http://x');
    assert.equal(sent.pathname, '/api/v2/rail-explorer');
    assert.deepEqual([...sent.searchParams.entries()], [['fromLat', '16.50889'], ['fromLng', '80.6166'], ['toLat', '16.29606'], ['toLng', '80.4563']]);
  });

  test('the normal discovery animation plays during the railway request', () => {
    assert.match(dashboard, /estimatedRail=\{phase\.view === 'estimated_rail'\}/);
    const loading = strip(ui.renderAt('/search-results?from=Vijayawada&to=Guntur&fromLat=16.1&fromLng=80.1&toLat=16.9&toLng=80.9&view=estimated-rail'));
    assert.match(loading, /Finding your best routes/);
    assert.match(loading, /Train · estimated railway connections/);
    assert.match(loading, /Finding connected railway corridors/);
  });

  test('a Train search is never silently turned into a bus search', () => {
    assert.match(dashboard, /if \(!answer\.available\) throw new RailUnavailableError/);
    assert.doesNotMatch(read('pages', 'EstimatedRailResults.tsx'), /runPlanSearch|planRequest|fetchPlan/);
  });
});

describe('7-8, 10-11. results', () => {
  const busJourney = {
    id: 'jr_bus', labels: ['BEST_PATH', 'FASTEST'], departureTime: '2026-10-20T07:00:00+05:30', arrivalTime: '2026-10-20T08:00:00+05:30',
    totalDurationSeconds: 3600, walkingDurationSeconds: 0, waitingDurationSeconds: 0, transfers: 0, transitLegCount: 1,
    datasetConfidence: 'inferred', scheduleConfidence: 'inferred', confidence: 'inferred', timeQuality: 'approximate', localRideDurationSeconds: 0, localRideCount: 0, fare: null,
    fareEstimate: { min: 40, max: 60, currency: 'INR', confidence: 'estimated', complete: true, components: [], unknownComponents: [] },
    tracking: { busLegs: 1, verifiedLegs: 0, notFoundLegs: 0, allVerified: false },
    legs: [{ mode: 'bus', routeId: '9999', routeShortName: '9999', routeLongName: null, operator: 'APSRTC', operatorInfo: { name: 'APSRTC', type: 'state_transport', source: 'test', confidence: 'published' }, routeCode: '9999', serviceNumber: null, tripId: 'T1', headsign: null,
      fromStop: { type: 'stop', name: 'Test Stop A', lat: 16.1, lon: 80.1 }, toStop: { type: 'stop', name: 'Test Stop B', lat: 16.9, lon: 80.9 },
      departureTime: '2026-10-20T07:00:00+05:30', arrivalTime: '2026-10-20T08:00:00+05:30', serviceDate: '2026-10-20', scheduleBasis: 'published_calendar', durationSeconds: 3600,
      intermediateStopCount: 3, datasetId: 1, dataConfidence: 'inferred', timeQuality: 'approximate', tracking: null, fare: null }]
  };
  const url = 'from=Vijayawada&to=Guntur&date=2026-10-20&time=06:00&fromLat=16.2&fromLng=80.2&toLat=16.8&toLng=80.8&rank=best';
  const prime = async () => {
    const realFetch = globalThis.fetch;
    globalThis.fetch = async () => new Response(JSON.stringify({ estimatedRail: { available: true, state: 'ready' }, modes: { bus: { available: true }, train: { available: false } } }), { status: 200 });
    try { await ui.caps.fetchCapabilities({ force: true }); } finally { globalThis.fetch = realFetch; }
    ui.explorer.rememberRailExplorer(ui.explorer.explorerKey({ fromLat: 16.2, fromLng: 80.2, toLat: 16.8, toLng: 80.8 }), answer);
    ui.planRequest.rememberPlan(ui.planRequest.planKey(ui.planRequest.planParamsFromSearch(new URLSearchParams(url))), { query: {}, warnings: [], journeys: [busJourney], sources: [] });
  };

  test('Any transport: bus journeys and train suggestions on one Travel options page, with All / Bus / Train tabs', async () => {
    await prime();
    const markup = ui.renderAt(`/search-results?${url}`);
    const text = strip(markup);
    assert.match(text, /All Bus · 1 Train · 1 \(estimated\)/);
    assert.match(text, /Bus journeys \(1\)/);
    assert.match(text, /Train suggestions/);
    assert.match(text, /Estimated railway connection/);
    assert.ok(text.indexOf('Bus journeys (1)') < text.indexOf('Estimated railway connection'), 'strongest timetable journeys first, train suggestions right after');
    assert.ok(text.indexOf('Estimated railway connection') < text.indexOf('Show later departures'), 'nearby, inside the same results, not far below');
  });

  test('ranking labels stay within bus journeys: train cards never get Fastest / Best path / Lower cost', async () => {
    await prime();
    const markup = ui.renderAt(`/search-results?${url}`);
    const trainCard = markup.slice(markup.indexOf('aria-label="Estimated rail connection'));
    assert.doesNotMatch(strip(trainCard.slice(0, trainCard.indexOf('</article>'))), /Fastest|Best path|Lower cost|Fewest transfers/);
    assert.match(read('pages', 'SearchResults.tsx'), /train suggestions are never ranked\s*\/\/ against them/);
  });

  test('Bus shows no train suggestions and does not ask the railway API', () => {
    const page = read('pages', 'SearchResults.tsx');
    // Estimated suggestions need Any transport or Train (never Bus), and only while scheduled trains are not working.
    assert.match(page, /const trainOrAny = preferences\.modes\.length === 0 \|\| \(preferences\.modes\.length === 1 && preferences\.modes\[0\] === 'train'\);/);
    assert.match(page, /const exploreRail = readExploreParam\(searchParams\) \|\| \(trainOrAny && capabilities\.estimatedRail\.available && !scheduledTrainsOk && !scheduledPending\);/);
    assert.match(page, /useRailExplorer\(exploreRail \? railCoords : null\)/);
  });

  test('Train: corridors are the main result, without any bus journey or planner request', () => {
    const coords = { fromLat: 16.3, fromLng: 80.3, toLat: 16.7, toLng: 80.7 };
    ui.explorer.rememberRailExplorer(ui.explorer.explorerKey(coords), answer);
    const text = strip(ui.renderAt('/search-results?from=Vijayawada&to=Guntur&date=2026-10-20&time=06:00&fromLat=16.3&fromLng=80.3&toLat=16.7&toLng=80.7&view=estimated-rail'));
    assert.match(text, /Train suggestions/);
    assert.match(text, /Alpha Junction \(ALF\) → Delta \(DLT\)/);
    assert.doesNotMatch(text, /Bus journeys|Departing after|Show later departures|Coming soon/);
  });

  test('no mixed bus + train itinerary is ever composed from an estimated corridor', () => {
    const backendPlanner = readFileSync(path.join(sourceRoot, '..', 'backend', 'transit', 'multimodal', 'planMultimodal.js'), 'utf8');
    assert.doesNotMatch(backendPlanner, /railNetwork\/|rail-explorer|railExplorer/);
    assert.doesNotMatch(read('components', 'EstimatedRailSection.tsx'), /departureTime|arrivalTime|transfer/i);
  });

  test('missing railway data: the reason is shown instead of an empty or fake result', () => {
    const text = strip(ui.render(ui.EstimatedRailList, { state: { loading: false, data: { available: false, state: 'missing', label: 'x', reason: 'The railway network has not been set up on this server yet.' }, error: null } }));
    assert.match(text, /The railway network has not been set up on this server yet\./);
  });
});

describe('8-9, 12-13. the estimated railway card', () => {
  const markup = ui.render(ui.EstimatedRailCard, { connection: connection(), attribution: '© OpenStreetMap contributors', assumptions: ASSUMPTIONS });
  const text = strip(markup);

  test('train icon, title, stations, corridor, duration range, distance, one status label and More details', () => {
    assert.match(markup, /lucide-train-front/);
    assert.match(text, /^Estimated railway connection Alpha Junction \(ALF\) → Delta \(DLT\) via Beta Junction Estimated — no verified train schedule/);
    assert.match(text, /≈ 350 km/);
    assert.match(text, /Estimated duration 5 h 40 min – 9 h 15 min/);
    assert.match(text, /More details/);
    assert.equal((text.match(/no verified train schedule/g) || []).length, 1, 'one status label, no repeated disclaimers');
  });

  test('no fabricated service: no clock time, train number, fare, booking, tracking or ranking badge', () => {
    assert.doesNotMatch(text, /\b\d{1,2}:\d{2}\b/);
    assert.doesNotMatch(text, /Train \d{5}|₹|seat|book|track|live|on time|Fastest|Best path|Lower cost/i);
  });

  test('the large route strip is continuous and animated, labelled with distances only', () => {
    const stripMarkup = ui.render(ui.RailCorridorStrip, { connection: connection() });
    assert.match(stripMarkup, /rc-erc-runner/);
    assert.match(strip(stripMarkup), /≈ 350 km estimated rail/);
    assert.doesNotMatch(strip(stripMarkup), /min|\d:\d/);
    const map = ui.render(ui.RailCorridorMap, { connection: connection(), attribution: '© OpenStreetMap contributors' });
    assert.match(map, /href="https:\/\/www\.openstreetmap\.org\/copyright"/);
  });

  test('phones: the card stacks and the strip scrolls sideways instead of squeezing', () => {
    const card = read('components', 'EstimatedRailSection.tsx');
    assert.match(card, /grid-cols-2 gap-x-4 gap-y-3 sm:grid-cols-3/);
    assert.match(card, /overflow-x-auto overflow-y-hidden/);
  });
});

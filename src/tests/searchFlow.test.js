// Search flow: preferences reach the request, the results page re-sorts exactly like the server, the finished response
// is handed over without a second request, and the route-discovery panel only ever says what is true.
// Journeys are TEST FIXTURES ONLY. Expected orders are written out by hand.
import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { bundle, sourceRoot } from './harness.js';
import { comparatorFor } from '../../backend/transit/multimodal/preferences.js';

globalThis.localStorage = { getItem: () => null, setItem: () => {}, removeItem: () => {} };

const ui = bundle(`
  import { createElement } from 'react';
  import { renderToStaticMarkup } from 'react-dom/server';
  import RouteDiscovery, { NEUTRAL_STATUS, SLOW_STATUS } from './components/RouteDiscovery';
  export * as prefs from './utils/travelPreferences';
  export * as request from './services/planRequest';
  export * as service from './services/planService';
  export const render = (Component, props) => renderToStaticMarkup(createElement(Component, props));
  export { RouteDiscovery, NEUTRAL_STATUS, SLOW_STATUS };
`, 'flow');

const { prefs, request, service } = ui;
const read = (...parts) => readFileSync(path.join(sourceRoot, ...parts), 'utf8');
const strip = markup => markup.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();

const BASE = Date.parse('2026-10-05T07:00:00+05:30');
const iso = m => new Date(BASE + m * 60000 + 330 * 60000).toISOString().slice(0, 19) + '+05:30';
const journey = (id, { dep = 0, minutes, transfers = 0, fare = [90, 110], raw = 8 }) => ({
  id, departureTime: iso(dep), arrivalTime: iso(dep + minutes), totalDurationSeconds: minutes * 60, transfers,
  fareEstimate: fare === null ? null : fare === 'partial'
    ? { min: 20, max: 30, complete: false }
    : { min: fare[0], max: fare[1], complete: true },
  rating: { score: Math.round(raw * 10) / 10, raw }
});
// The brief's table: A fastest (1h20 ₹280 2 tr), B cheapest (1h50 ₹100 1 tr), C direct (2h10 ₹160 0 tr).
const fixtures = () => [
  journey('A', { dep: 0, minutes: 80, transfers: 2, fare: [230, 330], raw: 7.4 }),
  journey('B', { dep: 75, minutes: 110, transfers: 1, fare: [80, 120], raw: 8.1 }),
  journey('C', { dep: 150, minutes: 130, transfers: 0, fare: [140, 180], raw: 8.6 })
];
const order = ranking => fixtures().reverse().sort(prefs.compareJourneysFor(ranking)).map(j => j.id);

describe('results ordering per preference', () => {
  test('Fastest → A, B, C', () => assert.deepEqual(order('fastest'), ['A', 'B', 'C']));
  test('Lowest estimated cost → B, C, A', () => assert.deepEqual(order('cost'), ['B', 'C', 'A']));
  test('Fewest transfers → C, B, A', () => assert.deepEqual(order('transfers'), ['C', 'B', 'A']));
  test('Best overall → by Best Path Rating: C (8.6), B (8.1), A (7.4)', () => assert.deepEqual(order('best'), ['C', 'B', 'A']));

  test('unpriced and partly priced journeys come last for cost, never as ₹0', () => {
    const list = [journey('partial', { minutes: 40, fare: 'partial' }), journey('none', { minutes: 40, fare: null }), journey('dear', { minutes: 90, fare: [400, 500] })];
    assert.equal(list.sort(prefs.compareJourneysFor('cost'))[0].id, 'dear');
  });

  test('the browser orders exactly like the server for every preference (shared rules, not two opinions)', () => {
    const many = [
      ...fixtures(),
      journey('D', { dep: 30, minutes: 80, transfers: 1, fare: [230, 330], raw: 7.9 }),
      journey('E', { dep: 200, minutes: 110, transfers: 0, fare: null, raw: 8.1 }),
      journey('F', { dep: 260, minutes: 95, transfers: 1, fare: 'partial', raw: 6.2 }),
      journey('G', { dep: 300, minutes: 130, transfers: 0, fare: [140, 180], raw: 8.6 })
    ];
    for (const ranking of ['best', 'fastest', 'cost', 'transfers']) {
      const browser = [...many].sort(prefs.compareJourneysFor(ranking)).map(j => j.id);
      const server = [...many].sort(comparatorFor(ranking)).map(j => j.id);
      assert.deepEqual(browser, server, ranking);
    }
  });
});

describe('preferences reach the request', () => {
  test('the results URL becomes request params with modes and an explicit rank; train is never sent', () => {
    const params = request.planParamsFromSearch(new URLSearchParams('from=Guntur&to=Vijayawada&date=2026-10-20&time=08:00&modes=bus&rank=fastest'));
    assert.deepEqual([params.modes, params.rank, params.windowMinutes], [['bus'], 'fastest', 360]);
    assert.equal(request.planParamsFromSearch(new URLSearchParams('from=a&to=b&date=2026-10-20&time=08:00')).rank, 'best');
    assert.deepEqual(request.planParamsFromSearch(new URLSearchParams('from=a&to=b&date=2026-10-20&time=08:00&modes=train')).modes, []);
  });

  test('fetchPlan sends modes and rank to /api/v2/plan', async () => {
    const urls = [];
    const realFetch = globalThis.fetch;
    globalThis.fetch = async url => { urls.push(String(url)); return new Response(JSON.stringify({ journeys: [] }), { status: 200 }); };
    try {
      await service.fetchPlan({ from: 'Guntur', to: 'Tenali', date: '2026-10-20', time: '08:00', modes: ['bus'], rank: 'transfers' });
    } finally { globalThis.fetch = realFetch; }
    const sent = new URL(urls[0], 'http://x').searchParams;
    assert.equal(sent.get('modes'), 'bus');
    assert.equal(sent.get('rank'), 'transfers');
  });

  test('a 422 MODE_UNAVAILABLE from the server becomes a clear error, not results', async () => {
    const realFetch = globalThis.fetch;
    globalThis.fetch = async () => new Response(JSON.stringify({ code: 'MODE_UNAVAILABLE', error: 'Train journeys are not available yet.' }), { status: 422 });
    try {
      await assert.rejects(service.fetchPlan({ from: 'a', to: 'b', date: '2026-10-20', time: '08:00', modes: ['train'] }), e => e.code === 'MODE_UNAVAILABLE');
    } finally { globalThis.fetch = realFetch; }
  });

  test('the request key includes the preferences (a Bus-only search never reuses a no-preference answer)', () => {
    const base = { from: 'a', to: 'b', date: '2026-10-20', time: '08:00', windowMinutes: 360 };
    const keys = new Set([
      request.planKey({ ...base, modes: [], rank: 'best' }),
      request.planKey({ ...base, modes: ['bus'], rank: 'best' }),
      request.planKey({ ...base, modes: [], rank: 'fastest' })
    ]);
    assert.equal(keys.size, 3);
  });
});

describe('one request per search', () => {
  let realFetch;
  let calls;
  beforeEach(() => {
    request.clearPlanCache();
    realFetch = globalThis.fetch;
    calls = 0;
  });
  afterEach(() => { globalThis.fetch = realFetch; });

  test('the search flow caches its answer for the results page, which therefore does not ask again', async () => {
    globalThis.fetch = async () => { calls++; return new Response(JSON.stringify({ journeys: [{ id: 'x' }] }), { status: 200 }); };
    const params = request.planParamsFromSearch(new URLSearchParams('from=a&to=b&date=2026-10-20&time=08:00&modes=bus&rank=cost'));
    const plan = await request.runPlanSearch(params, new AbortController().signal);
    assert.equal(calls, 1);
    assert.equal(request.recallPlan(request.planKey(params)), plan);
    assert.equal(request.recallPlan(request.planKey({ ...params, rank: 'best' })), null);
  });

  test('cached answers expire', () => {
    request.rememberPlan('k', { journeys: [] }, 0);
    assert.ok(request.recallPlan('k', 60_000));
    assert.equal(request.recallPlan('k', 6 * 60_000), null);
  });

  test('a hung request ends in a TIMEOUT error, never an endless spinner', async () => {
    globalThis.fetch = (_url, { signal }) => new Promise((_, reject) => signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' }))));
    await assert.rejects(request.runPlanSearch({ from: 'a', to: 'b', date: '2026-10-20', time: '08:00' }, new AbortController().signal, 30), e => e.code === 'TIMEOUT');
  });

  test('cancelling is an abort, not a timeout, and caches nothing', async () => {
    globalThis.fetch = (_url, { signal }) => new Promise((_, reject) => signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' }))));
    const controller = new AbortController();
    const pending = request.runPlanSearch({ from: 'a', to: 'b', date: '2026-10-20', time: '08:00' }, controller.signal, 10_000);
    controller.abort();
    await assert.rejects(pending, e => e.name === 'AbortError');
  });

  test('the results page uses the handed-over answer before requesting, and only re-requests on purpose', () => {
    const page = read('pages', 'SearchResults.tsx');
    assert.match(page, /const cached = retryCount === 0 \? recallPlan\(planKey\(params\)\) : null;/);
    // Changing only the sort (rank) must not trigger a request: rank is not a dependency of the request effect.
    assert.match(page, /\}, \[from, to, date, time, fromLat, fromLng, toLat, toLng, modesKey, retryCount, navigate\]\);/);
  });
});

describe('the flow: Show routes / Skip → real search → results', () => {
  const dashboard = read('pages', 'Dashboard.tsx');

  test('both Show routes and Skip go through the same confirm → startSearch path', () => {
    const modal = read('components', 'PreferenceModal.tsx');
    assert.match(modal, /onClick=\{confirm\}[\s\S]{0,20}|const confirm = \(\) => onConfirm\(/);
    assert.match(modal, /onConfirm\(\{ \.\.\.DEFAULT_PREFERENCES, modes: \[\] \}\)/);
    assert.match(dashboard, /onConfirm=\{handleConfirmPreferences\}/);
    assert.match(dashboard, /startSearch\(preferences, pending\.params\);/);
  });

  test('duplicate submissions are ignored and stale results never update the page', () => {
    assert.match(dashboard, /if \(searchRef\.current\) return; \/\/ a search is already running/);
    assert.match(dashboard, /if \(!pending \|\| phase\.kind !== 'choose'\) return;/);
    assert.match(dashboard, /const isCurrent = \(\) => searchRef\.current === controller && !controller\.signal\.aborted;/);
    assert.match(dashboard, /useEffect\(\(\) => \(\) => \{ searchRef\.current\?\.abort\(\); searchRef\.current = null; \}, \[\]\);/);
    assert.equal((dashboard.match(/if \(!isCurrent\(\)\) return;/g) || []).length, 3, 'checked after every await');
  });

  test('fast searches do not flash and nobody waits on the animation for long', () => {
    assert.match(dashboard, /const MIN_DISCOVERY_MS = 700;/);
    assert.match(dashboard, /const DISCOVERY_EXIT_MS = 200;/);
    assert.match(dashboard, /pause\(Math\.max\(0, MIN_DISCOVERY_MS - \(performance\.now\(\) - started\)\)\)/, 'only the remainder of 0.7 s, after the real answer');
  });

  test('navigation happens only after the real request succeeded; errors stay in the panel with recovery actions', () => {
    const run = dashboard.slice(dashboard.indexOf('const startSearch'), dashboard.indexOf('const handleConfirmPreferences'));
    assert.ok(run.indexOf('runPlanSearch(') < run.indexOf('navigate('));
    assert.match(run, /\.catch\(error => \{[\s\S]*setPhase\(\{ kind: 'error'/);
    assert.match(dashboard, /onRetry=\{\(\) => startSearch\(phase\.preferences, pending\.params\)\}/);
    assert.match(dashboard, /onEditPreferences=\{\(\) => setPhase\(\{ kind: 'choose' \}\)\}/);
    assert.match(dashboard, /onChangeSearch=\{closeFlow\}/);
  });

  test('the discovery panel replaces the dialog inside the same overlay (blur and focus handling stay on)', () => {
    assert.match(dashboard, /stage=\{pending && phase\.kind !== 'choose' \? \(\s*<RouteDiscovery/);
    const modal = read('components', 'PreferenceModal.tsx');
    assert.match(modal, /\{stage \? \(\s*<div ref=\{dialogRef\} role="dialog" aria-modal="true" aria-label=\{stageLabel\}/);
    assert.match(modal, /onClick=\{stage \? undefined : onClose\}/, 'a stray click cannot cancel a running search');
  });

  test('changing the sort on the results page updates the URL preference (refresh and back keep it)', () => {
    const page = read('pages', 'SearchResults.tsx');
    assert.match(page, /setSearchParams\(writePreferenceParams\(\{ \.\.\.preferences, ranking \}, new URLSearchParams\(searchParams\)\), \{ replace: true \}\);/);
    assert.match(page, /const params = new URLSearchParams\(searchParams\);\s*params\.set\('date', next\.date\);/, 'later departures copy every parameter, rank and modes included');
  });
});

describe('route-discovery panel', () => {
  const panel = (extra = {}) => ui.render(ui.RouteDiscovery, {
    from: 'Guntur', to: 'Vijayawada', preferences: { modes: [], ranking: 'best' }, state: 'searching', animate: true, ...extra
  });

  test('headline, the trip, the chosen preference and one neutral live status line', () => {
    const markup = panel();
    const text = strip(markup);
    assert.match(text, /Finding your best routes\.\.\. Guntur Vijayawada No preference · Best overall Finding available journeys…/);
    assert.match(markup, /role="status" aria-live="polite"/);
    assert.match(markup, /aria-busy="true"/);
  });

  test('no invented stages and no percentages', () => {
    const text = strip(panel());
    for (const claim of ['Searching available connections', 'Checking journey timings', 'Comparing travel options', 'Preparing your routes']) {
      assert.ok(!text.includes(claim), claim);
    }
    assert.doesNotMatch(text, /\d+\s*%/);
    assert.equal(ui.SLOW_STATUS, 'Still searching… this can take a few seconds.');
  });

  test('Bus only shows a bus marker; no preference a neutral one; never any train visuals', () => {
    assert.match(panel({ preferences: { modes: ['bus'], ranking: 'fastest' } }), /data-marker="bus"/);
    assert.match(panel(), /data-marker="generic"/);
    for (const preferences of [{ modes: [], ranking: 'best' }, { modes: ['bus'], ranking: 'cost' }]) {
      assert.doesNotMatch(panel({ preferences }), /train/i);
    }
  });

  test('the scene is decorative and static under reduced motion', () => {
    const moving = panel();
    const still = panel({ animate: false });
    assert.match(moving, /<svg[^>]*aria-hidden="true"/);
    assert.match(moving, /<animateMotion/);
    assert.doesNotMatch(still, /<animate/);
    assert.match(still, /data-animated="false"/);
  });

  test('errors: an alert, the reason, and only the recovery actions that can help', () => {
    const noop = () => {};
    const retryable = panel({ state: 'error', error: { title: 'Can’t reach RouteConnect', message: 'Check your connection, then try again.', canRetry: true }, onRetry: noop, onEditPreferences: noop, onChangeSearch: noop });
    assert.match(retryable, /role="alert"/);
    assert.match(strip(retryable), /Can’t reach RouteConnect Check your connection, then try again\. Try again Edit preferences Change search/);
    const final = panel({ state: 'error', error: { title: 'We couldn’t find that place', message: 'x', canRetry: false }, onRetry: noop, onEditPreferences: noop, onChangeSearch: noop });
    assert.doesNotMatch(strip(final), /Try again/);
  });

  test('cancel is offered while searching; mobile-safe sizing', () => {
    assert.match(strip(panel({ onCancel: () => {} })), /Cancel$/);
    const source = read('components', 'RouteDiscovery.tsx');
    assert.match(source, /className="block h-auto w-full"/);
    assert.doesNotMatch(source, /\bw-\[\d+px\]|min-w-\[\d+px\]/);
  });

  test('CSS motion is transform / opacity / dash only and switches off under reduced motion', () => {
    const css = read('index.css');
    const block = css.slice(css.indexOf('/* Route discovery'), css.indexOf('/* Journey simulation strip'));
    for (const frames of block.match(/@keyframes [\w-]+ \{[^\n]+/g)) {
      const props = [...frames.replace(/^@keyframes [\w-]+ /, '').matchAll(/([a-z-]+):/g)].map(m => m[1]);
      for (const prop of props) assert.ok(['opacity', 'transform', 'stroke-dashoffset'].includes(prop), `${prop} in ${frames}`);
    }
    assert.match(block, /@media \(prefers-reduced-motion: reduce\) \{\s*\.rc-disc-enter, \.rc-disc-exit, \.rc-disc-flow, \.rc-disc-node, \.rc-disc-halo, \.rc-results-enter \{ animation: none !important; \}/);
  });
});

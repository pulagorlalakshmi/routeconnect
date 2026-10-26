// Production behaviour against a hosted backend that sleeps (Render free tier) behind the Vercel /api rewrite:
// stop search times out and reports a waking/failed server instead of "no match", answers are cached, Train availability
// follows scheduled-train capability only, and the capability poll stops once nothing more can change.
// Server answers are TEST FIXTURES ONLY.
import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { bundle, sourceRoot } from './harness.js';

globalThis.localStorage = { getItem: () => null, setItem: () => {}, removeItem: () => {} };

const ui = bundle(`
  import { createElement } from 'react';
  import { renderToStaticMarkup } from 'react-dom/server';
  import PreferenceModal from './components/PreferenceModal';
  export * as service from './services/planService';
  export * as caps from './services/capabilities';
  export * as prefs from './utils/travelPreferences';
  export { SUGGESTION_MESSAGES, SUGGESTIONS_RETRY_DELAYS_MS } from './components/LocationInput';
  export const renderModal = props => renderToStaticMarkup(createElement(PreferenceModal, { open: true, initial: { modes: [], ranking: 'best' }, onConfirm: () => {}, onClose: () => {}, ...props }));
`, 'production');

const { service, caps, prefs } = ui;
const read = (...parts) => readFileSync(path.join(sourceRoot, ...parts), 'utf8');
const strip = markup => markup.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const place = name => ({ id: `place:${name}`, name, lat: 16.5, lon: 80.6, stopCount: 1, services: 10, matchedBy: 'prefix' });

let realFetch;
beforeEach(() => { realFetch = globalThis.fetch; service.clearPlacesCache(); });
afterEach(() => { globalThis.fetch = realFetch; });

describe('API base: relative /api, routed by the Vercel rewrite', () => {
  test('vercel.json proxies /api to the Express backend over HTTPS (no mixed content, no CORS)', () => {
    const config = JSON.parse(readFileSync(path.join(sourceRoot, '..', 'vercel.json'), 'utf8'));
    const rule = config.rewrites.find(r => r.source === '/api/:path*');
    assert.match(rule.destination, /^https:\/\/[^/]+\.onrender\.com\/api\/:path\*$/);
  });

  test('frontend calls stay same-origin: no localhost or hard-coded backend host in shipped code', () => {
    for (const file of ['services/planService.ts', 'services/capabilities.ts', 'services/railExplorer.ts', 'context/AuthContext.tsx']) {
      assert.doesNotMatch(read(file), /localhost|127\.0\.0\.1|onrender\.com/, file);
    }
  });
});

describe('stop search', () => {
  test('returns the server places and caches them per query', async () => {
    let calls = 0;
    globalThis.fetch = async url => { calls++; assert.match(String(url), /^\/api\/v2\/places\?query=Vija&limit=8$/); return json({ places: [place('Vijayawada')] }); };
    assert.deepEqual((await service.fetchPlaces('Vija')).map(p => p.name), ['Vijayawada']);
    assert.deepEqual((await service.fetchPlaces(' vija ')).map(p => p.name), ['Vijayawada']);
    assert.equal(calls, 1);
  });

  test('a server that does not answer times out with TIMEOUT instead of hanging', async () => {
    globalThis.fetch = (url, { signal }) => new Promise((_, reject) => signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' }))));
    await assert.rejects(service.fetchPlaces('Guntur', undefined, { timeoutMs: 20 }), e => e instanceof service.PlacesError && e.code === 'TIMEOUT');
  });

  test('timetable still loading (503) and network failures are errors, never "no match"; failures are not cached', async () => {
    globalThis.fetch = async () => json({ error: 'Transit data is not available.' }, 503);
    await assert.rejects(service.fetchPlaces('Tenali'), e => e.code === 'UNAVAILABLE');
    globalThis.fetch = async () => { throw new TypeError('Failed to fetch'); };
    await assert.rejects(service.fetchPlaces('Tenali'), e => e.code === 'OFFLINE');
    globalThis.fetch = async () => json({ places: [place('Tenali')] });
    assert.equal((await service.fetchPlaces('Tenali')).length, 1);
  });

  test('a superseded request is aborted and reported as an abort, not a failure', async () => {
    globalThis.fetch = (url, { signal }) => new Promise((_, reject) => signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' }))));
    const controller = new AbortController();
    const pending = service.fetchPlaces('Narasaraopet', controller.signal);
    controller.abort();
    await assert.rejects(pending, e => e.name === 'AbortError');
  });

  test('searchPlaces keeps its lenient contract for the dashboard: a failure reads as no match', async () => {
    globalThis.fetch = async () => json({}, 500);
    assert.deepEqual(await service.searchPlaces('Guntur'), []);
  });

  test('the suggestion list distinguishes searching, waking, failed and empty; retries are bounded', () => {
    const m = ui.SUGGESTION_MESSAGES;
    assert.equal(new Set([m.loading, m.waking, m.error, m.empty]).size, 4);
    assert.match(m.waking, /waking/i);
    assert.doesNotMatch(m.error, /No matching stop/);
    assert.ok(ui.SUGGESTIONS_RETRY_DELAYS_MS.length >= 1 && ui.SUGGESTIONS_RETRY_DELAYS_MS.length <= 4);
    assert.match(read('components', 'LocationInput.tsx'), /warmUpServer\(\)/);
  });
});

describe('Train availability follows scheduled trains, not the estimated explorer', () => {
  const live = (train, estimatedRail) => caps.capabilitiesFromResponse({ modes: { bus: { available: true }, train }, estimatedRail });

  test('RailRadar ready + explorer failed: Train is a scheduled, selectable choice', () => {
    const value = live({ available: true, provider: 'railradar', sourceName: 'RailRadar' }, { available: false, state: 'failed', reason: 'The railway network could not be prepared on the server.' });
    assert.deepEqual(value.availableModes, ['bus', 'train']);
    const train = prefs.travelChoicesFor({ availableModes: value.availableModes, estimatedRail: value.estimatedRail }).find(c => c.id === 'train');
    assert.deepEqual([train.available, train.view, train.modes], [true, 'planned', ['train']]);
    const text = strip(ui.renderModal({ availableModes: value.availableModes, trainSourceName: 'RailRadar', estimatedRail: value.estimatedRail }));
    assert.doesNotMatch(text, /UNAVAILABLE|could not be prepared/i);
  });

  test('no scheduled source: the note gives the scheduled-train reason, not the explorer failure', () => {
    const value = live({ available: false, reason: 'Scheduled train search is not set up on this server yet (no RailRadar key is configured).' }, { available: false, state: 'failed', reason: 'The railway network could not be prepared on the server.' });
    const text = strip(ui.renderModal({ availableModes: value.availableModes, trainReason: value.train.reason, estimatedRail: value.estimatedRail }));
    assert.match(text, /no RailRadar key is configured/);
    assert.doesNotMatch(text, /could not be prepared/);
  });

  test('the capability poll stops once the explorer state can no longer change by itself', () => {
    assert.equal(caps.capabilitiesSettled(live({ available: true }, { available: false, state: 'failed' })), true);
    assert.equal(caps.capabilitiesSettled(live({ available: false }, { available: false, state: 'preparing' })), false);
    assert.equal(caps.capabilitiesSettled(caps.DEFAULT_CAPABILITIES), false);
  });
});

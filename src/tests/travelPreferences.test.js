// Destination UX fix, place-object swap / same-place validation, and Travel Preferences (asked in a dialog after
// "Find routes"). Three choices: Any transport, Bus, Train (estimated railway suggestions, enabled when the network is ready).
// Expected values below are written out by hand, not recomputed with the production helpers.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { bundle, sourceRoot } from './harness.js';

globalThis.localStorage = { getItem: () => null, setItem: () => {}, removeItem: () => {} };

const ui = bundle(`
  import { createElement } from 'react';
  import { renderToStaticMarkup } from 'react-dom/server';
  import SearchCard from './components/SearchCard';
  import PreferenceModal from './components/PreferenceModal';
  import RouteMotionBackdrop from './components/RouteMotionBackdrop';
  import AboutData, { DATA_POLICY_SECTIONS } from './pages/AboutData';
  import { MemoryRouter } from 'react-router-dom';
  import { AuthProvider } from './context/AuthContext';
  import LocationInput, { quickActionsFor } from './components/LocationInput';
  export * as places from './utils/locationValue';
  export * as prefs from './utils/travelPreferences';
  export const render = (Component, props) => renderToStaticMarkup(createElement(Component, props));
  export const renderRouted = (Component, props) => renderToStaticMarkup(createElement(MemoryRouter, null, createElement(AuthProvider, null, createElement(Component, props))));
  export { SearchCard, PreferenceModal, RouteMotionBackdrop, AboutData, DATA_POLICY_SECTIONS, LocationInput, quickActionsFor };
`, 'prefs');

const { places, prefs } = ui;
const strip = markup => markup.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
const read = (...parts) => readFileSync(path.join(sourceRoot, ...parts), 'utf8');
const noop = () => {};

const searchCard = extra => ui.render(ui.SearchCard, {
  from: '', to: '', date: '2026-10-20', time: '08:00', onFromChange: noop, onCurrentLocation: noop, onToChange: noop,
  onDateChange: noop, onTimeChange: noop, onSwapLocations: noop, onSearch: noop, loading: false, isValid: true, ...extra
});
const modal = (initial = { modes: [], ranking: 'best' }, extra = {}) => ui.render(ui.PreferenceModal, {
  open: true, initial, trip: { from: 'Guntur', to: 'Vijayawada', when: 'Tue, 20 Oct 2026, 08:00' }, onConfirm: noop, onClose: noop, ...extra
});
const inputsOf = markup => [...markup.matchAll(/<input[^>]*>/g)].map(m => m[0]);
const checkedValues = markup => inputsOf(markup).filter(i => /checked=""/.test(i)).map(i => /value="([^"]+)"/.exec(i)[1]);

// Real coordinates (approximate) used as independent fixtures.
const GUNTUR_BUS_STAND = { lat: 16.2991, lng: 80.4575 };
const VIJAYAWADA_PNBS = { lat: 16.5097, lng: 80.6185 };

describe('1. destination: no "current location" option', () => {
  test('only the origin offers current location; the destination offers no current location or select on map', () => {
    assert.ok(ui.quickActionsFor('origin').top.includes('current_location'));
    const destination = ui.quickActionsFor('destination');
    assert.ok(![...destination.top, ...destination.bottom].includes('current_location'));
    assert.ok(![...destination.top, ...destination.bottom].includes('select_on_map'));
  });

  test('the destination field renders no current-location control and no GPS button', () => {
    const markup = ui.render(ui.LocationInput, { kind: 'destination', label: 'To', placeholder: 'Search a place or stop', value: 'Guntur', onChange: noop });
    assert.doesNotMatch(markup, /current location/i);
    assert.doesNotMatch(markup, /aria-label="Use my current location"/);
    assert.doesNotMatch(markup, /Select on map/i);
  });

  test('the map dialog offers "Use my current location" only to the origin, and map picks still report coordinates', () => {
    const source = read('components', 'LocationInput.tsx');
    assert.match(source, /\{allowsCurrentLocation && \(\s*<button[\s\S]{0,200}onClick=\{useCurrentLocationOnGoogleMap\}/);
    assert.match(source, /\} else if \(selectedMapLocation\) \{\s*onCoordinates\?\.\(selectedMapLocation\.lat, selectedMapLocation\.lng\);/);
    assert.match(source, /if \(e\.key === 'Enter' && allowsCurrentLocation\)/, 'typing "current location" + Enter in To does nothing special');
  });
});

describe('2/3. place objects: swap and same-place validation', () => {
  const guntur = { text: 'Guntur Bus Stand', coords: GUNTUR_BUS_STAND };
  const vijayawada = { text: 'Vijayawada PNBS', coords: VIJAYAWADA_PNBS };

  test('swap moves the whole place objects, coordinates included', () => {
    const swapped = places.swapPlaces({ from: guntur, to: vijayawada });
    assert.equal(swapped.from, vijayawada);
    assert.equal(swapped.to, guntur);
    assert.deepEqual(swapped.to.coords, { lat: 16.2991, lng: 80.4575 });
    const back = places.swapPlaces(swapped);
    assert.equal(back.from, guntur);
    assert.equal(back.to, vijayawada);
  });

  test('swapping a GPS origin carries its coordinates to To', () => {
    const gps = { text: '📍 Current Location', coords: { lat: 16.3, lng: 80.45 } };
    const swapped = places.swapPlaces({ from: gps, to: vijayawada });
    assert.deepEqual(swapped.to, { text: '📍 Current Location', coords: { lat: 16.3, lng: 80.45 } });
  });

  test('coordinates decide when both sides have them', () => {
    // ~30 m apart: same stop picked two ways
    assert.equal(places.isSamePlace(guntur, { text: 'Pinned Location (16.2993, 80.4577)', coords: { lat: 16.2993, lng: 80.4577 } }), true);
    // same name, different towns: NOT the same place
    assert.equal(places.isSamePlace({ text: 'RTC Bus Stand', coords: GUNTUR_BUS_STAND }, { text: 'RTC Bus Stand', coords: VIJAYAWADA_PNBS }), false);
    assert.equal(places.isSamePlace(guntur, vijayawada), false);
    // ~500 m apart: different places
    assert.equal(places.isSamePlace(guntur, { text: 'x', coords: { lat: 16.3036, lng: 80.4575 } }), false);
  });

  test('text decides only when coordinates are missing, ignoring case, spacing and the pin emoji', () => {
    assert.equal(places.isSamePlace({ text: 'guntur  bus stand', coords: null }, guntur), true);
    assert.equal(places.isSamePlace({ text: '📍 Current Location', coords: null }, { text: 'current location', coords: null }), true);
    assert.equal(places.isSamePlace({ text: 'Guntur', coords: null }, { text: 'Tenali', coords: null }), false);
    assert.equal(places.isSamePlace({ text: '', coords: null }, { text: '', coords: null }), false);
  });

  test('editing text drops stale coordinates, except while it still says current location', () => {
    assert.deepEqual(places.editPlaceText(guntur, 'Guntur Bus Stan'), { text: 'Guntur Bus Stan', coords: null });
    const gps = { text: '📍 Current Location', coords: { lat: 1, lng: 2 } };
    assert.equal(places.editPlaceText(gps, '📍 Current Location'), gps);
    assert.deepEqual(places.editPlaceText(gps, 'current location').coords, { lat: 1, lng: 2 });
  });

  test('the dashboard validates with isSamePlace and keeps both places in one state object', () => {
    const source = read('pages', 'Dashboard.tsx');
    assert.match(source, /isSamePlace\(places\.from, places\.to\)/);
    assert.match(source, /setPlaces\(prev => swapPlaces\(prev\)\)/);
    assert.doesNotMatch(source, /from\.trim\(\)\.toLowerCase\(\) !== to\.trim\(\)\.toLowerCase\(\)/, 'no display-text-only comparison');
  });
});

describe('4. the search form asks only the essentials', () => {
  test('From, To, Date and one "Find routes" button; no preferences on the form', () => {
    const markup = searchCard();
    assert.match(strip(markup), /^Plan your journey From To Date Find routes$/);
    assert.doesNotMatch(markup, /preferences|Depart after/i);
    assert.equal((markup.match(/<input /g) || []).length, 3);
    assert.doesNotMatch(read('components', 'SearchCard.tsx'), /TravelPreferences|onPreferencesChange/);
  });

  test('"Find routes" validates, then opens the preference dialog; only a finished search navigates', () => {
    const source = read('pages', 'Dashboard.tsx');
    const search = source.slice(source.indexOf('const handleSearch'), source.indexOf('const startSearch'));
    assert.match(search, /setPending\(\{/);
    assert.doesNotMatch(search, /navigate\(/, 'no navigation before preferences are confirmed');
    const run = source.slice(source.indexOf('const startSearch'), source.indexOf('const handleConfirmPreferences'));
    assert.match(run, /writePreferenceParams\(preferences, new URLSearchParams\(baseParams\), capabilities\.availableModes\)/);
    assert.match(run, /runPlanSearch\([\s\S]*\.then\([\s\S]*navigate\(`\/search-results\?/, 'navigation only after the real request resolves');
    assert.match(source, /<PreferenceModal[\s\S]{0,200}open=\{pending !== null\}/);
  });
});

describe('4. preference dialog', () => {
  test('closed: renders nothing', () => {
    assert.equal(ui.render(ui.PreferenceModal, { open: false, initial: { modes: [], ranking: 'best' }, onConfirm: noop, onClose: noop }), '');
  });

  test('an accessible modal dialog with a title, the trip, and three actions', () => {
    const markup = modal();
    assert.match(markup, /role="dialog"[^>]*aria-modal="true"/);
    const titleId = /aria-labelledby="([^"]+)"/.exec(markup)[1];
    assert.ok(markup.includes(`id="${titleId}"`));
    assert.match(markup, />Any preferences\?</);
    const text = strip(markup);
    assert.match(text, /Guntur Vijayawada · Tue, 20 Oct 2026, 08:00/);
    assert.match(text, /Skip — any transport Back Show routes$/);
    assert.match(markup, /aria-label="Back to search"/);
  });

  test('three travel choices; Any transport is the default; Train is disabled while the railway network is not ready', () => {
    const markup = modal();
    assert.match(strip(markup), /Travel by Any transport .* Bus .* Train Unavailable/);
    assert.doesNotMatch(strip(markup), /Coming soon|Scheduled train|Estimated rail/);
    const modeInputs = inputsOf(markup).filter(i => /type="radio"/.test(i) && /value="(any|bus|train)"/.test(i));
    assert.equal(modeInputs.length, 3);
    const byValue = Object.fromEntries(modeInputs.map(i => [/value="([^"]+)"/.exec(i)[1], i]));
    assert.match(byValue.any, /checked=""/);
    assert.doesNotMatch(byValue.bus, /disabled=""|checked=""/);
    assert.match(byValue.train, /disabled=""/);
    assert.doesNotMatch(byValue.train, /checked=""/);
    assert.match(byValue.train, /aria-describedby="[^"]+-train-note"/);
    assert.match(strip(markup), /Train: Train suggestions are not available right now\. Bus search still works\./);
  });

  test('pre-fills the remembered choice', () => {
    assert.deepEqual(checkedValues(modal({ modes: ['bus'], ranking: 'fastest' })), ['bus', 'fastest']);
  });

  test('a remembered train choice cannot come back selected', () => {
    assert.deepEqual(checkedValues(modal({ modes: ['train'], ranking: 'best' })), ['any', 'best']);
    assert.deepEqual(checkedValues(modal({ modes: ['bus', 'train'], ranking: 'cost' })), ['any', 'cost']);
  });

  test('four ranking choices, Best overall by default', () => {
    const markup = modal();
    assert.match(strip(markup), /Show first Best overall Fastest Lowest estimated cost Fewest transfers/);
    const ranks = inputsOf(markup).filter(i => /value="(best|fastest|cost|transfers)"/.test(i));
    assert.equal(ranks.length, 4);
    assert.match(ranks.find(i => /checked=""/.test(i)), /value="best"/);
  });

  test('keyboard and focus: Escape closes, Tab is trapped, the page behind is inert and does not scroll', () => {
    const source = read('components', 'PreferenceModal.tsx');
    assert.match(source, /event\.key === 'Escape'[\s\S]{0,80}onCloseRef\.current\(\)/);
    assert.match(source, /event\.key !== 'Tab'/);
    assert.match(source, /setAttribute\('inert', ''\)/);
    assert.match(source, /document\.body\.style\.overflow = 'hidden'/);
    assert.match(source, /opener\?\.focus\?\.\(\)/, 'focus returns to the button that opened it');
    assert.match(source, /createPortal\(content, document\.body\)/);
  });

  test('"Skip" and an unavailable selection both fall back to No preference', () => {
    const source = read('components', 'PreferenceModal.tsx');
    assert.match(source, /onConfirm\(\{ \.\.\.DEFAULT_PREFERENCES, modes: \[\] \}, \{ view: 'planned' \}\)/);
    // An unavailable choice can never be the selection: it falls back to the first choice (No preference).
    assert.match(source, /choices\.find\(c => c\.id === choiceId && c\.available\) \?\? choices\[0\]/);
  });
});

describe('6. dialog motion is light and respects reduced motion', () => {
  test('the backdrop is decorative SVG; moving vehicles only render when motion is allowed', () => {
    const still = ui.render(ui.RouteMotionBackdrop, { animate: false });
    const moving = ui.render(ui.RouteMotionBackdrop, { animate: true });
    assert.match(still, /aria-hidden="true"/);
    assert.doesNotMatch(still, /animateMotion/);
    assert.equal((moving.match(/<animateMotion/g) || []).length, 4);
    assert.ok((moving.match(/<path/g) || []).length <= 10, 'a handful of elements');
  });

  test('CSS animates only transform, opacity and stroke-dashoffset, and switches everything off under reduced motion', () => {
    const css = read('index.css');
    const block = css.slice(css.indexOf('@keyframes rc-pref-fade'));
    for (const frames of block.match(/@keyframes rc-pref-[\w-]+ \{[^\n]+/g)) {
      const props = [...frames.replace(/^@keyframes [\w-]+ /, '').matchAll(/([a-z-]+):/g)].map(m => m[1]);
      for (const prop of props) assert.ok(['opacity', 'transform', 'stroke-dashoffset'].includes(prop), `${prop} in ${frames}`);
    }
    assert.match(block, /@media \(prefers-reduced-motion: reduce\)[\s\S]*rc-pref-dialog[\s\S]*animation: none !important[\s\S]*\.rc-pref-mover \{ display: none; \}/);
  });
});

describe('5. results page and Data & policies page', () => {
  const results = () => read('pages', 'SearchResults.tsx');

  test('"About this data" is no longer an accordion on the results page; a link opens the policy page', () => {
    assert.doesNotMatch(results(), /<details|About this data/);
    assert.match(results(), /<Link\s+to="\/about-data"[\s\S]{0,300}Data &amp; policies/);
  });

  test('a subtle preference / sort line sits under the search summary', () => {
    assert.match(results(), /Preference: \{modeSummary\(preferences\.modes\)\} · Sorted by: \{SORT_LABEL\[sortBy\]\}/);
  });

  test('notes about this particular search stay on the results page as one-line notices', () => {
    assert.match(results(), /SEARCH_SPECIFIC_INFO = new Set\(\['ORIGIN_DESTINATION_WALKABLE', 'SEARCH_WINDOW_EXPANDED', 'LOCAL_RIDE_HEAVY', 'RAIL_SCHEDULED_ONLY', 'MIXED_ONLY'\]\)/);
  });

  test('routes: /about-data renders the page, /policies redirects to it, and the navbar links to it', () => {
    const app = read('App.tsx');
    assert.match(app, /path="\/about-data" element=\{<AboutData \/>\}/);
    assert.match(app, /path="\/policies" element=\{<Navigate to="\/about-data" replace \/>\}/);
    assert.match(read('components', 'Navbar.tsx'), /\{ name: 'Data & Policies', path: '\/about-data'/);
  });

  test('the page covers every required topic as its own titled section', () => {
    assert.deepEqual(ui.DATA_POLICY_SECTIONS.map(s => s.title), [
      'About the route data', 'Timetable accuracy', 'Data sources', 'Fare estimates', 'Local ride estimates',
      'Live tracking', 'Train availability', 'Train suggestions (estimated)', 'Privacy & external links', 'Our promise'
    ]);
    const markup = ui.renderRouted(ui.AboutData, {});
    assert.equal((markup.match(/<h1/g) || []).length, 1);
    assert.equal((markup.match(/<h2 id="/g) || []).length, 10);
    for (const section of ui.DATA_POLICY_SECTIONS) assert.ok(markup.includes(`href="#${section.id}"`), section.id);
  });

  test('the page is honest about trains, fares and tracking', () => {
    const text = strip(ui.renderRouted(ui.AboutData, {}));
    assert.match(text, /Train journeys are not available yet, and we never show made-up trains\./);
    assert.match(text, /No train number, name, time or fare is ever generated\./);
    assert.match(text, /Fares are approximate ranges, never exact ticket prices\./);
    assert.match(text, /It is not a live position\./);
    assert.doesNotMatch(text, /100% accurate|guaranteed|live train/i);
  });
});

describe('4. preferences: normalising, storage and URL', () => {
  test('train cannot be selected or restored; unknown values fall back to defaults', () => {
    assert.deepEqual(prefs.normalizePreferences({ modes: ['train'], ranking: 'cheapest' }), { modes: [], ranking: 'best' });
    assert.deepEqual(prefs.normalizePreferences({ modes: ['train', 'bus', 'bus', 'boat'], ranking: 'cost' }), { modes: ['bus'], ranking: 'cost' });
    assert.deepEqual(prefs.normalizePreferences(null), { modes: [], ranking: 'best' });
    assert.deepEqual(prefs.toggleMode({ modes: [], ranking: 'best' }, 'train'), { modes: [], ranking: 'best' });
    assert.deepEqual(prefs.toggleMode({ modes: [], ranking: 'best' }, 'bus'), { modes: ['bus'], ranking: 'best' });
    assert.deepEqual(prefs.toggleMode({ modes: ['bus'], ranking: 'best' }, 'bus'), { modes: [], ranking: 'best' });
  });

  test('saved and restored through storage; broken storage never throws', () => {
    const store = new Map();
    const storage = { getItem: key => store.get(key) ?? null, setItem: (key, value) => store.set(key, value) };
    prefs.savePreferences({ modes: ['bus'], ranking: 'transfers' }, storage);
    assert.equal(store.get('routeconnect.travelPreferences'), '{"modes":["bus"],"ranking":"transfers"}');
    assert.deepEqual(prefs.loadPreferences(storage), { modes: ['bus'], ranking: 'transfers' });
    store.set('routeconnect.travelPreferences', '{not json');
    assert.deepEqual(prefs.loadPreferences(storage), { modes: [], ranking: 'best' });
    const throwing = { getItem: () => { throw new Error('blocked'); }, setItem: () => { throw new Error('blocked'); } };
    assert.deepEqual(prefs.loadPreferences(throwing), { modes: [], ranking: 'best' });
    assert.doesNotThrow(() => prefs.savePreferences({ modes: ['bus'], ranking: 'best' }, throwing));
    assert.deepEqual(prefs.loadPreferences(null), { modes: [], ranking: 'best' });
  });

  test('URL: defaults add nothing; choices round-trip; a linked train preference is ignored', () => {
    assert.equal(prefs.writePreferenceParams({ modes: [], ranking: 'best' }, new URLSearchParams('from=A')).toString(), 'from=A');
    assert.equal(prefs.writePreferenceParams({ modes: ['bus'], ranking: 'cost' }, new URLSearchParams()).toString(), 'modes=bus&rank=cost');
    assert.deepEqual(prefs.readPreferenceParams(new URLSearchParams('modes=bus&rank=fastest')), { modes: ['bus'], ranking: 'fastest' });
    assert.deepEqual(prefs.readPreferenceParams(new URLSearchParams('modes=train')), { modes: [], ranking: 'best' });
  });

  test('summaries distinguish no preference from Bus only', () => {
    assert.equal(prefs.modeSummary([]), 'Any transport');
    assert.equal(prefs.modeSummary(['bus']), 'Bus only');
    assert.equal(prefs.preferencesSummary({ modes: [], ranking: 'cost' }), 'Any transport · Lowest estimated cost');
    assert.deepEqual(prefs.MODE_CHOICES.map(c => [c.id, c.available]), [['any', true], ['bus', true], ['train', false], ['bus_train', false]]);
    assert.equal(prefs.modeChoiceOf(['bus']).id, 'bus');
    assert.equal(prefs.modeChoiceOf([]).id, 'any');
    assert.equal(prefs.modeChoiceOf(['train', 'bus']).id, 'bus_train');
  });
});

describe('5/8. mode filtering (hard constraint)', () => {
  const walk = { mode: 'walk' };
  const ride = { mode: 'local_ride' };
  const bus = { mode: 'bus' };
  const rail = { mode: 'rail' };
  const air = { mode: 'air' };

  test('Bus only keeps bus journeys, including walking / local-ride access and egress', () => {
    assert.equal(prefs.journeyMatchesModes({ legs: [ride, bus, walk, bus, walk] }, ['bus']), true);
    assert.equal(prefs.journeyMatchesModes({ legs: [walk, bus, rail, ride] }, ['bus']), false);
    assert.equal(prefs.journeyMatchesModes({ legs: [ride, air, ride] }, ['bus']), false);
  });

  test('no preference keeps every journey', () => {
    for (const legs of [[bus], [ride, rail, ride], [air]]) assert.equal(prefs.journeyMatchesModes({ legs }, []), true);
  });

  test('the results page applies the filter before the user filters and maps "Show first" to the initial sort', () => {
    const source = read('pages', 'SearchResults.tsx');
    assert.match(source, /journeyMatchesModes\(journey, preferences\.modes\)/);
    assert.match(source, /best: 'recommended', fastest: 'fastest', cost: 'cost', transfers: 'transfers'/);
    assert.match(source, /const sortBy: SortKey = viewSort \?\? SORT_FOR_RANKING\[preferences\.ranking\];/, 'the sort follows the URL preference, not a value frozen at mount');
    assert.match(source, /Show every available mode/);
  });
});

describe('8. lowest estimated cost never favours an unpriced journey', () => {
  const fare = (min, max, complete = true) => ({ fareEstimate: { min, max, currency: 'INR', confidence: 'estimated', complete, components: [], unknownComponents: [] } });
  const journeys = {
    a: fare(140, 210),   // midpoint 175
    b: fare(60, 90),     // midpoint 75
    c: { fareEstimate: null },
    d: fare(20, 30, false), // looks cheapest but part of it is unpriced
    e: fare(100, 120)    // midpoint 110
  };

  test('priced journeys ascend by estimate; incomplete or missing estimates go last', () => {
    const order = Object.keys(journeys).sort((x, y) => prefs.compareEstimatedCost(journeys[x], journeys[y]));
    assert.deepEqual(order.slice(0, 3), ['b', 'e', 'a']);
    assert.deepEqual(new Set(order.slice(3)), new Set(['c', 'd']));
  });

  test('comparable fare is the midpoint of a complete estimate only', () => {
    assert.equal(prefs.comparableFare(journeys.a), 175);
    assert.equal(prefs.comparableFare(journeys.c), null);
    assert.equal(prefs.comparableFare(journeys.d), null);
  });
});

describe('24/25. responsive and accessible', () => {
  test('every dialog control has a label; groups use fieldset + legend', () => {
    const markup = modal();
    for (const id of [...markup.matchAll(/<input[^>]*id="([^"]+)"/g)].map(m => m[1])) {
      assert.ok(markup.includes(`for="${id}"`), `label for ${id}`);
    }
    assert.equal((markup.match(/<fieldset/g) || []).length, 2);
    assert.equal((markup.match(/<legend/g) || []).length, 2);
  });

  test('phones get a bottom sheet with stacked actions; no fixed widths', () => {
    const source = read('components', 'PreferenceModal.tsx');
    assert.match(source, /items-end justify-center sm:items-center/);
    assert.match(source, /rounded-t-3xl[^"]*sm:rounded-3xl/);
    assert.match(source, /max-h-\[calc\(100dvh-1rem\)\] overflow-y-auto/);
    assert.match(source, /sticky bottom-0 grid grid-cols-2 gap-2[^"]*sm:flex/, 'actions: Show routes full width, Back + Skip side by side');
    assert.match(source, /grid grid-cols-1 gap-2 sm:grid-cols-3/);
    assert.doesNotMatch(source, /\bw-\[\d+px\]|min-w-\[\d+px\]/);
  });

  test('the policy page stacks to one column on phones', () => {
    const source = read('pages', 'AboutData.tsx');
    assert.match(source, /grid gap-4 md:grid-cols-2/);
    assert.match(source, /grid grid-cols-2 gap-2\.5 sm:grid-cols-4/);
  });
});

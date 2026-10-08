import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { bundle, sourceRoot } from './harness.js';

globalThis.localStorage = { getItem: () => null, setItem: () => {}, removeItem: () => {} };

const ui = bundle(`
  import { createElement } from 'react';
  import { renderToStaticMarkup } from 'react-dom/server';
  import TrackingTransition, { transitionStages } from './components/TrackingTransition';
  import { TrackBus, TrackerMenu, VehicleLine, BusSummaryRow } from './components/BusIdentity';
  import { APSRTC_TRACKERS, trackersForLeg } from './config/apsrtcTrackers';
  import { launchTracking, prefersReducedMotion, openTrackerUrl, isPlainClick, TRANSITION_MS, TRACKER_WINDOW_FEATURES } from './utils/trackingLaunch';
  export const render = (Component, props) => renderToStaticMarkup(createElement(Component, props));
  export { TrackingTransition, transitionStages, TrackBus, TrackerMenu, VehicleLine, BusSummaryRow, APSRTC_TRACKERS, trackersForLeg,
    launchTracking, prefersReducedMotion, openTrackerUrl, isPlainClick, TRANSITION_MS, TRACKER_WINDOW_FEATURES };
`, 'tracking');

const strip = markup => markup.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
const URLS = {
  apsrtc: 'https://apsrtclivetrack.com/',
  redbus: 'https://www.redbus.in/live-tracking/apsrtc/',
  abhibus: 'https://www.abhibus.com/apsrtc-live-track/service-no'
};
const tracker = id => ui.APSRTC_TRACKERS.find(t => t.id === id);
const leg = (extra = {}) => ({
  mode: 'bus', routeShortName: '03846', operator: 'APSRTC', serviceNumber: '03846', vehicleNumber: null, vehicleNumberSource: null,
  vehicleNumberConfidence: 'unknown', tripId: 't1', dataConfidence: 'inferred',
  tracking: { serviceNumber: '03846', vehicleNumber: null, status: 'verified', preferredProvider: 'apsrtc', checkedOn: '2026-10-08',
    providers: ['apsrtc', 'redbus', 'abhibus'].map(id => ({ id, recognized: true, availableAsExternalOption: true })) },
  fromStop: { type: 'stop', name: 'Guntur', lat: 16.3, lon: 80.45 }, toStop: { type: 'stop', name: 'Narasaraopet', lat: 16.2, lon: 80.1 },
  ...extra
});

// A fake browser for launchTracking: records copies, opens and timers; nothing real happens.
function fakeEnv({ reducedMotion = false, copyOk = true } = {}) {
  const log = { copied: [], opened: [], scheduled: [], cancelled: 0 };
  return {
    log,
    run: () => log.scheduled.splice(0).forEach(({ fn }) => fn()),
    env: {
      reducedMotion,
      copy: async text => { log.copied.push(text); return copyOk; },
      open: url => log.opened.push(url),
      schedule: (fn, ms) => { const entry = { fn, ms }; log.scheduled.push(entry); return entry; },
      cancelSchedule: entry => { log.cancelled++; log.scheduled = log.scheduled.filter(e => e !== entry); }
    }
  };
}

describe('tracker registry', () => {
  test('1. priority: APSRTC Official, then redBus, then AbhiBus', () => {
    assert.deepEqual([...ui.APSRTC_TRACKERS].sort((a, b) => a.priority - b.priority).map(t => t.name), ['APSRTC Official', 'redBus', 'AbhiBus']);
    assert.deepEqual(ui.trackersForLeg(leg()).map(t => t.id), ['apsrtc', 'redbus', 'abhibus']);
  });

  test('2. official tracker config', () => {
    assert.deepEqual({ ...tracker('apsrtc') }, { id: 'apsrtc', name: 'APSRTC Official', type: 'official', priority: 1, url: URLS.apsrtc, supportsServiceNumber: true });
  });

  test('3. redBus config', () => {
    assert.deepEqual({ ...tracker('redbus') }, { id: 'redbus', name: 'redBus', type: 'external', priority: 2, url: URLS.redbus, supportsServiceNumber: true });
  });

  test('4. AbhiBus config', () => {
    assert.deepEqual({ ...tracker('abhibus') }, { id: 'abhibus', name: 'AbhiBus', type: 'external', priority: 3, url: URLS.abhibus, supportsServiceNumber: true });
  });

  test('12. no invented query parameters or fragments on any URL', () => {
    for (const t of ui.APSRTC_TRACKERS) assert.equal(new URL(t.url).search + new URL(t.url).hash, '', t.url);
  });
});

describe('Track Bus launch', () => {
  test('5. the service number is copied at once (inside the click), and the toast is short', async () => {
    const { env, log } = fakeEnv();
    const launch = ui.launchTracking(tracker('apsrtc'), '03846', () => {}, env);
    assert.deepEqual(log.copied, ['03846'], 'copied before any timer runs');
    assert.equal(await launch.copied, 'Service 03846 copied');
  });

  test('6. the transition is shown after the click; nothing has opened yet', () => {
    const { env, log } = fakeEnv();
    const launch = ui.launchTracking(tracker('apsrtc'), '03846', () => {}, env);
    assert.equal(launch.animated, true);
    assert.deepEqual(log.opened, []);
    const markup = ui.render(ui.TrackingTransition, { serviceNumber: '03846', trackerName: 'APSRTC Official', onCancel: () => {} });
    assert.match(markup, /role="dialog"/);
    assert.match(markup, /aria-modal="true"/);
    assert.match(strip(markup), /Opening live APSRTC tracking Preparing service 03846/);
    assert.match(markup, /Cancel/);
    // Before any click the card shows only the compact control, no overlay.
    assert.doesNotMatch(ui.render(ui.TrackBus, { leg: leg() }), /role="dialog"|Preparing service/);
  });

  test('6b. the stages read: preparing, connecting, opening <tracker>', () => {
    assert.deepEqual(ui.transitionStages('03846', 'redBus'), ['Preparing service 03846', 'Connecting to live bus tracking', 'Opening redBus']);
    assert.match(strip(ui.render(ui.TrackingTransition, { serviceNumber: '03846', trackerName: 'redBus', onCancel: () => {}, initialStage: 2 })), /Opening redBus/);
  });

  test('7. external navigation happens only when the ~1 s transition ends', () => {
    const { env, log, run } = fakeEnv();
    let opened = 0;
    const launch = ui.launchTracking(tracker('apsrtc'), '03846', () => opened++, env);
    assert.equal(log.scheduled.length, 1);
    assert.equal(log.scheduled[0].ms, ui.TRANSITION_MS);
    assert.ok(ui.TRANSITION_MS >= 800 && ui.TRANSITION_MS <= 1500, `${ui.TRANSITION_MS} ms`);
    assert.deepEqual(log.opened, []);
    run();
    assert.deepEqual(log.opened, [URLS.apsrtc]);
    assert.equal(opened, 1);
    assert.equal(launch.isDone(), true);
  });

  test('cancelling (Escape / Cancel / leaving the page) before the end opens nothing', () => {
    const { env, log, run } = fakeEnv();
    const launch = ui.launchTracking(tracker('redbus'), '03846', () => assert.fail('must not open'), env);
    launch.cancel();
    run();
    assert.deepEqual(log.opened, []);
    assert.equal(log.cancelled, 1);
    launch.cancel(); // idempotent
    assert.equal(log.cancelled, 1);
  });

  test('8. reduced motion skips the transition and opens straight away', () => {
    const { env, log } = fakeEnv({ reducedMotion: true });
    const launch = ui.launchTracking(tracker('abhibus'), '03846', () => {}, env);
    assert.equal(launch.animated, false);
    assert.equal(log.scheduled.length, 0);
    assert.deepEqual(log.opened, [URLS.abhibus]);
    assert.equal(ui.prefersReducedMotion({ matchMedia: q => ({ matches: q === '(prefers-reduced-motion: reduce)' }) }), true);
    assert.equal(ui.prefersReducedMotion({ matchMedia: () => ({ matches: false }) }), false);
    assert.equal(ui.prefersReducedMotion(undefined), false);
    const css = readFileSync(path.join(sourceRoot, 'index.css'), 'utf8');
    const block = css.slice(css.indexOf('@media (prefers-reduced-motion: reduce)'));
    for (const name of ['rc-track-line', 'rc-track-bus', 'rc-track-pulse', 'rc-track-progress']) assert.ok(block.includes(`.${name}`), name);
    assert.match(block, /animation: none/);
  });

  test('9. the alternate tracker menu lists every tracker, default first, and each launches its own tracker', () => {
    const launched = [];
    const markup = ui.render(ui.TrackerMenu, { trackers: ui.trackersForLeg(leg()), serviceNumber: '03846', onLaunch: t => launched.push(t.id), onResult: () => {} });
    assert.match(strip(markup), /Track with APSRTC Official Default redBus AbhiBus/);
    assert.match(markup, /role="menu"/);
    assert.equal((markup.match(/role="menuitem"/g) || []).length, 3);
    // The chevron stays on the card so another tracker is always one click away.
    const control = ui.render(ui.TrackBus, { leg: leg() });
    assert.match(control, /aria-haspopup="menu"/);
    assert.match(control, /aria-label="Choose tracker"/);
  });

  test('10. each provider opens exactly its registry URL', () => {
    for (const id of ['apsrtc', 'redbus', 'abhibus']) {
      const { env, log, run } = fakeEnv();
      ui.launchTracking(tracker(id), '03846', () => {}, env);
      run();
      assert.deepEqual(log.opened, [URLS[id]]);
    }
  });

  test('11. nothing about the user is sent: only the bare URL, with noopener + noreferrer, and only the service number is copied', () => {
    const calls = [];
    ui.openTrackerUrl(URLS.redbus, { open: (...args) => calls.push(args) });
    assert.deepEqual(calls, [[URLS.redbus, '_blank', 'noopener,noreferrer']]);
    assert.equal(ui.TRACKER_WINDOW_FEATURES, 'noopener,noreferrer');

    const { env, log, run } = fakeEnv();
    const originalFetch = globalThis.fetch;
    let requests = 0;
    globalThis.fetch = () => { requests++; return Promise.reject(new Error('no requests')); };
    try {
      ui.launchTracking(tracker('apsrtc'), '03846', () => {}, env);
      ui.render(ui.TrackingTransition, { serviceNumber: '03846', trackerName: 'APSRTC Official', onCancel: () => {} });
      run();
    } finally { globalThis.fetch = originalFetch; }
    assert.equal(requests, 0, 'no network request during the transition');
    assert.deepEqual(log.copied, ['03846']);
    for (const url of log.opened) assert.doesNotMatch(url, /\?|#|lat|lon|user|session|token|email|03846|Guntur/i);
  });

  test('copy failure still opens the tracker and shows the number to type', async () => {
    const { env, log, run } = fakeEnv({ copyOk: false });
    const launch = ui.launchTracking(tracker('redbus'), '03846', () => {}, env);
    assert.equal(await launch.copied, 'Service number: 03846');
    run();
    assert.deepEqual(log.opened, [URLS.redbus]);
  });

  test('only a plain left click runs the transition; ctrl/cmd/shift/middle clicks keep normal link behaviour', () => {
    const base = { button: 0, metaKey: false, ctrlKey: false, shiftKey: false, altKey: false };
    assert.equal(ui.isPlainClick(base), true);
    assert.equal(ui.isPlainClick({ ...base, ctrlKey: true }), false);
    assert.equal(ui.isPlainClick({ ...base, metaKey: true }), false);
    assert.equal(ui.isPlainClick({ ...base, shiftKey: true }), false);
    assert.equal(ui.isPlainClick({ ...base, button: 1 }), false);
  });
});

describe('vehicle number and card compactness', () => {
  test('13. unknown vehicle number: the line is hidden entirely', () => {
    assert.equal(ui.render(ui.VehicleLine, { leg: leg() }), '');
    assert.doesNotMatch(strip(ui.render(ui.BusSummaryRow, { leg: leg() })), /Vehicle|not available/i);
  });

  test('14. a vehicle number is shown only with a trusted source', () => {
    const trusted = leg({ vehicleNumber: 'AP16Z0461', vehicleNumberSource: 'apsrtc', vehicleNumberConfidence: 'published' });
    assert.match(strip(ui.render(ui.VehicleLine, { leg: trusted })), /^Vehicle No\. AP16Z0461$/);
    assert.equal(ui.render(ui.VehicleLine, { leg: leg({ vehicleNumber: 'AP16Z0461', vehicleNumberSource: null }) }), '');
  });

  test('15. no registration is fabricated anywhere in the tracking UI', () => {
    const everything = ui.render(ui.BusSummaryRow, { leg: leg() }) + ui.render(ui.TrackingTransition, { serviceNumber: '03846', trackerName: 'redBus', onCancel: () => {} });
    assert.doesNotMatch(strip(everything), /\bAP\s?\d{2}\s?[A-Z]{1,2}\s?\d{3,4}\b/);
  });

  test('16. no large disclaimer block: no warning paragraphs in the control or the transition', () => {
    const text = strip(ui.render(ui.BusSummaryRow, { leg: leg() })) + strip(ui.render(ui.TrackingTransition, { serviceNumber: '03846', trackerName: 'redBus', onCancel: () => {} }));
    assert.doesNotMatch(text, /may not|might not|Why tracking|not be available|External live tracking|guarantee/i);
    assert.doesNotMatch(ui.render(ui.TrackBus, { leg: leg() }), /<p[ >]/);
  });

  test('17. Track Bus is a compact control: one small link, a chevron and a tooltip icon', () => {
    const markup = ui.render(ui.TrackBus, { leg: leg() });
    assert.equal((markup.match(/<a /g) || []).length, 1);
    assert.equal((markup.match(/<button /g) || []).length, 1);
    assert.match(markup, /text-\[11px\]/);
    assert.match(markup, /title="Tracking provided by APSRTC\/external partners\."/);
    assert.ok(markup.length < 2200, `${markup.length} chars`);
    // The transition card itself stays small.
    assert.match(ui.render(ui.TrackingTransition, { serviceNumber: '03846', trackerName: 'redBus', onCancel: () => {} }), /max-w-\[320px\]/);
  });

  test('no emojis or childish copy in the transition', () => {
    const text = strip(ui.render(ui.TrackingTransition, { serviceNumber: '03846', trackerName: 'redBus', onCancel: () => {} }));
    assert.doesNotMatch(text, /[\u{1F300}-\u{1FAFF}☀-➿]/u);
    assert.doesNotMatch(text, /!|yay|woo|hang tight/i);
  });
});

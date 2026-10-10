// The continuous journey animation: ONE progress value (0..1) drives ONE vehicle along ONE connected line.
// The model (buildTimeline / stateAt), the rAF driver and the rendered markup are tested without a browser.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { bundle, sourceRoot } from './harness.js';

const ui = bundle(`
  import { createElement } from 'react';
  import { renderToStaticMarkup } from 'react-dom/server';
  import JourneySimulation, { lineGradient } from './components/JourneySimulation';
  import { buildSimulation, buildTimeline, stateAt, createLoopDriver, layoutFractions, cameraTarget, easeCamera, LOOP_MS } from './utils/journeySimulation';
  export const render = (Component, props) => renderToStaticMarkup(createElement(Component, props));
  export { JourneySimulation, lineGradient, buildSimulation, buildTimeline, stateAt, createLoopDriver, layoutFractions, cameraTarget, easeCamera, LOOP_MS };
`, 'loop');

const read = (...parts) => readFileSync(path.join(sourceRoot, ...parts), 'utf8');
const place = (name, type = 'stop') => ({ type, name, lat: 16, lon: 80 });
const t = (hhmm, day = '09') => `2026-10-${day}T${hhmm}:00+05:30`;
const minutes = (a, b) => (Number(b.slice(0, 2)) * 60 + Number(b.slice(3)) - Number(a.slice(0, 2)) * 60 - Number(a.slice(3)));

const transit = (mode, service, from, to, dep, arr) => ({
  mode, routeId: service, routeShortName: service, operator: 'APSRTC', serviceNumber: service, tripId: `t${service}`, headsign: null,
  fromStop: place(from), toStop: place(to), departureTime: t(dep), arrivalTime: t(arr), gtfsDepartureTime: `${dep}:00`, gtfsArrivalTime: `${arr}:00`,
  serviceDate: '2026-10-09', scheduleBasis: 'published_timetable', durationSeconds: minutes(dep, arr) * 60, intermediateStopCount: 2,
  datasetId: 1, dataConfidence: 'published', timeQuality: 'exact', fare: null
});
const bus = (...args) => transit('bus', ...args);
const ride = (from, to, dep, arr) => ({
  mode: 'local_ride', kind: 'access', label: 'Estimated local ride', from: place(from, 'origin'), to: place(to), distanceMeters: 4000,
  durationSeconds: minutes(dep, arr) * 60, rideSeconds: minutes(dep, arr) * 60, pickupWaitSeconds: 0, departureTime: t(dep), arrivalTime: t(arr),
  dataConfidence: 'estimated', durationConfidence: 'estimated', providerIntegration: false, availabilityStatus: 'unknown', isRealtime: false, fare: null
});
const walk = (from, to, dep, arr) => ({
  mode: 'walk', kind: 'access', from: place(from, 'origin'), to: place(to), distanceMeters: 400, durationSeconds: minutes(dep, arr) * 60,
  departureTime: t(dep), arrivalTime: t(arr), dataConfidence: 'estimated'
});

const rideBus = { legs: [ride('Home', 'GUNTUR', '07:45', '08:00'), bus('03675', 'GUNTUR', 'NARASARAOPET', '08:10', '08:45')] };
const twoBuses = { legs: [bus('03772', 'VIJAYAWADA', 'ONGOLE', '08:00', '10:00'), bus('03551', 'ONGOLE', 'NELLORE', '10:20', '12:00')] };
const rideTwoBuses = { legs: [ride('Home', 'GUNTUR', '07:30', '07:50'), bus('03846', 'GUNTUR', 'PEDAKAKANI', '08:00', '08:15'), bus('05408', 'PEDAKAKANI', 'NARASARAOPET', '08:35', '09:15')] };
const busTrain = { legs: [bus('03772', 'GUNTUR', 'VIJAYAWADA', '06:00', '07:30'), transit('rail', '12711', 'VIJAYAWADA', 'CHENNAI', '08:00', '14:00')] };
const trainFlight = { legs: [transit('rail', '12711', 'VIJAYAWADA', 'CHENNAI', '06:00', '12:00'), transit('air', '6E101', 'CHENNAI AIRPORT', 'DELHI', '14:00', '16:30')] };
const walkBus = { legs: [walk('Home', 'GUNTUR', '07:50', '08:00'), bus('03846', 'GUNTUR', 'NARASARAOPET', '08:05', '09:00')] };
const fiveLegs = { legs: [ride('Home', 'A', '06:00', '06:15'), bus('1', 'A', 'B', '06:20', '07:00'), bus('2', 'B', 'C', '07:10', '08:00'), transit('rail', '3', 'C', 'D', '08:30', '11:00'), transit('air', '4', 'D', 'E', '12:00', '13:00')] };

const model = journey => {
  const sim = ui.buildSimulation(journey);
  return { sim, timeline: ui.buildTimeline(sim), at: p => ui.stateAt(ui.buildTimeline(sim), sim.segments, p) };
};
const sample = (journey, steps = 4000) => {
  const { sim, timeline } = model(journey);
  return Array.from({ length: steps }, (_, i) => ui.stateAt(timeline, sim.segments, i / steps));
};
const modeSequence = states => states.reduce((seq, s) => (seq.at(-1) === s.mode ? seq : [...seq, s.mode]), []);

describe('1/6. one continuous progress value', () => {
  test('position runs from the origin to the destination without a jump, over several legs', () => {
    for (const journey of [rideBus, twoBuses, rideTwoBuses, fiveLegs]) {
      const states = sample(journey);
      assert.equal(states[0].position, 0);
      assert.equal(states.at(-1).position, 1);
      for (let i = 1; i < states.length; i++) {
        const step = states[i].position - states[i - 1].position;
        assert.ok(step >= 0, 'never moves backwards within the loop');
        assert.ok(step < 0.01, `no jump (${step.toFixed(4)} at ${i})`);
      }
    }
  });

  test('state is a pure function of one progress value, and wraps modulo 1', () => {
    const { sim, timeline } = model(rideTwoBuses);
    for (const p of [0, 0.17, 0.5, 0.83]) {
      assert.deepEqual(ui.stateAt(timeline, sim.segments, p), ui.stateAt(timeline, sim.segments, p));
      assert.deepEqual(ui.stateAt(timeline, sim.segments, p + 1), ui.stateAt(timeline, sim.segments, p));
    }
  });

  test('the component has one rAF loop, one progress source and no per-leg timers', () => {
    const source = read('components', 'JourneySimulation.tsx');
    assert.equal((source.match(/requestAnimationFrame\(/g) || []).length, 1);
    assert.equal((source.match(/createLoopDriver\(/g) || []).length, 1);
    assert.equal((source.match(/setInterval|setTimeout/g) || []).length, 0);
    assert.doesNotMatch(source, /setActive|setTick|key=\{`\$\{i\}-\$\{tick\}`\}/);
  });
});

describe('2-5. seamless mode changes', () => {
  test('local ride -> bus', () => {
    assert.deepEqual(modeSequence(sample(rideBus)), ['local_ride', 'bus']);
  });
  test('bus -> bus (a transfer)', () => {
    const { sim } = model(twoBuses);
    assert.deepEqual(modeSequence(sample(twoBuses)), ['bus']);
    assert.deepEqual(sim.nodes.map(n => n.kind), ['origin', 'transfer', 'destination']);
    assert.deepEqual([...new Set(sample(twoBuses).map(s => s.segment))], [0, 1], 'the vehicle hands over from leg 0 to leg 1');
  });
  test('bus -> train', () => {
    assert.deepEqual(modeSequence(sample(busTrain)), ['bus', 'train']);
  });
  test('train -> flight, and walking -> bus', () => {
    assert.deepEqual(modeSequence(sample(trainFlight)), ['train', 'flight']);
    assert.deepEqual(modeSequence(sample(walkBus)), ['walk', 'bus']);
  });
  test('a long multi-leg journey keeps the leg order', () => {
    assert.deepEqual(modeSequence(sample(fiveLegs)), ['local_ride', 'bus', 'train', 'flight']);
  });
});

describe('8. leg order is the journey order', () => {
  test('travel phases visit the legs in order and the nodes carry the real places', () => {
    const { sim, timeline } = model(rideTwoBuses);
    const travelled = timeline.phases.filter(p => p.kind === 'travel').map(p => p.segment);
    assert.deepEqual(travelled, [0, 1, 2]);
    assert.deepEqual(sim.nodes.map(n => n.name), ['Home', 'GUNTUR', 'PEDAKAKANI', 'NARASARAOPET']);
    const positions = timeline.nodePositions;
    assert.deepEqual([...positions].sort((a, b) => a - b), positions);
    for (let i = 1; i < timeline.phases.length; i++) assert.ok(Math.abs(timeline.phases[i].from - timeline.phases[i - 1].to) < 1e-9, 'phases tile the loop');
  });
});

describe('9. transfer pauses', () => {
  test('every inner node has one short pause: stationary, at the node, already showing the next mode', () => {
    const { sim, timeline } = model(rideTwoBuses);
    const pauses = timeline.phases.filter(p => p.kind === 'pause');
    assert.equal(pauses.length, 2);
    pauses.forEach((pause, k) => {
      const ms = (pause.to - pause.from) * ui.LOOP_MS;
      assert.ok(ms >= 500 && ms <= 1100, `${ms} ms`);
      assert.equal(pause.startPos, pause.endPos);
      assert.equal(pause.startPos, timeline.nodePositions[k + 1]);
      const middle = ui.stateAt(timeline, sim.segments, (pause.from + pause.to) / 2);
      assert.equal(middle.phase, 'pause');
      assert.equal(middle.position, timeline.nodePositions[k + 1]);
      assert.equal(middle.segment, k + 1);
      assert.equal(middle.mode, sim.segments[k + 1].mode);
    });
  });

  test('the vehicle slows into a stop and speeds away from it (slow in, slow out)', () => {
    const { sim, timeline } = model(twoBuses);
    const travel = timeline.phases.find(p => p.kind === 'travel');
    const at = f => ui.stateAt(timeline, sim.segments, travel.from + (travel.to - travel.from) * f).position;
    const total = travel.endPos - travel.startPos;
    assert.ok(at(0.05) - at(0) < total * 0.05 / 1.0, 'gentle start');
    assert.ok(at(1) - at(0.95) < total * 0.05, 'gentle arrival');
    assert.ok(at(0.55) - at(0.45) > total * 0.1, 'fastest in the middle');
  });

  test('a long real wait is only ever a brief pause', () => {
    const longWait = { legs: [bus('1', 'A', 'B', '06:00', '07:00'), bus('2', 'B', 'C', '13:00', '14:00')] };
    const { timeline } = model(longWait);
    const pause = timeline.phases.find(p => p.kind === 'pause');
    assert.ok((pause.to - pause.from) * ui.LOOP_MS <= 1000.001);
  });
});

describe('5. real time maps to a short loop', () => {
  test('the loop length does not depend on the journey length', () => {
    const tiny = { legs: [bus('1', 'A', 'B', '08:00', '08:05')] };
    const huge = { legs: [bus('1', 'A', 'B', '06:00', '12:00')] };
    assert.equal(model(tiny).timeline.loopMs, ui.LOOP_MS);
    assert.equal(model(huge).timeline.loopMs, ui.LOOP_MS);
    assert.ok(ui.LOOP_MS >= 8000 && ui.LOOP_MS <= 12000);
  });

  test('time on each leg follows its duration, with a minimum so a very short leg stays visible', () => {
    const { timeline } = model({ legs: [ride('Home', 'GUNTUR', '07:58', '08:00'), bus('1', 'GUNTUR', 'B', '08:05', '14:05')] });
    const [shortLeg, longLeg] = timeline.phases.filter(p => p.kind === 'travel').map(p => (p.to - p.from) * ui.LOOP_MS);
    assert.ok(shortLeg >= 500, `short leg gets ${shortLeg} ms`);
    assert.ok(longLeg > shortLeg * 4);
    const two = model(twoBuses).timeline.phases.filter(p => p.kind === 'travel').map(p => p.to - p.from);
    assert.ok(two[0] > two[1] * 0.9 && two[0] < two[1] * 1.5, 'a 2 h leg and a 1 h 40 min leg get similar, proportional time');
  });

  test('the text values are untouched: durations and times come straight from the legs', () => {
    const journey = rideTwoBuses;
    const before = JSON.stringify(journey);
    const { sim } = model(journey);
    assert.deepEqual(sim.segments.map(s => s.durationSeconds), journey.legs.map(l => l.durationSeconds));
    assert.deepEqual(sim.nodes.map(n => n.time), [journey.legs[0].departureTime, ...journey.legs.map(l => l.arrivalTime)]);
    assert.equal(sim.nodes[2].waitSeconds, 20 * 60, 'wait before the second bus is the real gap between legs');
    assert.equal(JSON.stringify(journey), before, 'the journey is never modified');
  });
});

describe('10. the loop restarts only after the destination', () => {
  test('the destination is held and faded out before the wrap; the start fades in', () => {
    const { sim, timeline } = model(rideTwoBuses);
    const end = timeline.phases.at(-1);
    assert.equal(end.kind, 'hold-end');
    assert.equal(end.to, 1);
    assert.equal(ui.stateAt(timeline, sim.segments, end.from + 0.001).position, 1);
    assert.ok(ui.stateAt(timeline, sim.segments, 0.9999).opacity < 0.05, 'invisible when the loop wraps');
    const start = ui.stateAt(timeline, sim.segments, 0);
    assert.equal(start.position, 0);
    assert.equal(start.opacity, 0);
    assert.equal(start.phase, 'hold-start');
    // position falls only at the wrap point
    const states = sample(rideTwoBuses, 2000);
    const drops = states.filter((s, i) => i > 0 && s.position < states[i - 1].position);
    assert.equal(drops.length, 0);
  });
});

describe('3/13. the rAF driver', () => {
  const fakeFrames = () => {
    const pending = new Map();
    let id = 0;
    return {
      raf: cb => { pending.set(++id, cb); return id; },
      caf: handle => { pending.delete(handle); },
      pending,
      step(time) { const entries = [...pending]; pending.clear(); for (const [, cb] of entries) cb(time); }
    };
  };

  test('accumulates time, wraps modulo the loop, and never jumps after a long frame', () => {
    const frames = fakeFrames();
    const seen = [];
    const driver = ui.createLoopDriver({ loopMs: 10000, onFrame: p => seen.push(p), raf: frames.raf, caf: frames.caf });
    driver.start();
    frames.step(1000);          // first frame only anchors the clock
    frames.step(1016);
    frames.step(1032);
    frames.step(6000);          // a stalled tab: capped at 100 ms, not 5 s
    assert.ok(Math.abs(seen[3] - (16 + 16 + 100) / 10000) < 1e-9);
    assert.ok(seen.every(p => p >= 0 && p < 1));
  });

  test('stop() cancels the pending frame and no frame runs afterwards (unmount / off-screen / reduced motion)', () => {
    const frames = fakeFrames();
    let calls = 0;
    const driver = ui.createLoopDriver({ loopMs: 10000, onFrame: () => { calls++; }, raf: frames.raf, caf: frames.caf });
    driver.start();
    frames.step(0);
    frames.step(16);
    assert.equal(frames.pending.size, 1);
    const elapsed = driver.stop();
    assert.equal(frames.pending.size, 0, 'the pending frame is cancelled');
    frames.step(32);
    assert.equal(calls, 2);
    assert.equal(elapsed, 16);
  });

  test('resuming continues from where it stopped instead of restarting the journey', () => {
    const frames = fakeFrames();
    const seen = [];
    const first = ui.createLoopDriver({ loopMs: 10000, onFrame: p => seen.push(p), raf: frames.raf, caf: frames.caf });
    first.start();
    frames.step(0); frames.step(90); frames.step(180);
    const elapsed = first.stop();
    const second = ui.createLoopDriver({ loopMs: 10000, startElapsedMs: elapsed, onFrame: p => seen.push(p), raf: frames.raf, caf: frames.caf });
    second.start();
    frames.step(5000); frames.step(5016);
    assert.ok(seen.at(-1) > 0.018, `resumed at ${seen.at(-1)}`);
  });

  test('the component starts the driver only while visible and stops it in the effect cleanup', () => {
    const source = read('components', 'JourneySimulation.tsx');
    assert.match(source, /if \(frozen \|\| !visible\) return;/);
    assert.match(source, /elapsedMs\.current = driver\.stop\(\);\s+window\.removeEventListener\('resize', measure\);/, 'effect cleanup stops the loop and removes listeners');
    assert.match(source, /return \(\) => observer\.disconnect\(\);/);
    assert.match(source, /prefersReducedMotion\(\)/);
  });
});

describe('4/7. visual continuity and reduced motion', () => {
  const frozen = (journey, progress, extra = {}) => ui.render(ui.JourneySimulation, { journey, progress, ...extra });
  const phaseMid = (journey, kind, n = 0) => {
    const { timeline } = model(journey);
    const phase = timeline.phases.filter(p => p.kind === kind)[n];
    return (phase.from + phase.to) / 2;
  };

  test('one vehicle, one connected line: a single completed layer and a single runner at any progress', () => {
    for (const p of [0.02, 0.3, phaseMid(rideTwoBuses, 'pause'), 0.97]) {
      const markup = frozen(rideTwoBuses, p);
      assert.equal((markup.match(/data-runner/g) || []).length, 1);
      assert.equal((markup.match(/data-line="completed"/g) || []).length, 1);
      assert.equal((markup.match(/data-mode="[a-z_]+" data-icon=/g) || []).length, 0, 'no per-leg chips while the vehicle moves');
      assert.equal((markup.match(/data-active="true"/g) || []).length, 1, 'only one icon is visible at a time');
    }
  });

  test('during a transfer pause the vehicle sits on the node with the next leg\'s mode', () => {
    const { timeline } = model(rideBus);
    const pause = timeline.phases.find(p => p.kind === 'pause');
    const markup = frozen(rideBus, (pause.from + pause.to) / 2);
    const left = (timeline.nodePositions[1] * 100).toFixed(3);
    assert.match(markup, new RegExp(`data-runner="true" data-mode="bus"[^>]*style="left:${left.replace('.', '\\.')}%`));
    assert.match(markup, new RegExp(`clip-path:inset\\(0 ${(100 - timeline.nodePositions[1] * 100).toFixed(3).replace('.', '\\.')}% 0 0\\)`));
  });

  test('the completed part is a clip of the same line, and the upcoming line is a faded copy', () => {
    const markup = frozen(twoBuses, 0.5);
    assert.match(markup, /opacity-30/);
    assert.equal((markup.match(/linear-gradient/g) || []).length, 2);
    const gradients = [...markup.matchAll(/background:(linear-gradient\([^)]*\))/g)].map(m => m[1]);
    assert.equal(gradients[0], gradients[1], 'identical gradient: the two layers can never drift apart');
  });

  test('colours blend smoothly at a change of mode and the line has no gaps', () => {
    const { sim, timeline } = model(rideBus);
    const gradient = ui.lineGradient(sim.segments, timeline.nodePositions);
    assert.match(gradient, /^linear-gradient\(90deg, #E5A93D 0\.000%, #E5A93D [\d.]+%, #146B5B [\d.]+%, #146B5B 100\.000%\)$/);
    const stops = [...gradient.matchAll(/ ([\d.]+)%/g)].map(m => Number(m[1]));
    assert.deepEqual([...stops].sort((a, b) => a - b), stops, 'stops are ordered: a continuous bar');
  });

  test('reduced motion / off-screen / details strip: a static diagram that explains the journey by itself', () => {
    const markup = ui.render(ui.JourneySimulation, { journey: rideTwoBuses, animate: false });
    assert.doesNotMatch(markup, /data-runner/);
    assert.equal((markup.match(/data-icon=/g) || []).length, 3, 'one icon per leg');
    for (const text of ['20 min', '15 min', '40 min', '10 min wait', '20 min wait', 'Transfer']) assert.ok(markup.includes(text), text);
    assert.match(markup, /data-motion="off"/);
  });
});

describe('7/12. mobile', () => {
  test('width follows the number of legs and scrolls inside the card; every position is a percentage of one track', () => {
    for (const [journey, legs] of [[rideBus, 2], [rideTwoBuses, 3], [fiveLegs, 5]]) {
      const markup = ui.render(ui.JourneySimulation, { journey });
      assert.match(markup, new RegExp(`style="min-width:${legs * 168 + 32}px"`));
      assert.match(markup, /overflow-x-auto/);
      assert.doesNotMatch(markup, /left:\d+(\.\d+)?px/, 'positions never use pixels, so they stay aligned at any width');
    }
  });

  test('end labels are anchored inward so nothing clips at the card edges', () => {
    const markup = ui.render(ui.JourneySimulation, { journey: rideBus });
    assert.match(markup, /translate-x-\[-10px\] text-left/);
    assert.match(markup, /translate-x-\[calc\(-100%\+10px\)\] text-right/);
  });

  test('layout keeps every leg at least 25% of an equal share, however short', () => {
    const fractions = ui.layoutFractions([{ durationSeconds: 120 }, { durationSeconds: 21600 }, { durationSeconds: 60 }]);
    assert.ok(Math.abs(fractions.reduce((a, b) => a + b, 0) - 1) < 1e-9);
    for (const f of fractions) assert.ok(f >= 0.5 / 3 - 1e-9);
  });
});

describe('12. a scrollable strip keeps the vehicle in view', () => {
  const geometry = { originX: 20, trackWidth: 800, viewWidth: 300, maxScroll: 552 };

  test('the camera centres the vehicle, clamped at both ends (no panning on the first and last stretch)', () => {
    assert.equal(ui.cameraTarget(geometry, 0), 0);
    assert.equal(ui.cameraTarget(geometry, 0.1), 0);
    assert.equal(ui.cameraTarget(geometry, 0.5), 20 + 400 - 150);
    assert.equal(ui.cameraTarget(geometry, 1), 552);
    assert.equal(ui.cameraTarget({ ...geometry, maxScroll: 0 }, 0.5), 0, 'a strip that fits never scrolls');
    for (let p = 0; p < 1; p += 0.01) assert.ok(ui.cameraTarget(geometry, p + 0.01) >= ui.cameraTarget(geometry, p));
  });

  test('the real scroll position eases towards the target, so it never jumps (including when the loop restarts)', () => {
    let x = 552;                                  // camera at the far end when the loop wraps
    const target = ui.cameraTarget(geometry, 0);  // swings back to 0
    const path = [];
    for (let i = 0; i < 60; i++) { x = ui.easeCamera(x, target, 16); path.push(x); }
    for (let i = 1; i < path.length; i++) assert.ok(path[i - 1] - path[i] < 552 * 0.1, 'small steps');
    assert.ok(path.at(-1) < 552 * 0.05, 'it gets there within about a second');
    assert.equal(ui.easeCamera(100, 300, 0), 100);
  });

  test('the user stays in control: the camera yields after wheel / touch / pointer / key input', () => {
    const source = read('components', 'JourneySimulation.tsx');
    assert.match(source, /\['wheel', 'touchstart', 'pointerdown', 'keydown'\]/);
    assert.match(source, /now >= camera\.userUntil/);
    assert.match(source, /USER_SCROLL_GRACE_MS/);
  });
});

describe('14. nothing but the strip changed', () => {
  test('the simulation code reads legs only: no backend, routing, fare or network access', () => {
    for (const file of [['components', 'JourneySimulation.tsx'], ['utils', 'journeySimulation.ts']]) {
      const source = read(...file);
      assert.doesNotMatch(source, /backend|fetchPlan|planJourneys|rankJourneys|raptor|fetch\(|fareEstimate|leaflet|google\.maps|\.lat\b|\.lon\b/i, file.join('/'));
    }
  });
  test('no nodes or modes are invented: segments are exactly the legs (minus trivial walks)', () => {
    const withTiny = { legs: [walk('Home', 'GUNTUR', '07:59', '07:59'), ...rideBus.legs] };
    assert.equal(ui.buildSimulation(withTiny).segments.length, rideBus.legs.length);
    assert.equal(ui.buildSimulation(rideTwoBuses).nodes.length, rideTwoBuses.legs.length + 1);
  });
});

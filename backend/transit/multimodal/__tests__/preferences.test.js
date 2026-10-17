// Travel preferences must change real results: the hard mode filter, and the ranking priority applied by the shortlist
// and the order the server returns. Journeys below are TEST FIXTURES ONLY (synthetic ids, stops and times), never
// production timetable data. Expected orders are written out by hand from the fixture numbers.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { parsePreferences, journeyAllowed, comparatorFor, comparableFare, transportModeOf } from '../preferences.js';
import { buildShortlist } from '../shortlist.js';
import { handleMultimodalPlanRequest } from '../planMultimodal.js';
import { makeNetwork, daily } from '../../routing/__tests__/helpers.js';

const BASE = Date.parse('2026-10-05T07:00:00+05:30');
const iso = minutes => new Date(BASE + minutes * 60000 + 330 * 60000).toISOString().slice(0, 19) + '+05:30';

// A journey reduced to what ranking reads. `fare` = [min, max] | null | 'partial'.
function journey(id, { dep = 0, minutes, transfers = 0, fare = [90, 110], access = 'walk', legs: legModes = null, raw = null }) {
  const vehicles = legModes ?? Array.from({ length: transfers + 1 }, () => 'bus');
  const per = minutes / (vehicles.length + 1);
  const legs = [{ mode: access, kind: 'access', durationSeconds: per * 60, departureTime: iso(dep), arrivalTime: iso(dep + per) }];
  vehicles.forEach((mode, i) => legs.push({
    mode, tripId: `${id}-t${i}`, operator: 'Test Operator', operatorInfo: { name: 'Test Operator' },
    departureTime: iso(dep + per * (i + 1)), arrivalTime: iso(dep + per * (i + 2)), durationSeconds: per * 60,
    dataConfidence: 'inferred', timeQuality: 'approximate', fromStop: { name: 'x' }, toStop: { name: 'y' }
  }));
  const fareEstimate = fare === null ? null
    : fare === 'partial' ? { min: 20, max: 30, currency: 'INR', confidence: 'estimated', complete: false, components: [], unknownComponents: [{ legIndex: 0 }] }
      : { min: fare[0], max: fare[1], currency: 'INR', confidence: 'estimated', complete: true, components: [], unknownComponents: [] };
  return {
    id, labels: [], departureTime: iso(dep), arrivalTime: iso(dep + minutes), totalDurationSeconds: minutes * 60,
    walkingDurationSeconds: access === 'walk' ? per * 60 : 0, waitingDurationSeconds: 0,
    localRideDurationSeconds: access === 'local_ride' ? per * 60 : 0, localRideCount: access === 'local_ride' ? 1 : 0,
    transfers: vehicles.length - 1, transitLegCount: vehicles.length, scheduleConfidence: 'inferred', timeQuality: 'approximate',
    fareEstimate, tracking: { busLegs: vehicles.length, verifiedLegs: 0, notFoundLegs: 0, allVerified: false }, legs,
    ...(raw === null ? {} : { rating: { raw } })
  };
}

// The brief's table: A fastest, B cheapest, C direct. Different departure bands so none collapse into one cluster.
const A = () => journey('A', { dep: 0, minutes: 80, transfers: 2, fare: [230, 330] });   // 1h20, ₹280, 2 transfers
const B = () => journey('B', { dep: 75, minutes: 110, transfers: 1, fare: [80, 120] });  // 1h50, ₹100, 1 transfer
const C = () => journey('C', { dep: 150, minutes: 130, transfers: 0, fare: [140, 180] }); // 2h10, ₹160, direct
const ids = list => list.map(j => j.id);

describe('parsing', () => {
  test('modes and rank are validated; absent means no preference', () => {
    assert.deepEqual(parsePreferences({}).value, { modes: [], rank: null });
    assert.deepEqual(parsePreferences({ modes: 'train,bus,bus', rank: 'FASTEST' }).value, { modes: ['bus', 'train'], rank: 'fastest' });
    assert.equal(parsePreferences({ modes: 'boat' }).ok, false);
    assert.equal(parsePreferences({ rank: 'cheapest' }).ok, false);
    assert.equal(parsePreferences({ rank: ['best', 'fastest'] }).ok, false);
  });

  test('walking and local rides are connections, not modes', () => {
    assert.equal(transportModeOf('walk'), null);
    assert.equal(transportModeOf('local_ride'), null);
    assert.equal(transportModeOf('bus'), 'bus');
    assert.equal(transportModeOf('rail'), 'train');
    assert.equal(transportModeOf('air'), 'flight');
  });
});

describe('mode filter', () => {
  test('Bus only keeps bus journeys with walk / local-ride access, and drops any journey with a train or flight leg', () => {
    assert.equal(journeyAllowed(journey('w', { minutes: 60, access: 'local_ride' }), ['bus']), true);
    assert.equal(journeyAllowed(journey('r', { minutes: 60, legs: ['bus', 'rail'] }), ['bus']), false);
    assert.equal(journeyAllowed(journey('f', { minutes: 60, legs: ['air'] }), ['bus']), false);
    assert.equal(journeyAllowed(journey('r', { minutes: 60, legs: ['bus', 'rail'] }), []), true, 'no preference keeps everything');
  });
});

describe('ranking: each priority orders by its own metric (fixture table A / B / C)', () => {
  test('Fastest: A (1h20) → B (1h50) → C (2h10)', () => {
    assert.deepEqual(ids([C(), B(), A()].sort(comparatorFor('fastest', () => 5))), ['A', 'B', 'C']);
  });

  test('Lowest estimated cost: B (₹100) → C (₹160) → A (₹280)', () => {
    assert.deepEqual(ids([A(), C(), B()].sort(comparatorFor('cost', () => 5))), ['B', 'C', 'A']);
  });

  test('Fewest transfers: C (direct) → B (1) → A (2)', () => {
    assert.deepEqual(ids([A(), B(), C()].sort(comparatorFor('transfers', () => 5))), ['C', 'B', 'A']);
  });

  test('Best overall: highest Best Path Rating first, independent of departure order', () => {
    const rated = [journey('early', { dep: 0, minutes: 60, raw: 7.1 }), journey('mid', { dep: 60, minutes: 60, raw: 9.4 }), journey('late', { dep: 120, minutes: 60, raw: 8.2 })];
    assert.deepEqual(ids(rated.sort(comparatorFor('best'))), ['mid', 'late', 'early']);
  });

  test('a door-to-door faster journey beats one with less time on the bus', () => {
    // X: 30 min on the bus but a long local ride to reach it (100 min total); Y: 70 min bus, short walk (80 min total).
    const X = journey('X', { minutes: 100, access: 'local_ride' });
    const Y = journey('Y', { minutes: 80 });
    X.legs[1].durationSeconds = 30 * 60;
    Y.legs[1].durationSeconds = 70 * 60;
    assert.deepEqual(ids([X, Y].sort(comparatorFor('fastest', () => 5))), ['Y', 'X']);
  });

  test('access rides and walks never count as transfers', () => {
    const ride = journey('ride', { minutes: 90, access: 'local_ride' });
    const twoBus = journey('two', { minutes: 60, transfers: 1 });
    assert.equal(ride.transfers, 0);
    assert.deepEqual(ids([twoBus, ride].sort(comparatorFor('transfers', () => 5))), ['ride', 'two']);
  });

  test('missing or partial fares are never treated as ₹0: they rank last for cost', () => {
    const none = journey('none', { minutes: 50, fare: null });
    const partial = journey('partial', { minutes: 50, fare: 'partial' }); // looks like ₹25, but part is unpriced
    const priced = journey('priced', { minutes: 90, fare: [300, 400] });
    assert.equal(comparableFare(partial), null);
    assert.equal(comparableFare(none), null);
    const order = ids([none, partial, priced].sort(comparatorFor('cost', () => 5)));
    assert.equal(order[0], 'priced');
    assert.deepEqual(new Set(order.slice(1)), new Set(['none', 'partial']));
  });

  test('equal rankings are broken deterministically (next metric, then id)', () => {
    const p = journey('p', { minutes: 60, fare: [90, 110] });
    const q = journey('q', { minutes: 50, fare: [80, 120] }); // same ₹100 midpoint, faster
    const r = journey('r', { minutes: 50, fare: [80, 120] });
    assert.deepEqual(ids([p, r, q].sort(comparatorFor('cost', () => 5))), ['q', 'r', 'p']);
  });
});

describe('shortlist honours the priority', () => {
  // Five more near-identical slow direct buses that would otherwise crowd the list.
  const fillers = () => Array.from({ length: 5 }, (_, i) => journey(`F${i}`, { dep: 200 + i * 70, minutes: 140 + i, fare: [150, 190] }));

  for (const [priority, first] of [['fastest', 'A'], ['cost', 'B'], ['transfers', 'C']]) {
    test(`${priority}: ${first} leads the returned list`, () => {
      const { journeys, stats } = buildShortlist([...fillers(), C(), B(), A()], { priority });
      assert.equal(journeys[0].id, first);
      assert.equal(stats.priority, priority);
    });
  }

  test('best: returned in Best Path Rating order, and the first one carries the Best path badge', () => {
    const { journeys } = buildShortlist([...fillers(), C(), B(), A()], { priority: 'best' });
    const raws = journeys.map(j => j.rating.raw);
    assert.deepEqual(raws, [...raws].sort((x, y) => y - x));
    assert.ok(journeys[0].labels.includes('BEST_PATH'));
  });

  test('without a priority the original behaviour is kept: ordered by departure', () => {
    const { journeys, stats } = buildShortlist([...fillers(), C(), B(), A()]);
    const deps = journeys.map(j => Date.parse(j.departureTime));
    assert.deepEqual(deps, [...deps].sort((x, y) => x - y));
    assert.equal(stats.priority, null);
  });

  test('a journey worse on every metric (dominated) is never brought back by a priority', () => {
    // D: departs earlier, arrives later, costs more and changes more than B.
    const D = journey('D', { dep: 70, minutes: 140, transfers: 2, fare: [300, 360] });
    for (const priority of ['best', 'fastest', 'cost', 'transfers']) {
      assert.ok(!buildShortlist([A(), B(), C(), D], { priority }).journeys.some(j => j.id === 'D'), priority);
    }
  });

  test('badges are true of the list: Fastest = least total time, Fewest transfers = fewest changes, no cost claim on overlap', () => {
    const { journeys } = buildShortlist([A(), B(), C()], { priority: 'cost' });
    const byId = Object.fromEntries(journeys.map(j => [j.id, j]));
    assert.ok(byId.A.labels.includes('FASTEST'));
    assert.ok(byId.C.labels.includes('LEAST_TRANSFERS'));
    // B ₹80–120 vs C ₹140–180: 120 × 1.1 = 132 < 140 and < A's 230, so the claim is defensible.
    assert.ok(byId.B.labels.includes('LOWER_ESTIMATED_COST'));
    const overlapping = buildShortlist([A(), journey('B2', { dep: 75, minutes: 110, transfers: 1, fare: [120, 170] }), C()], { priority: 'cost' });
    assert.ok(!overlapping.journeys.some(j => j.labels.includes('LOWER_ESTIMATED_COST')), 'overlapping ranges: no cheaper claim');
  });
});

describe('end to end through /api/v2/plan (synthetic GTFS network)', () => {
  // Origin at stop A, destination at stop C. One direct bus (slow) and a two-bus connection via B (faster).
  const network = () => makeNetwork({
    stops: { A: [16.5, 80.0], B: [16.5, 80.05], C: [16.5, 80.1] },
    trips: [
      { id: 'DIRECT', route: '04001', service: 'ALL', times: [['A', '08:00'], ['C', '10:10']] },
      { id: 'LEG1', route: '04002', service: 'ALL', times: [['A', '08:10'], ['B', '08:40']] },
      { id: 'LEG2', route: '04003', service: 'ALL', times: [['B', '08:50'], ['C', '09:30']] }
    ],
    calendars: [daily()], agency: 'APSRTC'
  });
  const query = extra => ({ fromLat: '16.5', fromLng: '80.0', toLat: '16.5', toLng: '80.1', date: '2026-10-05', time: '07:55', windowMinutes: '120', ...extra });
  const run = (extra, sources = []) => handleMultimodalPlanRequest(query(extra), { getNetwork: network, now: new Date('2026-10-03T06:30:00Z'), sources });
  const shape = j => (j.transfers === 0 ? 'direct' : `${j.transfers + 1}-bus`);

  test('the preference reaches the server and changes the order of the same real journeys', async () => {
    const fastest = await run({ rank: 'fastest', modes: 'bus' });
    const transfers = await run({ rank: 'transfers', modes: 'bus' });
    assert.equal(fastest.status, 200);
    assert.deepEqual(fastest.body.journeys.map(shape), ['2-bus', 'direct']);
    assert.deepEqual(transfers.body.journeys.map(shape), ['direct', '2-bus']);
    assert.deepEqual(fastest.body.preferences, { modes: ['bus'], rank: 'fastest' });
    // Same journeys, only the order differs: nothing is added or invented.
    assert.deepEqual(new Set(fastest.body.journeys.map(j => j.id)), new Set(transfers.body.journeys.map(j => j.id)));
    const twoBus = fastest.body.journeys[0];
    assert.ok(twoBus.labels.includes('FASTEST'));
    assert.ok(transfers.body.journeys[0].labels.includes('LEAST_TRANSFERS'));
  });

  test('train requests cannot be served without a configured railway source', async () => {
    for (const modes of ['train', 'bus,train']) {
      const { status, body } = await run({ modes });
      assert.equal(status, 422);
      assert.equal(body.code, 'MODE_UNAVAILABLE');
      assert.equal(body.journeys, undefined, 'no journeys of any kind are substituted');
    }
  });

  test('invalid preferences are rejected, not ignored', async () => {
    assert.equal((await run({ rank: 'cheapest' })).status, 400);
    assert.equal((await run({ modes: 'bus,boat' })).status, 400);
  });

  test('Bus only does not even call a configured rail source, and says why', async () => {
    let called = false;
    const rail = { id: 'rail', label: 'Rail stub', mode: 'rail', status: () => ({ configured: true }), search: async () => { called = true; return { trunks: [] }; } };
    const { status, body } = await run({ modes: 'bus' }, [rail]);
    assert.equal(status, 200);
    assert.equal(called, false);
    assert.deepEqual(body.sources.find(s => s.id === 'rail'), { id: 'rail', label: 'Rail stub', mode: 'rail', status: 'not_applicable', message: 'Not included in your travel preferences.', count: 0, ms: 0 });
  });
});

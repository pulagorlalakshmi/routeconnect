import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { dominates, paretoFilter, generalizedCost, rankJourneys } from '../ranking.js';
import { JOURNEY_LABELS } from '../types.js';
import { ROUTING_DEFAULTS } from '../config.js';

const H = 3600;
const ranking = { transferPenaltySeconds: 900, walkingExtraWeight: 1, waitingExtraWeight: 0.5, maxJourneys: 10 };

// A journey reduced to the fields ranking looks at (hours since midnight for departure/arrival).
function journey(id, dep, arr, transfers, walk = 0, wait = 0) {
  return {
    id, labels: [], transfers,
    totalDurationSeconds: (arr - dep) * H, walkingDurationSeconds: walk, waitingDurationSeconds: wait,
    _departureSeconds: dep * H, _arrivalSeconds: arr * H
  };
}

describe('Pareto filtering', () => {
  test('15. a journey that is no better anywhere and worse somewhere is removed', () => {
    const good = journey('good', 8, 10, 0, 600);
    const dominated = journey('dominated', 8, 10.5, 1, 600); // later arrival, more transfers, same walking
    const other = journey('tradeoff', 8, 9.5, 2, 600);       // faster but more transfers: not dominated
    const kept = paretoFilter([good, dominated, other]).map(j => j.id);
    assert.deepEqual(kept.sort(), ['good', 'tradeoff']);
    assert.equal(dominates(good, dominated), true);
    assert.equal(dominates(dominated, good), false);
    assert.equal(dominates(good, other), false);
    assert.equal(dominates(other, good), false);
  });

  test('leaving later with the same arrival dominates (less time spent at the origin)', () => {
    const early = journey('early', 8, 9, 0);
    const late = journey('late', 8.5, 9, 0);
    assert.deepEqual(paretoFilter([early, late]).map(j => j.id), ['late']);
  });

  test('equal journeys do not eliminate each other', () => {
    assert.equal(paretoFilter([journey('a', 8, 9, 0), journey('b', 8, 9, 0)]).length, 2);
  });

  test('different departures with later arrivals are kept as alternatives', () => {
    assert.equal(paretoFilter([journey('a', 8, 9, 0), journey('b', 9, 10, 0)]).length, 2);
  });
});

describe('winners', () => {
  // Costs (ranking weights above):
  //   J1: 7200 + 0*900 + 600*1 + 0       = 7800   (0 transfers)
  //   J3: 5400 + 2*900 + 600*1 + 1800/2  = 8700   (fastest, 2 transfers)
  //   J4: 6600 + 1*900 + 0     + 0       = 7500   (balanced)
  const j1 = journey('J1', 8, 10, 0, 600);
  const j2 = journey('J2', 8, 10.5, 1, 600);          // dominated by J1
  const j3 = journey('J3', 8, 9.5, 2, 600, 1800);
  const j4 = journey('J4', 8, 9 + 50 / 60, 1, 0);
  const ranked = rankJourneys([j1, j2, j3, j4], ranking);

  test('generalized cost is duration + transfer, walking and waiting penalties from config', () => {
    assert.equal(generalizedCost(j1, ranking), 7800);
    assert.equal(generalizedCost(j3, ranking), 8700);
    assert.equal(generalizedCost(j4, ranking), 7500);
    assert.equal(generalizedCost(j4, { ...ranking, transferPenaltySeconds: 0 }), 6600);
  });

  test('16. FASTEST is the shortest door-to-door duration', () => {
    assert.equal(ranked.winners.fastest, 'J3');
    assert.deepEqual(ranked.journeys.find(j => j.id === 'J3').labels.includes(JOURNEY_LABELS.FASTEST), true);
  });

  test('17. LEAST_TRANSFERS is the journey with the fewest transfers', () => {
    assert.equal(ranked.winners.leastTransfers, 'J1');
    assert.ok(ranked.journeys.find(j => j.id === 'J1').labels.includes(JOURNEY_LABELS.LEAST_TRANSFERS));
  });

  test('18. BEST_BALANCED minimises the generalized cost', () => {
    assert.equal(ranked.winners.bestBalanced, 'J4');
    assert.ok(ranked.journeys.find(j => j.id === 'J4').labels.includes(JOURNEY_LABELS.BEST_BALANCED));
  });

  test('the dominated journey is dropped and the weights decide the balanced winner', () => {
    assert.equal(ranked.journeys.find(j => j.id === 'J2'), undefined);
    assert.equal(ranked.stats.dominatedRemoved, 1);
    const penaliseTransfers = rankJourneys([j1, j3, j4], { ...ranking, transferPenaltySeconds: 5000 });
    assert.equal(penaliseTransfers.winners.bestBalanced, 'J1');
  });

  test('one journey can carry several labels', () => {
    const only = rankJourneys([journey('solo', 8, 9, 0)], ranking);
    assert.deepEqual(only.journeys[0].labels.sort(), ['BEST_BALANCED', 'FASTEST', 'LEAST_TRANSFERS']);
  });

  test('there is no CHEAPEST label because there is no fare data', () => {
    assert.equal('CHEAPEST' in JOURNEY_LABELS, false);
    for (const item of ranked.journeys) assert.ok(!item.labels.includes('CHEAPEST'));
  });

  test('output is ordered by departure time and winners survive the maxJourneys cap', () => {
    const many = Array.from({ length: 15 }, (_, i) => journey(`m${String(i).padStart(2, '0')}`, 8 + i * 0.25, 9.5 + i * 0.25 + (i % 3) * 0.05, i % 4));
    const capped = rankJourneys([...many, j3], { ...ranking, maxJourneys: 4 });
    assert.ok(capped.journeys.length <= 4, `kept ${capped.journeys.length}`);
    for (const id of Object.values(capped.winners).filter(Boolean)) assert.ok(capped.journeys.some(j => j.id === id), `winner ${id} kept`);
    const departures = capped.journeys.map(j => j._departureSeconds);
    assert.deepEqual([...departures].sort((a, b) => a - b), departures);
  });

  test('empty input yields no winners', () => {
    assert.deepEqual(rankJourneys([], ranking).winners, { fastest: null, leastTransfers: null, bestBalanced: null, lowerEstimatedCost: null });
  });

  test('ranking weights come from configuration defaults, not hidden constants', () => {
    assert.ok(ROUTING_DEFAULTS.ranking.transferPenaltySeconds > 0);
    assert.ok(Object.isFrozen(ROUTING_DEFAULTS.ranking));
  });
});

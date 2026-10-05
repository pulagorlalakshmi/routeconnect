import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { FARE_DEFAULTS, getFareConfig } from '../fareConfig.js';
import { estimateBusFare, estimateLocalRideFare, estimateLegFare, estimateJourneyFare } from '../fareEstimator.js';
import { lowerEstimatedCostWinner, rankJourneys } from '../../routing/ranking.js';
import { JOURNEY_LABELS } from '../../routing/types.js';

const config = getFareConfig({}, {});

describe('bus fare estimation', () => {
  test('10. a bus leg gets an estimated RANGE with the unknown service class stated', () => {
    const fare = estimateBusFare({ distanceKm: 88 }, config);
    assert.equal(fare.type, 'estimated_range');
    assert.equal(fare.confidence, 'estimated');
    assert.equal(fare.basis, 'distance_model');
    assert.equal(fare.serviceClass, 'unknown');
    assert.equal(fare.currency, 'INR');
    assert.match(fare.note, /Service class is not available/);
    // 88 km x 1.15 road = 101.2 km, +/-10% = 91.1..111.3 km; x Rs1.10..1.80/km; rounded OUTWARDS to Rs5
    assert.deepEqual({ min: fare.min, max: fare.max }, { min: 100, max: 205 });
  });

  test('the range is wide enough not to pretend precision, and never names a service class', () => {
    const fare = estimateBusFare({ distanceKm: 88 }, config);
    assert.ok(fare.max / fare.min > 1.5, `range ${fare.min}-${fare.max}`);
    assert.equal(fare.serviceClass, 'unknown', 'no Express / Palle Velugu / Deluxe class is ever claimed');
    assert.ok(!/palle|express|deluxe|luxury/i.test(fare.note));
  });

  test('a minimum fare applies to very short hops', () => {
    const fare = estimateBusFare({ distanceKm: 1 }, config);
    assert.ok(fare.min >= config.busMinimumFareMin);
    assert.ok(fare.max >= config.busMinimumFareMax);
  });

  test('uncertainty is configuration: a larger percentage widens the range', () => {
    const narrow = estimateBusFare({ distanceKm: 88 }, getFareConfig({ fareUncertaintyPercent: 5 }, {}));
    const wide = estimateBusFare({ distanceKm: 88 }, getFareConfig({ fareUncertaintyPercent: 30 }, {}));
    assert.ok(wide.min < narrow.min && wide.max > narrow.max);
  });

  test('invalid or zero distance yields no estimate (never a fare of zero)', () => {
    for (const distanceKm of [0, -3, NaN, undefined]) assert.equal(estimateBusFare({ distanceKm }, config), null);
  });
});

describe('local ride fare estimation', () => {
  test('11. a generic local ride gets a range from base + per-km, with no provider named', () => {
    const fare = estimateLocalRideFare({ roadDistanceKm: 12 }, config);
    assert.equal(fare.type, 'estimated_range');
    assert.equal(fare.confidence, 'estimated');
    // 12 km +/-10% = 10.8..13.2 km; base 30..50 + 11..16/km; rounded outwards
    assert.deepEqual({ min: fare.min, max: fare.max }, { min: 145, max: 265 });
    assert.ok(!/uber|rapido|ola/i.test(JSON.stringify(fare)));
    assert.match(fare.note, /Not a provider quote/);
  });

  test('longer rides cost more; a minimum fare applies to tiny rides', () => {
    assert.ok(estimateLocalRideFare({ roadDistanceKm: 25 }, config).max > estimateLocalRideFare({ roadDistanceKm: 5 }, config).max);
    assert.ok(estimateLocalRideFare({ roadDistanceKm: 0.3 }, config).min >= config.localRideMinimumFareMin);
  });
});

describe('estimates are always honest ranges', () => {
  test('13/14. across all distances: min < max, min >= 0, no exact amount, always labelled estimated', () => {
    for (const km of [0.1, 0.5, 1, 3, 7.5, 12, 25, 60, 88, 150, 400, 900]) {
      for (const fare of [estimateBusFare({ distanceKm: km }, config), estimateLocalRideFare({ roadDistanceKm: km }, config)]) {
        assert.ok(fare.min >= 0, `min for ${km} km`);
        assert.ok(fare.min < fare.max, `range for ${km} km: ${fare.min}-${fare.max}`);
        assert.equal(fare.confidence, 'estimated');
        assert.equal(fare.type, 'estimated_range');
        assert.ok(!('amount' in fare));
        assert.equal(fare.min % config.fareRoundingStep, 0);
        assert.equal(fare.max % config.fareRoundingStep, 0);
      }
    }
  });

  test('rounding goes outwards, never inwards', () => {
    const fare = estimateBusFare({ distanceKm: 88 }, getFareConfig({ fareRoundingStep: 50 }, {}));
    assert.equal(fare.min % 50, 0);
    assert.equal(fare.max % 50, 0);
    assert.ok(fare.min <= 100.2 && fare.max >= 200.4);
  });

  test('assumptions live in named, environment-overridable config values', () => {
    assert.ok(Object.isFrozen(FARE_DEFAULTS));
    for (const key of ['busFarePerKmMin', 'busFarePerKmMax', 'localRideBaseFareMin', 'localRideBaseFareMax', 'localRidePerKmMin', 'localRidePerKmMax', 'fareUncertaintyPercent']) {
      assert.ok(Number.isFinite(FARE_DEFAULTS[key]), key);
    }
    assert.equal(getFareConfig({}, { ROUTECONNECT_FARE_BUS_FARE_PER_KM_MAX: '3' }).busFarePerKmMax, 3);
    assert.equal(getFareConfig({}, { ROUTECONNECT_FARE_BUS_FARE_PER_KM_MAX: 'junk' }).busFarePerKmMax, FARE_DEFAULTS.busFarePerKmMax);
  });
});

describe('total journey fare', () => {
  const ride = km => ({ mode: 'local_ride', kind: 'access', distanceMeters: km * 1000 });
  const bus = km => ({ mode: 'bus', distanceMeters: km * 1000 });
  const walk = { mode: 'walk', kind: 'transfer', distanceMeters: 300 };

  test('12. the total is the sum of the component ranges, with a breakdown', () => {
    const legs = [ride(12), bus(88), { ...ride(4), kind: 'egress' }];
    const total = estimateJourneyFare(legs, config);
    const parts = [estimateLocalRideFare({ roadDistanceKm: 12 }, config), estimateBusFare({ distanceKm: 88 }, config), estimateLocalRideFare({ roadDistanceKm: 4 }, config)];
    assert.equal(total.min, parts.reduce((s, p) => s + p.min, 0));
    assert.equal(total.max, parts.reduce((s, p) => s + p.max, 0));
    assert.equal(total.confidence, 'estimated');
    assert.equal(total.complete, true);
    assert.equal(total.components.length, 3);
    assert.deepEqual(total.components.map(c => c.mode), ['local_ride', 'bus', 'local_ride']);
    assert.ok(total.min < total.max);
    assert.match(total.note, /Estimated from route distance/);
  });

  test('walking is free and is not a fare component', () => {
    const withWalk = estimateJourneyFare([walk, bus(40), walk], config);
    const without = estimateJourneyFare([bus(40)], config);
    assert.equal(withWalk.min, without.min);
    assert.equal(withWalk.components.length, 1);
    assert.equal(withWalk.complete, true);
  });

  test('15. an unknown cost is NOT treated as zero: the total is marked partial and the gap is listed', () => {
    const total = estimateJourneyFare([bus(40), { mode: 'ferry', kind: null, distanceMeters: 5000 }], config);
    const busOnly = estimateBusFare({ distanceKm: 40 }, config);
    assert.equal(total.complete, false);
    assert.deepEqual(total.unknownComponents.map(u => u.mode), ['ferry']);
    assert.equal(total.min, busOnly.min, 'covers only what could be priced');
    assert.equal(total.max, busOnly.max);
    assert.match(total.note, /Partial estimate/);
    assert.equal(estimateLegFare({ mode: 'ferry', distanceMeters: 5000 }, config), null);
  });

  test('15. when nothing can be priced there is no number at all, not "0"', () => {
    const total = estimateJourneyFare([{ mode: 'ferry', distanceMeters: 1000 }], config);
    assert.equal(total.min, null);
    assert.equal(total.max, null);
    assert.equal(total.confidence, 'unknown');
    assert.equal(total.complete, false);
    assert.equal(estimateJourneyFare([walk], config), null, 'a walk-only journey has no fare to estimate');
  });

  test('a published fare, if one ever exists, is exact and labelled published; mixing it with estimates stays an estimate', () => {
    const published = { mode: 'bus', distanceMeters: 50000, publishedFare: { amount: 145 } };
    assert.deepEqual(estimateLegFare(published, config), { type: 'published', amount: 145, currency: 'INR', confidence: 'published' });
    const onlyPublished = estimateJourneyFare([published], config);
    assert.equal(onlyPublished.confidence, 'published');
    assert.equal(onlyPublished.min, 145);
    assert.equal(onlyPublished.max, 145);
    const mixed = estimateJourneyFare([published, ride(5)], config);
    assert.equal(mixed.confidence, 'estimated');
    assert.ok(mixed.min < mixed.max);
  });
});

describe('fare-based labels (conservative)', () => {
  const ranking = { transferPenaltySeconds: 900, walkingExtraWeight: 1, waitingExtraWeight: 0.5, lowerCostMinGapPercent: 10, maxJourneys: 10 };
  const journey = (id, dep, min, max, extra = {}) => ({
    id, labels: [], transfers: 0, totalDurationSeconds: 3600, walkingDurationSeconds: 0, waitingDurationSeconds: 0,
    _departureSeconds: dep * 3600, _arrivalSeconds: (dep + 1) * 3600,
    fareEstimate: min === null ? null : { min, max, currency: 'INR', confidence: 'estimated', complete: true },
    ...extra
  });

  test('there is still no CHEAPEST or BUDGET label', () => {
    assert.equal('CHEAPEST' in JOURNEY_LABELS, false);
    assert.equal('BUDGET' in JOURNEY_LABELS, false);
    assert.equal(JOURNEY_LABELS.LOWER_ESTIMATED_COST, 'LOWER_ESTIMATED_COST');
  });

  test('16. overlapping ranges get no cost label at all', () => {
    const a = journey('a', 8, 120, 180);
    const b = journey('b', 9, 150, 210);
    assert.equal(lowerEstimatedCostWinner([a, b], ranking), null);
    const ranked = rankJourneys([a, b], ranking);
    assert.equal(ranked.winners.lowerEstimatedCost, null);
    for (const j of ranked.journeys) assert.ok(!j.labels.includes('LOWER_ESTIMATED_COST'));
  });

  test('16. ranges that touch or are within the margin are not "clearly cheaper"', () => {
    assert.equal(lowerEstimatedCostWinner([journey('a', 8, 100, 140), journey('b', 9, 150, 200)], ranking), null, '140 x 1.1 = 154 > 150');
    assert.equal(lowerEstimatedCostWinner([journey('a', 8, 100, 140), journey('b', 9, 140, 200)], ranking), null);
  });

  test('17. clearly separated ranges earn "lower estimated cost" (and only the cheaper one)', () => {
    const a = journey('a', 8, 100, 140);
    const b = journey('b', 9, 240, 320);
    assert.equal(lowerEstimatedCostWinner([a, b], ranking).id, 'a');
    const ranked = rankJourneys([a, b], ranking);
    assert.equal(ranked.winners.lowerEstimatedCost, 'a');
    assert.ok(ranked.journeys.find(j => j.id === 'a').labels.includes('LOWER_ESTIMATED_COST'));
    assert.ok(!ranked.journeys.find(j => j.id === 'b').labels.includes('LOWER_ESTIMATED_COST'));
  });

  test('no claim is made when any journey lacks a complete estimate, or when there is only one journey', () => {
    assert.equal(lowerEstimatedCostWinner([journey('a', 8, 100, 140), journey('b', 9, null)], ranking), null);
    const partial = journey('b', 9, 240, 320);
    partial.fareEstimate.complete = false;
    assert.equal(lowerEstimatedCostWinner([journey('a', 8, 100, 140), partial], ranking), null);
    assert.equal(lowerEstimatedCostWinner([journey('a', 8, 100, 140)], ranking), null);
  });

  test('an uncertain fare never changes FASTEST, LEAST_TRANSFERS or BEST_BALANCED', () => {
    const quickButDear = journey('quick', 8, 400, 500, { totalDurationSeconds: 3000, _arrivalSeconds: 8 * 3600 + 3000 });
    const slowButCheap = journey('slow', 8, 50, 80, { totalDurationSeconds: 5000, _arrivalSeconds: 8 * 3600 + 5000 });
    const ranked = rankJourneys([quickButDear, slowButCheap], ranking);
    assert.equal(ranked.winners.fastest, 'quick');
    assert.equal(ranked.winners.bestBalanced, 'quick');
  });
});

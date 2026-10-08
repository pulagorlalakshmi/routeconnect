import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { rateJourneys, ratingLabel, transferScore, firstLastMileScore, scheduleScore, fareMidpoint, bestPathIds, PARAMETERS } from '../pathRating.js';
import { RATING_DEFAULTS } from '../ratingConfig.js';
import { rankJourneys } from '../../routing/ranking.js';
import { busIdentity } from '../../routing/journeyBuilder.js';
import { makeNetwork, plan, lineSpec } from '../../routing/__tests__/helpers.js';

const MIN = 60;
const ranking = { transferPenaltySeconds: 900, walkingExtraWeight: 1, waitingExtraWeight: 0.5, maxJourneys: 10 };

const fare = (min, max) => ({ min, max, currency: 'INR', confidence: 'estimated', complete: true, components: [], unknownComponents: [] });

// A journey reduced to the fields the rating reads.
function journey(id, { minutes = 120, transfers = 0, wait = 0, fareRange = fare(150, 250), legs = [], rides = 0, schedule = 'published', dep = 8 } = {}) {
  return {
    id, labels: [], transfers, totalDurationSeconds: minutes * MIN, walkingDurationSeconds: 0, waitingDurationSeconds: wait,
    localRideCount: rides, scheduleConfidence: schedule, fareEstimate: fareRange, legs,
    _departureSeconds: dep * 3600, _arrivalSeconds: dep * 3600 + minutes * MIN
  };
}
const walk = meters => ({ mode: 'walk', kind: 'access', distanceMeters: meters });
const ride = meters => ({ mode: 'local_ride', kind: 'access', distanceMeters: meters });
const rate = (list, overrides) => rateJourneys(list, overrides);

describe('rating parameters', () => {
  test('13. every score stays within 0-10', () => {
    const list = [
      journey('a', { minutes: 30, fareRange: fare(10, 20) }),
      journey('b', { minutes: 2000, transfers: 9, wait: 40 * 3600, fareRange: fare(9000, 12000), rides: 2, legs: [walk(50000), ride(90000), ride(90000)], schedule: 'unknown' }),
      journey('c', { fareRange: null })
    ];
    for (const rating of rate(list)) {
      assert.ok(rating.score >= 0 && rating.score <= 10, `overall ${rating.score}`);
      for (const key of PARAMETERS) {
        const { score } = rating.parameters[key];
        assert.ok(score === null || (score >= 0 && score <= 10), `${key} ${score}`);
      }
    }
  });

  test('14. the fastest journey scores strongly on time and slower ones score lower', () => {
    const [fast, slow, slower] = rate([journey('fast', { minutes: 100 }), journey('slow', { minutes: 150 }), journey('slower', { minutes: 300 })]);
    assert.ok(fast.parameters.time.score >= 9.5);
    assert.ok(slow.parameters.time.score < fast.parameters.time.score);
    assert.ok(slower.parameters.time.score < slow.parameters.time.score);
  });

  test('time counts the whole door-to-door duration (feeder and waiting included), not only bus time', () => {
    // total duration is what the planner computes from access + bus + waiting + egress
    const [direct, withFeeder] = rate([journey('direct', { minutes: 120 }), journey('feeder', { minutes: 180, rides: 1 })]);
    assert.ok(direct.parameters.time.score > withFeeder.parameters.time.score);
  });

  test('15. a lower estimated cost scores strongly on cost (midpoint of the range is compared)', () => {
    const [cheap, dear] = rate([journey('cheap', { fareRange: fare(100, 140) }), journey('dear', { fareRange: fare(250, 350) })]);
    assert.ok(cheap.parameters.cost.score >= 9.5);
    assert.ok(dear.parameters.cost.score < 6);
    assert.equal(fareMidpoint(journey('x', { fareRange: fare(100, 140) })), 120);
  });

  test('16. a zero-transfer option scores strongly on transfers', () => {
    assert.equal(transferScore(journey('d', { transfers: 0 })), 10);
    assert.ok(transferScore(journey('one', { transfers: 1 })) >= 8.5 && transferScore(journey('one', { transfers: 1 })) <= 9);
    assert.ok(transferScore(journey('two', { transfers: 2 })) >= 7 && transferScore(journey('two', { transfers: 2 })) <= 8);
    assert.ok(transferScore(journey('three', { transfers: 3 })) >= 5.5 && transferScore(journey('three', { transfers: 3 })) <= 7);
    assert.ok(transferScore(journey('four', { transfers: 4 })) < transferScore(journey('three', { transfers: 3 })));
  });

  test('long waiting at a transfer lowers transfer convenience', () => {
    assert.ok(transferScore(journey('w', { transfers: 1, wait: 3 * 3600 })) < transferScore(journey('n', { transfers: 1, wait: 600 })));
  });

  test('17. a long feeder reduces first/last-mile convenience, but is capped (rural trips are not crushed)', () => {
    const none = firstLastMileScore(journey('n', { legs: [walk(100)] }));
    const short = firstLastMileScore(journey('s', { rides: 1, legs: [ride(2000)] }));
    const long = firstLastMileScore(journey('l', { rides: 1, legs: [ride(25000)] }));
    const both = firstLastMileScore(journey('b', { rides: 2, legs: [ride(40000), { ...ride(40000), kind: 'egress' }] }));
    assert.ok(none > short && short > long);
    assert.ok(both >= 10 - RATING_DEFAULTS.firstLastMileMaxPenalty);
    assert.ok(short >= 7, 'a small feeder is still good');
  });

  test('18. an inferred schedule lowers schedule confidence and the overall rating', () => {
    const [published, inferred] = rate([journey('p', { schedule: 'published' }), journey('i', { schedule: 'inferred' })]);
    assert.ok(inferred.parameters.schedule.score < published.parameters.schedule.score);
    assert.ok(inferred.score < published.score);
  });

  test('19. published beats inferred beats estimated; an expired/extrapolated feed never gets 9 or 10', () => {
    const s = level => scheduleScore({ scheduleConfidence: level });
    assert.deepEqual(['live', 'verified', 'published', 'inferred', 'estimated', 'unknown'].map(s), [10, 9.5, 9, 7, 5.5, 4]);
    assert.ok(s('published') > s('inferred'));
    assert.ok(s('inferred') < 9);
  });
});

describe('missing and unknown data', () => {
  test('20. a missing fare re-normalises the weights over the remaining parameters', () => {
    const only = journey('only', { fareRange: null, minutes: 100 });
    const peer = journey('peer', { fareRange: null, minutes: 100 });
    const [rating] = rate([only, peer]);
    assert.equal(rating.parameters.cost.score, null);
    const { time, transfers, firstLastMile, schedule } = rating.parameters;
    const w = RATING_DEFAULTS.weights;
    const expected = (time.score * w.time + transfers.score * w.transfers + firstLastMile.score * w.firstLastMile + schedule.score * w.schedule) /
      (w.time + w.transfers + w.firstLastMile + w.schedule);
    assert.ok(Math.abs(rating.score - expected) <= 0.05, `${rating.score} vs ${expected}`);
  });

  test('21. an unknown or partial fare is never treated as zero (never makes a journey look cheapest)', () => {
    const [known, unknown, partial] = rate([
      journey('known', { fareRange: fare(200, 300) }),
      journey('unknown', { fareRange: null }),
      journey('partial', { fareRange: { ...fare(10, 20), complete: false } })
    ]);
    assert.equal(unknown.parameters.cost.score, null);
    assert.equal(partial.parameters.cost.score, null);
    assert.equal(known.parameters.cost.score, RATING_DEFAULTS.soleComparisonScore, 'only one comparable fare: neutral, not 10');
    assert.equal(fareMidpoint({ fareEstimate: { min: null, max: null, complete: false } }), null);
    assert.equal(fareMidpoint({ fareEstimate: fare(0, 0) }), null);
    assert.ok(unknown.reasons.some(r => r.metric === 'cost' && r.type === 'caution'));
  });

  test('22. the result is deterministic and does not mutate the input', () => {
    const list = [journey('a', { minutes: 90 }), journey('b', { minutes: 140, transfers: 1 }), journey('c', { minutes: 200, rides: 1, legs: [ride(6000)] })];
    const snapshot = JSON.stringify(list);
    assert.deepEqual(rate(list), rate(list));
    assert.equal(JSON.stringify(list), snapshot);
  });

  test('a single journey gets a neutral comparison score, never a perfect time or cost score', () => {
    const [only] = rate([journey('only')]);
    assert.equal(only.parameters.time.score, RATING_DEFAULTS.soleComparisonScore);
    assert.equal(only.parameters.cost.score, RATING_DEFAULTS.soleComparisonScore);
  });

  test('weights are configurable', () => {
    const list = [journey('fast', { minutes: 60, schedule: 'unknown' }), journey('slow', { minutes: 120, schedule: 'published' })];
    const timeHeavy = rate(list, { weights: { time: 1, cost: 0, transfers: 0, firstLastMile: 0, schedule: 0 } });
    assert.equal(timeHeavy[0].score, 10);
    assert.equal(timeHeavy[1].score, 3.5); // 10 * (60/120)^1.5
    const sum = Object.values(RATING_DEFAULTS.weights).reduce((a, b) => a + b, 0);
    assert.ok(Math.abs(sum - 1) < 1e-9);
  });
});

describe('labels', () => {
  test('professional labels follow the score bands and not every route is Excellent', () => {
    assert.deepEqual([9.4, 9.0, 8.9, 8.0, 7.9, 7.0, 6.9, 6.0, 5.9, 0].map(s => ratingLabel(s)),
      ['Excellent', 'Excellent', 'Very Good', 'Very Good', 'Good', 'Good', 'Fair', 'Fair', 'Limited', 'Limited']);
    const ratings = rate([journey('a', { minutes: 100, fareRange: fare(100, 150) }), journey('b', { minutes: 300, transfers: 3, fareRange: fare(400, 600), schedule: 'inferred' })]);
    assert.notEqual(ratings[0].label, ratings[1].label);
    assert.ok(ratings[1].label !== 'Excellent');
  });
});

describe('Best Path selection and explanations', () => {
  const list = () => [
    journey('fast', { minutes: 100, transfers: 1, fareRange: fare(200, 300), dep: 8 }),
    journey('direct', { minutes: 130, transfers: 0, fareRange: fare(150, 250), dep: 9 }),
    journey('poor', { minutes: 320, transfers: 3, wait: 7200, fareRange: fare(500, 700), schedule: 'inferred', dep: 10 })
  ];

  test('23. exactly one journey receives BEST_PATH, and it has the highest rating', () => {
    const ranked = rankJourneys(list(), ranking);
    const best = ranked.journeys.filter(j => j.labels.includes('BEST_PATH'));
    assert.equal(best.length, 1);
    assert.equal(ranked.winners.bestPath, best[0].id);
    const top = Math.max(...ranked.journeys.map(j => j.rating.raw));
    assert.equal(best[0].rating.raw, top);
  });

  test('an exact tie is the only case where two journeys share Best Path', () => {
    const twins = [journey('a'), journey('b')];
    const ratings = rate(twins);
    assert.deepEqual(bestPathIds(twins, ratings), ['a', 'b']);
    const differing = [journey('a', { minutes: 100 }), journey('b', { minutes: 101 })];
    assert.equal(bestPathIds(differing, rate(differing)).length, 1);
  });

  test('24. explanations correspond to the real metrics', () => {
    const ratings = rate(list());
    const [fast, direct, poor] = ratings;
    const texts = r => r.reasons.map(x => x.text);
    assert.ok(texts(fast).includes('Fast journey'));
    assert.ok(texts(direct).includes('No transfers'));
    assert.ok(!texts(fast).includes('No transfers'), 'a journey with a transfer never claims "No transfers"');
    assert.ok(poor.reasons.some(r => r.type === 'caution' && r.metric === 'schedule' && /inferred/i.test(r.text)));
    assert.ok(poor.reasons.some(r => r.type === 'caution' && ['time', 'cost', 'transfers'].includes(r.metric)));
    assert.ok(!poor.reasons.some(r => r.text === 'Fast journey'));
    for (const r of ratings) {
      assert.ok(r.reasons.length >= 1 && r.reasons.length <= 4);
      for (const reason of r.reasons) {
        const { score } = r.parameters[reason.metric];
        if (reason.type === 'positive') assert.ok(score >= 8.5 || reason.metric === 'transfers' || reason.metric === 'schedule', `${reason.text} ${score}`);
      }
    }
  });

  test('a local ride is reported as a caution, never as a strength', () => {
    const [rating] = rate([journey('r', { rides: 1, legs: [ride(3000)] }), journey('x', { minutes: 400 })]);
    assert.ok(rating.reasons.some(r => r.metric === 'firstLastMile' && r.type === 'caution'));
  });

  test('summary wording is friendly but never claims certainty', () => {
    for (const rating of rate(list())) {
      assert.ok(rating.summary.length > 0);
      assert.ok(!/definitely|guarantee|certain|best bus/i.test(rating.summary));
    }
  });
});

describe('bus identification (backend)', () => {
  const route = { sourceId: '03846', shortName: '03846', longName: null, agencyName: 'APSRTC' };

  test('1/2. the feed code 03846 becomes public service number 3846; it is not a vehicle number', () => {
    const id = busIdentity(route, {});
    assert.equal(id.routeId, '03846');
    assert.equal(id.routeCode, '03846');
    assert.equal(id.serviceNumber, '3846');
    assert.equal(id.operator, 'APSRTC');
    assert.notEqual(id.vehicleNumber, id.serviceNumber);
  });

  test('3/5. the vehicle number is null with unknown provenance and is never derived from the service number', () => {
    const id = busIdentity(route, { name: 'APSRTC GTFS' });
    assert.equal(id.vehicleNumber, null);
    assert.equal(id.vehicleNumberSource, null);
    assert.equal(id.vehicleNumberConfidence, 'unknown');
    assert.ok(!JSON.stringify(id).match(/\bAP\d{2}/i));
  });

  test('the operator comes only from the feed agency: no agency, no operator (even if the dataset is named APSRTC)', () => {
    assert.equal(busIdentity({ ...route, agencyName: null }, { name: 'Community APSRTC GTFS' }).operator, null);
    assert.equal(busIdentity({ ...route, agencyName: null }, { name: 'Community APSRTC GTFS' }).serviceNumber, null);
  });

  test('every transit leg of a real plan carries the identity fields and no registration number', () => {
    const spec = lineSpec();
    const result = plan(makeNetwork(spec), spec, { from: 'A', to: 'C' });
    const leg = result.journeys[0].legs[0];
    // No agency in this synthetic feed: the code is only a route code, never called a service number.
    assert.equal(leg.serviceNumber, null);
    assert.equal(leg.routeCode, leg.routeShortName);
    assert.equal(leg.operator, null);
    assert.equal(leg.vehicleNumber, null);
    assert.equal(leg.vehicleNumberSource, null);
    assert.equal(leg.vehicleNumberConfidence, 'unknown');
    assert.ok(result.journeys[0].rating && result.journeys[0].rating.score >= 0);
    assert.ok(result.journeys[0].labels.includes('BEST_PATH'));
  });
});

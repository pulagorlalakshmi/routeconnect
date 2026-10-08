// Journey ranking: Pareto filtering first (no weights), then labelled winners.
//
// Dominance is evaluated on criteria derived from the SCHEDULE and the complete door-to-door journey:
//   arrival time (earlier is better), departure time (later is better: less time at the origin),
//   number of transfers, walking duration, and local-ride duration (estimated, unverified transport).
// A journey that is no better in any criterion and strictly worse in at least one is removed.
//
// Labels: FASTEST (shortest COMPLETE door-to-door duration, including first/last mile), LEAST_TRANSFERS,
// BEST_BALANCED (lowest generalized cost), and, only when it is defensible, LOWER_ESTIMATED_COST.
// There is deliberately no CHEAPEST / BUDGET label: fares are estimated ranges, so a "cheapest" claim would
// be false precision. Fares never influence FASTEST / BEST_BALANCED, so an uncertain estimate cannot override
// timetable correctness.
import { JOURNEY_LABELS } from './types.js';
import { rateJourneys, bestPathIds } from '../rating/pathRating.js';

const rides = journey => journey.localRideDurationSeconds ?? 0;

export function dominates(a, b) {
  const aValues = [a._arrivalSeconds, -a._departureSeconds, a.transfers, a.walkingDurationSeconds, rides(a)];
  const bValues = [b._arrivalSeconds, -b._departureSeconds, b.transfers, b.walkingDurationSeconds, rides(b)];
  let strictlyBetter = false;
  for (let i = 0; i < aValues.length; i++) {
    if (aValues[i] > bValues[i]) return false;
    if (aValues[i] < bValues[i]) strictlyBetter = true;
  }
  return strictlyBetter;
}

export function paretoFilter(journeys) {
  return journeys.filter((candidate, i) => !journeys.some((other, j) => i !== j && dominates(other, candidate)));
}

// Seconds-equivalent cost: duration (which already includes first/last mile) plus penalties for transfers, walking,
// waiting and estimated local rides (whose availability is not verified).
export function generalizedCost(journey, ranking) {
  return Math.round(
    journey.totalDurationSeconds +
    journey.transfers * ranking.transferPenaltySeconds +
    journey.walkingDurationSeconds * ranking.walkingExtraWeight +
    journey.waitingDurationSeconds * ranking.waitingExtraWeight +
    (journey.localRideCount ?? 0) * (ranking.localRidePenaltySeconds ?? 0) +
    rides(journey) * (ranking.localRideExtraWeight ?? 0)
  );
}

function compareBy(keysOf) {
  return (a, b) => {
    const ka = keysOf(a);
    const kb = keysOf(b);
    for (let i = 0; i < ka.length; i++) {
      if (ka[i] < kb[i]) return -1;
      if (ka[i] > kb[i]) return 1;
    }
    return 0;
  };
}

const pickBest = (journeys, keysOf) => (journeys.length ? [...journeys].sort(compareBy(keysOf))[0] : null);

// A journey is "clearly cheaper" only if its estimated fare RANGE ends below where every other range begins, with a
// margin. Overlapping ranges (the normal case) produce no winner. Needs two or more comparable, complete estimates;
// if any journey lacks a complete estimate nothing can be claimed.
export function lowerEstimatedCostWinner(journeys, ranking) {
  if (journeys.length < 2) return null;
  const estimates = journeys.map(journey => journey.fareEstimate);
  if (estimates.some(e => !e || !e.complete || e.confidence === 'unknown' || !Number.isFinite(e.min) || !Number.isFinite(e.max))) return null;
  const margin = 1 + (ranking.lowerCostMinGapPercent ?? 10) / 100;
  const winners = journeys.filter((candidate, i) =>
    journeys.every((other, j) => i === j || candidate.fareEstimate.max * margin < other.fareEstimate.min));
  return winners.length === 1 ? winners[0] : null;
}

export function rankJourneys(journeys, ranking) {
  const withCost = journeys.map(journey => ({ ...journey, labels: [], generalizedCostSeconds: generalizedCost(journey, ranking) }));
  const pareto = paretoFilter(withCost);

  const fastest = pickBest(pareto, j => [j.totalDurationSeconds, j._arrivalSeconds, j.transfers, j.walkingDurationSeconds, j.id]);
  const leastTransfers = pickBest(pareto, j => [j.transfers, j.totalDurationSeconds, j._arrivalSeconds, j.walkingDurationSeconds, j.id]);
  const bestBalanced = pickBest(pareto, j => [j.generalizedCostSeconds, j.totalDurationSeconds, j.transfers, j.id]);

  const winnerIds = new Set([fastest, leastTransfers, bestBalanced].filter(Boolean).map(j => j.id));
  const selected = [...pareto.filter(j => winnerIds.has(j.id))];
  const rest = pareto
    .filter(j => !winnerIds.has(j.id))
    .sort(compareBy(j => [j.generalizedCostSeconds, j.totalDurationSeconds, j.id]));
  for (const journey of rest) {
    if (selected.length >= ranking.maxJourneys) break;
    selected.push(journey);
  }

  for (const journey of selected) {
    if (fastest && journey.id === fastest.id) journey.labels.push(JOURNEY_LABELS.FASTEST);
    if (leastTransfers && journey.id === leastTransfers.id) journey.labels.push(JOURNEY_LABELS.LEAST_TRANSFERS);
    if (bestBalanced && journey.id === bestBalanced.id) journey.labels.push(JOURNEY_LABELS.BEST_BALANCED);
  }

  // Judged on what the user will actually see, so the claim is true of the list on screen.
  const lowerCost = lowerEstimatedCostWinner(selected, ranking);
  if (lowerCost) lowerCost.labels.push(JOURNEY_LABELS.LOWER_ESTIMATED_COST);

  // Best Path Rating: judged on the journeys the user will actually see, so the comparison is true of the list on screen.
  const ratings = rateJourneys(selected, ranking.rating);
  selected.forEach((journey, i) => { journey.rating = ratings[i]; });
  const bestIds = new Set(bestPathIds(selected, ratings));
  for (const journey of selected) if (bestIds.has(journey.id)) journey.labels.unshift(JOURNEY_LABELS.BEST_PATH);
  const bestPath = selected.find(j => bestIds.has(j.id)) ?? null;

  selected.sort(compareBy(j => [j._departureSeconds, j._arrivalSeconds, j.id]));
  return {
    journeys: selected,
    winners: {
      fastest: fastest?.id ?? null,
      leastTransfers: leastTransfers?.id ?? null,
      bestBalanced: bestBalanced?.id ?? null,
      lowerEstimatedCost: lowerCost?.id ?? null,
      bestPath: bestPath?.id ?? null
    },
    stats: { candidates: journeys.length, pareto: pareto.length, dominatedRemoved: journeys.length - pareto.length, returned: selected.length }
  };
}

// Turns all candidate journeys (GTFS buses, composed train / flight journeys, ...) into a short, DIVERSE list.
//
//   1. Same-vehicle dedupe: journeys that ride exactly the same vehicles (same trips, same departures) differ only in
//      how you reach the first stop or where you change - keep the best one.
//   2. Pareto filter on complete door-to-door metrics: arrival, departure (later is better), transfers, walking,
//      local-ride time, and estimated cost (only when both fares are known).
//   3. Best Path Rating for every survivor (time, cost, transfers, first/last mile, schedule, tracking, convenience).
//   4. Clustering: primary mode + operator + direct/with-transfers + departure band. Near-identical options (eight
//      buses an hour apart on one corridor) collapse to the strongest per cluster.
//   5. Selection: the winners of each real category (best path, fastest, fewest transfers, lower estimated cost, best
//      of each mode) first, then the strongest remaining clusters, preferring departure times and modes not yet shown.
//   6. Labels are re-computed on the final list, so every claim is true of what the user sees.
// No category is created without data: a mode with no candidate simply does not appear.
import { rateJourneys, bestPathIds, fareMidpoint } from '../rating/pathRating.js';
import { lowerEstimatedCostWinner } from '../routing/ranking.js';
import { JOURNEY_LABELS } from '../routing/types.js';

export const SHORTLIST_DEFAULTS = Object.freeze({
  maxResults: 7,
  departureBandSeconds: 60 * 60,
  maxPerPrimaryMode: 4,        // only enforced while other modes still have candidates
  ranking: Object.freeze({ lowerCostMinGapPercent: 10 })
});

const vehicleLegs = journey => journey.legs.filter(leg => leg.mode !== 'walk' && leg.mode !== 'local_ride');
const ms = iso => Date.parse(iso);

export function primaryModeOf(journey) {
  const legs = vehicleLegs(journey);
  if (legs.length === 0) return 'other';
  const longest = legs.reduce((a, b) => ((b.durationSeconds ?? 0) > (a.durationSeconds ?? 0) ? b : a));
  const mode = String(longest.mode);
  if (/rail|train|subway|metro|tram/.test(mode)) return 'train';
  if (/air|flight/.test(mode)) return 'flight';
  return 'bus';
}

export function modesOf(journey) {
  const modes = [];
  for (const leg of journey.legs) {
    const mode = leg.mode === 'walk' || leg.mode === 'local_ride' ? leg.mode : primaryModeOf({ legs: [leg] });
    if (modes.at(-1) !== mode) modes.push(mode);
  }
  return modes;
}

const vehicleKey = journey => vehicleLegs(journey).map(leg => `${leg.tripId}@${leg.departureTime}`).join('>');

function betterOf(a, b) {
  const ka = [ms(a.arrivalTime), -ms(a.departureTime), a.transfers, a.walkingDurationSeconds, a.localRideDurationSeconds ?? 0];
  const kb = [ms(b.arrivalTime), -ms(b.departureTime), b.transfers, b.walkingDurationSeconds, b.localRideDurationSeconds ?? 0];
  for (let i = 0; i < ka.length; i++) if (ka[i] !== kb[i]) return ka[i] < kb[i] ? a : b;
  return a.id <= b.id ? a : b;
}

export function dedupeSameVehicles(journeys) {
  const best = new Map();
  for (const journey of journeys) {
    const key = vehicleKey(journey) || journey.id;
    best.set(key, best.has(key) ? betterOf(best.get(key), journey) : journey);
  }
  return [...best.values()];
}

function metrics(journey) {
  return [ms(journey.arrivalTime), -ms(journey.departureTime), journey.transfers, journey.walkingDurationSeconds, journey.localRideDurationSeconds ?? 0];
}

export function dominatesComplete(a, b) {
  const va = metrics(a);
  const vb = metrics(b);
  const fa = fareMidpoint(a);
  const fb = fareMidpoint(b);
  if (fa !== null && fb !== null) { va.push(fa); vb.push(fb); }
  else if (fa !== fb) return false; // one fare unknown: never dominated on cost grounds, and never dominates either
  let strictly = false;
  for (let i = 0; i < va.length; i++) {
    if (va[i] > vb[i]) return false;
    if (va[i] < vb[i]) strictly = true;
  }
  return strictly;
}

export function paretoComplete(journeys) {
  return journeys.filter((candidate, i) => !journeys.some((other, j) => i !== j && dominatesComplete(other, candidate)));
}

export function clusterKey(journey, bandSeconds = SHORTLIST_DEFAULTS.departureBandSeconds) {
  const legs = vehicleLegs(journey);
  const operators = [...new Set(legs.map(leg => leg.operatorInfo?.name ?? leg.operator ?? 'unknown'))].join('+');
  // Bands follow the LOCAL clock in the timestamp ("2026-10-09T22:15:00+05:30" -> 22:00-23:00), not UTC hours.
  const local = /^(\d{4}-\d{2}-\d{2})T(\d{2}):(\d{2})/.exec(journey.departureTime);
  const band = local
    ? `${local[1]}#${Math.floor((Number(local[2]) * 3600 + Number(local[3]) * 60) / bandSeconds)}`
    : String(Math.floor(ms(journey.departureTime) / 1000 / bandSeconds));
  return [primaryModeOf(journey), operators, journey.transfers === 0 ? 'direct' : 'transfer', band].join('|');
}

/**
 * @returns {{ journeys: object[], winners: object, stats: object }}
 */
export function buildShortlist(candidates, options = {}) {
  const opts = { ...SHORTLIST_DEFAULTS, ...options };
  const deduped = dedupeSameVehicles(candidates);
  const pareto = paretoComplete(deduped);
  if (pareto.length === 0) return { journeys: [], winners: {}, stats: { candidates: candidates.length, afterDedupe: deduped.length, afterPareto: 0, clusters: 0, returned: 0 } };

  const ratings = rateJourneys(pareto, opts.rating);
  const rated = pareto.map((journey, i) => ({ journey, raw: ratings[i].raw }));
  const byRaw = (a, b) => b.raw - a.raw || a.journey.id.localeCompare(b.journey.id);

  // Strongest per cluster.
  const clusters = new Map();
  for (const entry of rated) {
    const key = clusterKey(entry.journey, opts.departureBandSeconds);
    if (!clusters.has(key) || byRaw(entry, clusters.get(key)) < 0) clusters.set(key, entry);
  }
  const representatives = [...clusters.values()].sort(byRaw);

  // Category winners, judged on complete journeys (not just the cluster representatives).
  const pick = (list, keys) => [...list].sort((a, b) => {
    const ka = keys(a); const kb = keys(b);
    for (let i = 0; i < ka.length; i++) if (ka[i] !== kb[i]) return ka[i] < kb[i] ? -1 : 1;
    return 0;
  })[0];
  const fastest = pick(rated, e => [e.journey.totalDurationSeconds, ms(e.journey.arrivalTime), -e.raw]);
  const fewest = pick(rated, e => [e.journey.transfers, -e.raw]);
  const cheapest = pick(rated.filter(e => fareMidpoint(e.journey) !== null), e => [fareMidpoint(e.journey), -e.raw]);
  const modeBest = new Map();
  for (const entry of rated.sort(byRaw)) {
    const mode = primaryModeOf(entry.journey);
    if (!modeBest.has(mode)) modeBest.set(mode, entry);
  }

  const chosen = [];
  const keyOf = new Map(rated.map(entry => [entry, clusterKey(entry.journey, opts.departureBandSeconds)]));
  // One journey per cluster: a category winner that is a near-twin of something already chosen adds nothing.
  const take = entry => {
    if (!entry || chosen.includes(entry) || chosen.length >= opts.maxResults) return;
    if (chosen.some(other => keyOf.get(other) === keyOf.get(entry))) return;
    chosen.push(entry);
  };
  take(rated[0]);        // best overall (rated was sorted by raw above)
  take(fastest);
  take(fewest);
  take(cheapest);
  for (const entry of modeBest.values()) take(entry);

  // Fill with the strongest remaining clusters: new departure bands and under-represented modes first.
  const bandOf = entry => clusterKey(entry.journey, opts.departureBandSeconds).split('|')[3];
  const modeCount = mode => chosen.filter(e => primaryModeOf(e.journey) === mode).length;
  const modesAvailable = new Set(rated.map(e => primaryModeOf(e.journey)));
  for (const pass of ['new_band', 'any']) {
    for (const entry of representatives) {
      if (chosen.length >= opts.maxResults) break;
      if (chosen.includes(entry)) continue;
      const mode = primaryModeOf(entry.journey);
      if (modesAvailable.size > 1 && modeCount(mode) >= opts.maxPerPrimaryMode) continue;
      if (pass === 'new_band' && chosen.some(e => bandOf(e) === bandOf(entry) && primaryModeOf(e.journey) === mode)) continue;
      take(entry);
    }
  }

  // Final list: fresh labels and a fresh rating computed against what is actually shown.
  const finalJourneys = chosen.map(entry => ({ ...entry.journey, labels: [], primaryMode: primaryModeOf(entry.journey), modes: modesOf(entry.journey) }));
  const finalRatings = rateJourneys(finalJourneys, opts.rating);
  finalJourneys.forEach((journey, i) => { journey.rating = finalRatings[i]; });

  const label = (journey, name) => { if (journey && !journey.labels.includes(name)) journey.labels.push(name); };
  const final = (keys) => pick(finalJourneys.map(journey => ({ journey, raw: journey.rating.raw })), keys)?.journey;
  const bestIds = new Set(bestPathIds(finalJourneys, finalRatings));
  for (const journey of finalJourneys) if (bestIds.has(journey.id)) label(journey, JOURNEY_LABELS.BEST_PATH);
  const fastestFinal = final(e => [e.journey.totalDurationSeconds, ms(e.journey.arrivalTime), -e.raw]);
  label(fastestFinal, JOURNEY_LABELS.FASTEST);
  const minTransfers = Math.min(...finalJourneys.map(j => j.transfers));
  // "Fewest transfers" only means something when the options differ.
  if (finalJourneys.some(j => j.transfers > minTransfers)) label(final(e => [e.journey.transfers, -e.raw]), JOURNEY_LABELS.LEAST_TRANSFERS);
  const lowerCost = lowerEstimatedCostWinner(finalJourneys, opts.ranking);
  if (lowerCost) label(lowerCost, JOURNEY_LABELS.LOWER_ESTIMATED_COST);

  finalJourneys.sort((a, b) => ms(a.departureTime) - ms(b.departureTime) || ms(a.arrivalTime) - ms(b.arrivalTime) || a.id.localeCompare(b.id));
  const idOf = name => finalJourneys.find(j => j.labels.includes(name))?.id ?? null;
  return {
    journeys: finalJourneys,
    winners: {
      bestPath: idOf(JOURNEY_LABELS.BEST_PATH),
      fastest: idOf(JOURNEY_LABELS.FASTEST),
      leastTransfers: idOf(JOURNEY_LABELS.LEAST_TRANSFERS),
      lowerEstimatedCost: idOf(JOURNEY_LABELS.LOWER_ESTIMATED_COST)
    },
    stats: {
      candidates: candidates.length,
      afterDedupe: deduped.length,
      afterPareto: pareto.length,
      clusters: clusters.size,
      returned: finalJourneys.length,
      modes: Object.fromEntries([...modesAvailable].map(mode => [mode, rated.filter(e => primaryModeOf(e.journey) === mode).length]))
    }
  };
}

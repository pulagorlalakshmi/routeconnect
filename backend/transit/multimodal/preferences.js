// Travel preferences for /api/v2/plan: which transport modes may carry the journey (`modes`) and what to rank by
// (`rank`). Both are applied in the multimodal layer, ABOVE the routing engines: RAPTOR, fares and ratings are unchanged.
//
//   modes = "bus" | "train" | "bus,train"   (absent = no preference: every mode with a configured data source)
//   rank  = "best" | "fastest" | "cost" | "transfers"   (absent = the original diverse shortlist, ordered by departure)
//
// Walking and estimated local rides are access/egress connections, never a "mode": a Bus-only journey may start with a
// walk or a local ride to the first stop.
import { fareMidpoint } from '../rating/pathRating.js';

export const TRANSPORT_MODES = Object.freeze(['bus', 'train']);
export const RANK_PRIORITIES = Object.freeze(['best', 'fastest', 'cost', 'transfers']);

// A journey leg's / source's transport mode in preference terms.
export function transportModeOf(mode) {
  const text = String(mode ?? '').toLowerCase();
  if (text === 'walk' || text === 'local_ride') return null;
  if (/rail|train|subway|metro|tram/.test(text)) return 'train';
  if (/air|flight/.test(text)) return 'flight';
  if (/bus|coach/.test(text)) return 'bus';
  return 'other';
}

/** @returns {{ ok: true, value: { modes: string[], rank: string|null } } | { ok: false, errors: string[] }} */
export function parsePreferences(raw = {}) {
  const errors = [];
  const text = name => (typeof raw[name] === 'string' ? raw[name].trim() : Array.isArray(raw[name]) ? null : '');
  const modesText = text('modes');
  const rankText = text('rank');
  if (modesText === null) errors.push('modes must be provided once');
  if (rankText === null) errors.push('rank must be provided once');

  const modes = [...new Set((modesText ?? '').split(',').map(m => m.trim().toLowerCase()).filter(Boolean))];
  const unknown = modes.filter(m => !TRANSPORT_MODES.includes(m));
  if (unknown.length > 0) errors.push(`modes may only contain ${TRANSPORT_MODES.join(', ')}`);
  const rank = rankText ? rankText.toLowerCase() : null;
  if (rank !== null && !RANK_PRIORITIES.includes(rank)) errors.push(`rank must be one of ${RANK_PRIORITIES.join(', ')}`);

  if (errors.length > 0) return { ok: false, errors };
  return { ok: true, value: { modes: TRANSPORT_MODES.filter(m => modes.includes(m)), rank } };
}

// Hard filter: with explicit modes, every timetable leg must use one of them. No preference keeps every journey.
export function journeyAllowed(journey, modes) {
  if (!modes || modes.length === 0) return true;
  return journey.legs.every(leg => {
    const mode = transportModeOf(leg.mode);
    return mode === null || modes.includes(mode);
  });
}

// A complete fare estimate's midpoint, or null when any part is unpriced: a missing fare is never treated as ₹0.
export function comparableFare(journey) {
  const estimate = journey.fareEstimate;
  if (!estimate || estimate.complete === false) return null;
  return fareMidpoint(journey);
}

const ms = iso => Date.parse(iso);

// Sort keys per priority, ascending. `raw` is the Best Path Rating (higher is better) of the journey within its list.
// Each priority ranks by its own metric first and breaks ties with the others, ending with the id for determinism.
const KEYS = {
  best: (j, raw) => [-raw, j.totalDurationSeconds, j.transfers, ms(j.arrivalTime)],
  fastest: (j, raw) => [j.totalDurationSeconds, ms(j.arrivalTime), j.transfers, -raw],
  transfers: (j, raw) => [j.transfers, j.totalDurationSeconds, ms(j.arrivalTime), -raw],
  cost: (j, raw) => {
    const fare = comparableFare(j);
    return [fare === null ? 1 : 0, fare ?? 0, j.totalDurationSeconds, -raw];
  }
};

export function comparatorFor(priority, rawOf = journey => journey.rating?.raw ?? 0) {
  const keysOf = KEYS[priority] ?? KEYS.best;
  return (a, b) => {
    const ka = keysOf(a, rawOf(a));
    const kb = keysOf(b, rawOf(b));
    for (let i = 0; i < ka.length; i++) if (ka[i] !== kb[i]) return ka[i] < kb[i] ? -1 : 1;
    return String(a.id).localeCompare(String(b.id));
  };
}

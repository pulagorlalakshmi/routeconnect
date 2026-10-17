// Travel preferences, asked in a short step after "Find routes": which transport modes may carry the journey, and how
// to order results.
//
// Modes are a hard filter. No mode ticked means "no explicit preference": every mode with genuine data is eligible.
// Walking and estimated local rides are access/egress connections, never a mode here, so a Bus-only journey may still
// start with a walk or a local ride to the first stop.
//
// Train is listed but NOT available: no verified railway timetable provider is connected yet. It cannot be selected,
// and a stored or linked "train" preference is dropped rather than silently producing an empty search.
import type { Journey } from '../services/planService';

export type TransportMode = 'bus' | 'train';
export type RankingPreference = 'best' | 'fastest' | 'cost' | 'transfers';

export interface TravelPreferences {
  modes: TransportMode[]; // [] = no explicit preference
  ranking: RankingPreference;
}

export interface ModeOption {
  id: TransportMode;
  label: string;
  available: boolean;
  unavailableLabel?: string;
  unavailableReason?: string;
}

export const MODE_OPTIONS: readonly ModeOption[] = [
  { id: 'bus', label: 'Bus', available: true },
  {
    id: 'train',
    label: 'Train',
    available: false,
    unavailableLabel: 'Coming soon',
    unavailableReason: 'Train search is not available yet: no verified railway timetable is connected.'
  }
];

export const RANKING_OPTIONS: readonly { id: RankingPreference; label: string }[] = [
  { id: 'best', label: 'Best overall' },
  { id: 'fastest', label: 'Fastest' },
  { id: 'cost', label: 'Lowest estimated cost' },
  { id: 'transfers', label: 'Fewest transfers' }
];

export const DEFAULT_PREFERENCES: TravelPreferences = Object.freeze({ modes: [], ranking: 'best' }) as TravelPreferences;
export const PREFERENCES_STORAGE_KEY = 'routeconnect.travelPreferences';

const AVAILABLE_MODES = new Set(MODE_OPTIONS.filter(option => option.available).map(option => option.id));
const RANKINGS = new Set(RANKING_OPTIONS.map(option => option.id));

export function normalizePreferences(raw: unknown): TravelPreferences {
  const value = (raw && typeof raw === 'object' ? raw : {}) as { modes?: unknown; ranking?: unknown };
  const modes = Array.isArray(value.modes)
    ? MODE_OPTIONS.map(option => option.id).filter(id => AVAILABLE_MODES.has(id) && (value.modes as unknown[]).includes(id))
    : [];
  const ranking = RANKINGS.has(value.ranking as RankingPreference) ? (value.ranking as RankingPreference) : 'best';
  return { modes, ranking };
}

export function toggleMode(preferences: TravelPreferences, mode: TransportMode): TravelPreferences {
  if (!AVAILABLE_MODES.has(mode)) return preferences;
  const modes = preferences.modes.includes(mode) ? preferences.modes.filter(m => m !== mode) : [...preferences.modes, mode];
  return normalizePreferences({ ...preferences, modes });
}

// The four choices offered to people. A choice is available only when every mode in it has genuine data behind it, so
// "Train only" and "Bus + Train" stay visible but unselectable until a verified railway timetable is connected.
export type ModeChoiceId = 'any' | 'bus' | 'train' | 'bus_train';
export interface ModeChoice {
  id: ModeChoiceId;
  label: string;
  description: string;
  modes: TransportMode[];
  available: boolean;
}

const choice = (id: ModeChoiceId, label: string, description: string, modes: TransportMode[]): ModeChoice =>
  ({ id, label, description, modes, available: modes.every(mode => AVAILABLE_MODES.has(mode)) });

export const MODE_CHOICES: readonly ModeChoice[] = [
  choice('any', 'No preference', 'Every mode we have real timetables for', []),
  choice('bus', 'Bus only', 'Buses, with a walk or local ride to the stop', ['bus']),
  choice('train', 'Train only', 'Trains, with a walk or local ride to the station', ['train']),
  choice('bus_train', 'Bus + Train', 'Separate and combined bus and train journeys', ['bus', 'train'])
];

export function modeChoiceOf(modes: TransportMode[]): ModeChoice {
  const key = [...modes].sort().join('+');
  return MODE_CHOICES.find(option => [...option.modes].sort().join('+') === key) ?? MODE_CHOICES[0];
}

export function modeSummary(modes: TransportMode[]): string {
  if (modes.length === 0) return 'No preference';
  const labels = MODE_OPTIONS.filter(option => modes.includes(option.id)).map(option => option.label);
  return labels.length === 1 ? `${labels[0]} only` : labels.join(' + ');
}

export function rankingLabel(ranking: RankingPreference): string {
  return RANKING_OPTIONS.find(option => option.id === ranking)?.label ?? 'Best overall';
}

export function preferencesSummary(preferences: TravelPreferences): string {
  return `${modeSummary(preferences.modes)} · ${rankingLabel(preferences.ranking)}`;
}

type StorageLike = Pick<Storage, 'getItem' | 'setItem'>;
const defaultStorage = (): StorageLike | null => {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage;
  } catch {
    return null;
  }
};

export function loadPreferences(storage: StorageLike | null = defaultStorage()): TravelPreferences {
  try {
    const text = storage?.getItem(PREFERENCES_STORAGE_KEY);
    return text ? normalizePreferences(JSON.parse(text)) : { ...DEFAULT_PREFERENCES };
  } catch {
    return { ...DEFAULT_PREFERENCES };
  }
}

export function savePreferences(preferences: TravelPreferences, storage: StorageLike | null = defaultStorage()): void {
  try {
    storage?.setItem(PREFERENCES_STORAGE_KEY, JSON.stringify(normalizePreferences(preferences)));
  } catch {
    // Storage unavailable (private mode, blocked): preferences still apply to this search through the URL.
  }
}

// URL form: ?modes=bus&rank=fastest. Defaults are omitted so ordinary searches keep their old URLs.
export function writePreferenceParams(preferences: TravelPreferences, params: URLSearchParams): URLSearchParams {
  const normalized = normalizePreferences(preferences);
  if (normalized.modes.length > 0) params.set('modes', normalized.modes.join(','));
  else params.delete('modes');
  if (normalized.ranking !== 'best') params.set('rank', normalized.ranking);
  else params.delete('rank');
  return params;
}

export function readPreferenceParams(params: URLSearchParams): TravelPreferences {
  return normalizePreferences({
    modes: (params.get('modes') ?? '').split(',').map(mode => mode.trim()).filter(Boolean),
    ranking: params.get('rank') ?? 'best'
  });
}

// The transport mode a timetable leg belongs to, or null for walking / local rides (access, egress, transfers).
export function legTransportMode(mode: string): TransportMode | 'flight' | 'other' | null {
  if (mode === 'walk' || mode === 'local_ride') return null;
  if (/bus|coach/i.test(mode)) return 'bus';
  if (/rail|train|subway|metro|tram/i.test(mode)) return 'train';
  if (/air|flight/i.test(mode)) return 'flight';
  return 'other';
}

// Hard filter: with explicit modes, every timetable leg must use one of them. No preference keeps every journey.
export function journeyMatchesModes(journey: Pick<Journey, 'legs'>, modes: TransportMode[]): boolean {
  if (modes.length === 0) return true;
  return journey.legs.every(leg => {
    const mode = legTransportMode(leg.mode);
    return mode === null || (modes as string[]).includes(mode);
  });
}

// A journey's estimated cost for comparison: the midpoint of a COMPLETE estimate, or null when any part is unpriced.
export function comparableFare(journey: Pick<Journey, 'fareEstimate'>): number | null {
  const fare = journey.fareEstimate;
  if (!fare || !fare.complete || fare.min === null || fare.max === null) return null;
  if (!Number.isFinite(fare.min) || !Number.isFinite(fare.max) || fare.max <= 0) return null;
  return (fare.min + fare.max) / 2;
}

// Lowest estimated cost first. Journeys without a complete estimate are never treated as cheap: they go last.
export function compareEstimatedCost(a: Pick<Journey, 'fareEstimate'>, b: Pick<Journey, 'fareEstimate'>): number {
  const fa = comparableFare(a);
  const fb = comparableFare(b);
  if (fa === null && fb === null) return 0;
  if (fa === null) return 1;
  if (fb === null) return -1;
  return fa - fb;
}

// Ordering for each "Show first" choice. Mirrors the server's comparatorFor() (backend/transit/multimodal/preferences.js)
// so re-sorting on the results page matches the server's order exactly:
//   best      - Best Path Rating (the documented balanced score), then total time, transfers, arrival
//   fastest   - total door-to-door time (walks, local rides, waits included), then arrival, transfers, rating
//   transfers - vehicle changes (walking and access rides never count), then total time, arrival, rating
//   cost      - complete estimated fare (midpoint); unpriced journeys last, never as ₹0; then total time, rating
type Rankable = Pick<Journey, 'id' | 'totalDurationSeconds' | 'arrivalTime' | 'transfers' | 'fareEstimate' | 'rating'>;
const RANK_KEYS: Record<RankingPreference, (j: Rankable, raw: number) => number[]> = {
  best: (j, raw) => [-raw, j.totalDurationSeconds, j.transfers, Date.parse(j.arrivalTime)],
  fastest: (j, raw) => [j.totalDurationSeconds, Date.parse(j.arrivalTime), j.transfers, -raw],
  transfers: (j, raw) => [j.transfers, j.totalDurationSeconds, Date.parse(j.arrivalTime), -raw],
  cost: (j, raw) => {
    const fare = comparableFare(j);
    return [fare === null ? 1 : 0, fare ?? 0, j.totalDurationSeconds, -raw];
  }
};

export function compareJourneysFor(ranking: RankingPreference) {
  const keysOf = RANK_KEYS[ranking] ?? RANK_KEYS.best;
  return (a: Rankable, b: Rankable): number => {
    const ka = keysOf(a, a.rating?.raw ?? a.rating?.score ?? 0);
    const kb = keysOf(b, b.rating?.raw ?? b.rating?.score ?? 0);
    for (let i = 0; i < ka.length; i++) if (ka[i] !== kb[i]) return ka[i] < kb[i] ? -1 : 1;
    return a.id.localeCompare(b.id);
  };
}

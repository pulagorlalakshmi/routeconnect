// Travel preferences, asked in a short step after "Find routes": which transport modes may carry the journey, and how
// to order results.
//
// Modes are a hard filter. No mode ticked means "no explicit preference": every mode with genuine data is eligible.
// Walking and estimated local rides are access/egress connections, never a mode here, so a Bus-only journey may still
// start with a walk or a local ride to the first stop.
//
// Availability is decided by the SERVER (GET /api/v2/capabilities, see services/capabilities.ts): Train can be chosen only
// while the backend has a usable railway timetable. Every function below takes the currently available modes and
// defaults to buses only, so a stored or linked "train" preference is dropped whenever trains are not available.
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

export const TRANSPORT_MODES: readonly TransportMode[] = ['bus', 'train'];
// What may be chosen before (or without) the server confirming anything else.
export const DEFAULT_AVAILABLE_MODES: readonly TransportMode[] = ['bus'];

// Labels for each mode. `available` here is the DEFAULT; the live value comes from modeChoicesFor(availableModes).
export const MODE_OPTIONS: readonly ModeOption[] = [
  { id: 'bus', label: 'Bus', available: true },
  {
    id: 'train',
    label: 'Scheduled train',
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

const RANKINGS = new Set(RANKING_OPTIONS.map(option => option.id));
type Available = readonly TransportMode[];

export function normalizePreferences(raw: unknown, available: Available = DEFAULT_AVAILABLE_MODES): TravelPreferences {
  const value = (raw && typeof raw === 'object' ? raw : {}) as { modes?: unknown; ranking?: unknown };
  const modes = Array.isArray(value.modes)
    ? MODE_OPTIONS.map(option => option.id).filter(id => available.includes(id) && (value.modes as unknown[]).includes(id))
    : [];
  const ranking = RANKINGS.has(value.ranking as RankingPreference) ? (value.ranking as RankingPreference) : 'best';
  return { modes, ranking };
}

export function toggleMode(preferences: TravelPreferences, mode: TransportMode, available: Available = DEFAULT_AVAILABLE_MODES): TravelPreferences {
  if (!available.includes(mode)) return preferences;
  const modes = preferences.modes.includes(mode) ? preferences.modes.filter(m => m !== mode) : [...preferences.modes, mode];
  return normalizePreferences({ ...preferences, modes }, available);
}

// The four choices offered to people. A choice is available only when every mode in it has genuine data behind it, so
// "Train only" and "Bus + Train" stay visible but unselectable while the server reports no usable railway timetable.
export type ModeChoiceId = 'any' | 'bus' | 'train' | 'bus_train';
export interface ModeChoice {
  id: ModeChoiceId;
  label: string;
  description: string;
  modes: TransportMode[];
  available: boolean;
}

const CHOICES: readonly Omit<ModeChoice, 'available'>[] = [
  { id: 'any', label: 'No preference', description: 'Every mode we have real timetables for', modes: [] },
  { id: 'bus', label: 'Bus only', description: 'Buses, with a walk or local ride to the stop', modes: ['bus'] },
  { id: 'train', label: 'Scheduled train', description: 'Timetabled trains, with a walk or local ride to the station', modes: ['train'] },
  { id: 'bus_train', label: 'Bus + scheduled train', description: 'Separate and combined bus and timetabled train journeys', modes: ['bus', 'train'] }
];

export function modeChoicesFor(available: Available = DEFAULT_AVAILABLE_MODES): ModeChoice[] {
  return CHOICES.map(option => ({ ...option, modes: [...option.modes], available: option.modes.every(mode => available.includes(mode)) }));
}

// The choices with default availability (buses only), for code that has not heard from the server.
export const MODE_CHOICES: readonly ModeChoice[] = modeChoicesFor();

export function modeChoiceOf(modes: TransportMode[], choices: readonly ModeChoice[] = MODE_CHOICES): ModeChoice {
  const key = [...modes].sort().join('+');
  return choices.find(option => [...option.modes].sort().join('+') === key) ?? choices[0];
}

export function modeSummary(modes: TransportMode[]): string {
  if (modes.length === 0) return 'Any transport';
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

export function loadPreferences(storage: StorageLike | null = defaultStorage(), available: Available = DEFAULT_AVAILABLE_MODES): TravelPreferences {
  try {
    const text = storage?.getItem(PREFERENCES_STORAGE_KEY);
    return text ? normalizePreferences(JSON.parse(text), available) : { ...DEFAULT_PREFERENCES };
  } catch {
    return { ...DEFAULT_PREFERENCES };
  }
}

export function savePreferences(preferences: TravelPreferences, storage: StorageLike | null = defaultStorage(), available: Available = DEFAULT_AVAILABLE_MODES): void {
  try {
    storage?.setItem(PREFERENCES_STORAGE_KEY, JSON.stringify(normalizePreferences(preferences, available)));
  } catch {
    // Storage unavailable (private mode, blocked): preferences still apply to this search through the URL.
  }
}

// ---- What the preference dialog offers ----
// Two kinds of result exist and are never mixed:
//   planned        - timetable journeys from /api/v2/plan (buses; scheduled trains once a licensed timetable exists)
//   estimated_rail - mapped railway corridors with an ESTIMATED duration (/api/v2/rail-explorer): not train services
// "No preference" shows planned journeys AND, in its own section, estimated rail connections.
export type SearchView = 'planned' | 'estimated_rail';
export type TravelChoiceId = ModeChoiceId | 'estimated_rail';
export interface TravelChoice {
  id: TravelChoiceId;
  label: string;
  description: string;
  modes: TransportMode[];
  view: SearchView;
  available: boolean;
  unavailableLabel: string | null;
}
export interface EstimatedRailAvailability { available: boolean; state?: string | null; reason?: string | null }

// Train availability as the server reports it. "unknown" = the server could not be asked (unreachable, or an older
// server without the endpoint): shown as such, never silently as "unavailable".
export const TRAIN_ESTIMATE_NOTE = 'Train suggestions are estimated from mapped railway connections. Schedules are not verified.';

// The three choices people see. "Train" means SCHEDULED trains whenever the server has a working timetable provider
// (availableModes includes 'train'); otherwise it falls back to ESTIMATED railway suggestions (mapped track + assumed
// speeds), enabled only when the railway network is genuinely ready. Never two train choices.
export function travelChoicesFor({ availableModes = DEFAULT_AVAILABLE_MODES, estimatedRail = { available: false } }: { availableModes?: Available; estimatedRail?: EstimatedRailAvailability } = {}): TravelChoice[] {
  if (availableModes.includes('train')) {
    return [
      { id: 'any', label: 'Any transport', modes: [], view: 'planned', available: true, unavailableLabel: null, description: 'Buses and scheduled trains' },
      { id: 'bus', label: 'Bus', description: 'Timetabled buses', modes: ['bus'], view: 'planned', available: true, unavailableLabel: null },
      { id: 'train', label: 'Train', description: 'Scheduled trains', modes: ['train'], view: 'planned', available: true, unavailableLabel: null }
    ];
  }
  const trainLabel = estimatedRail.available ? null
    : estimatedRail.state === 'preparing' ? 'Preparing…'
    : estimatedRail.state === 'unknown' ? 'Not checked'
    : 'Unavailable';
  return [
    {
      id: 'any', label: 'Any transport', modes: [], view: 'planned', available: true, unavailableLabel: null,
      description: estimatedRail.available ? 'Buses and estimated train suggestions' : 'Every transport with real data'
    },
    { id: 'bus', label: 'Bus', description: 'Timetabled buses', modes: ['bus'], view: 'planned', available: true, unavailableLabel: null },
    { id: 'train', label: 'Train', description: 'Railway connections near you', modes: [], view: 'estimated_rail', available: estimatedRail.available, unavailableLabel: trainLabel }
  ];
}

export function travelChoiceOf(modes: TransportMode[], view: SearchView, choices: readonly TravelChoice[]): TravelChoice {
  // A remembered "Train" carries over whichever kind of train search is currently on offer.
  if (view === 'estimated_rail') return choices.find(c => c.view === 'estimated_rail') ?? choices.find(c => c.id === 'train') ?? choices[0];
  if (modes.length === 1 && modes[0] === 'train') return choices.find(c => c.id === 'train') ?? choices[0];
  const key = [...modes].sort().join('+');
  return choices.find(c => c.view === 'planned' && [...c.modes].sort().join('+') === key) ?? choices[0];
}

// URL ?view=estimated-rail: the whole search is estimated rail connections (no timetable planning at all).
export const VIEW_STORAGE_KEY = 'routeconnect.searchView';
export const readViewParam = (params: URLSearchParams): SearchView => (params.get('view') === 'estimated-rail' ? 'estimated_rail' : 'planned');
export function writeViewParam(params: URLSearchParams, view: SearchView): URLSearchParams {
  if (view === 'estimated_rail') {
    params.set('view', 'estimated-rail');
    params.delete('modes');
    params.delete('explore');
  } else {
    params.delete('view');
  }
  return params;
}
export function loadView(storage: StorageLike | null = defaultStorage()): SearchView {
  try { return storage?.getItem(VIEW_STORAGE_KEY) === 'estimated_rail' ? 'estimated_rail' : 'planned'; } catch { return 'planned'; }
}
export function saveView(view: SearchView, storage: StorageLike | null = defaultStorage()): void {
  try { storage?.setItem(VIEW_STORAGE_KEY, view); } catch { /* storage unavailable: the URL still carries it */ }
}
export const viewSummary = (view: SearchView, modes: TransportMode[]): string => (view === 'estimated_rail' ? 'Train (estimated)' : modes.length === 0 ? 'Any transport' : modeSummary(modes));

// Legacy "Explore estimated rail connections" links (?explore=rail) still add the estimated section below planned
// journeys. New searches get it automatically with "No preference".
export const EXPLORE_STORAGE_KEY = 'routeconnect.exploreRail';
export const readExploreParam = (params: URLSearchParams): boolean => params.get('explore') === 'rail';
export function writeExploreParam(params: URLSearchParams, explore: boolean): URLSearchParams {
  if (explore) params.set('explore', 'rail');
  else params.delete('explore');
  return params;
}
export function loadExplore(storage: StorageLike | null = defaultStorage()): boolean {
  try { return storage?.getItem(EXPLORE_STORAGE_KEY) === '1'; } catch { return false; }
}
export function saveExplore(explore: boolean, storage: StorageLike | null = defaultStorage()): void {
  try { storage?.setItem(EXPLORE_STORAGE_KEY, explore ? '1' : '0'); } catch { /* storage unavailable: the URL still carries it */ }
}

// URL form: ?modes=bus&rank=fastest. Defaults are omitted so ordinary searches keep their old URLs.
export function writePreferenceParams(preferences: TravelPreferences, params: URLSearchParams, available: Available = DEFAULT_AVAILABLE_MODES): URLSearchParams {
  const normalized = normalizePreferences(preferences, available);
  if (normalized.modes.length > 0) params.set('modes', normalized.modes.join(','));
  else params.delete('modes');
  if (normalized.ranking !== 'best') params.set('rank', normalized.ranking);
  else params.delete('rank');
  return params;
}

// The plan request reads the URL with every known mode (TRANSPORT_MODES): the server is the judge, and answers a train
// request it cannot serve with MODE_UNAVAILABLE instead of silently searching buses.
export function readPreferenceParams(params: URLSearchParams, available: Available = DEFAULT_AVAILABLE_MODES): TravelPreferences {
  return normalizePreferences({
    modes: (params.get('modes') ?? '').split(',').map(mode => mode.trim()).filter(Boolean),
    ranking: params.get('rank') ?? 'best'
  }, available);
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

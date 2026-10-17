// One definition of "the plan request for this results URL", shared by the search flow (which runs the request while
// the route-discovery animation plays) and the results page (which shows it). A short-lived in-memory cache hands the
// finished response to the results page, so the same search is never requested twice; refreshing the page (empty
// cache) simply runs it again.
import { fetchPlan, PlanError } from './planService';
import type { PlanParams, PlanResponse } from './planService';
import { nowLocalHHMM, todayLocalIso } from '../utils/dateTime';
import { readPreferenceParams } from '../utils/travelPreferences';

// Rural services are sparse, so look several hours ahead of the requested time.
export const WINDOW_MINUTES = 360;
// A search never hangs forever: past this the user gets a clear "took too long" with a retry.
export const SEARCH_TIMEOUT_MS = 45_000;

const finiteOrNull = (text: string | null) => {
  if (text === null || text.trim() === '') return null;
  const value = Number(text);
  return Number.isFinite(value) ? value : null;
};

export function planParamsFromSearch(search: URLSearchParams): PlanParams {
  const fromLat = finiteOrNull(search.get('fromLat'));
  const fromLng = finiteOrNull(search.get('fromLng'));
  const toLat = finiteOrNull(search.get('toLat'));
  const toLng = finiteOrNull(search.get('toLng'));
  const preferences = readPreferenceParams(search);
  return {
    from: search.get('from') || '',
    to: search.get('to') || '',
    fromCoords: fromLat !== null && fromLng !== null ? { lat: fromLat, lng: fromLng } : null,
    toCoords: toLat !== null && toLng !== null ? { lat: toLat, lng: toLng } : null,
    date: search.get('date') || todayLocalIso(),
    time: search.get('time') || nowLocalHHMM(),
    windowMinutes: WINDOW_MINUTES,
    modes: preferences.modes,
    // Always explicit, so the server orders the list by what the user chose ("best" included).
    rank: preferences.ranking
  };
}

export function planKey(params: PlanParams): string {
  return JSON.stringify([
    params.from?.trim() ?? '', params.to?.trim() ?? '', params.fromCoords ?? null, params.toCoords ?? null,
    params.date, params.time, params.windowMinutes ?? null, params.maxTransfers ?? null, params.modes ?? [], params.rank ?? null
  ]);
}

const CACHE_TTL_MS = 5 * 60 * 1000;
const CACHE_MAX = 8;
const cache = new Map<string, { plan: PlanResponse; at: number }>();

export function rememberPlan(key: string, plan: PlanResponse, now = Date.now()): void {
  cache.delete(key);
  cache.set(key, { plan, at: now });
  while (cache.size > CACHE_MAX) cache.delete(cache.keys().next().value as string);
}

export function recallPlan(key: string, now = Date.now()): PlanResponse | null {
  const hit = cache.get(key);
  if (!hit) return null;
  if (now - hit.at > CACHE_TTL_MS) { cache.delete(key); return null; }
  return hit.plan;
}

export function clearPlanCache(): void {
  cache.clear();
}

// Runs the request with a timeout. `signal` lets the caller cancel (closing the flow, leaving the page).
export async function runPlanSearch(params: PlanParams, signal: AbortSignal, timeoutMs = SEARCH_TIMEOUT_MS): Promise<PlanResponse> {
  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => { timedOut = true; controller.abort(); }, timeoutMs);
  const forward = () => controller.abort();
  signal.addEventListener('abort', forward, { once: true });
  if (signal.aborted) controller.abort();
  try {
    const plan = await fetchPlan(params, controller.signal);
    rememberPlan(planKey(params), plan);
    return plan;
  } catch (error) {
    if (timedOut) {
      throw new PlanError('TIMEOUT', 'The search is taking longer than expected.');
    }
    throw error;
  } finally {
    clearTimeout(timer);
    signal.removeEventListener('abort', forward);
  }
}

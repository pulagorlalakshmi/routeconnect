// RailRadar adapter: an OPTIONAL, backend-only cross-check of a scheduled train against RailRadar's "trains between
// stations" API (https://railradar.in/docs/trains-between-stations).
//
//   RAILRADAR_API_KEY=rr_live_...          required; never sent to the browser, never logged
//   RAILRADAR_API_BASE=https://api.railradar.in/v1
//   RAILRADAR_MONTHLY_REQUEST_BUDGET=100   the free sandbox allows 100 requests/month; this process stops at the budget
//
// RailRadar describes itself as an independent, crowd-powered service not affiliated with Indian Railways, IRCTC or
// NTES, so a match is reported as "consistent with RailRadar", never as official or live confirmation. Only the
// scheduled timetable search (live=false) is used. Results are cached so one train is never asked about twice in a while.
import { createTtlCache } from '../../sources/sourceRunner.js';

const DEFAULT_BASE = 'https://api.railradar.in/v1';
const STATION = /^[A-Z]{1,5}$/;
const TRAIN = /^\d{5}$/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;

export function createRailRadarClient({ env = process.env, fetchImpl = null, cache = createTtlCache({ ttlMs: 6 * 3600 * 1000, max: 300 }) } = {}) {
  // Under the Node test runner, a real key never reaches the network: tests must pass their own fetchImpl. This keeps
  // the test suite from spending the (small) monthly request quota.
  const underTest = Boolean(process.env.NODE_TEST_CONTEXT) && !fetchImpl;
  const key = underTest ? null : env.RAILRADAR_API_KEY?.trim() || null;
  fetchImpl = fetchImpl ?? fetch;
  const base = (env.RAILRADAR_API_BASE || DEFAULT_BASE).replace(/\/+$/, '');
  const budget = Number(env.RAILRADAR_MONTHLY_REQUEST_BUDGET) > 0 ? Number(env.RAILRADAR_MONTHLY_REQUEST_BUDGET) : 100;
  let month = null;
  let used = 0;
  // RailRadar's own count of requests left this month (x-ratelimit-remaining-month), when it has told us.
  let providerRemaining = null;

  const spend = () => {
    const current = new Date().toISOString().slice(0, 7);
    if (current !== month) { month = current; used = 0; providerRemaining = null; }
    if (used >= budget || providerRemaining === 0) return false;
    used++;
    return true;
  };

  /**
   * Scheduled trains between two station codes on `date` (the date at the FROM station), live=false (timetable only).
   * byCity: also stations in the same city (e.g. Secunderabad, Hyderabad, Kacheguda) in one request.
   * Each train: { number, name, type, runDays (at the train's origin), from:{code,name,departure,day}, to:{code,name,arrival,day},
   *               distanceKm, durationMinutes, haltsBetween }
   */
  async function trainsBetween(from, to, date, { byCity = false } = {}) {
    const cacheKey = `${from}|${to}|${date}|${byCity ? 'city' : 'station'}`;
    const hit = cache.get(cacheKey);
    if (hit) return hit;
    if (!key) throw Object.assign(new Error('RailRadar is not configured.'), { code: 'NOT_CONFIGURED' });
    if (!spend()) throw Object.assign(new Error('The RailRadar request budget for this month is used up.'), { code: 'BUDGET_EXHAUSTED' });
    const url = `${base}/trains/between/${encodeURIComponent(from)}/${encodeURIComponent(to)}?date=${encodeURIComponent(date)}&live=false${byCity ? '&byCity=true' : ''}`;
    let response;
    try {
      response = await fetchImpl(url, { headers: { Authorization: `Bearer ${key}`, Accept: 'application/json' }, signal: AbortSignal.timeout(8000) });
    } catch (error) {
      const timedOut = error?.name === 'TimeoutError' || error?.name === 'AbortError';
      throw Object.assign(new Error(timedOut ? 'RailRadar did not answer in time.' : 'RailRadar could not be reached.'), { code: timedOut ? 'TIMEOUT' : 'NETWORK' });
    }
    const remaining = Number(response.headers?.get?.('x-ratelimit-remaining-month'));
    if (Number.isFinite(remaining)) providerRemaining = remaining;
    if (response.status === 401 || response.status === 403) throw Object.assign(new Error('RailRadar rejected the API key.'), { code: 'UNAUTHORIZED' });
    if (response.status === 429) throw Object.assign(new Error('RailRadar rate limit reached; try again later.'), { code: 'RATE_LIMITED' });
    if (response.status === 404) return cache.set(cacheKey, []);
    if (!response.ok) throw Object.assign(new Error(`RailRadar returned HTTP ${response.status}.`), { code: 'PROVIDER_ERROR' });
    const body = await response.json();
    const hhmm = value => (typeof value === 'string' && /^\d{1,2}:\d{2}/.test(value) ? value.slice(0, 5).padStart(5, '0') : null);
    const trains = (body?.data?.trains ?? []).map(entry => ({
      number: String(entry.train?.number ?? ''),
      name: entry.train?.name ?? null,
      type: entry.train?.type ?? null,
      runDays: Array.isArray(entry.train?.runDays) ? entry.train.runDays : null,
      from: { code: entry.from?.code ?? from, name: entry.from?.name ?? null, departure: hhmm(entry.from?.departure), day: Number(entry.from?.day) || 1 },
      to: { code: entry.to?.code ?? to, name: entry.to?.name ?? null, arrival: hhmm(entry.to?.arrival), day: Number(entry.to?.day) || 1 },
      distanceKm: Number.isFinite(Number(entry.distance)) ? Number(entry.distance) : null,
      durationMinutes: Number.isFinite(Number(entry.duration)) ? Number(entry.duration) : null,
      haltsBetween: Number.isFinite(Number(entry.totalHaltsBetween)) ? Number(entry.totalHaltsBetween) : null,
      // Kept for verify(): the boarding and alighting clock times.
      departure: hhmm(entry.from?.departure),
      arrival: hhmm(entry.to?.arrival)
    })).filter(t => /^\d{5}$/.test(t.number) && t.from.departure && t.to.arrival);
    return cache.set(cacheKey, trains);
  }

  return {
    configured: Boolean(key),
    budget: () => ({ month, used, budget, providerRemaining }),
    trainsBetween,

    /**
     * @param {{ train: string, from: string, to: string, date: string, departure: string, arrival: string }} scheduled
     *        our scheduled times as "HH:MM"
     */
    async verify(scheduled) {
      const checkedAt = new Date().toISOString();
      const provider = { name: 'RailRadar', kind: 'crowd-powered, unofficial', official: false };
      if (!key) return { status: 'not_configured', provider, checkedAt };
      if (!TRAIN.test(scheduled.train) || !STATION.test(scheduled.from) || !STATION.test(scheduled.to) || !DATE.test(scheduled.date)) {
        return { status: 'invalid_request', provider, checkedAt };
      }
      let trains;
      try {
        trains = await trainsBetween(scheduled.from, scheduled.to, scheduled.date);
      } catch (error) {
        return { status: 'unavailable', reason: error.code ?? 'PROVIDER_ERROR', message: error.message, provider, checkedAt };
      }
      const match = trains.find(t => t.number === scheduled.train);
      if (!match) return { status: 'not_listed', provider, checkedAt };
      const hhmm = value => (typeof value === 'string' ? value.slice(0, 5) : null);
      const differences = [];
      if (hhmm(match.departure) && hhmm(match.departure) !== scheduled.departure) differences.push({ field: 'departure', ours: scheduled.departure, provider: hhmm(match.departure) });
      if (hhmm(match.arrival) && hhmm(match.arrival) !== scheduled.arrival) differences.push({ field: 'arrival', ours: scheduled.arrival, provider: hhmm(match.arrival) });
      return { status: differences.length === 0 ? 'consistent' : 'differs', differences, provider, checkedAt };
    }
  };
}

// One client per process, so the monthly budget and the response cache are shared by planning, capabilities and verify.
let shared = null;
export function getSharedRailRadarClient(env = process.env) {
  if (!shared) shared = createRailRadarClient({ env });
  return shared;
}

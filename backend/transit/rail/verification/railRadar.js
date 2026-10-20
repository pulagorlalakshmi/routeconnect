// RailRadar client (https://railradar.in/docs): scheduled trains between stations, used for scheduled train search
// (sources/rail/railRadarSource.js) and for the optional verify endpoint.
//
//   RAILRADAR_API_KEY / RAILRADAR_BACKUP_API_KEY, RAILRADAR_ACTIVE_KEY, RAILRADAR_KEY_FAILOVER,
//   RAILRADAR_MONTHLY_REQUEST_BUDGET    - see railRadarCredentials.js (keys never sent to the browser, never logged)
//   RAILRADAR_API_BASE=https://api.railradar.in/v1
//
// RailRadar describes itself as an independent, crowd-powered service not affiliated with Indian Railways, IRCTC or
// NTES, so a match is reported as "consistent with RailRadar", never as official or live confirmation. Only the
// scheduled timetable search (live=false) is used. Results are cached so one question is never asked twice in a while.
import { createTtlCache } from '../../sources/sourceRunner.js';
import { createCredentialManager } from './railRadarCredentials.js';

const DEFAULT_BASE = 'https://api.railradar.in/v1';
const STATION = /^[A-Z]{1,5}$/;
const TRAIN = /^\d{5}$/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;

export function createRailRadarClient({ env = process.env, fetchImpl = null, cache = createTtlCache({ ttlMs: 6 * 3600 * 1000, max: 300 }), now } = {}) {
  // Under the Node test runner, real keys never reach the network: tests must pass their own fetchImpl. This keeps
  // the test suite from spending the (small) monthly request quota.
  const underTest = Boolean(process.env.NODE_TEST_CONTEXT) && !fetchImpl;
  const credentials = createCredentialManager({ env, disabled: underTest, ...(now ? { now } : {}) });
  fetchImpl = fetchImpl ?? fetch;
  const base = (env.RAILRADAR_API_BASE || DEFAULT_BASE).replace(/\/+$/, '');

  // One request with the current credential. A rejected credential (401/403, failover "auth" or "quota") or a rate-limited
  // one (429, failover "quota") hands over to the other credential and the request is retried ONCE. With failover "off"
  // these answers are reported as they are.
  async function request(url, attempt = 0) {
    const { credentialId, authorization } = credentials.acquire();
    let response;
    try {
      response = await fetchImpl(url, { headers: { Authorization: authorization, Accept: 'application/json' }, signal: AbortSignal.timeout(8000) });
    } catch (error) {
      const timedOut = error?.name === 'TimeoutError' || error?.name === 'AbortError';
      throw Object.assign(new Error(timedOut ? 'RailRadar did not answer in time.' : 'RailRadar could not be reached.'), { code: timedOut ? 'TIMEOUT' : 'NETWORK' });
    }
    const remaining = response.headers?.get?.('x-ratelimit-remaining-month');
    // A successful answer that used the allowance up is still used; the next request goes to the other credential.
    if (remaining !== null && remaining !== undefined && remaining !== '') credentials.recordQuota(credentialId, Number(remaining));
    if (response.status === 401 || response.status === 403) {
      if (credentials.reject(credentialId) && attempt === 0) return request(url, attempt + 1);
      throw Object.assign(new Error('RailRadar rejected the API key.'), { code: 'UNAUTHORIZED' });
    }
    if (response.status === 429) {
      if (credentials.rateLimited(credentialId, Number(response.headers?.get?.('retry-after'))) && attempt === 0) return request(url, attempt + 1);
      throw Object.assign(new Error('RailRadar rate limit reached; try again later.'), { code: 'RATE_LIMITED' });
    }
    return response;
  }

  /**
   * Scheduled trains between two station codes on `date` (the date at the FROM station), live=false (timetable only).
   * byCity: also stations in the same city (e.g. Secunderabad, Hyderabad, Kacheguda) in one request.
   * Each train: { number, name, type, runDays (at the train's origin), from:{code,name,departure,day}, to:{code,name,arrival,day},
   *               distanceKm, durationMinutes, haltsBetween }
   */
  const inFlight = new Map();
  async function trainsBetween(from, to, date, { byCity = false } = {}) {
    // The cache is shared by all credentials: an answer is about the timetable, not about whose key fetched it.
    const cacheKey = `${from}|${to}|${date}|${byCity ? 'city' : 'station'}`;
    const hit = cache.get(cacheKey);
    if (hit) return hit;
    // Identical questions asked at the same time (e.g. two searches, or a search and the verify endpoint) share one request.
    if (inFlight.has(cacheKey)) return inFlight.get(cacheKey);
    const pending = fetchTrains(from, to, date, byCity, cacheKey).finally(() => inFlight.delete(cacheKey));
    inFlight.set(cacheKey, pending);
    return pending;
  }

  async function fetchTrains(from, to, date, byCity, cacheKey) {
    const url = `${base}/trains/between/${encodeURIComponent(from)}/${encodeURIComponent(to)}?date=${encodeURIComponent(date)}&live=false${byCity ? '&byCity=true' : ''}`;
    const response = await request(url);
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
    // A credential is configured (it may still be rejected or out of allowance: see availability()).
    get configured() { return credentials.availability().code !== 'NOT_CONFIGURED'; },
    // Whether a request may be made right now, and why not (no key, rejected key, allowance used up).
    availability: () => credentials.availability(),
    // Safe diagnostics: credential presence, state and usage, never key values.
    credentials: () => credentials.summary(),
    budget: () => {
      const summary = credentials.summary();
      const active = summary.credentials.find(c => c.id === summary.active) ?? summary.credentials.find(c => c.id === summary.preferred);
      return { month: new Date().toISOString().slice(0, 7), used: active.usedThisMonth, budget: summary.budgetPerCredential, providerRemaining: active.providerRemaining, active: summary.active, failover: summary.failover };
    },
    trainsBetween,

    /**
     * @param {{ train: string, from: string, to: string, date: string, departure: string, arrival: string }} scheduled
     *        our scheduled times as "HH:MM"
     */
    async verify(scheduled) {
      const checkedAt = new Date().toISOString();
      const provider = { name: 'RailRadar', kind: 'crowd-powered, unofficial', official: false };
      if (credentials.availability().code === 'NOT_CONFIGURED') return { status: 'not_configured', provider, checkedAt };
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

// One client per process, so the request allowance and the response cache are shared by planning, capabilities and verify.
let shared = null;
export function getSharedRailRadarClient(env = process.env) {
  if (!shared) shared = createRailRadarClient({ env });
  return shared;
}

// Runs independent transport sources side by side. Each source is isolated:
//   - not configured  -> reported, never called
//   - not applicable  -> reported (e.g. flights for a 30 km trip), never called
//   - slow            -> cut off at its own timeout; the others still return
//   - throws          -> reported as an error; the others still return
// A source never sees another source's results and nothing here invents data.

export const SOURCE_STATUS = Object.freeze({
  OK: 'ok',
  NOT_CONFIGURED: 'not_configured',
  NOT_APPLICABLE: 'not_applicable',
  TIMEOUT: 'timeout',
  ERROR: 'error'
});

function withTimeout(promise, ms) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(Object.assign(new Error(`timed out after ${ms} ms`), { code: 'SOURCE_TIMEOUT' })), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

/**
 * @param {Array<{ id: string, label: string, mode: string, timeoutMs?: number,
 *                 status(ctx): { configured: boolean, applicable?: boolean, reason?: string },
 *                 search(ctx): Promise<{ trunks?: object[], journeys?: object[], meta?: object }> }>} sources
 * @returns {Promise<{ results: Map<string, {trunks: object[], journeys: object[], meta?: object}>, report: object[] }>}
 */
export async function runSources(sources, ctx, { defaultTimeoutMs = 6000 } = {}) {
  const results = new Map();
  const report = await Promise.all(sources.map(async source => {
    const base = { id: source.id, label: source.label, mode: source.mode };
    let state;
    try {
      state = source.status(ctx);
    } catch (error) {
      return { ...base, status: SOURCE_STATUS.ERROR, message: error.message, count: 0, ms: 0 };
    }
    if (!state.configured) return { ...base, status: SOURCE_STATUS.NOT_CONFIGURED, message: state.reason ?? null, count: 0, ms: 0 };
    if (state.applicable === false) return { ...base, status: SOURCE_STATUS.NOT_APPLICABLE, message: state.reason ?? null, count: 0, ms: 0 };

    const started = performance.now();
    try {
      const output = await withTimeout(Promise.resolve().then(() => source.search(ctx)), source.timeoutMs ?? defaultTimeoutMs);
      const value = { trunks: output?.trunks ?? [], journeys: output?.journeys ?? [], meta: output?.meta };
      results.set(source.id, value);
      return { ...base, status: SOURCE_STATUS.OK, message: null, count: value.trunks.length + value.journeys.length, ms: Math.round(performance.now() - started) };
    } catch (error) {
      const timedOut = error?.code === 'SOURCE_TIMEOUT';
      if (!timedOut) console.error(`Source ${source.id} failed:`, error?.message ?? error);
      return { ...base, status: timedOut ? SOURCE_STATUS.TIMEOUT : SOURCE_STATUS.ERROR, message: error?.message ?? String(error), count: 0, ms: Math.round(performance.now() - started) };
    }
  }));
  return { results, report };
}

// Small TTL cache for slow-changing lookups (airports near a point, station indexes, operator metadata).
export function createTtlCache({ ttlMs = 6 * 3600 * 1000, max = 500 } = {}) {
  const map = new Map();
  return {
    get(key) {
      const hit = map.get(key);
      if (!hit) return undefined;
      if (Date.now() > hit.expires) { map.delete(key); return undefined; }
      return hit.value;
    },
    set(key, value) {
      if (map.size >= max) map.delete(map.keys().next().value);
      map.set(key, { value, expires: Date.now() + ttlMs });
      return value;
    },
    size: () => map.size
  };
}

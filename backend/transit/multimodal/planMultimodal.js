// Multimodal planning: a layer ABOVE RAPTOR. RAPTOR (planner.js) stays the GTFS bus engine, unchanged; other modes come
// from independent sources and are joined around the origin and destination here.
//
//   resolve places (GTFS stops; coordinates pass through)
//     -> GTFS buses: RAPTOR, as one source (wider candidate pool than before; nothing else changes)
//     -> rail / flights / private buses: independent sources, in parallel, each with its own timeout
//     -> compose trunk legs into door-to-door journeys (estimated walk / local ride + station/airport buffers)
//     -> shortlist: same-vehicle dedupe, Pareto, Best Path Rating, clustering, diverse selection, labels
// A failing or slow source only removes its own options; buses still work if rail fails, and vice versa.
import { handlePlanRequest } from '../routing/planner.js';
import { getRoutingConfig } from '../routing/config.js';
import { getTransitNetwork } from '../routing/dataLoader.js';
import { getFareConfig } from '../fare/fareConfig.js';
import { haversineMeters } from '../routing/geo.js';
import { parseClockTime } from '../routing/serviceCalendar.js';
import { runSources } from '../sources/sourceRunner.js';
import { createRailSource } from '../sources/rail/railSource.js';
import { createDuffelSource } from '../sources/flights/duffelSource.js';
import { createPrivateBusSource } from '../sources/privateBus/privateBusSource.js';
import { composeAroundTrunk, COMPOSE_DEFAULTS } from './compose.js';
import { buildShortlist } from './shortlist.js';

// The bus planner returns more candidates than before so the shortlist has something to diversify.
export const GTFS_CANDIDATE_POOL = 30;

export function defaultSources(env = process.env) {
  return [createRailSource({ env }), createDuffelSource({ env }), createPrivateBusSource()];
}

/**
 * @returns {Promise<{status:number, body:object}>}
 */
export async function handleMultimodalPlanRequest(rawQuery, {
  config = getRoutingConfig(),
  now = new Date(),
  getNetwork = () => getTransitNetwork(),
  sources = defaultSources(),
  fareConfig = getFareConfig()
} = {}) {
  const started = performance.now();

  // 1. Buses (and place resolution) via the existing RAPTOR planner. The network is loaded with the default config
  //    (one shared cache entry); only the candidate pool size differs.
  const busConfig = { ...config, ranking: { ...config.ranking, maxJourneys: GTFS_CANDIDATE_POOL } };
  const gtfsStarted = performance.now();
  let gtfs;
  try {
    gtfs = handlePlanRequest(rawQuery, { config: busConfig, now, getNetwork });
  } catch (error) {
    console.error('GTFS planning failed:', error);
    gtfs = { status: 500, body: { error: 'Journey planning failed.' } };
  }
  const gtfsMs = Math.round(performance.now() - gtfsStarted);
  // Input problems (bad query, unknown place) are returned as before: there is nothing to search.
  if (gtfs.status === 400 || gtfs.status === 404) return gtfs;

  const body = gtfs.status === 200 ? gtfs.body : null;
  const q = body?.query ?? coordinatesFrom(rawQuery);
  const sourceReport = [{
    id: 'gtfs', label: body?.dataset?.name ? `${body.dataset.name}` : 'GTFS timetable', mode: 'bus',
    status: gtfs.status === 200 ? 'ok' : 'error', message: gtfs.status === 200 ? null : gtfs.body?.error ?? null,
    count: body?.journeys?.length ?? 0, ms: gtfsMs
  }];
  if (!q) return gtfs; // no coordinates to search other modes with

  // 2. Other modes, isolated and in parallel.
  const windowMinutes = Number(q.windowMinutes ?? rawQuery?.windowMinutes) || config.defaultWindowMinutes;
  const timeSeconds = parseClockTime(q.time ?? rawQuery?.time) ?? 0;
  const ctx = {
    origin: { lat: Number(q.fromLat), lon: Number(q.fromLng), name: body?.resolved?.from?.name ?? null },
    destination: { lat: Number(q.toLat), lon: Number(q.toLng), name: body?.resolved?.to?.name ?? null },
    date: q.date ?? rawQuery?.date,
    windowStartSeconds: timeSeconds,
    windowEndSeconds: timeSeconds + windowMinutes * 60,
    utcOffset: config.utcOffset ?? '+05:30',
    crowFliesMeters: haversineMeters(Number(q.fromLat), Number(q.fromLng), Number(q.toLat), Number(q.toLng))
  };
  const { results, report } = await runSources(sources, ctx);
  sourceReport.push(...report);

  // 3. Compose trunk legs into complete journeys (bounded per source).
  const composed = [];
  for (const [, result] of results) {
    composed.push(...result.journeys);
    const sequences = result.trunks.map(t => (Array.isArray(t) ? t : [t])).slice(0, COMPOSE_DEFAULTS.maxTrunks);
    for (const sequence of sequences) {
      composed.push(...composeAroundTrunk(sequence, { ...ctx, config, fareConfig }));
    }
  }

  // 4. Shortlist across everything.
  const candidates = [...(body?.journeys ?? []), ...composed];
  const shortlist = buildShortlist(candidates, { ranking: config.ranking });

  const base = body ?? { query: q, warnings: [], journeys: [] };
  const warnings = [...(base.warnings ?? [])];
  if (gtfs.status !== 200) warnings.push({ code: 'BUS_SOURCE_UNAVAILABLE', severity: 'warning', message: 'Bus timetable search failed; other transport sources were still searched.' });
  return {
    status: shortlist.journeys.length > 0 || gtfs.status === 200 ? 200 : gtfs.status,
    body: {
      ...base,
      warnings,
      message: shortlist.journeys.length === 0 ? (base.message ?? 'No journey was found.') : null,
      journeys: shortlist.journeys,
      winners: shortlist.winners,
      sources: sourceReport,
      shortlist: shortlist.stats,
      performance: { ...(base.performance ?? {}), totalMs: Math.round(performance.now() - started), gtfsMs }
    }
  };
}

function coordinatesFrom(raw) {
  const ok = ['fromLat', 'fromLng', 'toLat', 'toLng'].every(key => Number.isFinite(Number(raw?.[key])) && raw?.[key] !== undefined && raw?.[key] !== '');
  return ok ? { fromLat: raw.fromLat, fromLng: raw.fromLng, toLat: raw.toLat, toLng: raw.toLng, date: raw.date, time: raw.time } : null;
}

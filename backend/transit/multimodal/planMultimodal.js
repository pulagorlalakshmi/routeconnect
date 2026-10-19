// Multimodal planning: a layer ABOVE RAPTOR. RAPTOR (planner.js) stays the GTFS bus engine, unchanged; other modes come
// from independent sources and are joined around the origin and destination here.
//
//   resolve places (GTFS stops; coordinates pass through)
//     -> GTFS buses: RAPTOR, as one source (wider candidate pool than before; nothing else changes)
//     -> rail / flights / private buses: independent sources, in parallel, each with its own timeout
//     -> compose trunk legs into door-to-door journeys (estimated walk / local ride + station/airport buffers)
//     -> shortlist: same-vehicle dedupe, Pareto, Best Path Rating, clustering, diverse selection, labels
// A failing or slow source only removes its own options; buses still work if rail fails, and vice versa.
//
// Travel preferences (preferences.js): `modes` is a HARD filter applied to sources and candidates before the shortlist;
// `rank` steers which journeys the shortlist keeps and their order. A requested mode with no configured data source is
// refused (422) rather than silently answered with other modes.
import { handlePlanRequest } from '../routing/planner.js';
import { getRoutingConfig } from '../routing/config.js';
import { getTransitNetwork } from '../routing/dataLoader.js';
import { getFareConfig } from '../fare/fareConfig.js';
import { haversineMeters } from '../routing/geo.js';
import { parseClockTime } from '../routing/serviceCalendar.js';
import { runSources } from '../sources/sourceRunner.js';
import { createRailSource } from '../sources/rail/railSource.js';
import { createRailRadarSource } from '../sources/rail/railRadarSource.js';
import { getSharedRailRadarClient } from '../rail/verification/railRadar.js';
import { createDuffelSource } from '../sources/flights/duffelSource.js';
import { createPrivateBusSource } from '../sources/privateBus/privateBusSource.js';
import { composeAroundTrunk, COMPOSE_DEFAULTS } from './compose.js';
import { createBusFeeder } from './busFeeder.js';
import { buildShortlist } from './shortlist.js';
import { journeyAllowed, parsePreferences, transportModeOf } from './preferences.js';

// The bus planner returns more candidates than before so the shortlist has something to diversify.
export const GTFS_CANDIDATE_POOL = 30;
// How many train options (best first) are also tried with a timetable bus to / from the station.
export const BUS_FEEDER_TRUNKS = 5;

// Scheduled trains come from RailRadar when a key is configured on the server; otherwise from the (licensed-only) imported
// timetable, which stays off until permitted. Never both: one rail source, one set of train results.
export function defaultSources(env = process.env) {
  const rail = env.RAILRADAR_API_KEY?.trim() ? createRailRadarSource({ env, client: getSharedRailRadarClient(env) }) : createRailSource({ env });
  return [rail, createDuffelSource({ env }), createPrivateBusSource()];
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

  // 0. Travel preferences. Train (or any mode) without a configured source cannot be honoured: say so.
  const parsedPreferences = parsePreferences(rawQuery ?? {});
  if (!parsedPreferences.ok) {
    return { status: 400, body: { error: 'Invalid travel preferences.', details: parsedPreferences.errors } };
  }
  const preferences = parsedPreferences.value;
  const configuredModes = new Set(['bus']); // GTFS buses are always searched
  const unavailableReasons = {};
  for (const source of sources) {
    let state = null;
    try { state = source.status({ crowFliesMeters: Number.MAX_SAFE_INTEGER }); } catch { state = null; }
    const mode = transportModeOf(source.mode);
    if (state?.configured) configuredModes.add(mode);
    else if (state?.reason && !unavailableReasons[mode]) unavailableReasons[mode] = state.reason;
  }
  const unavailable = preferences.modes.filter(mode => !configuredModes.has(mode));
  if (unavailable.length > 0) {
    return {
      status: 422,
      body: {
        code: 'MODE_UNAVAILABLE',
        error: unavailable.includes('train')
          ? 'Train journeys are not available yet: no verified railway timetable is connected.'
          : `No data source is available for: ${unavailable.join(', ')}.`,
        reason: unavailableReasons[unavailable[0]] ?? null,
        modes: unavailable
      }
    };
  }
  const modeAllowed = mode => preferences.modes.length === 0 || preferences.modes.includes(transportModeOf(mode));

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
  const placeName = end => body?.resolved?.[end]?.name ?? (typeof rawQuery?.[end] === 'string' && rawQuery[end].trim() !== '' ? rawQuery[end].trim().slice(0, 80) : null);
  const ctx = {
    origin: { lat: Number(q.fromLat), lon: Number(q.fromLng), name: placeName('from') },
    destination: { lat: Number(q.toLat), lon: Number(q.toLng), name: placeName('to') },
    date: q.date ?? rawQuery?.date,
    windowStartSeconds: timeSeconds,
    windowEndSeconds: timeSeconds + windowMinutes * 60,
    utcOffset: config.utcOffset ?? '+05:30',
    crowFliesMeters: haversineMeters(Number(q.fromLat), Number(q.fromLng), Number(q.toLat), Number(q.toLng)),
    config
  };
  const selectedSources = sources.filter(source => modeAllowed(source.mode));
  const { results, report } = await runSources(selectedSources, ctx);
  sourceReport.push(...report);
  for (const source of sources.filter(source => !selectedSources.includes(source))) {
    sourceReport.push({ id: source.id, label: source.label, mode: source.mode, status: 'not_applicable', message: 'Not included in your travel preferences.', count: 0, ms: 0 });
  }

  // 3. Compose trunk legs into complete journeys (bounded per source). Trains may be reached / left by timetable bus
  //    (Bus + Train, Train + Bus, Bus + Train + Bus) when buses are allowed and the bus network is loaded.
  let feeder = null;
  if (modeAllowed('bus') && results.has('rail')) {
    try {
      const network = getNetwork();
      if (network) feeder = createBusFeeder({ network, config, fareConfig, now, utcOffset: ctx.utcOffset });
    } catch (error) {
      console.error('Bus feeder unavailable:', error.message);
    }
  }
  const composed = [];
  for (const [id, result] of results) {
    composed.push(...result.journeys);
    const sequences = result.trunks.map(t => (Array.isArray(t) ? t : [t])).slice(0, COMPOSE_DEFAULTS.maxTrunks);
    sequences.forEach((sequence, i) => {
      // Bus connections only for the strongest few train options: each costs bus-planner searches.
      const withBus = feeder && id === 'rail' && i < BUS_FEEDER_TRUNKS;
      composed.push(...composeAroundTrunk(sequence, {
        ...ctx, config, fareConfig,
        ...(withBus ? { transitAccess: feeder.access, transitEgress: feeder.egress } : {})
      }));
    });
  }

  // 4. Shortlist across everything.
  const candidates = [...(body?.journeys ?? []), ...composed].filter(journey => journeyAllowed(journey, preferences.modes));
  const shortlist = buildShortlist(candidates, { ranking: config.ranking, priority: preferences.rank ?? undefined });

  const base = body ?? { query: q, warnings: [], journeys: [] };
  const warnings = [...(base.warnings ?? [])];
  if (gtfs.status !== 200) warnings.push({ code: 'BUS_SOURCE_UNAVAILABLE', severity: 'warning', message: 'Bus timetable search failed; other transport sources were still searched.' });
  warnings.push(...railWarnings(results.get('rail')?.meta, shortlist.journeys));
  return {
    status: shortlist.journeys.length > 0 || gtfs.status === 200 ? 200 : gtfs.status,
    body: {
      ...base,
      warnings,
      message: shortlist.journeys.length === 0 ? (base.message ?? 'No journey was found.') : null,
      journeys: shortlist.journeys,
      winners: shortlist.winners,
      preferences: { modes: preferences.modes, rank: preferences.rank },
      sources: sourceReport,
      shortlist: shortlist.stats,
      performance: { ...(base.performance ?? {}), totalMs: Math.round(performance.now() - started), gtfsMs }
    }
  };
}

// One short notice about where train times come from, only when a train is actually shown (no repeated warnings).
export function railWarnings(meta, journeys) {
  if (!meta?.source) return [];
  const showsTrain = journeys.some(journey => journey.legs.some(leg => transportModeOf(leg.mode) === 'train'));
  const warnings = [];
  if (showsTrain && meta.source.id === 'railradar') {
    warnings.push({
      code: 'RAIL_SCHEDULED_ONLY', severity: 'info',
      message: 'Train times are scheduled timetable times from RailRadar (an independent service, not Indian Railways). Not live running status. Confirm on NTES (139) before travelling.'
    });
  } else if (showsTrain) {
    const age = meta.freshness?.ageDays;
    const stale = meta.freshness?.status === 'stale';
    warnings.push({
      code: stale ? 'RAIL_SNAPSHOT_STALE' : 'RAIL_SCHEDULED_ONLY',
      severity: stale ? 'warning' : 'info',
      message: `Train times are scheduled times from an unofficial timetable snapshot of ${meta.source.snapshotDate}`
        + (stale ? ` (${age} days old): trains changed since then may be missing or differ.` : '.')
        + ' Not live running status. Confirm on NTES (139) before travelling.'
    });
  }
  if (meta.dateCovered === false) {
    warnings.push({ code: 'RAIL_DATE_NOT_COVERED', severity: 'warning', message: 'The railway timetable snapshot does not cover this date, so no trains are shown for it.' });
  }
  return warnings;
}

function coordinatesFrom(raw) {
  const ok = ['fromLat', 'fromLng', 'toLat', 'toLng'].every(key => Number.isFinite(Number(raw?.[key])) && raw?.[key] !== undefined && raw?.[key] !== '');
  return ok ? { fromLat: raw.fromLat, fromLng: raw.fromLng, toLat: raw.toLat, toLng: raw.toLng, date: raw.date, time: raw.time } : null;
}

// Multimodal planning: a layer ABOVE RAPTOR. RAPTOR (planner.js) stays the GTFS bus engine, unchanged; other modes come
// from independent sources and are joined around the origin and destination here.
//
//   resolve places (GTFS stops; coordinates pass through)
//     -> GTFS buses: RAPTOR, as one source (wider candidate pool than before; nothing else changes)
//     -> rail / flights / private buses: independent sources, in parallel, each with its own timeout. The rail source is
//        given the bus network, so it can ask about transfer HUBS reachable by bus (railHubs.js), within its budget
//     -> compose trunk legs into door-to-door journeys (walk / estimated local ride / timetable bus to and from the
//        stations + station buffers), every connection checked on absolute times (compose.js, busFeeder.js)
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
import { createRailRadarSource, RAIL_MAX_TRUNKS } from '../sources/rail/railRadarSource.js';
import { getSharedRailRadarClient } from '../rail/verification/railRadar.js';
import { createDuffelSource } from '../sources/flights/duffelSource.js';
import { createPrivateBusSource } from '../sources/privateBus/privateBusSource.js';
import { composeAroundTrunk, COMPOSE_DEFAULTS } from './compose.js';
import { createBusFeeder } from './busFeeder.js';
import { buildShortlist } from './shortlist.js';
import { journeyAllowed, parsePreferences, transportModeOf } from './preferences.js';
import { attachCandidateDepartures, groupJourneysByRoute } from '../routing/routeGrouping.js';
import { resolvePlace } from '../routing/placeSearch.js';
import { resolveNationalPlace } from '../routing/nationalPlaces.js';
import { busStopsNear } from './railHubs.js';

// The bus planner returns more candidates than before so the shortlist has something to diversify.
export const GTFS_CANDIDATE_POOL = 30;
// How many train options (best first) are also tried with a timetable bus to / from the station. Trains at a transfer
// hub reached by bus are always tried (without the bus they cannot be reached at all).
export const BUS_FEEDER_TRUNKS = 5;
// A hub reached BY BUS (not the station nearest the traveller) is offered as a ride-only connection only up to this
// distance: a two-hour auto ride to a junction 36 km away is not a journey anyone should be shown.
export const HUB_RIDE_MAX_METERS = 15000;
// Most public-transport changes in a composed (bus + train) journey; ROUTECONNECT_MULTIMODAL_MAX_TRANSFERS overrides.
export const MAX_MIXED_TRANSFERS = 2;
export const maxMixedTransfers = (env = process.env) => {
  const n = Number(env.ROUTECONNECT_MULTIMODAL_MAX_TRANSFERS);
  return Number.isInteger(n) && n >= 1 && n <= 4 ? n : MAX_MIXED_TRANSFERS;
};

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
  fareConfig = getFareConfig(),
  maxTransfersMixed = maxMixedTransfers(),
  resolveNational = resolveNationalPlace
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

  // 0b. A typed place that is not a bus stop (Mumbai, a railway station code...) is resolved to coordinates from the
  //     nationwide reference, so trains are still searched; the bus planner then simply finds no bus there.
  const national = resolveOutsideBusDataset(rawQuery ?? {}, getNetwork, resolveNational);
  rawQuery = national.raw;

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

  const body = gtfs.status === 200 ? { ...gtfs.body, resolved: { ...(gtfs.body.resolved ?? {}), ...national.resolved } } : null;
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
  let network = null;
  try { network = getNetwork(); } catch { network = null; }
  const utcOffset = config.utcOffset ?? '+05:30';
  const date = q.date ?? rawQuery?.date;
  const ctx = {
    origin: { lat: Number(q.fromLat), lon: Number(q.fromLng), name: placeName('from') },
    destination: { lat: Number(q.toLat), lon: Number(q.toLng), name: placeName('to') },
    date,
    windowStartSeconds: timeSeconds,
    windowEndSeconds: timeSeconds + windowMinutes * 60,
    utcOffset,
    crowFliesMeters: haversineMeters(Number(q.fromLat), Number(q.fromLng), Number(q.toLat), Number(q.toLng)),
    config,
    // For transfer-hub discovery (rail source): the bus network, whether buses may carry part of the journey, and the
    // best bus arrival already found (a hub that cannot come close to it is not worth a timetable request).
    network,
    busAllowed: modeAllowed('bus') && Boolean(network),
    bestBusArrivalSeconds: bestArrivalSeconds(body?.journeys ?? [], date, utcOffset)
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
  if (modeAllowed('bus') && results.has('rail') && network) {
    try {
      feeder = createBusFeeder({ network, config, fareConfig, now, utcOffset: ctx.utcOffset });
    } catch (error) {
      console.error('Bus feeder unavailable:', error.message);
    }
  }
  const composeStarted = performance.now();
  const composed = [];
  let mixedOverTransferLimit = 0;
  for (const [id, result] of results) {
    composed.push(...result.journeys);
    const sequences = result.trunks.map(t => (Array.isArray(t) ? t : [t])).slice(0, id === 'rail' ? RAIL_MAX_TRUNKS : COMPOSE_DEFAULTS.maxTrunks);
    sequences.forEach((sequence, i) => {
      // Bus connections for the strongest few train options (each costs bus-planner searches), and always for trains
      // at a hub that is reached by bus.
      const viaBusHub = sequence[0].planning?.pair?.access === 'bus' || sequence.at(-1).planning?.pair?.egress === 'bus';
      const withBus = feeder && id === 'rail' && (i < BUS_FEEDER_TRUNKS || viaBusHub);
      const pair = id === 'rail' ? { access: sequence[0].planning?.pair?.access, egress: sequence.at(-1).planning?.pair?.egress } : {};
      for (const journey of composeAroundTrunk(sequence, {
        ...ctx, config, fareConfig,
        ...(pair.access === 'bus' ? { maxAccessRideMeters: HUB_RIDE_MAX_METERS } : {}),
        ...(pair.egress === 'bus' ? { maxEgressRideMeters: HUB_RIDE_MAX_METERS } : {}),
        ...(withBus ? { transitAccess: feeder.access, transitEgress: feeder.egress } : {}),
        ...(feeder && id === 'rail' ? { transitTransfer: feeder.transfer } : {})
      })) {
        // At most `maxTransfersMixed` changes between public-transport services in a composed journey.
        if (journey.transfers > maxTransfersMixed) { mixedOverTransferLimit++; continue; }
        composed.push(journey);
      }
    });
  }
  const composeMs = Math.round(performance.now() - composeStarted);

  // 4. Shortlist across everything.
  const candidates = [...(body?.journeys ?? []), ...composed].filter(journey => journeyAllowed(journey, preferences.modes));
  const shortlist = buildShortlist(candidates, { ranking: config.ranking, priority: preferences.rank ?? undefined });
  attachCandidateDepartures(shortlist.journeys, candidates);

  const base = body ?? { query: q, warnings: [], journeys: [] };
  const warnings = [...(base.warnings ?? [])];
  if (gtfs.status !== 200) warnings.push({ code: 'BUS_SOURCE_UNAVAILABLE', severity: 'warning', message: 'Bus timetable search failed; other transport sources were still searched.' });
  warnings.push(...railWarnings(results.get('rail')?.meta, shortlist.journeys));
  const railReport = sourceReport.find(source => source.id === 'rail') ?? null;
  const busCoverage = network ? { origin: busStopsNear(network, ctx.origin), destination: busStopsNear(network, ctx.destination) } : null;
  const searchCoverage = describeCoverage({ journeys: shortlist.journeys, candidates, railReport, railMeta: results.get('rail')?.meta, windowMinutes, modes: preferences.modes, busCoverage });
  warnings.push(...coverageWarnings(searchCoverage));
  return {
    status: shortlist.journeys.length > 0 || gtfs.status === 200 ? 200 : gtfs.status,
    body: {
      ...base,
      warnings,
      message: shortlist.journeys.length === 0 ? noJourneyMessage(searchCoverage, base.message) : null,
      searchCoverage,
      ...(results.get('rail')?.meta?.coverage ? { railSearch: publicRailCoverage(results.get('rail').meta.coverage) } : {}),
      journeys: shortlist.journeys,
      groupedJourneys: groupJourneysByRoute(shortlist.journeys),
      winners: shortlist.winners,
      preferences: { modes: preferences.modes, rank: preferences.rank },
      sources: sourceReport,
      shortlist: shortlist.stats,
      performance: {
        ...(base.performance ?? {}), totalMs: Math.round(performance.now() - started), gtfsMs, composeMs,
        busFeederCalls: feeder?.calls ?? 0, mixedOverTransferLimit
      }
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

// Names the bus timetable does not know -> coordinates from the nationwide station / place reference.
// A name the bus timetable resolves (whole-word) is left to it. Returns the query to plan with and what was resolved.
export function resolveOutsideBusDataset(raw, getNetwork, resolveNational) {
  const out = { ...raw };
  const resolved = {};
  let network = null;
  try { network = getNetwork(); } catch { network = null; }
  for (const [end, latKey, lngKey] of [['from', 'fromLat', 'fromLng'], ['to', 'toLat', 'toLng']]) {
    const text = typeof raw[end] === 'string' ? raw[end].trim() : '';
    if (!text || raw[latKey] !== undefined || raw[lngKey] !== undefined) continue;
    // An official station code typed in capitals ("MAS", "NDLS") means that station, not a bus stop that starts with it.
    const typedCode = /^[A-Z]{2,5}$/.test(text);
    const place = resolveNational ? resolveNational(text) : null;
    if (!(typedCode && place?.code === text) && network && resolvePlace(network, text)) continue;
    if (!place) continue;
    out[latKey] = String(place.lat);
    out[lngKey] = String(place.lon);
    out[end] = place.name;
    resolved[end] = { query: text, name: place.name, lat: place.lat, lon: place.lon, matchedBy: place.matchedBy, kind: place.kind, code: place.code ?? null, source: 'openstreetmap' };
  }
  return { raw: out, resolved };
}

// Best arrival among the bus journeys, in seconds from 00:00 of the search date (the rail source's time base).
export function bestArrivalSeconds(journeys, date, utcOffset) {
  if (!date || journeys.length === 0) return null;
  const midnight = Date.parse(`${date}T00:00:00${utcOffset}`);
  if (!Number.isFinite(midnight)) return null;
  return Math.min(...journeys.map(journey => (Date.parse(journey.arrivalTime) - midnight) / 1000));
}

const familyOf = leg => transportModeOf(leg.mode);
// direct_bus | direct_train | mixed (bus and train) | other, from the public-transport legs of a journey.
export function journeyKind(journey) {
  const families = new Set(journey.legs.map(familyOf).filter(Boolean));
  if (families.has('bus') && families.has('train')) return 'mixed';
  if (families.size === 1 && families.has('bus')) return 'direct_bus';
  if (families.size === 1 && families.has('train')) return 'direct_train';
  return 'other';
}

/**
 * What was searched and found, so an empty or partial result is explained truthfully:
 * how many bus-only, train-only and bus + train journeys exist, whether the railway search ran, failed, or was limited
 * (by the per-search request cap, the monthly allowance or time), and how much of it was asked.
 */
export function describeCoverage({ journeys, candidates, railReport, railMeta, windowMinutes, modes = [], busCoverage = null }) {
  const count = list => list.reduce((acc, journey) => { acc[journeyKind(journey)]++; return acc; }, { direct_bus: 0, direct_train: 0, mixed: 0, other: 0 });
  const shown = count(journeys);
  const all = count(candidates);
  const rail = railMeta?.coverage ?? null;
  return {
    windowMinutes,
    modes,
    shown: { bus: shown.direct_bus, train: shown.direct_train, mixed: shown.mixed },
    found: { bus: all.direct_bus, train: all.direct_train, mixed: all.mixed },
    rail: {
      status: railReport?.status ?? 'not_searched', // ok | not_configured | not_applicable | timeout | error | not_searched
      message: railReport?.message ?? null,
      limitedBy: rail?.limitedBy ?? null, // budget | quota | time | provider_error | null
      pairsChecked: rail?.pairs?.length ?? 0,
      pairsSkipped: rail ? rail.skipped.budget + rail.skipped.time : 0,
      requests: rail?.requests ?? null,
      hubSearch: rail?.hubSearch ?? null,
      // Railway station near each end: ok | expanded (only a farther one) | none (no station in the reference data).
      stations: rail?.stations ?? null,
      trainsReturned: rail ? rail.pairs.reduce((n, p) => n + (p.trains ?? 0), 0) : null,
      quotaLow: Boolean(rail?.quotaLow)
    },
    // Is each end inside the bus timetable (APSRTC GTFS) at all?
    bus: busCoverage
  };
}

export function coverageWarnings(coverage) {
  const warnings = [];
  const { rail } = coverage;
  if (rail.status === 'ok' && rail.pairsSkipped > 0 && (rail.limitedBy === 'budget' || rail.limitedBy === 'quota' || rail.limitedBy === 'time')) {
    const why = rail.limitedBy === 'quota'
      ? 'the railway data allowance for this month is nearly used up'
      : rail.limitedBy === 'time'
        ? 'the railway data service answered slowly'
        : 'each search may only make a few railway data requests';
    warnings.push({
      code: 'RAIL_SEARCH_LIMITED', severity: 'warning',
      message: `Train connections were only partly checked (${rail.pairsChecked} station pair${rail.pairsChecked === 1 ? '' : 's'} checked, ${rail.pairsSkipped} not checked) because ${why}. More train or bus + train options may exist.`
    });
  }
  if (coverage.shown.mixed > 0 && coverage.found.bus === 0 && coverage.found.train === 0) {
    warnings.push({ code: 'MIXED_ONLY', severity: 'info', message: 'No single bus or train covers this trip in the searched window. These options combine bus and train.' });
  }
  return warnings;
}

// Never "no routes" when only part of the search could run: say what was and was not checked.
export function noJourneyMessage(coverage, fallback) {
  const { rail } = coverage;
  const window = `in the ${coverage.windowMinutes}-minute search window`;
  const trainOnly = coverage.modes?.length === 1 && coverage.modes[0] === 'train';
  const busOnly = coverage.modes?.length === 1 && coverage.modes[0] === 'bus';
  const what = trainOnly ? 'scheduled train (with walking or local-ride connections)' : 'direct or bus + train journey';
  const outsideBus = coverage.bus && (!coverage.bus.origin || !coverage.bus.destination);
  const busNote = outsideBus ? ' Bus timetables are only available for APSRTC (Andhra Pradesh) services, so buses could not be checked for this trip.' : '';
  if (busOnly) return outsideBus ? 'Bus timetables are only available for APSRTC (Andhra Pradesh) services, and this trip is outside them.' : (fallback ?? 'No journey was found.');
  if (rail.status === 'ok' && rail.limitedBy && rail.limitedBy !== 'provider_error' && rail.pairsSkipped > 0) {
    return rail.limitedBy === 'quota'
      ? `No ${what} was found among the connections checked ${window}. The monthly railway data allowance is nearly used up, so only part of the train search could run: this does not prove there is no route.${busNote}`
      : `No ${what} was found among the connections checked ${window}. The train search was limited, so this does not prove there is no route: try again later, or a different time.${busNote}`;
  }
  const noStation = rail.stations && Object.entries(rail.stations).filter(([, state]) => state === 'none').map(([end]) => end);
  if (noStation?.length) {
    return `There is no railway station near your ${noStation.join(' or ')} in the station data RouteConnect uses, so trains could not be searched.${busNote}`;
  }
  if (rail.status === 'ok' && rail.pairsChecked > 0 && rail.trainsReturned === 0) {
    return `No trains were found between the stations checked for this date.${busNote}`;
  }
  if (rail.status === 'error' || rail.status === 'timeout') {
    return trainOnly
      ? 'Scheduled trains could not be checked right now (the railway data service did not answer). Please try again shortly.'
      : `No bus journey was found ${window}, and scheduled trains could not be checked right now (the railway data service did not answer).`;
  }
  if (rail.status === 'ok') return trainOnly ? `No ${what} was found ${window}.` : `No direct bus, direct train or bus + train journey was found ${window}.${busNote}`;
  return fallback ?? 'No journey was found.';
}

// The coverage report as sent to the browser: what was asked and why searching stopped (no keys, no internals).
export function publicRailCoverage(coverage) {
  const { pairs, requests, skipped, hubSearch, hubs, via, limitedBy, quotaLow, quotaLimited, elapsedMs, stations, cityTerminals, busCoverage } = coverage;
  return {
    pairs: pairs.map(({ from, to, date, role, cost, trains, inWindow, error, byCity }) => ({ from, to, date, role, cost, byCity: Boolean(byCity), trains: trains ?? null, inWindow: inWindow ?? null, error: error ?? null })),
    requests, skipped, hubSearch, hubs, via, limitedBy, quotaLow: Boolean(quotaLow), quotaLimited: Boolean(quotaLimited), elapsedMs,
    stations: stations ?? null, cityTerminals: cityTerminals ?? null, busCoverage: busCoverage ?? null
  };
}

function coordinatesFrom(raw) {
  const ok = ['fromLat', 'fromLng', 'toLat', 'toLng'].every(key => Number.isFinite(Number(raw?.[key])) && raw?.[key] !== undefined && raw?.[key] !== '');
  return ok ? { fromLat: raw.fromLat, fromLng: raw.fromLng, toLat: raw.toLat, toLng: raw.toLng, date: raw.date, time: raw.time } : null;
}

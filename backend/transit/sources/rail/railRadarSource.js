// Scheduled trains from the RailRadar API (https://railradar.in/docs), as a rail source for the multimodal planner.
//
//   RAILRADAR_API_KEY                   server-side only (backend/.env); never logged or sent to the browser
//   RAILRADAR_MONTHLY_REQUEST_BUDGET    this process stops calling RailRadar at the budget (free tier: 100/month)
//   RAILRADAR_MAX_REQUESTS_PER_SEARCH   new (uncached) requests ONE search may make (default 3; 1 = direct trains only)
//   ROUTECONNECT_RAIL_HUB_SEARCH=false  ask only about the station nearest each end (no transfer hubs)
//
// A search first asks about the ANCHOR pair (the main station near each end: direct trains). Only when that is not
// enough - too few trains in the window, or a transfer hub promises a clearly earlier arrival - does it ask about a few
// HUB pairs (multimodal/railHubs.js: large stations reachable by timetable bus, e.g. Narasaraopet -> bus -> Vijayawada
// Jn -> train). Cached pairs are free and asked first; new requests are capped per search, run two at a time, stop at a
// deadline and as soon as enough trains are found. Station pair and date answers are cached (and shared by concurrent
// searches), so a repeated search costs nothing. Only trains RailRadar returns for the searched date are
// used: numbers, names, stations, scheduled times and running days come from the response; nothing is invented.
// Not used: live running status, fares, seats. Station coordinates (for walking / local-ride access) come from the
// OpenStreetMap railway network (ODbL) that RouteConnect already holds: the built graph, or the seed shipped with the
// code, so scheduled trains work even when the Estimated Rail explorer is off or failed to prepare (railStations.js).
import { haversineMeters } from '../../routing/geo.js';
import { estimateLocalRide, estimateWalk } from '../../routing/accessEgress.js';
import { getRoutingConfig } from '../../routing/config.js';
import { dayNumberToIso, formatLocalDateTime, isoToDayNumber, weekdayIndex } from '../../routing/serviceCalendar.js';
import { COMPOSE_DEFAULTS } from '../../multimodal/compose.js';
import { createRailRadarClient } from '../../rail/verification/railRadar.js';
import { getRailStations, recordTimetableEvidence } from '../../railNetwork/railStations.js';
import { paretoRail } from '../../rail/railSearch.js';
import { operatorIdentity } from '../operators.js';
import { busReachFrom, busStopsNear, hubCandidates, rankStationPairs, viaJunctions, HUB_DEFAULTS } from '../../multimodal/railHubs.js';

const DAY = 86400;
const WEEKDAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
const API_DAYS = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'];
export const RAILRADAR_SOURCE = Object.freeze({ id: 'railradar', name: 'RailRadar', type: 'third_party_api', url: 'https://railradar.in' });
const MIN_TRIP_METERS = 8000;
export const RAIL_MAX_TRUNKS = 10;
const MAX_TRUNKS = COMPOSE_DEFAULTS.maxTrunks;

const clockSeconds = text => {
  const m = /^(\d{1,2}):(\d{2})$/.exec(text ?? '');
  return m ? Number(m[1]) * 3600 + Number(m[2]) * 60 : null;
};

// Stations with a code from the mapped network, indexed by code (first one wins).
function stationIndex(graph) {
  const byCode = new Map();
  for (const s of graph?.stations ?? []) if (s.code && !byCode.has(s.code)) byCode.set(s.code, s);
  return byCode;
}

// The station a search is anchored on. Within JUNCTION_REACH_METERS, the largest nearby interchange (station size from
// railStations.js, traded against distance: a station 7 km away must be clearly larger than one 2 km away), e.g.
// Secunderabad Jn for central Hyderabad or Chennai Central for central Chennai; otherwise the nearest station (a halt
// only if nothing else is near). Other terminals of the same city are covered by one byCity question (Stage B below).
// A station NAMED after the place the traveller is in (Hyderabad Deccan, Mumbai Central, New Delhi, Guwahati) is that
// place's own station and counts as a major one: station identity, not a list of cities.
const JUNCTION_REACH_METERS = 8000;
const MAJOR_IMPORTANCE = 0.5;
const PLACE_STATION_BONUS = 0.25;
const placeWord = name => String(name ?? '').toLowerCase().replace(/\(.*?\)/g, ' ').replace(/[^a-z\s]/g, ' ').trim().split(/\s+/)[0] ?? '';
export const namedAfterPlace = (station, placeName) => {
  const word = placeWord(placeName);
  return word.length >= 4 && [station.name, ...(station.aliases ?? [])].some(n => String(n).toLowerCase().split(/[^a-z]+/).includes(word));
};
export function anchorStation(graph, point, radiusMeters) {
  const near = graph?.nearby
    ? graph.nearby(point.lat, point.lon, radiusMeters).filter(e => e.station.code).map(e => ({ s: e.station, m: e.meters }))
    : (graph?.stations ?? []).filter(s => s.code).map(s => ({ s, m: haversineMeters(point.lat, point.lon, s.lat, s.lon) })).filter(e => e.m <= radiusMeters).sort((a, b) => a.m - b.m);
  const reach = Math.min(JUNCTION_REACH_METERS, radiusMeters);
  const importanceOf = graph?.importanceOf && (s => Math.min(1, graph.importanceOf(s) + (point.name && namedAfterPlace(s, point.name) ? PLACE_STATION_BONUS : 0)));
  const value = e => importanceOf(e.s) - e.m / 20000;
  const major = importanceOf
    ? near.filter(e => e.m <= reach && importanceOf(e.s) >= MAJOR_IMPORTANCE).sort((a, b) => value(b) - value(a) || a.m - b.m)[0]
    : near.find(e => /junction|\bjn\b/i.test(e.s.name) && e.m <= reach);
  const station = near.find(e => e.s.kind === 'station');
  return major ?? station ?? near[0] ?? null;
}

// Does the train run on `searchDate` at its boarding station? RailRadar already answers per date; this re-checks the
// running days it returns (shifted to the day the train started), so a train is never offered on a day it does not run.
export function runsOnDate(train, searchDate) {
  if (!Array.isArray(train.runDays) || train.runDays.length === 0) return true; // no pattern given: the provider's date answer stands
  const started = isoToDayNumber(searchDate) - Math.max(0, (train.from?.day ?? 1) - 1);
  return train.runDays.includes(API_DAYS[weekdayIndex(started)]);
}

// Running days at the boarding station: the train's origin days shifted by the journey day there.
export function runningDaysAtBoarding(runDays, boardingDay) {
  if (!Array.isArray(runDays)) return null;
  const shift = Math.max(0, boardingDay - 1);
  return WEEKDAYS.filter((_, i) => runDays.includes(API_DAYS[(i - shift + 7 * 4) % 7]));
}

/**
 * RailRadar trains (for one date at the from station) -> trunk sequences for composeAroundTrunk.
 * accessSecondsFor / egressSecondsFor: planning estimate of getting to the boarding station / from the alighting station
 * (default: walk or local ride by distance; a hub reached by timetable bus passes its RAPTOR-based estimate). They only
 * choose which trains are worth composing: the real access and egress legs are built and validated later.
 * Each trunk carries `planning` { doorDepartureSeconds, doorArrivalSeconds, inWindow } (never copied into a journey).
 */
export function trainsToTrunks(trains, {
  ctx, searchDate, stations, anchors, accessSeconds, operatorInfo, maxTrunks = MAX_TRUNKS,
  accessSecondsFor = place => accessSeconds(haversineMeters(ctx.origin.lat, ctx.origin.lon, place.lat, place.lon)),
  egressSecondsFor = place => accessSeconds(haversineMeters(place.lat, place.lon, ctx.destination.lat, ctx.destination.lon)),
  fallbackToLater = true
}) {
  const searchDay = isoToDayNumber(searchDate);
  const anchorDay = isoToDayNumber(ctx.date);
  const offset = (searchDay - anchorDay) * DAY; // trains fetched for the day after the search date (late searches)
  const before = COMPOSE_DEFAULTS.bufferBeforeSeconds.rail;
  const after = COMPOSE_DEFAULTS.bufferAfterSeconds.rail;
  const place = (code, name, fallback) => {
    const s = stations.get(code);
    return s ? { type: 'station', name: name ?? s.name, code, lat: s.lat, lon: s.lon } : { type: 'station', name: name ?? code, code, lat: fallback.lat, lon: fallback.lon };
  };
  const candidates = [];
  for (const t of trains) {
    if (!runsOnDate(t, searchDate)) continue;
    const dep = clockSeconds(t.from.departure);
    const arr = clockSeconds(t.to.arrival);
    if (dep === null || arr === null) continue;
    const depAbs = offset + dep;
    const arrAbs = offset + (t.to.day - t.from.day) * DAY + arr;
    if (arrAbs <= depAbs) continue;
    const from = place(t.from.code, t.from.name, anchors.from);
    const to = place(t.to.code, t.to.name, anchors.to);
    const access = accessSecondsFor(from);
    const egress = egressSecondsFor(to);
    const doorDeparture = depAbs - before - access;
    const doorArrival = arrAbs + after + egress;
    candidates.push({ t, from, to, depAbs, arrAbs, doorDeparture, doorArrival, transfers: 0 });
  }
  const inWindow = candidates.filter(c => c.doorDeparture >= ctx.windowStartSeconds && c.doorDeparture <= ctx.windowEndSeconds);
  // Sparse routes: nothing in the window -> the next trains that day (their real times are shown).
  const chosen = inWindow.length > 0 ? inWindow : fallbackToLater ? candidates.filter(c => c.doorDeparture > ctx.windowEndSeconds) : [];
  const windowed = inWindow.length > 0;
  return paretoRail(chosen)
    .sort((a, b) => a.doorArrival - b.doorArrival || b.doorDeparture - a.doorDeparture)
    .slice(0, maxTrunks)
    .map(c => {
      const runStartDay = searchDay - (c.t.from.day - 1);
      return [{
        mode: 'rail',
        planning: { doorDepartureSeconds: c.doorDeparture, doorArrivalSeconds: c.doorArrival, inWindow: windowed, arrivalSeconds: c.arrAbs, departureSeconds: c.depAbs },
        operatorInfo,
        operator: operatorInfo.name,
        trainNumber: c.t.number,
        trainName: c.t.name,
        displayName: `${c.t.number}${c.t.name ? ` ${c.t.name}` : ''}`,
        headsign: null,
        from: c.from,
        to: c.to,
        departureTime: formatLocalDateTime(anchorDay, c.depAbs, ctx.utcOffset ?? '+05:30'),
        arrivalTime: formatLocalDateTime(anchorDay, c.arrAbs, ctx.utcOffset ?? '+05:30'),
        durationSeconds: c.arrAbs - c.depAbs,
        intermediateStopCount: c.t.haltsBetween ?? 0,
        intermediateStops: null, // RailRadar's between-stations answer gives the count of halts, not their names
        daysOfOperation: runningDaysAtBoarding(c.t.runDays, c.t.from.day),
        scheduleConfidence: 'published',
        timeQuality: 'exact',
        fare: null, // not requested; never guessed
        source: { ...RAILRADAR_SOURCE, snapshotDate: null },
        evidence: {
          trainNumber: c.t.number,
          trainName: c.t.name,
          trainType: c.t.type,
          fromCode: c.t.from.code,
          toCode: c.t.to.code,
          boardStopNumber: null,
          alightStopNumber: null,
          totalStops: null,
          haltsBetween: c.t.haltsBetween,
          scheduledDeparture: c.t.from.departure,
          scheduledArrival: c.t.to.arrival,
          departureRunDay: c.t.from.day,
          arrivalRunDay: c.t.to.day,
          runStartDate: dayNumberToIso(runStartDay),
          runStartWeekday: WEEKDAYS[weekdayIndex(runStartDay)],
          originRunningDays: Array.isArray(c.t.runDays) ? WEEKDAYS.filter((_, i) => c.t.runDays.includes(API_DAYS[i])) : null,
          calendarValidFrom: null,
          calendarValidTo: null,
          distanceKm: c.t.distanceKm !== null ? Math.round(c.t.distanceKm) : null,
          snapshotDate: null,
          provider: 'RailRadar'
        }
      }];
    });
}

// Request budget and search behaviour. RailRadar's free tier is ~100 requests a month per key, so one ordinary search
// must never spend more than a handful: the cap below is per search, on top of the monthly budget per credential.
export const RAIL_SEARCH_DEFAULTS = Object.freeze({
  maxRequestsPerSearch: 4,   // new (uncached) requests one search may make (never more than a tenth of the month's remainder)
  lowQuotaRemaining: 20,     // at or below this many requests left this month: direct (anchor) trains only
  maxHubPairs: 6,            // hub pairs considered at all (cached ones are free; the rest compete for the cap)
  concurrency: 2,            // requests in flight at once
  deadlineMs: 12000,         // the train search returns what it has by then
  minRequestMs: 2500,        // no new request is started with less time than this left
  trunksPerPair: 3,          // trains kept per station pair (Pareto, best arrival first)
  enoughInWindow: 2,         // stop asking once this many trains in the requested window are found
  hubGainMinutes: 45,        // hubs are asked about when one promises to arrive at least this much earlier ...
  busSlackMinutes: 90,       // ... and not when it would arrive this much later than the best bus journey
  minHubTripMeters: 40000,   // shorter trips: direct trains only
  sameTownMeters: 25000,     // a hub pair with both ends this close to the anchor's ends is a "same towns" variant ...
  wellServedTrains: 1,       // ... skipped when the anchor pair already has this many trains that day (any: the station is
                             // served, so another terminal in the same town is a poor use of a request)
  stationClusterMeters: 10000, // two hub pairs whose ends are both this close are one question
  railChangeMinutes: 20,     // two trains at the same station: minimum change time
  maxChangeWaitMinutes: 240, // ... and the longest wait for the second train
  cityRadiusMeters: 10000,   // an end with at least cityMinStations stations this close is a multi-terminal city ...
  cityMinStations: 3,        // ... and gets ONE byCity question (all its terminals) when direct trains are not enough
  expandedRadiusMeters: 60000, // no station within the normal radius: look this far once, and say so
  confidentTerminal: 0.8       // a city's anchor at least this "major" (station size + named after the place) is asked plainly
});

export function railSearchSettings(env = process.env) {
  const n = Number(env.RAILRADAR_MAX_REQUESTS_PER_SEARCH);
  return Object.freeze({
    ...RAIL_SEARCH_DEFAULTS,
    maxRequestsPerSearch: env.RAILRADAR_MAX_REQUESTS_PER_SEARCH !== undefined && Number.isInteger(n) && n >= 0 && n <= 10 ? n : RAIL_SEARCH_DEFAULTS.maxRequestsPerSearch,
    hubs: env.ROUTECONNECT_RAIL_HUB_SEARCH !== 'false',
    cityTerminals: env.ROUTECONNECT_RAIL_CITY_SEARCH !== 'false'
  });
}

function withDeadline(promise, ms) {
  let timer;
  const deadline = new Promise((_, reject) => {
    timer = setTimeout(() => reject(Object.assign(new Error('RailRadar did not answer before the search deadline.'), { code: 'DEADLINE' })), Math.max(0, ms));
  });
  return Promise.race([promise, deadline]).finally(() => clearTimeout(timer));
}

// Two trains at a junction: each first train with the earliest second train leaving after the change time. A change
// between two stations of one city (byCity legs) needs at least crossStationSeconds; compose.js then checks the actual
// connection (walk / bus / ride between them) on real times.
export function chainAtStation(firstTrunks, secondTrunks, { changeSeconds, maxWaitSeconds, crossStationSeconds = 3600, max = 3 }) {
  const out = [];
  const used = new Set();
  const byDeparture = [...secondTrunks].sort((a, b) => a[0].planning.departureSeconds - b[0].planning.departureSeconds);
  for (const [first] of [...firstTrunks].sort((a, b) => a[0].planning.arrivalSeconds - b[0].planning.arrivalSeconds)) {
    const next = byDeparture.find(([second]) => {
      const wait = second.planning.departureSeconds - first.planning.arrivalSeconds;
      const needed = second.from?.code && first.to?.code && second.from.code !== first.to.code ? Math.max(changeSeconds, crossStationSeconds) : changeSeconds;
      return wait >= needed && wait <= maxWaitSeconds && second.trainNumber !== first.trainNumber;
    });
    if (!next) continue;
    const key = `${first.trainNumber}>${next[0].trainNumber}@${next[0].departureTime}`;
    if (used.has(key)) continue;
    used.add(key);
    out.push([first, next[0]]);
    if (out.length >= max) break;
  }
  return out;
}

export function createRailRadarSource({ env = process.env, client = createRailRadarClient({ env }), getGraph = () => getRailStations(), settings = railSearchSettings(env), hubOptions = HUB_DEFAULTS, clock = () => Date.now() } = {}) {
  return {
    id: 'rail',
    label: 'RailRadar scheduled trains',
    mode: 'rail',
    timeoutMs: settings.deadlineMs + 2000, // the search itself stops at deadlineMs and returns what it found
    provider: 'railradar',
    status(ctx) {
      // No usable credential (none configured, rejected, or its allowance used up): scheduled trains are off, and the
      // planner / UI fall back to buses plus the labelled estimated railway explorer. Nothing is invented.
      const access = client.availability();
      if (!access.available) return { configured: false, code: access.code, reason: access.reason };
      let graph = null;
      try { graph = getGraph(); } catch { graph = null; }
      if (!graph?.stations) return { configured: false, reason: 'Railway station locations are not available on this server.' };
      if (ctx.crowFliesMeters < MIN_TRIP_METERS) return { configured: true, applicable: false, reason: 'Too short for a train journey.' };
      return { configured: true };
    },
    async search(ctx) {
      const started = clock();
      const elapsed = () => clock() - started;
      const set = getGraph();
      const stations = stationIndex(set);
      const importanceOf = set.importanceOf ?? (() => 0.3);
      const routing = ctx.config ?? getRoutingConfig();
      const accessSeconds = meters => (meters <= COMPOSE_DEFAULTS.walkMaxMeters ? estimateWalk(meters, routing).durationSeconds : estimateLocalRide(meters, routing).durationSeconds);
      const operatorInfo = operatorIdentity('Indian Railways', { source: 'rail:RailRadar', confidence: 'published', typeHint: 'rail' });
      const radius = Math.min(40000, Math.max(5000, ctx.crowFliesMeters * 0.4));
      // Controlled fallback: no station within the normal radius (a place far from the railway) -> one wider look, only
      // on long trips where a 40-60 km ride to the train can still make sense. Reported either way.
      const stationCoverage = {};
      const anchorAt = (point, end) => {
        const found = anchorStation(set, point, radius);
        if (found) { stationCoverage[end] = 'ok'; return found; }
        if (ctx.crowFliesMeters >= 3 * settings.expandedRadiusMeters) {
          const wide = anchorStation(set, point, settings.expandedRadiusMeters);
          if (wide) { stationCoverage[end] = 'expanded'; return wide; }
        }
        stationCoverage[end] = 'none';
        return null;
      };
      const from = anchorAt(ctx.origin, 'origin');
      const to = anchorAt(ctx.destination, 'destination');

      // What was asked, what it cost, and what was left unasked (and why): reported with the results.
      const coverage = {
        provider: 'railradar',
        pairs: [],
        requests: { made: 0, cached: 0, shared: 0, allowed: settings.maxRequestsPerSearch },
        skipped: { budget: 0, time: 0, unpromising: 0 },
        hubSearch: 'not_applicable',
        hubs: { origin: [], destination: [] },
        via: null,
        limitedBy: null,
        quotaLow: false,
        errors: [],
        stations: stationCoverage,
        cityTerminals: null
      };
      const monthly = client.budget();
      const left = Math.min(Math.max(0, monthly.budget - monthly.used), monthly.providerRemaining ?? Infinity);
      // Never more than a tenth of what is left this month (47 left -> 4, 30 -> 3), and direct trains only near the end.
      const quotaShare = left <= settings.lowQuotaRemaining ? 1 : Math.max(1, Math.floor(left / 10));
      if (quotaShare < settings.maxRequestsPerSearch) {
        coverage.quotaLow = left <= settings.lowQuotaRemaining;
        coverage.quotaLimited = true;
        coverage.requests.allowed = Math.min(quotaShare, settings.maxRequestsPerSearch);
      }

      const viaOf = meters => (meters <= COMPOSE_DEFAULTS.walkMaxMeters ? 'walk' : 'ride');
      const end = (station, via, minutes) => ({ station, via, minutes, importance: importanceOf(station) });
      const anchor = from && to && from.s.code !== to.s.code
        ? { from: end(from.s, viaOf(from.m), accessSeconds(from.m) / 60), to: end(to.s, viaOf(to.m), accessSeconds(to.m) / 60), role: 'anchor' }
        : null;
      // Planning time at a station end: a bus-reached hub uses its timetable-based estimate; a junction change uses none.
      const planningSeconds = e => (e.via === 'bus' ? () => e.minutes * 60 : e.via === 'station' ? () => 0 : null);
      const nextDate = (days = 1) => dayNumberToIso(isoToDayNumber(ctx.date) + days);
      // The date to ask about for a hub: the day the traveller can first board there.
      const boardingDate = pair => nextDate(Math.max(0, Math.floor((ctx.windowStartSeconds + pair.from.minutes * 60 + COMPOSE_DEFAULTS.bufferBeforeSeconds.rail) / DAY)));
      const costOf = (pair, date, byCity = false) => client.costOf(pair.from.station.code, pair.to.station.code, date, { byCity });

      const runPair = async (pair, date, window = null, { byCity = false } = {}) => {
        const entry = { from: pair.from.station.code, to: pair.to.station.code, date, role: pair.role, cost: costOf(pair, date, byCity), ...(byCity ? { byCity: true } : {}) };
        if (entry.cost === 'request') {
          if (coverage.requests.made >= coverage.requests.allowed) { coverage.skipped.budget++; return null; }
          if (settings.deadlineMs - elapsed() < settings.minRequestMs) { coverage.skipped.time++; return null; }
          coverage.requests.made++;
        } else {
          coverage.requests[entry.cost === 'cached' ? 'cached' : 'shared']++;
        }
        coverage.pairs.push(entry);
        let trains;
        try {
          trains = await withDeadline(client.trainsBetween(entry.from, entry.to, date, { byCity }), settings.deadlineMs - elapsed());
        } catch (error) {
          entry.error = error.code ?? 'PROVIDER_ERROR';
          coverage.errors.push({ code: entry.error, message: error.message });
          return { error, trunks: [] };
        }
        recordTimetableEvidence(trains);
        const accessFor = planningSeconds(pair.from);
        const egressFor = planningSeconds(pair.to);
        const trunks = trainsToTrunks(trains, {
          ctx: window ? { ...ctx, ...window } : ctx, searchDate: date, stations, anchors: { from: pair.from.station, to: pair.to.station },
          accessSeconds, operatorInfo, maxTrunks: settings.trunksPerPair,
          ...(accessFor ? { accessSecondsFor: accessFor } : {}),
          ...(egressFor ? { egressSecondsFor: egressFor } : {}),
          ...(window ? { fallbackToLater: false } : {})
        });
        for (const [leg] of trunks) leg.planning.pair = { role: pair.role, access: pair.from.via, egress: pair.to.via };
        entry.trains = trains.length;
        entry.inWindow = trunks.some(([leg]) => leg.planning.inWindow) ? trunks.length : 0;
        return { trunks };
      };
      const inWindowCount = list => list.filter(sequence => sequence[0].planning.inWindow).length;
      const bestArrival = list => list.reduce((best, sequence) => Math.min(best, sequence.at(-1).planning.doorArrivalSeconds), Infinity);

      // Stage A. Direct trains between the main stations near each end. In a multi-terminal city whose nearest large
      // station is not clearly ITS main station (a suburban junction near a city centre), the first question is a byCity
      // one: every station of both cities in one request, so the right terminal is not left to a guess.
      const isCity = point => (set.isCity
        ? set.isCity(point, settings.cityRadiusMeters, settings.cityMinStations)
        : Boolean(set.nearby) && set.nearby(point.lat, point.lon, settings.cityRadiusMeters).filter(e => e.station.kind === 'station').length >= settings.cityMinStations);
      const confident = (end, point) => importanceOf(end.station) + (point.name && namedAfterPlace(end.station, point.name) ? PLACE_STATION_BONUS : 0) >= settings.confidentTerminal;
      const cityEnds = anchor ? { origin: isCity(ctx.origin), destination: isCity(ctx.destination) } : { origin: false, destination: false };
      const cityFirst = Boolean(settings.cityTerminals && anchor && ((cityEnds.origin && !confident(anchor.from, ctx.origin)) || (cityEnds.destination && !confident(anchor.to, ctx.destination))));
      const found = [];
      if (anchor) {
        const dates = [ctx.date];
        if (ctx.windowEndSeconds > DAY) dates.push(nextDate()); // a window past midnight also needs the next day's trains
        for (const date of dates) found.push(...((await runPair(anchor, date, null, { byCity: cityFirst }))?.trunks ?? []));
      }

      // Stage B. Other terminals of a multi-terminal city (Chennai Central / Egmore / Perambur, Lucknow Jn / Charbagh):
      // ONE byCity question when the plain question was not enough. A train already found keeps its original station.
      if (settings.cityTerminals && anchor && !cityFirst && (cityEnds.origin || cityEnds.destination)
        && inWindowCount(found) < settings.enoughInWindow) {
        const known = new Set(found.map(sequence => sequence[0].trainNumber));
        const city = (await runPair({ ...anchor, role: 'city' }, ctx.date, null, { byCity: true }))?.trunks ?? [];
        const added = city.filter(sequence => !known.has(sequence[0].trainNumber));
        found.push(...added);
      }
      coverage.cityTerminals = { cityFirst, asked: coverage.pairs.some(p => p.byCity), ends: cityEnds };

      // Stage D. Two trains with a change at a junction (Train -> Train), only when no direct train was found and the
      //    budget still allows both questions. A station change (Train -> walk / bus -> Train) is composed and validated in compose.js.
      const tryVia = async () => {
        viaDone = true;
        if (settings.hubs && anchor && found.length === 0 && ctx.crowFliesMeters >= settings.minHubTripMeters
          && coverage.requests.allowed - coverage.requests.made >= 2) {
          const [via] = viaJunctions({ stations: set.stations, nearby: set.nearby ?? null, origin: anchor.from.station, destination: anchor.to.station, exclude: new Set([anchor.from.station.code, anchor.to.station.code]), importanceOf, options: hubOptions, max: 1 });
          if (via) {
            coverage.via = via.station.code;
            const mid = end(via.station, 'station', 0);
            // In a multi-terminal city the change may be between two of its stations (arrive Delhi Jn, leave New Delhi):
            // byCity legs find both; compose.js then checks the connection between them on real times.
            const viaCity = settings.cityTerminals && isCity(via.station);
            const first = (await runPair({ from: anchor.from, to: mid, role: 'via' }, ctx.date, null, { byCity: viaCity }))?.trunks ?? [];
            if (first.length > 0) {
              const change = settings.railChangeMinutes * 60;
              const earliest = Math.min(...first.map(([leg]) => leg.planning.arrivalSeconds));
              const date = nextDate(Math.floor((earliest + change) / DAY));
              const window = { windowStartSeconds: earliest + change - COMPOSE_DEFAULTS.bufferBeforeSeconds.rail, windowEndSeconds: earliest + settings.maxChangeWaitMinutes * 60 };
              const second = (await runPair({ from: mid, to: anchor.to, role: 'via' }, date, window, { byCity: viaCity }))?.trunks ?? [];
              found.push(...chainAtStation(first, second, { changeSeconds: change, maxWaitSeconds: settings.maxChangeWaitMinutes * 60 }));
            }
          }
        }
      };

      // Where neither end is inside the bus dataset, "hubs" can only be other stations within ride range (largely what
      // Stage B covers), so a change between two trains is tried first.
      let viaDone = false;
      const busCoverage = Boolean(ctx.busAllowed && ctx.network) && [ctx.origin, ctx.destination].some(p => busStopsNear(ctx.network, p));
      coverage.busCoverage = busCoverage;
      if (!busCoverage) await tryVia();

      // Stage C. Transfer hubs, only when they can help: too few direct trains in the window, or a hub promising a clearly
      //    earlier arrival. Hubs nobody can reach in time, or that cannot beat the best bus, are never asked about.
      let needHubs = false;
      if (settings.hubs && ctx.crowFliesMeters >= settings.minHubTripMeters) {
        const busAllowed = ctx.busAllowed !== false && Boolean(ctx.network);
        const reach = busAllowed ? busReachFrom(ctx.network, ctx.origin, { date: ctx.date, timeSeconds: ctx.windowStartSeconds, config: routing }) : null;
        const common = { stations: set.stations, nearby: set.nearby ?? null, network: ctx.network ?? null, busAllowed, config: routing, importanceOf, options: hubOptions };
        const origins = hubCandidates({ ...common, point: ctx.origin, other: ctx.destination, role: 'origin', reach });
        const destinations = hubCandidates({ ...common, point: ctx.destination, other: ctx.origin, role: 'destination' });
        coverage.hubs = { origin: origins.map(h => h.station.code), destination: destinations.map(h => h.station.code) };
        const isAnchor = p => anchor && p.from.station.code === anchor.from.station.code && p.to.station.code === anchor.to.station.code;
        const pairs = rankStationPairs({ origins, destinations }).filter(p => !isAnchor(p)).slice(0, settings.maxHubPairs);
        const estimatedArrival = p => ctx.windowStartSeconds + p.estimatedMinutes * 60;
        const anchorBest = bestArrival(found);
        needHubs = pairs.length > 0 && (inWindowCount(found) < settings.enoughInWindow || pairs.some(p => estimatedArrival(p) + settings.hubGainMinutes * 60 < anchorBest));
        coverage.hubSearch = pairs.length === 0 ? 'no_candidates' : needHubs ? 'searched' : 'not_needed';
        if (needHubs) {
          // Another station in the SAME two towns as the anchor (Kacheguda instead of Secunderabad) rarely helps: when the
          // anchor is well served the problem is the time window, and when it has no trains at all such variants are a
          // last resort. Hubs in other towns (a bus to a bigger station) come first.
          const anchorTrains = coverage.pairs.filter(p => p.role === 'anchor').reduce((n, p) => n + (p.trains ?? 0), 0);
          const near = (a, b) => haversineMeters(a.lat, a.lon, b.lat, b.lon) <= settings.sameTownMeters;
          const sameTown = p => anchor && near(p.from.station, anchor.from.station) && near(p.to.station, anchor.to.station);
          const promising = pairs.filter(p => {
            const beatsBus = !Number.isFinite(ctx.bestBusArrivalSeconds) || estimatedArrival(p) <= ctx.bestBusArrivalSeconds + settings.busSlackMinutes * 60;
            // Once a byCity question covered every station of both towns, another pair in the same towns adds nothing.
            const coveredByCity = coverage.pairs.some(q => q.byCity && (q.role === 'anchor' || q.role === 'city'));
            const useful = beatsBus && !(sameTown(p) && (anchorTrains >= settings.wellServedTrains || coveredByCity));
            if (!useful) coverage.skipped.unpromising++;
            return useful;
          }).sort((a, b) => Number(sameTown(a)) - Number(sameTown(b))).filter((p, i, list) => {
            // Krishna Canal Jn -> Gudur after Vijayawada Jn -> Gudur is the same question: one per pair of station clusters.
            const duplicate = list.slice(0, i).some(q => haversineMeters(p.from.station.lat, p.from.station.lon, q.from.station.lat, q.from.station.lon) <= settings.stationClusterMeters
              && haversineMeters(p.to.station.lat, p.to.station.lon, q.to.station.lat, q.to.station.lon) <= settings.stationClusterMeters);
            if (duplicate) coverage.skipped.unpromising++;
            return !duplicate;
          });
          // Free answers first (cached or already being fetched), then new requests in priority order.
          const queue = [...promising.filter(p => costOf(p, boardingDate(p)) !== 'request'), ...promising.filter(p => costOf(p, boardingDate(p)) === 'request')];
          const hubFound = [];
          while (queue.length > 0 && inWindowCount(hubFound) < settings.enoughInWindow) {
            const batch = queue.splice(0, settings.concurrency);
            for (const result of await Promise.all(batch.map(p => runPair(p, boardingDate(p))))) hubFound.push(...(result?.trunks ?? []));
          }
          found.push(...hubFound);
        }
      }

      if (!viaDone) await tryVia();

      if (coverage.skipped.budget > 0) coverage.limitedBy = coverage.quotaLow ? 'quota' : 'budget';
      else if (coverage.skipped.time > 0 || coverage.errors.some(e => e.code === 'DEADLINE')) coverage.limitedBy = 'time';
      else if (coverage.errors.length > 0) coverage.limitedBy = 'provider_error';
      // Every question failed: report the provider failure (the planner says trains are unavailable, buses still show).
      if (found.length === 0 && coverage.pairs.length > 0 && coverage.pairs.every(p => p.error)) {
        throw Object.assign(new Error(coverage.errors[0].message), { code: coverage.errors[0].code, coverage });
      }
      if (!process.env.NODE_TEST_CONTEXT) {
        console.log(`[Rail search] ${ctx.origin.name ?? 'origin'} -> ${ctx.destination.name ?? 'destination'}: ${coverage.requests.made} RailRadar request(s), ${coverage.requests.cached} cached, ${coverage.pairs.length} pair(s) checked${coverage.limitedBy ? `, limited by ${coverage.limitedBy}` : ''} (${elapsed()} ms)`);
      }

      // In-window trains first, then by estimated door-to-door arrival.
      found.sort((a, b) => Number(b[0].planning.inWindow) - Number(a[0].planning.inWindow) || a.at(-1).planning.doorArrivalSeconds - b.at(-1).planning.doorArrivalSeconds);
      return {
        trunks: found.slice(0, RAIL_MAX_TRUNKS),
        meta: {
          source: RAILRADAR_SOURCE,
          ...(anchor ? { stations: { origin: anchor.from.station.code, destination: anchor.to.station.code } } : { message: 'No railway station near one end of this trip.' }),
          budget: client.budget(),
          coverage: { ...coverage, elapsedMs: elapsed() }
        }
      };
    }
  };
}

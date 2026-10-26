// Scheduled trains from the RailRadar API (https://railradar.in/docs), as a rail source for the multimodal planner.
//
//   RAILRADAR_API_KEY                 server-side only (backend/.env); never logged or sent to the browser
//   RAILRADAR_MONTHLY_REQUEST_BUDGET  this process stops calling RailRadar at the budget (free tier: 100/month)
//
// One search = normally ONE request: the main station near each end (see anchorStation), cached for 6 hours per
// station pair and date. Only trains RailRadar returns for the searched date are
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
import { getRailStations } from '../../railNetwork/railStations.js';
import { paretoRail } from '../../rail/railSearch.js';
import { operatorIdentity } from '../operators.js';

const DAY = 86400;
const WEEKDAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
const API_DAYS = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'];
export const RAILRADAR_SOURCE = Object.freeze({ id: 'railradar', name: 'RailRadar', type: 'third_party_api', url: 'https://railradar.in' });
const MIN_TRIP_METERS = 8000;
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

// The station a search is anchored on: the nearest junction within JUNCTION_REACH_METERS (junctions are where most trains
// call, e.g. Secunderabad Jn for central Hyderabad), otherwise the nearest station (a halt only if nothing else is near).
// RailRadar's byCity grouping is NOT used: it reports the last station a train reaches inside the city (Lingampalli,
// Medchal...), which sends people to the far edge of the city.
const JUNCTION_REACH_METERS = 8000;
export function anchorStation(graph, point, radiusMeters) {
  const near = [];
  for (const s of graph?.stations ?? []) {
    if (!s.code) continue;
    const m = haversineMeters(point.lat, point.lon, s.lat, s.lon);
    if (m <= radiusMeters) near.push({ s, m });
  }
  near.sort((a, b) => a.m - b.m);
  const junction = near.find(e => /junction|\bjn\b/i.test(e.s.name) && e.m <= Math.min(JUNCTION_REACH_METERS, radiusMeters));
  const station = near.find(e => e.s.kind === 'station');
  return junction ?? station ?? near[0] ?? null;
}

// Running days at the boarding station: the train's origin days shifted by the journey day there.
export function runningDaysAtBoarding(runDays, boardingDay) {
  if (!Array.isArray(runDays)) return null;
  const shift = Math.max(0, boardingDay - 1);
  return WEEKDAYS.filter((_, i) => runDays.includes(API_DAYS[(i - shift + 7 * 4) % 7]));
}

/** RailRadar trains (for one date at the from station) -> trunk sequences for composeAroundTrunk. */
export function trainsToTrunks(trains, { ctx, searchDate, stations, anchors, accessSeconds, operatorInfo, maxTrunks = MAX_TRUNKS }) {
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
    const dep = clockSeconds(t.from.departure);
    const arr = clockSeconds(t.to.arrival);
    if (dep === null || arr === null) continue;
    const depAbs = offset + dep;
    const arrAbs = offset + (t.to.day - t.from.day) * DAY + arr;
    if (arrAbs <= depAbs) continue;
    const from = place(t.from.code, t.from.name, anchors.from);
    const to = place(t.to.code, t.to.name, anchors.to);
    const access = accessSeconds(haversineMeters(ctx.origin.lat, ctx.origin.lon, from.lat, from.lon));
    const egress = accessSeconds(haversineMeters(to.lat, to.lon, ctx.destination.lat, ctx.destination.lon));
    const doorDeparture = depAbs - before - access;
    const doorArrival = arrAbs + after + egress;
    candidates.push({ t, from, to, depAbs, arrAbs, doorDeparture, doorArrival, transfers: 0 });
  }
  const inWindow = candidates.filter(c => c.doorDeparture >= ctx.windowStartSeconds && c.doorDeparture <= ctx.windowEndSeconds);
  // Sparse routes: nothing in the window -> the next trains that day (their real times are shown).
  const chosen = inWindow.length > 0 ? inWindow : candidates.filter(c => c.doorDeparture > ctx.windowEndSeconds);
  return paretoRail(chosen)
    .sort((a, b) => a.doorArrival - b.doorArrival || b.doorDeparture - a.doorDeparture)
    .slice(0, maxTrunks)
    .map(c => {
      const runStartDay = searchDay - (c.t.from.day - 1);
      return [{
        mode: 'rail',
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

export function createRailRadarSource({ env = process.env, client = createRailRadarClient({ env }), getGraph = () => getRailStations() } = {}) {
  return {
    id: 'rail',
    label: 'RailRadar scheduled trains',
    mode: 'rail',
    timeoutMs: 9000,
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
      const graph = getGraph();
      const stations = stationIndex(graph);
      const radius = Math.min(40000, Math.max(5000, ctx.crowFliesMeters * 0.4));
      const from = anchorStation(graph, ctx.origin, radius);
      const to = anchorStation(graph, ctx.destination, radius);
      if (!from || !to || from.s.code === to.s.code) return { trunks: [], meta: { source: RAILRADAR_SOURCE, message: 'No railway station near one end of this trip.' } };
      const routing = ctx.config ?? getRoutingConfig();
      const accessSeconds = meters => (meters <= COMPOSE_DEFAULTS.walkMaxMeters ? estimateWalk(meters, routing).durationSeconds : estimateLocalRide(meters, routing).durationSeconds);
      const operatorInfo = operatorIdentity('Indian Railways', { source: 'rail:RailRadar', confidence: 'published', typeHint: 'rail' });
      const anchors = { from: from.s, to: to.s };
      const dates = [ctx.date];
      // A window running past midnight also needs the next day's trains (one more request, cached like the first).
      if (ctx.windowEndSeconds > DAY) dates.push(dayNumberToIso(isoToDayNumber(ctx.date) + 1));
      const trunks = [];
      for (const date of dates) {
        const trains = await client.trainsBetween(from.s.code, to.s.code, date);
        trunks.push(...trainsToTrunks(trains, { ctx, searchDate: date, stations, anchors, accessSeconds, operatorInfo }));
      }
      return {
        trunks: trunks.slice(0, MAX_TRUNKS),
        meta: { source: RAILRADAR_SOURCE, stations: { origin: from.s.code, destination: to.s.code }, budget: client.budget() }
      };
    }
  };
}

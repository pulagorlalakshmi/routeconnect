// Train search over the in-memory rail network (railNetwork.js): direct trains and one same-station train-to-train change.
//
// Time model: a train run starts on its SERVICE DAY (the first-station departure date, which is what the calendar
// describes). Stop times are seconds from 00:00 of that day and exceed 86400 on later journey days. For a search on date
// D, a run on service day D+k reaches stop p at k*86400 + time[p] seconds after 00:00 of D. Every candidate k from
// -maxRunDays upwards is checked against the calendar of THAT day, so overnight trains, trains boarded on their second
// or third day, and searches whose window crosses midnight are all handled without extrapolating any calendar.
//
// Only the source's own trains, stops, times and running days are used. Access/egress times are estimates supplied by
// the caller and are used to (a) keep the door departure inside the requested window and (b) compare stations.
import { haversineMeters } from '../routing/geo.js';
import { dayNumberToIso, formatLocalDateTime, isoToDayNumber, weekdayIndex } from '../routing/serviceCalendar.js';
import { activeServicesOn } from './railNetwork.js';

const NONE = -1;
const DAY = 86400;
const WEEKDAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

export const RAIL_SEARCH_DEFAULTS = Object.freeze({
  radiusMeters: 40000,
  // Around each end, stations further than this share of the trip's straight-line length are ignored, so a short trip
  // never "boards" near the destination (Vijayawada -> Guntur must not start at Guntur station).
  radiusShareOfTrip: 0.4,
  minRadiusMeters: 5000,
  nearestStations: 4,       // closest stations around each end...
  busiestStations: 3,       // ...plus the best-served ones within the radius (a junction 15 km away beats a halt 2 km away)
  boardBufferSeconds: 20 * 60,
  alightBufferSeconds: 10 * 60,
  minTransferSeconds: 45 * 60,
  maxTransferWaitSeconds: 3 * 3600,
  maxJourneySeconds: 48 * 3600,
  maxResults: 10,
  pareto: true,             // false lists every matching train (station-board style validation)
  maxTransfers: 1,
  // Estimated access/egress time counts this much more than timetabled train time when choosing WHICH station to board
  // or leave at (it is an estimate; the train time is published). Reported times are never weighted.
  estimateWeight: 1.5,
  // A journey taking longer than this multiple of the fastest train journey found is noise, not an option.
  maxDurationRatio: 1.5,
  // Sparse routes: when nothing departs inside the window, look this much further once (times shown are real).
  extendIfEmptySeconds: 6 * 3600,
  // A change must not send the traveller far out of their way: the two legs' straight-line lengths may add up to at most
  // this multiple of the trip's straight-line length.
  maxTransferDetour: 1.5,
  // Restrict discovery to these station codes (exact station searches, verification); null = discover by distance.
  originStationCodes: null,
  destinationStationCodes: null,
  // Fallback when the caller gives no access estimate: walking up to 1 km, otherwise a 25 km/h road trip + 8 min pickup.
  accessSeconds: meters => (meters <= 1000 ? Math.round((meters * 1.3) / 1.2) : Math.round((meters * 1.4) / (25000 / 3600)) + 8 * 60)
});

const trainCountAt = (network, s) => network.stationStops[s].length / 2;

/** Stations to try around a point: the nearest few plus the best-served within the radius. */
export function discoverStations(network, point, { radiusMeters, nearestStations, busiestStations, accessSeconds } = RAIL_SEARCH_DEFAULTS) {
  const within = [];
  network.stations.forEach((station, s) => {
    if (station.lat === null || trainCountAt(network, s) === 0) return;
    const meters = haversineMeters(point.lat, point.lon, station.lat, station.lon);
    if (meters <= radiusMeters) within.push({ s, meters });
  });
  within.sort((a, b) => a.meters - b.meters || a.s - b.s);
  const chosen = within.slice(0, nearestStations);
  const busiest = within.slice(nearestStations).sort((a, b) => trainCountAt(network, b.s) - trainCountAt(network, a.s) || a.meters - b.meters);
  chosen.push(...busiest.slice(0, busiestStations));
  return chosen.map(entry => ({ ...entry, accessSeconds: accessSeconds(entry.meters) }));
}

/**
 * @param network  from getRailNetwork()
 * @param query    { origin:{lat,lon}, destination:{lat,lon}, date:'YYYY-MM-DD', windowStartSeconds, windowEndSeconds }
 * @returns { journeys: Array<{ legs: Leg[], doorDeparture, doorArrival, transfers }>, originStations, destinationStations, stats }
 *          Leg = { t, board, alight, k, dep, arr } (dep/arr in seconds after 00:00 of the search date)
 */
export function searchRail(network, query, options = {}) {
  const opts = { ...RAIL_SEARCH_DEFAULTS, ...options };
  const searchDay = isoToDayNumber(query.date);
  if (searchDay === null) throw new Error('searchRail: invalid date');
  const tripMeters = haversineMeters(query.origin.lat, query.origin.lon, query.destination.lat, query.destination.lon);
  const radiusMeters = Math.min(opts.radiusMeters, Math.max(opts.minRadiusMeters, tripMeters * opts.radiusShareOfTrip));
  const exact = codes => codes.map(code => network.stationIndex.get(code)).filter(s => s !== undefined)
    .map(s => ({ s, meters: 0, accessSeconds: 0 }));
  const originsAll = opts.originStationCodes ? exact(opts.originStationCodes) : discoverStations(network, query.origin, { ...opts, radiusMeters });
  const destinationsAll = opts.destinationStationCodes ? exact(opts.destinationStationCodes) : discoverStations(network, query.destination, { ...opts, radiusMeters });
  // A station near both ends belongs to the nearer one.
  const destinationMeters = new Map(destinationsAll.map(d => [d.s, d.meters]));
  const originMeters = new Map(originsAll.map(o => [o.s, o.meters]));
  // A station that takes the traveller backwards (further from the other end than they already are) is not offered.
  const backtracks = (station, from, other) => {
    const st = network.stations[station.s];
    const back = haversineMeters(st.lat, st.lon, other.lat, other.lon) - haversineMeters(from.lat, from.lon, other.lat, other.lon);
    return back > Math.max(5000, 0.5 * station.meters);
  };
  const origins = originsAll.filter(o => (!destinationMeters.has(o.s) || o.meters < destinationMeters.get(o.s))
    && (opts.originStationCodes || !backtracks(o, query.origin, query.destination)));
  const destinations = destinationsAll.filter(d => (!originMeters.has(d.s) || d.meters <= originMeters.get(d.s))
    && (opts.destinationStationCodes || !backtracks(d, query.destination, query.origin)));
  const stats = { radiusMeters: Math.round(radiusMeters), originStations: origins.length, destinationStations: destinations.length, boardings: 0, transferChecks: 0, candidates: 0 };
  const empty = { journeys: [], originStations: origins, destinationStations: destinations, stats };
  if (origins.length === 0 || destinations.length === 0) return empty;

  const originAccess = new Map(origins.map(o => [o.s, o.accessSeconds]));
  const egressOf = new Map(destinations.map(d => [d.s, d.accessSeconds]));

  const firstK = -network.maxRunDays;
  const maxAccess = Math.max(...origins.map(o => o.accessSeconds));
  const lastK = Math.floor((query.windowEndSeconds + maxAccess + opts.boardBufferSeconds + opts.maxJourneySeconds) / DAY);
  const runs = (t, k) => {
    const serviceIdx = network.trains[t].serviceIdx;
    return serviceIdx !== NONE && activeServicesOn(network, searchDay + k)[serviceIdx] === 1;
  };

  // For every train, the positions where it reaches a destination station (with an arrival time).
  const destPositions = new Map();
  for (const d of destinations) {
    const list = network.stationStops[d.s];
    for (let i = 0; i < list.length; i += 2) {
      const t = list[i];
      const p = list[i + 1];
      if (network.trains[t].arr[p] === NONE) continue;
      if (!destPositions.has(t)) destPositions.set(t, []);
      destPositions.get(t).push(p);
    }
  }
  // Best alighting position after `after` on train t, for a run on service day k.
  const bestAlight = (t, after, k) => {
    const positions = destPositions.get(t);
    if (!positions) return null;
    const train = network.trains[t];
    let best = null;
    for (const q of positions) {
      if (q <= after) continue;
      const arr = k * DAY + train.arr[q];
      const egress = egressOf.get(train.station[q]);
      const door = arr + opts.alightBufferSeconds + egress;
      const score = door + (opts.estimateWeight - 1) * egress;
      if (!best || score < best.score) best = { q, arr, door, score };
    }
    return best;
  };

  // Departures from a transfer station on trains that can reach the destination (lazily filtered, cached).
  const transferDepartures = new Map();
  const departuresTowardDestination = s => {
    let list = transferDepartures.get(s);
    if (!list) {
      list = [];
      const all = network.stationStops[s];
      for (let i = 0; i < all.length; i += 2) {
        const t = all[i];
        const p = all[i + 1];
        if (network.trains[t].dep[p] !== NONE && destPositions.has(t) && destPositions.get(t).some(q => q > p)) list.push(t, p);
      }
      transferDepartures.set(s, list);
    }
    return list;
  };

  const best = new Map(); // dedupe key -> journey
  const offer = (key, journey) => {
    stats.candidates++;
    const current = best.get(key);
    if (!current || journey.doorArrival < current.doorArrival || (journey.doorArrival === current.doorArrival && journey.doorDeparture > current.doorDeparture)) best.set(key, journey);
  };

  for (const o of origins) {
    const earliest = query.windowStartSeconds + o.accessSeconds + opts.boardBufferSeconds;
    const latest = query.windowEndSeconds + o.accessSeconds + opts.boardBufferSeconds;
    const list = network.stationStops[o.s];
    for (let i = 0; i < list.length; i += 2) {
      const t = list[i];
      const p = list[i + 1];
      const train = network.trains[t];
      if (train.dep[p] === NONE) continue;
      // Never board where the same train later calls at a nearer origin station: board there instead.
      let laterNearer = false;
      for (let r = p + 1; r < train.station.length && !laterNearer; r++) {
        const access = originAccess.get(train.station[r]);
        if (access !== undefined && access < o.accessSeconds && train.dep[r] !== NONE) laterNearer = true;
      }
      if (laterNearer) continue;
      for (let k = firstK; k <= lastK; k++) {
        const dep = k * DAY + train.dep[p];
        if (dep < earliest || dep > latest || !runs(t, k)) continue;
        stats.boardings++;
        const doorDeparture = dep - opts.boardBufferSeconds - o.accessSeconds;
        const leg1 = { t, board: p, k, dep };

        // Direct.
        const direct = bestAlight(t, p, k);
        if (direct && direct.arr - dep <= opts.maxJourneySeconds) {
          offer(`${t}@${k}`, { legs: [{ ...leg1, alight: direct.q, arr: direct.arr }], doorDeparture, doorArrival: direct.door, transfers: 0 });
        }

        // One change, at the same station, onto a train that reaches the destination.
        if (opts.maxTransfers === 0) continue;
        const boardStation = network.stations[train.station[p]];
        for (let q = p + 1; q < train.station.length; q++) {
          const x = train.station[q];
          if (train.arr[q] === NONE || egressOf.has(x) || originAccess.has(x)) continue;
          const xs = network.stations[x];
          if (xs.lat === null) continue;
          const viaMeters = haversineMeters(boardStation.lat, boardStation.lon, xs.lat, xs.lon) + haversineMeters(xs.lat, xs.lon, query.destination.lat, query.destination.lon);
          if (viaMeters > opts.maxTransferDetour * Math.max(tripMeters, 1)) continue;
          const arriveX = k * DAY + train.arr[q];
          const onward = departuresTowardDestination(x);
          for (let j = 0; j < onward.length; j += 2) {
            const t2 = onward[j];
            if (t2 === t) continue;
            const p2 = onward[j + 1];
            const train2 = network.trains[t2];
            for (let k2 = firstK; k2 <= lastK; k2++) {
              const dep2 = k2 * DAY + train2.dep[p2];
              stats.transferChecks++;
              if (dep2 < arriveX + opts.minTransferSeconds || dep2 > arriveX + opts.maxTransferWaitSeconds || !runs(t2, k2)) continue;
              const alight2 = bestAlight(t2, p2, k2);
              if (!alight2 || alight2.arr - dep > opts.maxJourneySeconds) continue;
              offer(`${t}@${k}>${t2}@${k2}`, {
                legs: [{ ...leg1, alight: q, arr: arriveX }, { t: t2, board: p2, k: k2, dep: dep2, alight: alight2.q, arr: alight2.arr }],
                doorDeparture, doorArrival: alight2.door, transfers: 1
              });
            }
          }
        }
      }
    }
  }

  let found = opts.pareto ? paretoRail([...best.values()]) : [...best.values()];
  if (opts.pareto && found.length > 0) {
    const fastest = Math.min(...found.map(j => j.doorArrival - j.doorDeparture));
    found = found.filter(j => j.doorArrival - j.doorDeparture <= opts.maxDurationRatio * fastest);
  }
  if (found.length === 0 && opts.extendIfEmptySeconds > 0) {
    const extended = searchRail(network, { ...query, windowEndSeconds: query.windowEndSeconds + opts.extendIfEmptySeconds }, { ...opts, extendIfEmptySeconds: 0 });
    return { ...extended, windowExtendedSeconds: opts.extendIfEmptySeconds };
  }
  const journeys = found
    .sort((a, b) => a.doorArrival - b.doorArrival || b.doorDeparture - a.doorDeparture || a.transfers - b.transfers)
    .slice(0, opts.maxResults);
  return { journeys, originStations: origins, destinationStations: destinations, stats, windowExtendedSeconds: 0 };
}

// Keep journeys not beaten on (later door departure, earlier door arrival, fewer changes).
export function paretoRail(journeys) {
  const dominates = (a, b) => a.doorDeparture >= b.doorDeparture && a.doorArrival <= b.doorArrival && a.transfers <= b.transfers
    && (a.doorDeparture > b.doorDeparture || a.doorArrival < b.doorArrival || a.transfers < b.transfers);
  return journeys.filter(candidate => !journeys.some(other => other !== candidate && dominates(other, candidate)));
}

const clock = seconds => {
  const s = ((seconds % DAY) + DAY) % DAY;
  return `${String(Math.floor(s / 3600)).padStart(2, '0')}:${String(Math.floor((s % 3600) / 60)).padStart(2, '0')}`;
};

// Running days of a service, expressed at the station where the passenger boards (a train leaving its origin late on
// Monday that reaches the boarding station after midnight "runs Tuesday" there).
export function runningDaysAt(network, train, boardPos) {
  const calendar = network.serviceIndex.calendarByService[train.serviceIdx];
  if (!calendar) return null;
  const shift = Math.floor(train.dep[boardPos] / DAY);
  return WEEKDAYS.filter((_, i) => calendar.days[(i - shift + 7 * 4) % 7] === 1);
}

/** Turns a searchRail leg into the trunk-leg shape the multimodal composer understands. */
export function toTrunk(network, leg, { searchDay, utcOffset, operatorInfo, scheduleConfidence, source }) {
  const train = network.trains[leg.t];
  const station = p => {
    const s = network.stations[train.station[p]];
    return { type: 'station', name: s.name, code: s.code, lat: s.lat, lon: s.lon };
  };
  const between = [];
  for (let p = leg.board + 1; p < leg.alight; p++) between.push(network.stations[train.station[p]].name);
  const runDay = searchDay + leg.k;
  const calendar = network.serviceIndex.calendarByService[train.serviceIdx];
  const distance = train.dist[leg.alight] - train.dist[leg.board];
  return {
    mode: 'rail',
    operatorInfo,
    operator: operatorInfo?.name ?? null,
    trainNumber: train.number,
    trainName: train.name,
    displayName: `${train.number}${train.name ? ` ${train.name}` : ''}`,
    headsign: train.headsign,
    from: station(leg.board),
    to: station(leg.alight),
    departureTime: formatLocalDateTime(searchDay, leg.dep, utcOffset),
    arrivalTime: formatLocalDateTime(searchDay, leg.arr, utcOffset),
    durationSeconds: leg.arr - leg.dep,
    intermediateStopCount: between.length,
    intermediateStops: between,
    daysOfOperation: runningDaysAt(network, train, leg.board),
    scheduleConfidence,
    timeQuality: 'exact',
    fare: null, // no fare in the timetable source; never guessed
    source,
    evidence: {
      trainNumber: train.number,
      trainName: train.name,
      fromCode: network.stations[train.station[leg.board]].code,
      toCode: network.stations[train.station[leg.alight]].code,
      boardStopNumber: leg.board + 1,
      alightStopNumber: leg.alight + 1,
      totalStops: train.station.length,
      scheduledDeparture: clock(train.dep[leg.board]),
      scheduledArrival: clock(train.arr[leg.alight]),
      departureRunDay: Math.floor(train.dep[leg.board] / DAY) + 1,
      arrivalRunDay: Math.floor(train.arr[leg.alight] / DAY) + 1,
      runStartDate: dayNumberToIso(runDay),
      runStartWeekday: WEEKDAYS[weekdayIndex(runDay)],
      originRunningDays: calendar ? WEEKDAYS.filter((_, i) => calendar.days[i] === 1) : null,
      calendarValidFrom: calendar ? dayNumberToIso(calendar.startDay) : null,
      calendarValidTo: calendar ? dayNumberToIso(calendar.endDay) : null,
      distanceKm: Number.isFinite(distance) && distance > 0 ? Math.round(distance) : null,
      snapshotDate: source?.snapshotDate ?? null
    }
  };
}

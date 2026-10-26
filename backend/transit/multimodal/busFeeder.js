// Timetable buses to and from railway stations (Bus + Train, Train + Bus, Bus + Train + Bus, Train + Bus + Train).
//
// Uses the existing GTFS bus planner (planJourneys) unchanged, between the traveller's point and a station's coordinates:
//   access(origin, station, latestArrivalMs)        -> the LATEST-leaving bus journey that reaches the station in time
//   egress(station, destination, earliestMs)        -> the EARLIEST-arriving bus journey leaving the station after that
//   transfer(stationA, stationB, earliestMs, latestMs) -> the EARLIEST-arriving bus between two stations in that slot
// The planner's own first/last walk or local ride is the connection between the bus stand and the station: it is
// modelled from real coordinates (bus stop -> station), never invented as a platform or path.
// A bus option is offered only when it contains a real bus leg and saves a meaningful share of the estimated local-ride
// time it replaces (a bus that rides most of the way anyway is not a better option). Bounded: a fixed number of planner
// calls per request, cached per station and half-hour, so adding buses can never make train search unbounded.
import { planJourneys } from '../routing/planner.js';
import { haversineMeters } from '../routing/geo.js';
import { estimateLocalRide } from '../routing/accessEgress.js';

const SEARCH_BEFORE_MINUTES = 150;   // look for access buses leaving up to this long before the latest arrival ...
const MAX_SEARCH_BEFORE_MINUTES = 720; // ... more for far stations (a bus to a hub 300 km away takes 6-8 hours)
const PLANNING_BUS_KPH = 30;           // only to size that search window (never shown as a journey time); long APSRTC
                                       // rides average ~30-35 km/h over the straight-line distance
const ACCESS_WINDOW_MINUTES = 120;
const EGRESS_WINDOW_MINUTES = 180;
const DEFAULT_MAX_CALLS = 20;
// A bus alternative must save at least this much of the local-ride time it replaces (absolute and relative).
const MIN_RIDE_SAVING_SECONDS = 10 * 60;
const MIN_RIDE_SAVING_SHARE = 0.3;

const offsetMinutesOf = utcOffset => {
  const m = /([+-])(\d{2}):(\d{2})$/.exec(utcOffset);
  return m ? (m[1] === '-' ? -1 : 1) * (Number(m[2]) * 60 + Number(m[3])) : 0;
};

// Epoch ms -> local { date, time, timeSeconds } in the search's offset.
export function localClock(ms, utcOffset) {
  const local = new Date(ms + offsetMinutesOf(utcOffset) * 60000);
  const hh = local.getUTCHours();
  const mm = local.getUTCMinutes();
  return { date: local.toISOString().slice(0, 10), time: `${String(hh).padStart(2, '0')}:${String(mm).padStart(2, '0')}`, timeSeconds: hh * 3600 + mm * 60 };
}

const hasBus = journey => journey.legs.some(leg => leg.mode !== 'walk' && leg.mode !== 'local_ride');
const rideSeconds = journey => journey.legs.filter(leg => leg.mode === 'local_ride').reduce((sum, leg) => sum + leg.durationSeconds, 0);
const stationPlace = station => ({ type: 'station', name: station.name, code: station.code ?? null, lat: station.lat, lon: station.lon });
// Worth offering instead of a direct local ride of `directSeconds`?
export const savesRide = (journey, directSeconds) => rideSeconds(journey) <= directSeconds - Math.max(MIN_RIDE_SAVING_SECONDS, MIN_RIDE_SAVING_SHARE * directSeconds);
// ... and not at the price of a long wait: the bus option may take at most this much longer, door to door, than the
// direct ride would (no waiting two hours at night for a bus to save a 30-minute auto ride).
export const maxExtraSeconds = directSeconds => Math.max(45 * 60, directSeconds);
// How far before the latest arrival to look for buses: long enough for the bus ride itself, plus a choice of departures.
export const searchBeforeMinutes = meters => Math.min(MAX_SEARCH_BEFORE_MINUTES, Math.max(SEARCH_BEFORE_MINUTES, Math.round((meters / 1000 / PLANNING_BUS_KPH) * 60) + 120));

export function createBusFeeder({ network, config, fareConfig, now = new Date(), utcOffset = '+05:30', maxCalls = DEFAULT_MAX_CALLS, maxTransfers = 1, plan = planJourneys }) {
  let calls = 0;
  const cache = new Map();
  const run = (key, query) => {
    if (cache.has(key)) return cache.get(key);
    if (calls >= maxCalls) return null;
    calls++;
    let journeys = [];
    try {
      journeys = plan(network, { ...query, maxTransfers: Math.min(maxTransfers, config.defaultMaxTransfers ?? maxTransfers) }, { config, fareConfig, now }).journeys ?? [];
    } catch (error) {
      console.error('Bus feeder search failed:', error.message);
    }
    cache.set(key, journeys);
    return journeys;
  };
  const directRide = (a, b) => estimateLocalRide(haversineMeters(a.lat, a.lon, b.lat, b.lon), config).durationSeconds;

  return {
    get calls() { return calls; },

    access(origin, station, latestArrivalMs) {
      const before = searchBeforeMinutes(haversineMeters(origin.lat, origin.lon, station.lat, station.lon));
      const start = localClock(latestArrivalMs - before * 60000, utcOffset);
      const key = `a|${origin.lat},${origin.lon}|${station.code ?? `${station.lat},${station.lon}`}|${Math.floor(latestArrivalMs / 1800000)}`;
      const journeys = run(key, { fromLat: origin.lat, fromLng: origin.lon, toLat: station.lat, toLng: station.lon, ...start, windowMinutes: Math.max(ACCESS_WINDOW_MINUTES, before - 30) });
      const limit = directRide(origin, station);
      const earliestMs = latestArrivalMs - (limit + maxExtraSeconds(limit)) * 1000;
      const usable = (journeys ?? []).filter(j => hasBus(j) && Date.parse(j.arrivalTime) <= latestArrivalMs && Date.parse(j.departureTime) >= earliestMs && savesRide(j, limit));
      if (usable.length === 0) return null;
      const best = usable.reduce((a, b) => (Date.parse(b.departureTime) > Date.parse(a.departureTime) ? b : a));
      const legs = best.legs.map(leg => ({ ...leg }));
      if (legs[0].from?.type === 'origin') legs[0].from = { ...legs[0].from, name: origin.name ?? legs[0].from.name };
      const last = legs.at(-1);
      if (last.mode === 'walk' || last.mode === 'local_ride') last.kind = 'transfer';
      last.to = stationPlace(station);
      return legs;
    },

    egress(station, destination, earliestDepartureMs) {
      const start = localClock(earliestDepartureMs, utcOffset);
      const key = `e|${station.code ?? `${station.lat},${station.lon}`}|${destination.lat},${destination.lon}|${Math.floor(earliestDepartureMs / 1800000)}`;
      const journeys = run(key, { fromLat: station.lat, fromLng: station.lon, toLat: destination.lat, toLng: destination.lon, ...start, windowMinutes: EGRESS_WINDOW_MINUTES });
      const limit = directRide(station, destination);
      const latestMs = earliestDepartureMs + (limit + maxExtraSeconds(limit)) * 1000;
      const usable = (journeys ?? []).filter(j => hasBus(j) && Date.parse(j.departureTime) >= earliestDepartureMs && Date.parse(j.arrivalTime) <= latestMs && savesRide(j, limit));
      if (usable.length === 0) return null;
      const best = usable.reduce((a, b) => (Date.parse(b.arrivalTime) < Date.parse(a.arrivalTime) ? b : a));
      const legs = best.legs.map(leg => ({ ...leg }));
      const first = legs[0];
      if (first.mode === 'walk' || first.mode === 'local_ride') first.kind = 'transfer';
      first.from = stationPlace(station);
      const last = legs.at(-1);
      if (last.to?.type === 'destination') last.to = { ...last.to, name: destination.name ?? last.to.name };
      return legs;
    },

    // Between two stations (Train -> Bus -> Train): the earliest-arriving bus journey leaving after `earliestMs` and
    // arriving by `latestMs` (the next train's boarding buffer).
    transfer(fromStation, toStation, earliestMs, latestMs) {
      const start = localClock(earliestMs, utcOffset);
      const key = `t|${fromStation.code ?? `${fromStation.lat},${fromStation.lon}`}|${toStation.code ?? `${toStation.lat},${toStation.lon}`}|${Math.floor(earliestMs / 1800000)}`;
      const windowMinutes = Math.max(30, Math.min(EGRESS_WINDOW_MINUTES, Math.floor((latestMs - earliestMs) / 60000)));
      const journeys = run(key, { fromLat: fromStation.lat, fromLng: fromStation.lon, toLat: toStation.lat, toLng: toStation.lon, ...start, windowMinutes });
      const usable = (journeys ?? []).filter(j => hasBus(j) && Date.parse(j.departureTime) >= earliestMs && Date.parse(j.arrivalTime) <= latestMs);
      if (usable.length === 0) return null;
      const best = usable.reduce((a, b) => (Date.parse(b.arrivalTime) < Date.parse(a.arrivalTime) ? b : a));
      const legs = best.legs.map(leg => ({ ...leg }));
      const isConnector = leg => leg.mode === 'walk' || leg.mode === 'local_ride';
      if (isConnector(legs[0])) legs[0] = { ...legs[0], kind: 'transfer', from: stationPlace(fromStation) };
      if (isConnector(legs.at(-1))) legs[legs.length - 1] = { ...legs.at(-1), kind: 'transfer', to: stationPlace(toStation) };
      return legs;
    }
  };
}

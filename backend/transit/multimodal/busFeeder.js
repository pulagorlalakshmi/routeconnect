// Timetable buses to and from railway stations (Bus + Train, Train + Bus, Bus + Train + Bus).
//
// Uses the existing GTFS bus planner (planJourneys) unchanged, between the traveller's point and a station's coordinates:
//   access(origin, station, latestArrivalMs)    -> the LATEST-leaving bus journey that reaches the station in time
//   egress(station, destination, earliestMs)    -> the EARLIEST-arriving bus journey leaving the station after that
// A bus option is offered only when it contains a real bus leg and uses less estimated local-ride time than simply
// taking a local ride to/from the station. Bounded: a fixed number of planner calls per request, cached per station
// and half-hour, so adding buses can never make train search unbounded.
import { planJourneys } from '../routing/planner.js';
import { haversineMeters } from '../routing/geo.js';
import { estimateLocalRide } from '../routing/accessEgress.js';

const SEARCH_BEFORE_MINUTES = 150;   // look for access buses leaving up to this long before the latest arrival
const ACCESS_WINDOW_MINUTES = 120;
const EGRESS_WINDOW_MINUTES = 120;
const DEFAULT_MAX_CALLS = 10;

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

export function createBusFeeder({ network, config, fareConfig, now = new Date(), utcOffset = '+05:30', maxCalls = DEFAULT_MAX_CALLS, plan = planJourneys }) {
  let calls = 0;
  const cache = new Map();
  const run = (key, query) => {
    if (cache.has(key)) return cache.get(key);
    if (calls >= maxCalls) return null;
    calls++;
    let journeys = [];
    try {
      journeys = plan(network, { ...query, maxTransfers: Math.min(1, config.defaultMaxTransfers ?? 1) }, { config, fareConfig, now }).journeys ?? [];
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
      const start = localClock(latestArrivalMs - SEARCH_BEFORE_MINUTES * 60000, utcOffset);
      const key = `a|${origin.lat},${origin.lon}|${station.code ?? `${station.lat},${station.lon}`}|${Math.floor(latestArrivalMs / 1800000)}`;
      const journeys = run(key, { fromLat: origin.lat, fromLng: origin.lon, toLat: station.lat, toLng: station.lon, ...start, windowMinutes: ACCESS_WINDOW_MINUTES });
      const limit = directRide(origin, station);
      const usable = (journeys ?? []).filter(j => hasBus(j) && Date.parse(j.arrivalTime) <= latestArrivalMs && rideSeconds(j) < limit);
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
      const usable = (journeys ?? []).filter(j => hasBus(j) && Date.parse(j.departureTime) >= earliestDepartureMs && rideSeconds(j) < limit);
      if (usable.length === 0) return null;
      const best = usable.reduce((a, b) => (Date.parse(b.arrivalTime) < Date.parse(a.arrivalTime) ? b : a));
      const legs = best.legs.map(leg => ({ ...leg }));
      const first = legs[0];
      if (first.mode === 'walk' || first.mode === 'local_ride') first.kind = 'transfer';
      first.from = stationPlace(station);
      const last = legs.at(-1);
      if (last.to?.type === 'destination') last.to = { ...last.to, name: destination.name ?? last.to.name };
      return legs;
    }
  };
}

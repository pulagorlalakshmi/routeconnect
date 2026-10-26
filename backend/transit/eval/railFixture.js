// A SYNTHETIC nationwide railway timetable for coverage regression (no real request, no real schedule).
//
// Corridors use REAL station codes and coordinates from the nationwide station reference (OpenStreetMap), so station
// discovery, terminal selection and hub search are exercised on real geography. The trains are FAKE: numbers start
// with 9, names say "Fixture", times come from distance at an assumed 55 km/h. A fake RailRadar answers from it with
// the provider's documented semantics, as observed in recorded live answers:
//   - trains calling at A and later at B are returned, whatever their origin (intermediate boarding)
//   - only trains running on the date at the boarding station (running days at the train's origin, shifted)
//   - byCity: every station of both cities; the LAST station inside the origin city and the FIRST inside the
//     destination city are reported (as RailRadar does)
import { haversineMeters } from '../routing/geo.js';
import { getStationIndex } from '../railNetwork/stationReference.js';

export const CORRIDORS = [
  'MAS GDR NLR OGL BZA RJY VSKP VZM BAM KUR BBS CTC KGP HWH',
  'MAS BZA WL BPQ NGP ET BPL VGLJ AGC NZM',
  'CSMT DR TNA KYN PUNE DD SUR KLBG WADI RC GTL RU MAS',
  'LTT KYN NK BSL NGP G DURG R BSP JSG ROU TATA KGP HWH',
  'NDLS CNB PRYJ DDU GAYA DHN ASN BWN HWH',
  'NDLS LKO BSB DDU',
  'SBC BNC KJM JTJ AJJ MAS',
  'SBC YPR TK DVG UBL MRJ PUNE CSMT',
  'TVC QLN KTYM ERS TCR SRR PGT CBE ED SA JTJ AJJ MAS',
  'MAS VM TPJ DG MDU TEN CAPE',
  'MAQ UD MAO RN PNVL LTT',
  'ADI BRC ST BVI MMCT',
  'NDLS JP AII ADI',
  'NDLS UMB LDH ASR',
  'NDLS UMB CDG',
  'HWH KGP TATA RNC',
  'SC KZJ BPQ NGP',
  'SC KZJ KMT BZA',
  'BBS KUR PURI',
  'GHY NJP MLDT BWN HWH',
  'PNBE ARA BXR DDU BSB',
  'SBC DMM ATP DHNE KRNT MBNR KCG',
  'TPTY RU GDR BZA SC',
  'BZA GNT TEL OGL'
].map(line => line.split(' '));

// Departures from each end of every corridor (minutes after midnight); the third runs Tue / Fri only.
const DEPARTURES = [5 * 60 + 30, 13 * 60 + 10, 20 * 60 + 15];
const ALL = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'];
const WEEKLY = ['tue', 'fri'];
const API_DAYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];
const hhmm = minutes => { const m = Math.round(minutes) % 1440; return `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`; };

export function buildFixtureTimetable(index = getStationIndex()) {
  const trains = [];
  CORRIDORS.forEach((codes, ci) => {
    const stops = codes.map(code => index.byCode.get(code)).filter(Boolean);
    for (const [dir, list] of [[0, stops], [1, [...stops].reverse()]]) {
      DEPARTURES.forEach((start, k) => {
        let t = start;
        const calls = [];
        list.forEach((s, i) => {
          if (i > 0) t += (haversineMeters(list[i - 1].lat, list[i - 1].lon, s.lat, s.lon) * 1.2 / 1000 / 55) * 60;
          const arr = t;
          if (i > 0 && i < list.length - 1) t += 2; // dwell
          calls.push({ code: s.code, name: s.name, lat: s.lat, lon: s.lon, arr, dep: t });
        });
        trains.push({ number: `9${String(ci).padStart(2, '0')}${dir}${k}`, name: `Fixture ${list[0].code}-${list.at(-1).code} ${k + 1}`, runDays: k === 2 ? WEEKLY : ALL, calls });
      });
    }
  });
  return trains;
}

const dayOf = minutes => Math.floor(Math.round(minutes) / 1440) + 1;

/** Fake RailRadar fetch over the fixture. Counts every request in `calls`. */
export function createFixtureRailRadar({ trains = buildFixtureTimetable(), index = getStationIndex(), cityMeters = 12000 } = {}) {
  const calls = [];
  const cityOf = code => {
    const s = index.byCode.get(code);
    if (!s) return new Set([code]);
    return new Set(index.nearby(s.lat, s.lon, cityMeters).map(e => e.station.code));
  };
  const fetchImpl = async url => {
    const m = /\/trains\/between\/([A-Z]+)\/([A-Z]+)\?date=([\d-]+)/.exec(String(url));
    const byCity = /byCity=true/.test(String(url));
    calls.push({ from: m[1], to: m[2], date: m[3], byCity });
    const fromSet = byCity ? cityOf(m[1]) : new Set([m[1]]);
    const toSet = byCity ? cityOf(m[2]) : new Set([m[2]]);
    const date = new Date(`${m[3]}T12:00:00Z`);
    const out = [];
    for (const train of trains) {
      const idxs = train.calls.map((c, i) => [c, i]);
      const boards = idxs.filter(([c]) => fromSet.has(c.code));
      const alights = idxs.filter(([c]) => toSet.has(c.code));
      if (!boards.length || !alights.length) continue;
      const [b, bi] = byCity ? boards.at(-1) : boards[0];
      const found = alights.find(([, i]) => i > bi);
      if (!found) continue;
      const [a] = found;
      // Running on the date at the boarding station: the train started (day at boarding - 1) days earlier.
      const started = new Date(date.getTime() - (dayOf(b.dep) - 1) * 86400000);
      if (!train.runDays.includes(API_DAYS[started.getUTCDay()])) continue;
      out.push({
        train: { number: train.number, name: train.name, type: 'Fixture', runDays: train.runDays },
        from: { code: b.code, name: b.name, departure: hhmm(b.dep), day: dayOf(b.dep) },
        to: { code: a.code, name: a.name, arrival: hhmm(a.arr), day: dayOf(a.arr) },
        distance: Math.round((a.arr - b.dep) * 55 / 60), duration: Math.round(a.arr - b.dep), totalHaltsBetween: Math.max(0, found[1] - bi - 1)
      });
    }
    return new Response(JSON.stringify({ success: true, data: { from: { code: m[1] }, to: { code: m[2] }, count: out.length, trains: out } }), { status: 200, headers: { 'x-ratelimit-remaining-month': '90' } });
  };
  return { fetchImpl, calls, trains };
}

/**
 * Ground truth for one origin-destination pair: is there a fixture train (or two at one junction) from a station within
 * `reachMeters` of the origin to one within `reachMeters` of the destination? Ignores time of day (any train that day).
 */
export function fixtureOracle(trains, origin, destination, { reachMeters = 40000, changeMinutes = 20, maxWaitMinutes = 360 } = {}) {
  const near = (c, p) => haversineMeters(c.lat, c.lon, p.lat, p.lon) <= reachMeters;
  let direct = false;
  for (const t of trains) {
    const i = t.calls.findIndex(c => near(c, origin));
    if (i >= 0 && t.calls.slice(i + 1).some(c => near(c, destination))) { direct = true; break; }
  }
  if (direct) return { direct: true, viaJunction: false };
  for (const a of trains) {
    const i = a.calls.findIndex(c => near(c, origin));
    if (i < 0) continue;
    for (const x of a.calls.slice(i + 1)) {
      for (const b of trains) {
        if (b === a) continue;
        const j = b.calls.findIndex(c => c.code === x.code);
        if (j < 0) continue;
        const wait = ((b.calls[j].dep - x.arr) % 1440 + 1440) % 1440;
        if (wait >= changeMinutes && wait <= maxWaitMinutes && b.calls.slice(j + 1).some(c => near(c, destination))) return { direct: false, viaJunction: true, via: x.code };
      }
    }
  }
  return { direct: false, viaJunction: false };
}

/** Does the fixture really have this train calling at `from` then `to` at these clock times? */
export function fixtureConfirms(trains, leg) {
  const train = trains.find(t => t.number === leg.trainNumber);
  if (!train) return false;
  const i = train.calls.findIndex(c => c.code === leg.fromStop.code && hhmm(c.dep) === leg.departureTime.slice(11, 16));
  if (i < 0) return false;
  return train.calls.slice(i + 1).some(c => c.code === leg.toStop.code && hhmm(c.arr) === leg.arrivalTime.slice(11, 16));
}

// Nationwide station discovery and train search. Station data: the shipped OpenStreetMap reference (real stations and
// places, ODbL). Trains: the SYNTHETIC fixture timetable (eval/railFixture.js) behind a fake RailRadar - no real request.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { buildStationReference, createSpatialIndex, createStationIndex, getStationIndex, stationImportance } from '../stationReference.js';
import { getRailStations, clearTimetableEvidence, recordTimetableEvidence, trainsSeenAt } from '../railStations.js';
import { searchNationalPlaces, resolveNationalPlace } from '../../routing/nationalPlaces.js';
import { mergePlaceSuggestions } from '../../routing/placeSearch.js';
import { haversineMeters } from '../../routing/geo.js';
import { anchorStation, runsOnDate, chainAtStation, createRailRadarSource, railSearchSettings } from '../../sources/rail/railRadarSource.js';
import { createRailRadarClient } from '../../rail/verification/railRadar.js';
import { handleMultimodalPlanRequest, noJourneyMessage, resolveOutsideBusDataset } from '../../multimodal/planMultimodal.js';
import { buildFixtureTimetable, createFixtureRailRadar, fixtureOracle, fixtureConfirms } from '../../eval/railFixture.js';
import { CASES } from '../../eval/coverageCases.js';
import { getRoutingConfig } from '../../routing/config.js';

const index = getStationIndex();
const set = getRailStations();
const place = name => resolveNationalPlace(name);

describe('nationwide station reference (OpenStreetMap)', () => {
  test('built from raw elements: official codes only, metro stations excluded, aliases kept, one entry per code', () => {
    const ref = buildStationReference({ elements: [
      { type: 'node', id: 1, lat: 13.08, lon: 80.27, tags: { railway: 'station', name: 'Test Central', 'railway:ref': 'TCX', alt_name: 'Old Test;Test Main', wikidata: 'Q1' } },
      { type: 'way', id: 2, center: { lat: 13.081, lon: 80.271 }, tags: { railway: 'station', name: 'Test Central', ref: 'TCX' } },
      { type: 'node', id: 3, lat: 13.0, lon: 80.2, tags: { railway: 'station', name: 'Test Metro', station: 'subway', ref: 'TMX' } },
      { type: 'node', id: 4, lat: 13.0, lon: 80.2, tags: { railway: 'halt', name: 'No Code Halt' } },
      { type: 'node', id: 5, lat: 13.05, lon: 80.25, tags: { place: 'city', name: 'Testpur', alt_name: 'Old Testpur' } }
    ] });
    assert.deepEqual(ref.stations.map(s => s.c), ['TCX']);
    assert.deepEqual(ref.stations[0].a.sort(), ['Old Test', 'Test Main']);
    assert.equal(ref.stations[0].w, 1, 'the better-described entry for a code wins');
    assert.deepEqual(ref.places.map(p => [p.n, p.t]), [['Testpur', 'city']]);
    assert.match(ref.meta.licence, /ODbL/);
    assert.equal(ref.meta.attribution, '© OpenStreetMap contributors');
  });

  test('the shipped seed covers India, not one region: major terminals of every metro and many states', () => {
    assert.ok(index.stations.length > 8000, `${index.stations.length} stations`);
    for (const code of ['MAS', 'MS', 'NDLS', 'NZM', 'HWH', 'SDAH', 'CSMT', 'LTT', 'MMCT', 'SBC', 'YPR', 'SC', 'BZA', 'BBS', 'GHY', 'TVC', 'ERS', 'LKO', 'PNBE', 'ADI', 'JP', 'ASR', 'NGP']) {
      assert.ok(index.byCode.has(code), code);
    }
    const inBox = (a, b, c, d) => index.stations.filter(s => s.lat >= a && s.lat <= b && s.lon >= c && s.lon <= d).length;
    for (const [state, box] of Object.entries({ TamilNadu: [8, 13.6, 76.2, 80.4], Maharashtra: [15.6, 22, 72.6, 80.9], WestBengal: [21.5, 27.2, 85.8, 89.9], Kerala: [8.2, 12.8, 74.8, 77.4], NorthEast: [22, 29.5, 89.7, 97.4] })) {
      assert.ok(inBox(...box) > 100, state);
    }
  });

  test('the spatial index finds exactly the stations a full scan finds, nearest first', () => {
    for (const [lat, lon, r] of [[13.08, 80.27, 25000], [28.61, 77.21, 8000], [22.57, 88.36, 40000], [34.16, 77.58, 40000]]) {
      const fast = index.nearby(lat, lon, r).map(e => e.station.code);
      const slow = index.stations.map(s => [s.code, haversineMeters(lat, lon, s.lat, s.lon)]).filter(([, m]) => m <= r).sort((a, b) => a[1] - b[1] || a[0].localeCompare(b[0])).map(([c]) => c);
      assert.deepEqual(fast, slow);
    }
    const grid = createSpatialIndex([{ code: 'A', lat: 10, lon: 10 }, { code: 'B', lat: 10.3, lon: 10 }]);
    assert.deepEqual(grid.nearby(10, 10, 40000).map(e => e.station.code), ['A', 'B']);
  });

  test('station identity: a station named after the city it is in counts as that city\'s station', () => {
    const idx = createStationIndex({ meta: {}, stations: [
      { c: 'NAGX', n: 'Nagpuram Junction', a: [], k: 'station', la: 21.15, lo: 79.09, w: 1 },
      { c: 'SMLX', n: 'Small Halt', a: [], k: 'halt', la: 21.16, lo: 79.1, w: 0 }
    ], places: [{ n: 'Nagpuram', a: [], t: 'city', la: 21.146, lo: 79.088 }] });
    assert.equal(idx.byCode.get('NAGX').serves, 'city');
    assert.equal(idx.byCode.get('SMLX').serves, null);
    assert.ok(stationImportance(idx.byCode.get('NAGX')) > stationImportance(idx.byCode.get('SMLX')) + 0.5);
  });

  test('timetable evidence: stations seen with many trains rank higher next time', () => {
    clearTimetableEvidence();
    const before = set.importanceOf(index.byCode.get('BBS'));
    recordTimetableEvidence(Array.from({ length: 20 }, () => ({ from: { code: 'BBS' }, to: { code: 'PURI' } })));
    assert.equal(trainsSeenAt('BBS'), 20);
    assert.ok(set.importanceOf(index.byCode.get('BBS')) > before);
    clearTimetableEvidence();
  });
});

describe('typed places across India', () => {
  test('cities, aliases and official codes resolve; whole words only ("Patna" is Patna, not Visakhapatnam)', () => {
    assert.equal(place('Patna').name, 'Patna');
    assert.equal(place('Mumbai').kind, 'city');
    assert.equal(place('Bombay').name, 'Mumbai');
    assert.equal(place('Madras').name, 'Chennai');
    assert.equal(place('Bangalore').name, 'Bengaluru');
    assert.equal(place('MAS').code, 'MAS');
    assert.equal(place('NDLS').code, 'NDLS');
  });

  test('short names must match exactly to plan from them; codes only in capitals', () => {
    assert.equal(place('Goa'), null, '"Goa" is a state: never silently Goalpara');
    assert.equal(place('GOA').code, 'GOA');
    assert.equal(place('Mas'), null);
    assert.equal(place('Visakha').name, 'Visakhapatnam', 'a 5+ letter prefix is accepted');
    assert.ok(searchNationalPlaces('Goa', { limit: 5 }).length > 0, 'autocomplete still offers prefix matches');
  });

  test('suggestions: bus places first, then cities and stations; a city that is also a bus place is listed once', () => {
    const gtfs = [{ id: 'place:1', name: 'Chennai', lat: 13.07, lon: 80.21, stopCount: 1, services: 50, matchedBy: 'exact' }];
    const merged = mergePlaceSuggestions(gtfs, searchNationalPlaces('Chennai', { limit: 5 }), 8);
    assert.equal(merged[0].kind, 'bus_stop');
    assert.equal(merged.filter(p => p.name === 'Chennai').length, 1);
    assert.ok(merged.some(p => p.kind === 'station'));
  });

  test('a place outside the bus timetable is planned from its coordinates instead of failing with "not found"', () => {
    const out = resolveOutsideBusDataset({ from: 'Mumbai', to: 'Pune' }, () => null, resolveNationalPlace);
    assert.equal(out.resolved.from.name, 'Mumbai');
    assert.ok(Number(out.raw.fromLat) > 18 && Number(out.raw.fromLat) < 20);
    assert.equal(out.resolved.to.source, 'openstreetmap');
  });
});

describe('boarding and alighting stations', () => {
  const anchor = (name, radius = 40000) => anchorStation(set, { ...place(name), name }, radius)?.s.code;
  test('the city\'s own main station, not a nearby suburban junction or harbour terminus', () => {
    assert.equal(anchor('Chennai'), 'MAS');
    assert.equal(anchor('Hyderabad'), 'HYB');
    assert.equal(anchor('Guwahati'), 'GHY');
    assert.equal(anchor('Delhi'), 'DLI');
    assert.equal(anchor('Vijayawada'), 'BZA', 'Andhra Pradesh behaviour is unchanged');
    assert.equal(anchor('Narasaraopet'), 'NRT');
  });
  test('no railway: no station is invented (Leh, Gangtok)', () => {
    assert.equal(anchor('Leh'), undefined);
    assert.equal(anchor('Gangtok'), undefined);
  });
  test('multi-terminal cities need a place=city and several stations: towns with many halts are not cities', () => {
    for (const city of ['Chennai', 'Mumbai', 'Kolkata', 'Lucknow']) assert.equal(set.isCity(place(city)), true, city);
    for (const town of ['Narasaraopet', 'Vinukonda', 'Puri']) assert.equal(set.isCity(place(town)), false, town);
  });
});

describe('train search across India (synthetic timetable)', () => {
  const trains = buildFixtureTimetable();
  const network = null;
  const env = { RAILRADAR_API_KEY: 'fixture-key', RAILRADAR_MONTHLY_REQUEST_BUDGET: '100000' };
  async function plan(from, to, extra = {}) {
    clearTimetableEvidence();
    const rr = createFixtureRailRadar({ trains });
    const client = createRailRadarClient({ env: { ...env, ...(extra.env ?? {}) }, fetchImpl: rr.fetchImpl });
    const rail = createRailRadarSource({ env, client });
    const o = place(from);
    const d = place(to);
    const { body } = await handleMultimodalPlanRequest({ fromLat: String(o.lat), fromLng: String(o.lon), toLat: String(d.lat), toLng: String(d.lon), from, to, date: '2026-10-27', time: '06:00', ...(extra.query ?? {}) }, { sources: [rail], getNetwork: () => network });
    return { body, rr, o, d };
  }
  const trainLegs = body => body.journeys.flatMap(j => j.legs.filter(l => l.mode === 'rail'));

  test('interstate: Chennai -> Visakhapatnam (no region boundary), every train leg exactly as the timetable has it', async () => {
    const { body } = await plan('Chennai', 'Visakhapatnam');
    assert.ok(trainLegs(body).length > 0);
    assert.ok(trainLegs(body).every(l => fixtureConfirms(trains, l)));
  });

  test('a city whose nearest large station is not its main one is asked about all its terminals at once (byCity)', async () => {
    const { body } = await plan('Mumbai', 'Pune');
    assert.equal(body.railSearch.pairs[0].byCity, true);
    assert.ok(trainLegs(body).some(l => ['CSMT', 'LTT', 'DR', 'TNA', 'KYN'].includes(l.fromStop.code)));
  });

  test('intermediate boarding and alighting (both ends mid-route)', async () => {
    const { body } = await plan('Nellore', 'Ongole');
    assert.ok(trainLegs(body).some(l => !/^Fixture (NLR|OGL)/.test(l.trainName)), 'boarded on a train that started elsewhere');
  });

  test('no station near an end: said plainly, nothing invented, no request spent on it', async () => {
    const { body, rr } = await plan('Leh', 'New Delhi');
    assert.equal(body.journeys.length, 0);
    assert.equal(rr.calls.length, 0);
    assert.match(body.message, /no railway station near your origin/);
  });

  test('requests per search stay within the cap; quota tiers shrink it (a tenth of what is left; 1 near the end)', async () => {
    const { rr } = await plan('Kolkata', 'Patna');
    assert.ok(rr.calls.length <= railSearchSettings({}).maxRequestsPerSearch);
    const tight = await plan('Kolkata', 'Patna', { env: { RAILRADAR_MONTHLY_REQUEST_BUDGET: '25' } });
    assert.ok(tight.rr.calls.length <= 2, `${tight.rr.calls.length} requests with 25 left`);
    const last = await plan('Kolkata', 'Patna', { env: { RAILRADAR_MONTHLY_REQUEST_BUDGET: '15' } });
    assert.equal(last.rr.calls.length, 1);
    assert.equal(last.body.railSearch.quotaLow, true);
  });

  test('running days are re-checked: a Monday-only train is never offered on a Tuesday', () => {
    const train = { runDays: ['mon'], from: { day: 1 } };
    assert.equal(runsOnDate(train, '2026-10-26'), true);
    assert.equal(runsOnDate(train, '2026-10-27'), false);
    assert.equal(runsOnDate({ runDays: ['mon'], from: { day: 2 } }, '2026-10-27'), true, 'started Monday, boards on day 2');
    assert.equal(runsOnDate({ runDays: null, from: { day: 1 } }, '2026-10-27'), true);
  });

  test('a change between two stations of one city needs at least an hour before the exact connection check', () => {
    const leg = (number, from, to, dep, arr) => [{ trainNumber: number, from: { code: from }, to: { code: to }, departureTime: `x${dep}`, planning: { departureSeconds: dep, arrivalSeconds: arr } }];
    const [same] = chainAtStation([leg('1', 'A', 'J', 0, 36000)], [leg('2', 'J', 'B', 36000 + 1800, 50000)], { changeSeconds: 1200, maxWaitSeconds: 14400 });
    assert.ok(same, 'same station: 30 min is enough');
    const cross = chainAtStation([leg('1', 'A', 'J', 0, 36000)], [leg('2', 'K', 'B', 36000 + 1800, 50000)], { changeSeconds: 1200, maxWaitSeconds: 14400 });
    assert.equal(cross.length, 0, 'another station of the city: 30 min is not');
  });
});

describe('coverage regression subset (synthetic timetable; the full 111-case run is npm run rail:coverage)', () => {
  test('discovery, validity and request budget on a representative subset', async () => {
    const trains = buildFixtureTimetable();
    const subset = CASES.filter((_, i) => i % 4 === 0);
    let expected = 0, found = 0, valid = 0, maxRequests = 0;
    for (const [from, to] of subset) {
      clearTimetableEvidence();
      const o = place(from), d = place(to);
      const rr = createFixtureRailRadar({ trains });
      const env = { RAILRADAR_API_KEY: 'fixture-key', RAILRADAR_MONTHLY_REQUEST_BUDGET: '100000' };
      const rail = createRailRadarSource({ env, client: createRailRadarClient({ env, fetchImpl: rr.fetchImpl }) });
      const { body } = await handleMultimodalPlanRequest({ fromLat: String(o.lat), fromLng: String(o.lon), toLat: String(d.lat), toLng: String(d.lon), date: '2026-10-27', time: '06:00' }, { sources: [rail], getNetwork: () => null, config: getRoutingConfig() });
      const legs = body.journeys.flatMap(j => j.legs.filter(l => l.mode === 'rail'));
      if (fixtureOracle(trains, o, d).direct) { expected++; if (legs.length) found++; }
      if (legs.every(l => fixtureConfirms(trains, l))) valid++;
      maxRequests = Math.max(maxRequests, rr.calls.length);
    }
    assert.ok(found / expected >= 0.9, `direct-train discovery ${found}/${expected}`);
    assert.equal(valid, subset.length, 'every train shown exists at those times');
    assert.ok(maxRequests <= 4);
  });
});

describe('explanations', () => {
  const base = { windowMinutes: 180, modes: [], shown: {}, found: {}, bus: { origin: true, destination: true }, rail: { status: 'ok', limitedBy: null, pairsChecked: 2, pairsSkipped: 0, trainsReturned: 5, stations: { origin: 'ok', destination: 'ok' } } };
  test('each reason is told apart, and none claims that no route exists when the search was limited', () => {
    assert.match(noJourneyMessage({ ...base, rail: { ...base.rail, trainsReturned: 0 } }), /No trains were found between the stations checked/);
    assert.match(noJourneyMessage({ ...base, rail: { ...base.rail, stations: { origin: 'none', destination: 'ok' } } }), /no railway station near your origin/);
    assert.match(noJourneyMessage({ ...base, rail: { ...base.rail, limitedBy: 'quota', pairsSkipped: 2 } }), /allowance is nearly used up.*does not prove/);
    assert.match(noJourneyMessage({ ...base, rail: { ...base.rail, limitedBy: 'budget', pairsSkipped: 1 } }), /limited.*does not prove/);
    assert.match(noJourneyMessage({ ...base, rail: { ...base.rail, status: 'error' } }), /could not be checked right now/);
    assert.match(noJourneyMessage({ ...base, bus: { origin: false, destination: true } }), /APSRTC/);
  });
});

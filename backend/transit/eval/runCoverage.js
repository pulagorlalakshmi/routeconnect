// Nationwide coverage regression over the SYNTHETIC fixture timetable (no real request is ever made).
//
//   npm run rail:coverage                      the planner in this checkout
//   npm run rail:coverage -- --root <dir>      the planner of another checkout (e.g. a git worktree of an older commit),
//                                              with the same cases, fixture, bus network and station reference
//   add --json <file> to save per-case results
//
// Measures, per case and overall: whether a train journey was found where the fixture has one (discovery), false
// "no train" answers, whether every train leg shown really exists in the fixture at those times (validity), station
// resolution for multi-terminal cities, RailRadar requests per cold search, latency, and ranking order.
import '../../env.js';
import fs from 'fs';
import path from 'path';
import { pathToFileURL } from 'url';
import { CASES, CITY_TERMINALS } from './coverageCases.js';
import { createFixtureRailRadar, fixtureOracle, fixtureConfirms, buildFixtureTimetable } from './railFixture.js';
import { resolveNationalPlace } from '../routing/nationalPlaces.js';
import { getTransitNetwork } from '../routing/dataLoader.js';
import { getStationIndex } from '../railNetwork/stationReference.js';

const args = process.argv.slice(2);
const option = name => { const i = args.indexOf(`--${name}`); return i >= 0 ? args[i + 1] : null; };
const root = path.resolve(option('root') ?? path.join(path.dirname(new URL(import.meta.url).pathname.replace(/^\/(\w:)/, '$1')), '..', '..', '..'));
const mod = rel => import(pathToFileURL(path.join(root, 'backend', 'transit', rel)).href);

const { handleMultimodalPlanRequest } = await mod('multimodal/planMultimodal.js');
const { createRailRadarSource } = await mod('sources/rail/railRadarSource.js');
const { createRailRadarClient } = await mod('rail/verification/railRadar.js');
const stationsModule = await mod('railNetwork/railStations.js').catch(() => ({}));
// Every case is a cold search: no timetable evidence carried over from earlier cases (reproducible, conservative).

const index = getStationIndex();
const trains = buildFixtureTimetable(index);
const network = getTransitNetwork();
const DATE = '2026-10-27'; // a Tuesday
const env = { RAILRADAR_API_KEY: 'fixture-key', RAILRADAR_MONTHLY_REQUEST_BUDGET: '100000' };

const isTrain = leg => leg.mode === 'rail';
const kindOf = j => {
  const modes = new Set(j.legs.filter(l => l.mode !== 'walk' && l.mode !== 'local_ride').map(l => (isTrain(l) ? 'train' : 'bus')));
  return modes.size === 2 ? 'mixed' : modes.has('train') ? 'train' : 'bus';
};
const chronological = j => j.legs.every((l, i) => i === 0 || Date.parse(l.departureTime) >= Date.parse(j.legs[i - 1].arrivalTime));

const results = [];
for (const [from, to, category] of CASES) {
  const o = resolveNationalPlace(from);
  const d = resolveNationalPlace(to);
  if (!o || !d) { results.push({ from, to, category, unresolved: !o ? from : to }); continue; }
  const oracle = fixtureOracle(trains, o, d);
  stationsModule.clearTimetableEvidence?.();
  const rr = createFixtureRailRadar({ trains, index });
  const client = createRailRadarClient({ env, fetchImpl: rr.fetchImpl });
  const rail = createRailRadarSource({ env, client });
  const query = { fromLat: String(o.lat), fromLng: String(o.lon), toLat: String(d.lat), toLng: String(d.lon), from, to, date: DATE, time: '06:00' };
  const started = performance.now();
  const { body } = await handleMultimodalPlanRequest(query, { sources: [rail], getNetwork: () => network });
  const ms = Math.round(performance.now() - started);
  const requests = rr.calls.length;
  const journeys = body?.journeys ?? [];
  const railJourneys = journeys.filter(j => j.legs.some(isTrain));
  const legs = railJourneys.flatMap(j => j.legs.filter(isTrain));
  const valid = journeys.every(chronological) && legs.every(l => fixtureConfirms(trains, l));
  // Ranking: the same search with "fastest" must be ordered by door-to-door time (cache is warm: no extra requests).
  const fastest = (await handleMultimodalPlanRequest({ ...query, rank: 'fastest' }, { sources: [rail], getNetwork: () => network })).body?.journeys ?? [];
  const rankingOk = fastest.every((j, i) => i === 0 || fastest[i - 1].totalDurationSeconds <= j.totalDurationSeconds);
  const firstTrain = railJourneys[0]?.legs.find(isTrain) ?? null;
  const lastTrain = railJourneys[0] ? [...railJourneys[0].legs].reverse().find(isTrain) : null;
  results.push({
    from, to, category, oracle: oracle.direct ? 'direct' : oracle.viaJunction ? 'via' : 'none',
    found: { any: journeys.length, train: railJourneys.length, mixed: journeys.filter(j => kindOf(j) === 'mixed').length },
    valid, rankingOk, requests, ms,
    boarding: firstTrain?.fromStop.code ?? null, alighting: lastTrain?.toStop.code ?? null,
    message: journeys.length === 0 ? body?.message ?? body?.error ?? null : null,
    limitedBy: body?.railSearch?.limitedBy ?? null
  });
}

// ---------- metrics ----------
const scored = results.filter(r => !r.unresolved);
const expectTrain = scored.filter(r => r.oracle !== 'none');
const discovered = expectTrain.filter(r => r.found.train > 0);
const falseNoTrain = expectTrain.filter(r => r.found.train === 0);
const terminalCases = scored.flatMap(r => [[r.from, r.boarding], [r.to, r.alighting]].filter(([city, code]) => CITY_TERMINALS[city] && code));
const terminalHits = terminalCases.filter(([city, code]) => CITY_TERMINALS[city].includes(code));
const pct = (a, b) => (b === 0 ? 'n/a' : `${Math.round((a / b) * 1000) / 10}% (${a}/${b})`);
const avg = list => (list.length ? Math.round((list.reduce((s, x) => s + x, 0) / list.length) * 10) / 10 : 0);
const byCategory = {};
for (const r of scored) {
  const c = (byCategory[r.category] ??= { cases: 0, expect: 0, found: 0, mixed: 0 });
  c.cases++;
  if (r.oracle !== 'none') { c.expect++; if (r.found.train > 0) c.found++; }
  if (r.found.mixed > 0) c.mixed++;
}
const summary = {
  root, cases: CASES.length, unresolved: results.filter(r => r.unresolved).map(r => r.unresolved),
  trainExpected: expectTrain.length,
  discoveryRate: pct(discovered.length, expectTrain.length),
  falseNoTrainRate: pct(falseNoTrain.length, expectTrain.length),
  validJourneyRate: pct(scored.filter(r => r.valid).length, scored.length),
  rankingCorrect: pct(scored.filter(r => r.rankingOk).length, scored.length),
  terminalResolution: pct(terminalHits.length, terminalCases.length),
  requestsPerSearch: { mean: avg(scored.map(r => r.requests)), max: Math.max(...scored.map(r => r.requests)) },
  latencyMs: { mean: avg(scored.map(r => r.ms)), max: Math.max(...scored.map(r => r.ms)) },
  byCategory
};
console.log(JSON.stringify(summary, null, 2));
if (args.includes('--cases')) for (const r of results) console.log(JSON.stringify(r));
const out = option('json');
if (out) fs.writeFileSync(out, JSON.stringify({ summary, results }, null, 2));

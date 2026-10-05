// npm run transit:compare [-- --date YYYY-MM-DD] [-- --time HH:MM] [-- --window MINUTES]
//
// Compares the legacy planner (routingEngine.js, /api/planner) with the GTFS/RAPTOR planner (/api/v2/plan) on the
// same city pairs and writes backend/transit/reports/old-vs-new-comparison.md (git-ignored).
//
// Safe by construction: the legacy engine runs against a THROWAWAY database in the OS temp directory and every
// outbound fetch() is disabled, so no real data is touched and no external/paid API can be called.
// The goal is not for the new planner to mimic the old one, only to show which is more correct and explainable.
import '../../env.js';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';
import { performance } from 'node:perf_hooks';
import { getTransitConfig } from '../config.js';
import { parseArgs } from './common.js';

const args = parseArgs();
const date = typeof args.date === 'string' ? args.date : '2026-10-05'; // a Monday
const time = typeof args.time === 'string' ? args.time : '08:00';
const windowMinutes = typeof args.window === 'string' ? Number(args.window) : 180;

// ---- isolate the legacy engine BEFORE importing it ----
const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rc-compare-'));
process.env.ROUTECONNECT_DATABASE_PATH = path.join(tempDir, 'legacy.db');
const realFetch = globalThis.fetch;
globalThis.fetch = async () => { throw new Error('network disabled by transit:compare'); };

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const { db, initializeDatabase } = await import('../../db/database.js');
const { findMultiModalRoutes } = await import('../../services/routingEngine.js');
const { getTransitNetwork } = await import('../routing/dataLoader.js');
const { planJourneys } = await import('../routing/planner.js');
const { getRoutingConfig } = await import('../routing/config.js');
const { parseClockTime } = await import('../routing/serviceCalendar.js');

const PAIRS = [['Bhimavaram', 'Vijayawada'], ['Narasaraopet', 'Ongole'], ['Vijayawada', 'Guntur'], ['Vijayawada', 'Hyderabad'], ['Kalla', 'Vijayawada'], ['Undi', 'Visakhapatnam']];

const hhmm = text => (typeof text === 'string' && /^\d{1,2}:\d{2}/.test(text) ? Number(text.slice(0, text.indexOf(':'))) * 60 + Number(text.slice(-2)) : null);
const strip = value => JSON.stringify(value, (key, v) => (key === 'id' ? undefined : v));
const ms = value => Math.round(value * 10) / 10;

function legacyMetrics(routes) {
  let segments = 0, estimated = 0, noTimes = 0, rideHailing = 0, priced = 0, impossible = 0;
  for (const route of routes) {
    for (let i = 0; i < route.segments.length; i++) {
      const s = route.segments[i];
      segments++;
      if (s.estimated) estimated++;
      if (!s.departure && !s.arrival) noTimes++;
      if (s.mode === 'uber' || s.mode === 'rapido') rideHailing++;
      if (typeof s.price === 'number') priced++;
      const next = route.segments[i + 1];
      const arrives = hhmm(s.arrival);
      const departs = hhmm(next?.departure);
      if (arrives !== null && departs !== null && departs < arrives) impossible++;
    }
  }
  return { segments, estimated, noTimes, rideHailing, priced, impossible };
}

function newMetrics(journeys) {
  let legs = 0, walk = 0, nonPublished = 0, impossible = 0;
  for (const journey of journeys) {
    for (let i = 0; i < journey.legs.length; i++) {
      const leg = journey.legs[i];
      legs++;
      if (leg.mode === 'walk') walk++;
      else if (leg.dataConfidence !== 'published') nonPublished++;
      const next = journey.legs[i + 1];
      if (next && next.departureTime < leg.arrivalTime) impossible++;
    }
  }
  return { legs, walk, nonPublished, impossible, fares: journeys.filter(j => j.fare !== null).length };
}

// Rough proxy for "hardcoded assumptions": numeric literals (other than 0/1/2) outside comments and strings.
function numericLiterals(files) {
  let total = 0;
  for (const file of files) {
    const text = fs.readFileSync(file, 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '')
      .replace(/`(?:\\.|[^`\\])*`/g, '``').replace(/'(?:\\.|[^'\\])*'/g, "''").replace(/"(?:\\.|[^"\\])*"/g, '""');
    for (const match of text.matchAll(/(?<![\w.$])\d+(?:\.\d+)?(?![\w.])/g)) {
      if (!['0', '1', '2'].includes(match[0])) total++;
    }
  }
  return total;
}

async function compare(config, network) {
  const lookup = db.prepare("SELECT latitude, longitude FROM locations WHERE LOWER(name) = ? AND type IN ('city','town','village') ORDER BY type LIMIT 1");
  const rows = [];
  const lines = [];

  for (const [from, to] of PAIRS) {
    const a = lookup.get(from.toLowerCase());
    const b = lookup.get(to.toLowerCase());
    if (!a || !b) { rows.push({ pair: `${from} -> ${to}`, skipped: true }); continue; }

    // OLD planner: by name; date only reaches connecting trains, time is not even a parameter.
    let t = performance.now();
    const oldRoutes = await findMultiModalRoutes(from, to, date, null, 1, null);
    const oldMs = performance.now() - t;
    const oldAgain = await findMultiModalRoutes(from, to, date, null, 1, null);
    const oldOtherDate = await findMultiModalRoutes(from, to, '2026-10-04', null, 1, null); // Sunday
    const oldIdsStable = JSON.stringify(oldRoutes.map(r => r.id)) === JSON.stringify(oldAgain.map(r => r.id));
    const oldDateSensitive = strip(oldRoutes) !== strip(oldOtherDate);

    // NEW planner: by coordinates; honours date and time.
    const query = (d, hhmmText) => ({
      fromLat: a.latitude, fromLng: a.longitude, toLat: b.latitude, toLng: b.longitude,
      date: d, time: hhmmText, timeSeconds: parseClockTime(hhmmText), maxTransfers: 3, windowMinutes
    });
    t = performance.now();
    const fresh = planJourneys(network, query(date, time), { config });
    const newMs = performance.now() - t;
    const again = planJourneys(network, query(date, time), { config });
    const night = planJourneys(network, query(date, '22:00'), { config });
    const newIdsStable = JSON.stringify(fresh.journeys.map(j => j.id)) === JSON.stringify(again.journeys.map(j => j.id));
    const newTimeSensitive = JSON.stringify(fresh.journeys.map(j => j.id)) !== JSON.stringify(night.journeys.map(j => j.id));

    rows.push({
      pair: `${from} -> ${to}`,
      old: { routes: oldRoutes.length, ms: ms(oldMs), idsStable: oldIdsStable, dateSensitive: oldDateSensitive, ...legacyMetrics(oldRoutes) },
      fresh: { journeys: fresh.journeys.length, ms: ms(newMs), idsStable: newIdsStable, timeSensitive: newTimeSensitive, confidence: fresh.dataset.effectiveConfidence, ...newMetrics(fresh.journeys),
        first: fresh.journeys[0] ? `${fresh.journeys[0].departureTime.slice(11, 16)}->${fresh.journeys[0].arrivalTime.slice(11, 16)}` : '-' }
    });
  }

  const oldFiles = ['routingEngine.js', 'busService.js', 'railwayService.js', 'flightService.js', 'transitPlacesService.js'].map(f => path.join(root, 'services', f));
  const routingDir = path.join(root, 'transit', 'routing');
  const newFiles = ['raptor.js', 'dataLoader.js', 'serviceCalendar.js', 'stopIndex.js', 'accessEgress.js', 'journeyBuilder.js', 'ranking.js', 'planner.js', 'planQuery.js'].map(f => path.join(routingDir, f));
  const hardcoded = { old: numericLiterals(oldFiles), fresh: numericLiterals(newFiles), freshConfigKnobs: Object.keys(config).length + Object.keys(config.ranking).length };

  lines.push('# Old planner vs new planner', '',
    `Search: ${date} ${time}, window ${windowMinutes} min. Old = \`/api/planner\` engine (routingEngine.js). New = \`/api/v2/plan\` (GTFS + RAPTOR).`,
    'The new planner is not meant to reproduce the old output; the question is which one is more correct and explainable.', '',
    '| Pair | Old routes | Old ms | Old estimated segs | Old segs w/o any time | Old impossible connections | New journeys | New ms | New first | New confidence | New impossible connections |',
    '|---|---|---|---|---|---|---|---|---|---|---|');
  for (const r of rows) {
    if (r.skipped) { lines.push(`| ${r.pair} | skipped (place missing in legacy DB) |||||||||| `); continue; }
    lines.push(`| ${r.pair} | ${r.old.routes} | ${r.old.ms} | ${r.old.estimated}/${r.old.segments} | ${r.old.noTimes}/${r.old.segments} | ${r.old.impossible} | ${r.fresh.journeys} | ${r.fresh.ms} | ${r.fresh.first} | ${r.fresh.confidence} | ${r.fresh.impossible} |`);
  }
  const ok = rows.filter(r => !r.skipped);
  const all = (fn) => ok.every(fn);
  lines.push('', '| Property | Old | New |', '|---|---|---|',
    `| Stable ids across identical searches | ${all(r => r.old.idsStable) ? 'yes' : '**no** (Date.now()/Math.random() in ids)'} | ${all(r => r.fresh.idsStable) ? 'yes (content hash)' : 'no'} |`,
    `| Result depends on departure time | **no** (time is not a parameter) | ${ok.some(r => r.fresh.timeSensitive) ? 'yes' : 'no'} |`,
    `| Result depends on weekday | ${ok.some(r => r.old.dateSensitive) ? 'partly (connecting trains only)' : '**no**'} | yes (service calendars) |`,
    `| Ride-hailing legs in results | ${ok.reduce((n, r) => n + r.old.rideHailing, 0)} (no GPS origin here) | 0 (never fabricated) |`,
    `| Segments carrying a numeric price | ${ok.reduce((n, r) => n + r.old.priced, 0)} of ${ok.reduce((n, r) => n + r.old.segments, 0)} (formula/curated) | 0 (fare is null) |`,
    `| Numeric literals in routing code (proxy for hardcoded assumptions) | ${hardcoded.old} | ${hardcoded.fresh} (+ ${hardcoded.freshConfigKnobs} named config values) |`,
    `| Confidence per leg | none (green "Available"/"Verified" copy) | published / inferred / estimated, weakest-leg rule |`,
    `| Timetable source | hand-curated static JS tables + formulas | imported GTFS stop_times |`, '',
    '_Impossible connection = the next leg departs before the previous leg arrived (clock times compared; legacy uses HH:MM strings, so overnight cases are ignored there)._', '',
    `_Numeric-literal counts exclude 0, 1 and 2 and ignore strings/comments; they are a rough proxy only._`);

  const reportPath = path.join(getTransitConfig().reportPath, '..', 'old-vs-new-comparison.md');
  fs.mkdirSync(path.dirname(reportPath), { recursive: true });
  fs.writeFileSync(reportPath, lines.join('\n') + '\n', 'utf8');
  console.log(lines.join('\n'));
  console.log(`\nReport written to ${path.relative(process.cwd(), reportPath)}`);
}

// ---- main (kept last so every helper above is initialised) ----
try {
  initializeDatabase();
  const config = getRoutingConfig();
  const network = getTransitNetwork({ config });
  if (!network) {
    console.error('No transit data. Run "npm run transit:download" and "npm run transit:import" first.');
    process.exitCode = 1;
  } else {
    await compare(config, network);
  }
} finally {
  globalThis.fetch = realFetch;
  try { db.close(); } catch { /* already closed */ }
  fs.rmSync(tempDir, { recursive: true, force: true });
}

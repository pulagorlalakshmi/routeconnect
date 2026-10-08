// Integration: GTFS zip -> transit database -> in-memory network -> planner / HTTP handler.
import { test, describe, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import path from 'path';
import { openTransitDb } from '../../transitDb.js';
import { readGtfsArchive } from '../../gtfs/reader.js';
import { importGtfs } from '../../importers/gtfsImporter.js';
import { baseFeedFiles, makeTempDir, writeZip, TEST_SOURCE } from '../../__tests__/fixtures.js';
import { loadNetworkFromDb, getTransitNetwork, reloadTransitNetwork, clearTransitNetworkCache } from '../dataLoader.js';
import { handlePlanRequest, planJourneys } from '../planner.js';
import { testConfig, NOW } from './helpers.js';

const tempDirs = [];
const tempDir = () => { const dir = makeTempDir('rc-routing-test-'); tempDirs.push(dir); return dir; };
after(() => { clearTransitNetworkCache(); for (const dir of tempDirs) fs.rmSync(dir, { recursive: true, force: true }); });

// Fixture feed (see transit/__tests__/fixtures.js): S1 (16.50,80.60) -> S2 (16.60,80.70) -> S3 (16.70,80.80)
//   T1 08:00-09:00 timepoints, T2 23:30 -> 26:00 overnight (approximate), T3 10:00-11:00 with an interpolated middle stop.
//   Service WK: Mon-Fri, 2026-01-01 .. 2026-12-31.
function importedDb(mutateFiles) {
  const files = baseFeedFiles();
  if (mutateFiles) mutateFiles(files);
  const db = openTransitDb(':memory:');
  importGtfs({ db, archive: readGtfsArchive(writeZip(tempDir(), files)), source: TEST_SOURCE, retrievedAt: '2026-06-01T00:00:00.000Z', asOf: '2026-06-15' });
  return db;
}

const config = testConfig();
const S1 = { fromLat: '16.50', fromLng: '80.60' };
const S3 = { toLat: '16.70', toLng: '80.80' };
const get = (query, getNetwork) => handlePlanRequest({ ...S1, ...S3, ...query }, { config, now: NOW, getNetwork });

describe('network loader (reads the database once, no SQL while routing)', () => {
  test('loads patterns, stops and calendars from the transit database', () => {
    const network = loadNetworkFromDb(importedDb(), config);
    assert.equal(network.stats.stops, 3);
    assert.equal(network.stats.tripsIncluded, 3);
    assert.equal(network.stats.stopTimes, 9);
    assert.equal(network.dataset.confidence_default, 'published');
    assert.equal(network.dataset.valid_to, '2026-12-31');
    assert.equal(network.maxTripTimeSeconds, 26 * 3600);
    assert.ok(network.stats.loadTimeMs >= 0);
  });

  test('returns null when nothing has been imported', () => {
    assert.equal(loadNetworkFromDb(openTransitDb(':memory:'), config), null);
  });

  test('time quality survives the round trip: exact, approximate and interpolated stop times', () => {
    const db = importedDb();
    const network = loadNetworkFromDb(db, config);
    const base = { fromLat: 16.5, fromLng: 80.6, toLat: 16.7, toLng: 80.8, maxTransfers: 1, windowMinutes: 60, date: '2026-10-05' };
    const at = time => planJourneys(network, { ...base, time, timeSeconds: Number(time.slice(0, 2)) * 3600 + Number(time.slice(3)) * 60 }, { config, now: NOW });

    const exact = at('07:30').journeys[0].legs[0];
    assert.equal(exact.tripId, 'T1');
    assert.equal(exact.timeQuality, 'exact');
    assert.equal(exact.dataConfidence, 'published');

    const interpolated = at('09:30').journeys[0].legs[0];
    assert.equal(interpolated.tripId, 'T3');
    assert.equal(interpolated.timeQuality, 'interpolated');
    assert.equal(interpolated.dataConfidence, 'inferred', 'interpolated times cap a published schedule at inferred');

    const overnight = at('22:45').journeys[0].legs[0];
    assert.equal(overnight.tripId, 'T2');
    assert.equal(overnight.timeQuality, 'approximate');
    assert.equal(overnight.gtfsArrivalTime, '26:00:00');
    assert.equal(overnight.arrivalTime, '2026-10-06T02:00:00+05:30');
  });
});

describe('GET /api/v2/plan handler', () => {
  const network = loadNetworkFromDb(importedDb(), config);
  const getNetwork = () => network;

  test('200: a validated query returns the documented response shape', () => {
    const { status, body } = get({ date: '2026-10-05', time: '07:30', windowMinutes: '60' }, getNetwork);
    assert.equal(status, 200);
    assert.deepEqual(Object.keys(body).sort(), ['access', 'dataset', 'datasetWarning', 'diagnostics', 'journeys', 'message', 'performance', 'query', 'resolved', 'search', 'warnings', 'winners']);
    assert.equal(body.message, null, 'no "no route" message when journeys exist');
    assert.equal(body.resolved, null, 'coordinates were supplied, so nothing was resolved by name');
    assert.equal(body.query.date, '2026-10-05');
    assert.equal(body.query.timezone, 'Asia/Kolkata');
    assert.equal(body.journeys[0].legs[0].tripId, 'T1');
    assert.equal(body.journeys[0].fare, null);
    assert.equal(body.dataset.verified, false);
    assert.equal(body.dataset.effectiveConfidence, 'published');
    for (const key of ['queryTimeMs', 'rangeSearches', 'roundsExecuted', 'patternsScanned', 'journeysGenerated', 'journeysReturned', 'networkLoadTimeMs']) {
      assert.ok(key in body.performance, key);
    }
  });

  test('the response never leaks file system paths', () => {
    const text = JSON.stringify(get({ date: '2026-10-05', time: '07:30' }, getNetwork).body);
    assert.ok(!/[A-Za-z]:\\|\.db\b|\/tmp\/|node_modules/.test(text));
  });

  test('400: invalid input is rejected with details', () => {
    const { status, body } = handlePlanRequest({ fromLat: 'x' }, { config, now: NOW, getNetwork });
    assert.equal(status, 400);
    assert.ok(body.details.length >= 4);
    assert.equal(get({ time: '99:99' }, getNetwork).status, 400);
    assert.equal(get({ maxTransfers: '99' }, getNetwork).status, 400);
  });

  test('503: no transit data imported', () => {
    const { status, body } = get({}, () => null);
    assert.equal(status, 503);
    assert.match(body.error, /transit:import/);
  });

  test('500 without leaking internals when the network cannot be loaded', () => {
    const { status, body } = get({}, () => { throw new Error('secret path C:\\x\\y.db'); });
    assert.equal(status, 500);
    assert.ok(!JSON.stringify(body).includes('secret'));
  });
});

describe('network cache', () => {
  test('is reused until the database file changes, and can be reloaded explicitly', () => {
    const dir = tempDir();
    const dbPath = path.join(dir, 'transit.db');
    const first = openTransitDb(dbPath);
    importGtfs({ db: first, archive: readGtfsArchive(writeZip(dir, baseFeedFiles())), source: TEST_SOURCE, asOf: '2026-06-15' });
    first.close();

    clearTransitNetworkCache();
    const a = getTransitNetwork({ dbPath, config });
    const b = getTransitNetwork({ dbPath, config });
    assert.equal(a, b, 'cached object reused');
    assert.notEqual(reloadTransitNetwork({ dbPath, config }), a, 'explicit reload builds a new network');

    const files = baseFeedFiles();
    files['stops.txt'] += 'S4,Delta,16.8,80.9\n';
    const second = openTransitDb(dbPath);
    importGtfs({ db: second, archive: readGtfsArchive(writeZip(dir, files, 'v2.zip')), source: TEST_SOURCE, asOf: '2026-06-15' });
    second.close();
    const c = getTransitNetwork({ dbPath, config });
    assert.equal(c.stats.stops, 4, 'a changed database file is picked up automatically');
  });

  test('a missing database yields null instead of throwing', () => {
    clearTransitNetworkCache();
    assert.equal(getTransitNetwork({ dbPath: path.join(tempDir(), 'nope.db'), config }), null);
  });
});

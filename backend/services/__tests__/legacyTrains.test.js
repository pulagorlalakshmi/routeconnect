// Regression: no production endpoint may return a fabricated train journey. The legacy planner's train data
// (STATIC_TRAIN_SERVICES, seeded segments / routes, placeholder stations) is not a verified timetable, and the v2
// planner only searches trains when a licensed timetable file is configured. Network is disabled; throw-away database.
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rc-legacy-trains-'));
process.env.ROUTECONNECT_DATABASE_PATH = path.join(tempDir, 'test.db');
const realFetch = globalThis.fetch;
globalThis.fetch = async () => { throw new Error('network disabled in tests'); };

const { db, initializeDatabase, getStoredMultiModalRoutes } = await import('../../db/database.js');
const { findMultiModalRoutes } = await import('../routingEngine.js');
const { findDirectTrains, findConnectingTrains } = await import('../railwayService.js');
const { stripTrainRoutes, isTrainSegment, requestsTrainOnly, LEGACY_TRAIN_DATA_ENABLED, TRAIN_DATA_UNAVAILABLE } = await import('../trainDataPolicy.js');
const { defaultSources } = await import('../../transit/multimodal/planMultimodal.js');

const serverSource = fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'server.js'), 'utf8');
const hasTrainLeg = route => route.segments.some(s => s.mode === 'train' || s.trainNumber);
const PLACEHOLDER = /Town [A-Z]\b|Railway Station [A-Z]\b|City [A-Z] Railway|Village [A-Z] /;

before(() => initializeDatabase());
after(() => {
  globalThis.fetch = realFetch;
  try { db.close(); } catch { /* already closed */ }
  fs.rmSync(tempDir, { recursive: true, force: true });
});

describe('train data policy', () => {
  test('legacy train data is disabled', () => {
    assert.equal(LEGACY_TRAIN_DATA_ENABLED, false);
    assert.equal(TRAIN_DATA_UNAVAILABLE.code, 'TRAIN_DATA_UNAVAILABLE');
  });

  test('a route is removed only when it has a train leg', () => {
    const bus = { segments: [{ mode: 'walking' }, { mode: 'bus' }] };
    const train = { segments: [{ mode: 'bus' }, { mode: 'train' }] };
    const numbered = { segments: [{ mode: 'express', trainNumber: '12727' }] };
    assert.deepEqual(stripTrainRoutes([bus, train, numbered]), [bus]);
    assert.deepEqual(stripTrainRoutes(null), []);
    assert.equal(isTrainSegment({ mode: 'Rail' }), true);
    assert.equal(isTrainSegment({ mode: 'bus' }), false);
  });

  test('train-only requests are recognised; mixed or absent mode is not', () => {
    assert.equal(requestsTrainOnly({ mode: 'train' }), true);
    assert.equal(requestsTrainOnly({ modes: 'rail' }), true);
    assert.equal(requestsTrainOnly({ modes: 'train,bus' }), false);
    assert.equal(requestsTrainOnly({ mode: 'bus' }), false);
    assert.equal(requestsTrainOnly({}), false);
  });
});

describe('legacy train lookups return nothing', () => {
  for (const [from, to] of [
    ['Vijayawada', 'Guntur'], ['Vijayawada', 'Hyderabad'], ['Guntur', 'Tenali'], ['Vijayawada', 'Visakhapatnam'],
    ['Guntur', 'Tirupati'], ['Bhimavaram Railway Station', 'Vijayawada Railway Station'], ['Town X Railway Station', 'Ongole Railway Station']
  ]) {
    test(`${from} -> ${to}`, () => {
      assert.deepEqual(findDirectTrains(from, to), []);
      assert.deepEqual(findConnectingTrains(from, to, 1, '2026-10-20'), []);
    });
  }
});

describe('/api/planner engine never returns a train leg', () => {
  for (const [from, to, origin] of [
    ['Vijayawada', 'Guntur'], ['Vijayawada', 'Hyderabad'], ['Guntur', 'Tenali'], ['Vijayawada', 'Visakhapatnam'], ['Guntur', 'Tirupati'],
    ['Bhimavaram', 'Vijayawada'], ['Narasaraopet', 'Ongole'], ['Village A', 'Ongole'], ['Village A', 'City B'],
    ['📍 Current Location', 'Vijayawada', { latitude: 16.5449, longitude: 81.5212 }]
  ]) {
    test(`${from} -> ${to}`, async () => {
      const routes = await findMultiModalRoutes(from, to, '2026-10-20', null, 1, origin ?? null);
      for (const route of routes) {
        assert.equal(hasTrainLeg(route), false, `train leg in ${route.routeName}`);
        assert.ok(!/train #|godavari|express train/i.test(JSON.stringify(route.segments)), `train text in ${route.routeName}`);
      }
    });
  }
});

describe('/api/routes/stored', () => {
  test('the seeded sample routes contain trains (precondition) and the endpoint filter removes every one', () => {
    const pairs = [['Village A', 'Ongole'], ['Village A', 'Ongole Railway Station'], ['Village A', 'City B'], ['Village A', 'City D'], ['Narasaraopet', 'Ongole']];
    const raw = pairs.flatMap(([from, to]) => getStoredMultiModalRoutes(from, to, 1));
    assert.ok(raw.some(hasTrainLeg), 'precondition: the seed data still holds sample train routes');
    for (const route of stripTrainRoutes(raw)) {
      assert.equal(hasTrainLeg(route), false);
      assert.ok(!PLACEHOLDER.test(JSON.stringify(route.segments.filter(s => s.mode === 'train'))));
    }
  });

  test('server.js filters the endpoint and the planner', () => {
    assert.match(serverSource, /stripTrainRoutes\(getStoredMultiModalRoutes\(/);
    assert.match(serverSource, /requestsTrainOnly\(req\.query\)[\s\S]{0,80}status\(501\)/);
    assert.match(serverSource, /trainSearch: \{ available: false/);
    assert.doesNotMatch(serverSource, /'train_network'/);
  });
});

describe('/api/v2/plan rail source', () => {
  test('without a configured timetable file the rail source is not configured and never searched', () => {
    const rail = defaultSources({}).find(source => source.id === 'rail');
    const status = rail.status({ crowFliesMeters: 100000 });
    assert.equal(status.configured, false);
  });
});

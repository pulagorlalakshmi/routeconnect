import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import path from 'path';
import fs from 'fs';
import { getTransitConfig } from '../config.js';
import { isTransitDbReady, ensureTransitData } from '../ensureData.js';
import { openTransitDb } from '../transitDb.js';
import { importGtfs } from '../importers/gtfsImporter.js';
import { readGtfsArchive } from '../gtfs/reader.js';
import { makeTempDir, baseFeedFiles, writeZip, TEST_SOURCE } from './fixtures.js';

describe('transit config path resolution', () => {
  test('returns standard dbPath and honors ROUTECONNECT_TRANSIT_DATABASE_PATH override', () => {
    const configDefault = getTransitConfig({});
    assert.ok(configDefault.dbPath.endsWith('transit.db'), 'default ends with transit.db');

    const customEnv = { ROUTECONNECT_TRANSIT_DATABASE_PATH: 'custom/dir/test-transit.db' };
    const configCustom = getTransitConfig(customEnv);
    assert.ok(configCustom.dbPath.includes('test-transit.db'), 'custom path reflected in dbPath');
  });

  test('resolves relative custom paths to absolute paths', () => {
    const customEnv = { ROUTECONNECT_TRANSIT_DATABASE_PATH: './relative/data/transit.db' };
    const config = getTransitConfig(customEnv);
    assert.ok(path.isAbsolute(config.dbPath), 'dbPath is absolute');
  });
});

describe('transit db readiness check', () => {
  test('returns false for non-existent or empty files', () => {
    assert.equal(isTransitDbReady('/non/existent/transit.db'), false);
    assert.equal(isTransitDbReady(''), false);
    assert.equal(isTransitDbReady(':memory:'), false);

    const dir = makeTempDir();
    const emptyFile = path.join(dir, 'empty.db');
    fs.writeFileSync(emptyFile, '');
    assert.equal(isTransitDbReady(emptyFile), false);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  test('returns true for an initialized transit database with dataset records', () => {
    const dir = makeTempDir();
    const dbPath = path.join(dir, 'transit.db');
    const db = openTransitDb(dbPath);
    importGtfs({
      db,
      archive: readGtfsArchive(writeZip(dir, baseFeedFiles())),
      source: TEST_SOURCE,
      asOf: '2026-06-15'
    });
    db.close();

    assert.equal(isTransitDbReady(dbPath), true);
    fs.rmSync(dir, { recursive: true, force: true });
  });
});

describe('ensureTransitData', () => {
  test('returns ready: true without re-importing when database already exists', async () => {
    const dir = makeTempDir();
    const dbPath = path.join(dir, 'transit.db');
    const db = openTransitDb(dbPath);
    importGtfs({
      db,
      archive: readGtfsArchive(writeZip(dir, baseFeedFiles())),
      source: TEST_SOURCE,
      asOf: '2026-06-15'
    });
    db.close();

    const env = { ROUTECONNECT_TRANSIT_DATABASE_PATH: dbPath };
    const result = await ensureTransitData({ env });
    assert.equal(result.ready, true);
    assert.equal(result.imported, false);
    assert.equal(result.dbPath, dbPath);

    fs.rmSync(dir, { recursive: true, force: true });
  });

  test('aligns feedZipPath under external mount path when ROUTECONNECT_TRANSIT_DATABASE_PATH is external', () => {
    const config = getTransitConfig({ ROUTECONNECT_TRANSIT_DATABASE_PATH: '/var/data/transit.db' });
    assert.equal(config.dbPath, '/var/data/transit.db');
    assert.equal(config.feedZipPath, path.normalize('/var/data/feeds/apsrtc-gtfs.zip'));
  });
});

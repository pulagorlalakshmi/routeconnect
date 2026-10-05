import { test, describe, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import path from 'path';
import {
  CONFIDENCE, CONFIDENCE_LEVELS, isConfidence, weakestConfidence, capConfidence
} from '../confidence.js';
import {
  normalizeSource, getValidity, effectiveConfidence, deriveValidity, gtfsDateToIso, todayInTimezone
} from '../datasetMetadata.js';
import { openTransitDb } from '../transitDb.js';
import { importGtfs } from '../importers/gtfsImporter.js';
import { readGtfsArchive } from '../gtfs/reader.js';
import { getTransitStatus } from '../status.js';
import { baseFeedFiles, makeTempDir, writeZip, TEST_SOURCE } from './fixtures.js';

const tempDirs = [];
const tempDir = () => { const dir = makeTempDir(); tempDirs.push(dir); return dir; };
after(() => { for (const dir of tempDirs) fs.rmSync(dir, { recursive: true, force: true }); });

describe('confidence vocabulary', () => {
  test('is exactly live/verified/published/inferred/estimated/unknown, weakest first', () => {
    assert.deepEqual([...CONFIDENCE_LEVELS], ['unknown', 'estimated', 'inferred', 'published', 'verified', 'live']);
    assert.ok(isConfidence('published'));
    assert.ok(!isConfidence('definitely-real'));
  });

  test('weakest-link and capping', () => {
    assert.equal(weakestConfidence('published', 'estimated', 'live'), CONFIDENCE.ESTIMATED);
    assert.equal(weakestConfidence(), CONFIDENCE.UNKNOWN);
    assert.equal(capConfidence('published', 'inferred'), CONFIDENCE.INFERRED);
    assert.equal(capConfidence('estimated', 'inferred'), CONFIDENCE.ESTIMATED);
  });
});

describe('source provenance', () => {
  test('community feed defaults: published, unverified, licence unknown', () => {
    const source = normalizeSource({ name: 'Community APSRTC GTFS', type: 'community_gtfs' });
    assert.equal(source.confidence, 'published');
    assert.equal(source.verified, false);
    assert.equal(source.license, 'unknown');
  });

  test('refuses to label unverified data as verified or live', () => {
    assert.throws(() => normalizeSource({ name: 'x', type: 'community_gtfs', confidence: 'verified' }), /verified/);
    assert.throws(() => normalizeSource({ name: 'x', type: 'community_gtfs', confidence: 'live' }), /verified/);
    assert.throws(() => normalizeSource({ name: 'x', type: 'community_gtfs', verified: true }), /verified=true/);
    assert.throws(() => normalizeSource({ name: 'x', type: 'community_gtfs', confidence: 'bogus' }), /Unknown confidence/);
  });

  test('the database itself rejects "verified" for unverified datasets', () => {
    const db = openTransitDb(':memory:');
    assert.throws(() => db.prepare(`
      INSERT INTO datasets (source_key, name, source_type, license, confidence_default, verified, retrieved_at, imported_at, checksum_sha256)
      VALUES ('k', 'n', 't', 'unknown', 'verified', 0, 'now', 'now', 'x')`).run());
  });
});

describe('validity and downgrade', () => {
  test('GTFS dates and timezone-aware "today"', () => {
    assert.equal(gtfsDateToIso('20260930'), '2026-09-30');
    assert.equal(gtfsDateToIso('20260231'), null);
    assert.equal(todayInTimezone('Asia/Kolkata', new Date('2026-10-03T22:08:00Z')), '2026-10-04');
  });

  test('derives the window from calendar and calendar_dates additions only', () => {
    const v = deriveValidity({
      calendarRows: [{ start_date: '20260830', end_date: '20260930' }],
      calendarDateRows: [{ date: '20261015', exception_type: '1' }, { date: '20261101', exception_type: '2' }]
    });
    assert.equal(v.validFrom, '2026-08-30');
    assert.equal(v.validTo, '2026-10-15');
  });

  test('an expired feed is downgraded from "published" to "inferred"; a valid one is not', () => {
    const dataset = { confidence_default: 'published', valid_from: '2026-08-30', valid_to: '2026-09-30' };
    assert.equal(getValidity({ validFrom: '2026-08-30', validTo: '2026-09-30' }, '2026-10-04').status, 'expired');
    assert.equal(effectiveConfidence(dataset, '2026-10-04'), 'inferred');
    assert.equal(effectiveConfidence(dataset, '2026-09-15'), 'published');
  });

  test('an undated feed is never trusted as "published"', () => {
    assert.equal(effectiveConfidence({ confidence_default: 'published' }, '2026-10-04'), 'inferred');
  });

  test('downgrading never raises a weaker level', () => {
    assert.equal(effectiveConfidence({ confidence_default: 'estimated', valid_from: '2026-01-01', valid_to: '2026-02-01' }, '2026-10-04'), 'estimated');
  });
});

describe('transit status service', () => {
  test('reports "not loaded" when there is no database', () => {
    const status = getTransitStatus({ dbPath: path.join(tempDir(), 'missing.db') });
    assert.equal(status.datasetLoaded, false);
  });

  test('exposes provenance and honest validity, with no paths or SQL', () => {
    const dir = tempDir();
    const dbPath = path.join(dir, 'transit.db');
    const db = openTransitDb(dbPath);
    importGtfs({ db, archive: readGtfsArchive(writeZip(dir, baseFeedFiles())), source: TEST_SOURCE, retrievedAt: '2026-06-01T00:00:00.000Z', asOf: '2026-06-15' });
    db.close();

    const status = getTransitStatus({ dbPath, now: new Date('2027-03-01T00:00:00Z') }); // after the 2026 window
    assert.equal(status.datasetLoaded, true);
    assert.equal(status.confidence, 'published');
    assert.equal(status.effectiveConfidence, 'inferred');
    assert.equal(status.verified, false);
    assert.equal(status.currentlyValid, false);
    assert.equal(status.validityStatus, 'expired');
    assert.equal(status.counts.stops, 3);
    assert.equal(status.counts.stopTimes, 9);
    const serialised = JSON.stringify(status);
    assert.ok(!serialised.includes(dir), 'must not leak file system paths');
    assert.ok(!/select |insert /i.test(serialised));
  });
});

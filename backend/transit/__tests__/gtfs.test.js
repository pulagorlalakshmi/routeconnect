import { test, describe, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import path from 'path';
import { parseCsv } from '../gtfs/csv.js';
import { parseGtfsTime, isInvalidGtfsTime, formatGtfsTime } from '../gtfs/time.js';
import { readGtfsArchive } from '../gtfs/reader.js';
import { validateGtfs } from '../validators/gtfsValidator.js';
import { importGtfs, ImportBlockedError, resolveTripTimes } from '../importers/gtfsImporter.js';
import { openTransitDb } from '../transitDb.js';
import { baseFeedFiles, makeTempDir, writeZip, TEST_SOURCE } from './fixtures.js';

const tempDirs = [];
const tempDir = () => { const dir = makeTempDir(); tempDirs.push(dir); return dir; };
after(() => { for (const dir of tempDirs) fs.rmSync(dir, { recursive: true, force: true }); });

const readFixture = (mutate) => {
  const files = baseFeedFiles();
  if (mutate) mutate(files);
  return readGtfsArchive(writeZip(tempDir(), files));
};

describe('CSV parsing', () => {
  test('handles BOM, CRLF, quotes, escaped quotes and embedded newlines', () => {
    const csv = '﻿id,name,note\r\n1,"Smith, John","He said ""hi"""\r\n2,"Line1\nLine2",x\r\n\r\n';
    const { header, rows } = parseCsv(csv);
    assert.deepEqual(header, ['id', 'name', 'note']);
    assert.equal(rows.length, 2);
    assert.equal(rows[0].name, 'Smith, John');
    assert.equal(rows[0].note, 'He said "hi"');
    assert.equal(rows[1].name, 'Line1\nLine2');
  });

  test('pads short rows and reports malformed rows', () => {
    const { rows, malformedRows } = parseCsv('a,b,c\n1,2\n');
    assert.equal(rows[0].c, '');
    assert.equal(malformedRows, 1);
  });
});

describe('GTFS time parsing', () => {
  test('parses ordinary and past-midnight times', () => {
    assert.equal(parseGtfsTime('08:00:00'), 28800);
    assert.equal(parseGtfsTime('8:05:09'), 8 * 3600 + 5 * 60 + 9);
    assert.equal(parseGtfsTime('24:00:00'), 86400);
    assert.equal(parseGtfsTime('25:30:00'), 91800);
  });

  test('empty means "no time"; garbage is invalid', () => {
    assert.equal(parseGtfsTime(''), null);
    assert.equal(isInvalidGtfsTime(''), false);
    assert.equal(parseGtfsTime('25:61:00'), null);
    assert.equal(isInvalidGtfsTime('25:61:00'), true);
    assert.equal(isInvalidGtfsTime('noon'), true);
  });

  test('formats seconds >= 24h without wrapping', () => {
    assert.equal(formatGtfsTime(91800), '25:30:00');
    assert.equal(formatGtfsTime(parseGtfsTime('07:05:09')), '07:05:09');
  });
});

describe('required files and structure', () => {
  test('detects a missing required file and blocks', () => {
    const archive = readFixture(files => { delete files['stops.txt']; });
    const report = validateGtfs(archive, { asOf: '2026-06-01' });
    assert.equal(report.blocking, true);
    assert.ok(report.missingRequiredFiles.includes('stops.txt'));
    assert.ok(report.checks.missing_required_file);
  });

  test('detects a missing required column', () => {
    const archive = readFixture(files => { files['stops.txt'] = 'stop_id,stop_name\nS1,Alpha\n'; });
    const report = validateGtfs(archive, { asOf: '2026-06-01' });
    assert.equal(report.blocking, true);
    assert.ok(report.checks.missing_required_column.samples.some(s => s.includes('stop_lat')));
  });

  test('accepts files nested in a folder inside the ZIP', () => {
    const files = baseFeedFiles();
    const nested = Object.fromEntries(Object.entries(files).map(([name, content]) => [`feed/${name}`, content]));
    const archive = readGtfsArchive(writeZip(tempDir(), nested));
    assert.ok(archive.fileNames.includes('stops.txt'));
    assert.equal(validateGtfs(archive, { asOf: '2026-06-01' }).blocking, false);
  });

  test('rejects a non-ZIP file', () => {
    const dir = tempDir();
    const bogus = path.join(dir, 'not.zip');
    fs.writeFileSync(bogus, 'this is not a zip');
    assert.throws(() => readGtfsArchive(bogus), /ZIP/);
  });

  test('a clean feed validates without errors and counts rows', () => {
    const report = validateGtfs(readFixture(), { asOf: '2026-06-01' });
    assert.equal(report.blocking, false);
    assert.equal(report.errorCount, 0);
    assert.equal(report.counts.stops, 3);
    assert.equal(report.counts.stopTimes, 9);
    assert.ok(report.checks.missing_fares, 'missing fares must be reported, never invented');
    assert.equal(report.checks.times_at_or_after_24h.count, 4); // T2: arrival+departure at 25:30 and 26:00
  });
});

describe('reference and ordering checks', () => {
  test('reports dangling references as blocking errors', () => {
    const archive = readFixture(files => {
      files['trips.txt'] += 'RX,WK,T9,Nowhere\n';           // unknown route
      files['stop_times.txt'] += 'T1,12:00:00,12:00:00,SX,4,1\n'; // unknown stop
    });
    const report = validateGtfs(archive, { asOf: '2026-06-01' });
    assert.equal(report.blocking, true);
    assert.ok(report.checks.dangling_trip_route);
    assert.ok(report.checks.dangling_stop_time_stop);
  });

  test('detects duplicate IDs and invalid coordinates on served stops', () => {
    const archive = readFixture(files => {
      files['stops.txt'] += 'S1,Alpha again,16.5,80.6\nS4,Bad,95.0,200.0\n';
      files['stop_times.txt'] += 'T1,12:00:00,12:00:00,S4,4,1\n';
    });
    const report = validateGtfs(archive, { asOf: '2026-06-01' });
    assert.ok(report.checks.duplicate_stop_id);
    assert.ok(report.checks.invalid_stop_coordinates_used);
    assert.equal(report.blocking, true);
  });

  test('detects non-monotonic times and duplicate stop sequences', () => {
    const archive = readFixture(files => {
      files['stop_times.txt'] += 'T1,07:00:00,07:00:00,S1,3,1\n'; // duplicate sequence 3, earlier time
    });
    const report = validateGtfs(archive, { asOf: '2026-06-01' });
    assert.ok(report.checks.duplicate_stop_time_sequence);
  });

  test('flags invalid time text', () => {
    const archive = readFixture(files => { files['stop_times.txt'] += 'T1,99:99:99,99:99:99,S1,9,1\n'; });
    assert.ok(validateGtfs(archive, { asOf: '2026-06-01' }).checks.invalid_time_format);
  });
});

describe('feed validity (expired detection)', () => {
  test('inside the window -> valid', () => {
    const report = validateGtfs(readFixture(), { asOf: '2026-06-15' });
    assert.equal(report.validity.status, 'valid');
    assert.equal(report.validity.currentlyValid, true);
    assert.equal(report.checks.feed_expired, undefined);
  });

  test('after the window -> expired, with a warning', () => {
    const report = validateGtfs(readFixture(), { asOf: '2027-02-01' });
    assert.equal(report.validity.status, 'expired');
    assert.equal(report.validity.currentlyValid, false);
    assert.equal(report.checks.feed_expired.severity, 'warning');
    assert.equal(report.blocking, false, 'an expired feed is still importable; it is downgraded, not rejected');
  });

  test('before the window -> not yet valid', () => {
    const report = validateGtfs(readFixture(), { asOf: '2025-12-01' });
    assert.equal(report.validity.status, 'not_yet_valid');
  });
});

describe('trip time resolution', () => {
  test('interpolates a missing middle time and flags it', () => {
    const rows = [
      { arrival_time: '10:00:00', departure_time: '10:00:00', timepoint: '1' },
      { arrival_time: '', departure_time: '', timepoint: '1' },
      { arrival_time: '11:00:00', departure_time: '11:00:00', timepoint: '1' }
    ];
    const times = resolveTripTimes(rows, true);
    assert.equal(times[1].arrival, 10 * 3600 + 1800);
    assert.equal(times[1].quality, 'interpolated');
    assert.equal(times[0].quality, 'exact');
  });

  test('timepoint=0 is "approximate", never "exact"', () => {
    const times = resolveTripTimes([{ arrival_time: '08:00:00', departure_time: '08:00:00', timepoint: '0' }], true);
    assert.equal(times[0].quality, 'approximate');
  });

  test('unresolvable missing endpoint time stays "unknown"', () => {
    const times = resolveTripTimes([
      { arrival_time: '', departure_time: '', timepoint: '1' },
      { arrival_time: '08:00:00', departure_time: '08:00:00', timepoint: '1' }
    ], true);
    assert.equal(times[0].quality, 'unknown');
    assert.equal(times[0].arrival, null);
  });
});

describe('import', () => {
  const importFixture = (db, mutate, options = {}) => {
    const archive = readFixture(mutate);
    return importGtfs({ db, archive, source: TEST_SOURCE, retrievedAt: '2026-06-01T00:00:00.000Z', asOf: '2026-06-15', ...options });
  };

  test('imports the expected counts and stores >24:00 times as raw seconds', () => {
    const db = openTransitDb(':memory:');
    const result = importFixture(db);
    assert.equal(result.skipped, false);
    assert.deepEqual(
      { stops: result.counts.stops, routes: result.counts.routes, trips: result.counts.trips, stopTimes: result.counts.stopTimes },
      { stops: 3, routes: 1, trips: 3, stopTimes: 9 }
    );
    const overnight = db.prepare(`
      SELECT st.arrival_seconds a, st.time_quality q FROM stop_times st JOIN trips t ON t.id = st.trip_id
      WHERE t.source_trip_id = 'T2' AND st.stop_sequence = 2`).get();
    assert.equal(overnight.a, 91800);           // 25:30:00, not wrapped to 01:30
    assert.equal(overnight.q, 'approximate');
    const interpolated = db.prepare(`
      SELECT st.arrival_seconds a, st.time_quality q FROM stop_times st JOIN trips t ON t.id = st.trip_id
      WHERE t.source_trip_id = 'T3' AND st.stop_sequence = 2`).get();
    assert.equal(interpolated.a, 37800);
    assert.equal(interpolated.q, 'interpolated');
    assert.equal(db.prepare('PRAGMA foreign_key_check').all().length, 0);
  });

  test('records provenance and never claims verification', () => {
    const db = openTransitDb(':memory:');
    importFixture(db);
    const dataset = db.prepare('SELECT * FROM datasets').get();
    assert.equal(dataset.confidence_default, 'published');
    assert.equal(dataset.verified, 0);
    assert.equal(dataset.license, 'unknown');
    assert.equal(dataset.valid_from, '2026-01-01');
    assert.equal(dataset.valid_to, '2026-12-31');
    assert.equal(dataset.retrieved_at, '2026-06-01T00:00:00.000Z');
    assert.equal(dataset.source_url, TEST_SOURCE.url);
  });

  test('re-importing the same archive is skipped; a changed archive replaces the old data', () => {
    const db = openTransitDb(':memory:');
    const dir = tempDir();
    const zip = writeZip(dir, baseFeedFiles());
    const archive = readGtfsArchive(zip);
    const first = importGtfs({ db, archive, source: TEST_SOURCE, asOf: '2026-06-15' });
    const second = importGtfs({ db, archive, source: TEST_SOURCE, asOf: '2026-06-15' });
    assert.equal(first.skipped, false);
    assert.equal(second.skipped, true);

    const changed = baseFeedFiles();
    changed['stops.txt'] += 'S4,Delta,16.8,80.9\n';
    const third = importGtfs({ db, archive: readGtfsArchive(writeZip(dir, changed, 'v2.zip')), source: TEST_SOURCE, asOf: '2026-06-15' });
    assert.equal(third.skipped, false);
    assert.equal(db.prepare('SELECT COUNT(*) c FROM datasets').get().c, 1);
    assert.equal(db.prepare('SELECT COUNT(*) c FROM stops').get().c, 4);
  });

  test('a blocked import throws and leaves existing data untouched', () => {
    const db = openTransitDb(':memory:');
    importFixture(db);
    const bad = baseFeedFiles();
    bad['trips.txt'] += 'RX,WK,T9,Nowhere\n';
    bad['stops.txt'] += 'S9,Extra,16.9,81.0\n'; // different checksum so it is not "unchanged"
    assert.throws(
      () => importGtfs({ db, archive: readGtfsArchive(writeZip(tempDir(), bad)), source: TEST_SOURCE, asOf: '2026-06-15' }),
      ImportBlockedError
    );
    assert.equal(db.prepare('SELECT COUNT(*) c FROM stops').get().c, 3);
    assert.equal(db.prepare('SELECT COUNT(*) c FROM datasets').get().c, 1);
  });

  test('derives stop kind from serving routes', () => {
    const db = openTransitDb(':memory:');
    importFixture(db, files => { files['stops.txt'] += 'S9,Unused,16.9,81.0\n'; });
    assert.equal(db.prepare("SELECT kind FROM stops WHERE source_stop_id = 'S1'").get().kind, 'bus');
    assert.equal(db.prepare("SELECT kind FROM stops WHERE source_stop_id = 'S9'").get().kind, 'unserved');
  });
});

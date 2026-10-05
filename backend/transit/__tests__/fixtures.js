// Tiny synthetic GTFS feeds for tests (never real operator data).
import fs from 'fs';
import os from 'os';
import path from 'path';
import { zipSync, strToU8 } from 'fflate';

export function baseFeedFiles() {
  return {
    'agency.txt': 'agency_id,agency_name,agency_url,agency_timezone\nA1,Test Agency,https://example.test,Asia/Kolkata\n',
    'stops.txt': [
      'stop_id,stop_name,stop_lat,stop_lon',
      'S1,Alpha,16.50,80.60',
      'S2,Bravo,16.60,80.70',
      'S3,Charlie,16.70,80.80',
      ''
    ].join('\n'),
    'routes.txt': 'route_id,route_short_name,route_long_name,route_type\nR1,1,Alpha - Charlie,3\n',
    'trips.txt': [
      'route_id,service_id,trip_id,trip_headsign',
      'R1,WK,T1,Charlie',
      'R1,WK,T2,Charlie',
      'R1,WK,T3,Charlie',
      ''
    ].join('\n'),
    'stop_times.txt': [
      'trip_id,arrival_time,departure_time,stop_id,stop_sequence,timepoint',
      // T1: ordinary daytime trip, exact timepoints
      'T1,08:00:00,08:00:00,S1,1,1',
      'T1,08:30:00,08:35:00,S2,2,1',
      'T1,09:00:00,09:00:00,S3,3,1',
      // T2: overnight trip, crosses midnight (25:30:00 = 01:30 next calendar day), approximate times
      'T2,23:30:00,23:30:00,S1,1,0',
      'T2,25:30:00,25:30:00,S2,2,0',
      'T2,26:00:00,26:00:00,S3,3,0',
      // T3: middle stop has no time -> importer must interpolate and flag it
      'T3,10:00:00,10:00:00,S1,1,1',
      'T3,,,S2,2,1',
      'T3,11:00:00,11:00:00,S3,3,1',
      ''
    ].join('\n'),
    'calendar.txt': [
      'service_id,monday,tuesday,wednesday,thursday,friday,saturday,sunday,start_date,end_date',
      'WK,1,1,1,1,1,0,0,20260101,20261231',
      ''
    ].join('\n')
  };
}

export function makeZip(files) {
  const entries = {};
  for (const [name, content] of Object.entries(files)) entries[name] = strToU8(content);
  return zipSync(entries);
}

export function makeTempDir(prefix = 'rc-transit-test-') {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

export function writeZip(dir, files, name = 'feed.zip') {
  const zipPath = path.join(dir, name);
  fs.writeFileSync(zipPath, makeZip(files));
  return zipPath;
}

export const TEST_SOURCE = Object.freeze({
  name: 'Test Community GTFS',
  type: 'community_gtfs',
  url: 'https://example.test/gtfs.zip',
  license: 'unknown',
  confidence: 'published',
  verified: false
});

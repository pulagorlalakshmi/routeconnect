// Download, import and "ensure" for the railway timetable. Used by the rail:* npm scripts and by server start-up.
// Nothing here runs unless rail is enabled (ROUTECONNECT_RAIL_ENABLED=true) or a CLI command is run explicitly.
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { getRailConfig, railDataPresent } from './railConfig.js';
import { openRailDb } from './railDb.js';
import { importRailRecords } from './railImporter.js';
import { gtfsRailProvider } from './providers/gtfsRailProvider.js';
import { readGtfsArchive } from '../gtfs/reader.js';
import { metaPathFor, readMeta, writeJson } from '../cli/common.js';
import { clearRailNetworkCache } from './railNetwork.js';

const TIMEOUT_MS = 120000;
const MAX_BYTES = 200 * 1024 * 1024;

export async function downloadRailFeed(config = getRailConfig(), { force = false, fetchImpl = fetch } = {}) {
  const zipPath = config.feedZipPath;
  if (!force && fs.existsSync(zipPath) && fs.statSync(zipPath).size > 1000) return { downloaded: false, path: zipPath, meta: readMeta(zipPath) };

  const response = await fetchImpl(config.source.url, { redirect: 'follow', signal: AbortSignal.timeout(TIMEOUT_MS) });
  if (!response.ok) throw new Error(`Rail feed download failed: HTTP ${response.status}`);
  const buffer = Buffer.from(await response.arrayBuffer());
  if (buffer.length > MAX_BYTES) throw new Error(`Rail feed is too large (${buffer.length} bytes).`);
  if (buffer.length < 4 || buffer[0] !== 0x50 || buffer[1] !== 0x4b) throw new Error('Downloaded rail feed is not a ZIP archive.');

  fs.mkdirSync(path.dirname(zipPath), { recursive: true });
  fs.writeFileSync(`${zipPath}.download`, buffer);
  fs.renameSync(`${zipPath}.download`, zipPath);
  const meta = {
    sourceUrl: config.source.url,
    resolvedUrl: response.url ?? null,
    retrievedAt: new Date().toISOString(),
    httpStatus: response.status,
    bytes: buffer.length,
    sha256: crypto.createHash('sha256').update(buffer).digest('hex')
  };
  writeJson(metaPathFor(zipPath), meta);
  return { downloaded: true, path: zipPath, meta };
}

export function importRailFeed(config = getRailConfig(), { now = new Date() } = {}) {
  if (!fs.existsSync(config.feedZipPath)) throw new Error(`Rail feed archive not found at ${config.feedZipPath}. Run "npm run rail:download" first.`);
  const archive = readGtfsArchive(config.feedZipPath);
  const meta = readMeta(config.feedZipPath);
  const records = gtfsRailProvider.normalise(archive);
  const db = openRailDb(config.dbPath);
  let result;
  try {
    result = importRailRecords({ db, records, source: config.source, checksum: archive.checksum, retrievedAt: meta?.retrievedAt ?? null, now });
  } finally {
    db.close();
  }
  writeJson(config.reportPath, {
    source: { ...config.source, retrievedAt: meta?.retrievedAt ?? null, sha256: archive.checksum },
    feed: records.meta,
    validFrom: result.validFrom,
    validTo: result.validTo,
    stats: result.stats,
    issueSamples: result.issues.slice(0, 100)
  });
  clearRailNetworkCache();
  return result;
}

// Server start-up: when rail is enabled and the database is missing, download + import once. Never throws.
export async function ensureRailData(config = getRailConfig()) {
  if (!config.enabled) return { ready: false, reason: 'disabled' };
  if (railDataPresent(config)) return { ready: true, imported: false };
  if (!config.autoImport) return { ready: false, reason: 'missing' };
  try {
    await downloadRailFeed(config);
    const result = importRailFeed(config);
    return { ready: true, imported: true, result };
  } catch (error) {
    return { ready: false, reason: 'error', error: error.message };
  }
}

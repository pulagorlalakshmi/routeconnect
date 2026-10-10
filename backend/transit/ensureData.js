// Automated bootstrap utility for the GTFS transit database.
// Ensures that the transit database is present and initialized before handling queries.
// Reusable across server startup, Render deploy hooks, and CLI commands.
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { getTransitConfig } from './config.js';
import { openTransitDb } from './transitDb.js';
import { readGtfsArchive } from './gtfs/reader.js';
import { validateGtfs } from './validators/gtfsValidator.js';
import { importGtfs } from './importers/gtfsImporter.js';
import { clearTransitNetworkCache } from './routing/dataLoader.js';
import { metaPathFor, writeJson, readMeta } from './cli/common.js';

const TIMEOUT_MS = 120000;
const MAX_BYTES = 200 * 1024 * 1024;

/**
 * Checks whether the transit database exists and contains an imported dataset.
 * Never creates files or executes write transactions.
 */
export function isTransitDbReady(dbPath = getTransitConfig().dbPath) {
  if (!dbPath || dbPath === ':memory:') return false;
  try {
    if (!fs.existsSync(dbPath)) return false;
    const stat = fs.statSync(dbPath);
    if (stat.size < 4096) return false;
    const db = openTransitDb(dbPath, { readOnly: true });
    try {
      const row = db.prepare('SELECT count(*) as count FROM datasets').get();
      return Boolean(row && Number(row.count) > 0);
    } finally {
      db.close();
    }
  } catch {
    return false;
  }
}

/**
 * Downloads the GTFS zip archive from the configured URL if not already present.
 */
export async function downloadFeedIfMissing(config = getTransitConfig()) {
  const zipPath = config.feedZipPath;
  if (fs.existsSync(zipPath) && fs.statSync(zipPath).size > 1000) {
    return { downloaded: false, path: zipPath, meta: readMeta(zipPath) };
  }

  const url = config.feed.url;
  console.log(`[Transit Bootstrap] Downloading GTFS archive from ${url}...`);
  const response = await fetch(url, { redirect: 'follow', signal: AbortSignal.timeout(TIMEOUT_MS) });
  if (!response.ok) {
    throw new Error(`Failed to download GTFS feed from ${url}: HTTP ${response.status} ${response.statusText}`);
  }

  const declared = Number(response.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > MAX_BYTES) {
    throw new Error(`GTFS feed is too large (${declared} bytes).`);
  }

  const buffer = Buffer.from(await response.arrayBuffer());
  if (buffer.length > MAX_BYTES) {
    throw new Error(`GTFS feed is too large (${buffer.length} bytes).`);
  }
  if (buffer.length < 4 || buffer[0] !== 0x50 || buffer[1] !== 0x4b) {
    throw new Error('Downloaded file is not a valid ZIP archive.');
  }

  fs.mkdirSync(path.dirname(zipPath), { recursive: true });
  const tempPath = `${zipPath}.download`;
  fs.writeFileSync(tempPath, buffer);
  fs.renameSync(tempPath, zipPath);

  const meta = {
    sourceUrl: url,
    resolvedUrl: response.url,
    retrievedAt: new Date().toISOString(),
    httpStatus: response.status,
    etag: response.headers.get('etag'),
    lastModified: response.headers.get('last-modified'),
    bytes: buffer.length,
    sha256: crypto.createHash('sha256').update(buffer).digest('hex')
  };
  writeJson(metaPathFor(zipPath), meta);

  console.log(`[Transit Bootstrap] Saved ${buffer.length} bytes to ${zipPath} (sha256: ${meta.sha256})`);
  return { downloaded: true, path: zipPath, meta };
}

/**
 * Ensures standard project candidate paths (backend/transit/data/transit.db and backend/data/transit.db)
 * remain in sync when either is updated.
 */
function syncAltDbIfApplicable(primaryDbPath) {
  try {
    const config = getTransitConfig();
    const defaultTransitDb = path.resolve(config.dataDir, 'transit.db');
    const altBackendDataDb = path.resolve(config.dataDir, '..', '..', 'data', 'transit.db');

    if (path.resolve(primaryDbPath) === defaultTransitDb && fs.existsSync(primaryDbPath)) {
      if (!fs.existsSync(altBackendDataDb) || fs.statSync(altBackendDataDb).size !== fs.statSync(primaryDbPath).size) {
        fs.mkdirSync(path.dirname(altBackendDataDb), { recursive: true });
        fs.copyFileSync(primaryDbPath, altBackendDataDb);
      }
    } else if (path.resolve(primaryDbPath) === altBackendDataDb && fs.existsSync(primaryDbPath)) {
      if (!fs.existsSync(defaultTransitDb) || fs.statSync(defaultTransitDb).size !== fs.statSync(primaryDbPath).size) {
        fs.mkdirSync(path.dirname(defaultTransitDb), { recursive: true });
        fs.copyFileSync(primaryDbPath, defaultTransitDb);
      }
    }
  } catch {
    // Non-fatal sync
  }
}

/**
 * Ensures the transit database is present and populated.
 * If the database already exists and has dataset records, skips import unless force=true.
 */
export async function ensureTransitData(options = {}) {
  const config = getTransitConfig(options.env || process.env);
  const force = options.force === true;

  if (!force && isTransitDbReady(config.dbPath)) {
    syncAltDbIfApplicable(config.dbPath);
    return { ready: true, imported: false, dbPath: config.dbPath };
  }

  console.log(`[Transit Bootstrap] Bootstrapping transit database for ${config.dbPath}...`);
  await downloadFeedIfMissing(config);

  const archive = readGtfsArchive(config.feedZipPath);
  const meta = readMeta(config.feedZipPath);
  const report = validateGtfs(archive, { asOf: options.asOf });
  const source = { ...config.feed, url: meta?.sourceUrl ?? config.feed.url };
  report.source = { ...source, retrievedAt: meta?.retrievedAt ?? null };

  if (report.blocking) {
    writeJson(config.reportPath, report);
    throw new Error('Transit feed validation blocked: feed contains fatal errors.');
  }

  fs.mkdirSync(path.dirname(config.dbPath), { recursive: true });
  const db = openTransitDb(config.dbPath);
  let result;
  try {
    result = importGtfs({
      db,
      archive,
      source,
      retrievedAt: meta?.retrievedAt,
      report,
      asOf: options.asOf,
      force
    });
  } finally {
    db.close();
  }

  writeJson(config.reportPath, report);
  syncAltDbIfApplicable(config.dbPath);
  clearTransitNetworkCache();

  console.log(`[Transit Bootstrap] Transit database successfully populated at ${config.dbPath}`);
  return { ready: true, imported: true, dbPath: config.dbPath, result };
}

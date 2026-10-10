// Single place for transit-data configuration (paths, feed URL, provenance labels).
// Values come from the environment (see backend/.env.example); nothing here is imported by routing code.
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export const TRANSIT_ROOT = __dirname;
const PROJECT_ROOT = path.resolve(TRANSIT_ROOT, '..', '..');

// Community-maintained APSRTC GTFS feed. Prototype/local use only: the licence is unconfirmed,
// so the archive and the database built from it are git-ignored and must not be redistributed.
export const DEFAULT_GTFS_URL = 'https://github.com/Neo2308/apsrtc-gtfs/raw/refs/heads/main/gtfs/gtfs.zip';

function resolveDbPath(env, defaultDbPath) {
  const custom = env.ROUTECONNECT_TRANSIT_DATABASE_PATH;
  if (custom && typeof custom === 'string' && custom.trim().length > 0) {
    return path.isAbsolute(custom) ? custom : path.resolve(process.cwd(), custom);
  }

  if (fs.existsSync(defaultDbPath)) return defaultDbPath;
  const altPath = path.resolve(PROJECT_ROOT, 'backend', 'data', 'transit.db');
  if (fs.existsSync(altPath)) return altPath;
  return defaultDbPath;
}

function resolveFeedZipPath(env, defaultZipPath, dbPath) {
  const custom = env.ROUTECONNECT_GTFS_ZIP_PATH;
  if (custom && typeof custom === 'string' && custom.trim().length > 0) {
    return path.isAbsolute(custom) ? custom : path.resolve(process.cwd(), custom);
  }

  if (dbPath && path.isAbsolute(dbPath)) {
    const parentDir = path.dirname(dbPath);
    const candidateInParent = path.join(parentDir, 'feeds', 'apsrtc-gtfs.zip');
    if (fs.existsSync(candidateInParent)) return candidateInParent;
    if (!dbPath.startsWith(PROJECT_ROOT)) {
      return candidateInParent;
    }
  }

  if (fs.existsSync(defaultZipPath)) return defaultZipPath;
  const altZip = path.resolve(PROJECT_ROOT, 'backend', 'data', 'feeds', 'apsrtc-gtfs.zip');
  if (fs.existsSync(altZip)) return altZip;
  return defaultZipPath;
}

// Read lazily so tests and scripts can override the environment before calling.
export function getTransitConfig(env = process.env) {
  const dataDir = path.join(TRANSIT_ROOT, 'data');
  const defaultDbPath = path.join(dataDir, 'transit.db');
  const defaultZipPath = path.join(dataDir, 'feeds', 'apsrtc-gtfs.zip');
  const defaultReportPath = path.join(TRANSIT_ROOT, 'reports', 'latest-validation.json');

  const dbPath = resolveDbPath(env, defaultDbPath);
  const feedZipPath = resolveFeedZipPath(env, defaultZipPath, dbPath);
  const reportPath = env.ROUTECONNECT_TRANSIT_REPORT_PATH
    ? (path.isAbsolute(env.ROUTECONNECT_TRANSIT_REPORT_PATH)
        ? env.ROUTECONNECT_TRANSIT_REPORT_PATH
        : path.resolve(process.cwd(), env.ROUTECONNECT_TRANSIT_REPORT_PATH))
    : defaultReportPath;

  return {
    dataDir,
    dbPath,
    feedZipPath,
    reportPath,
    feed: {
      url: env.ROUTECONNECT_GTFS_URL || DEFAULT_GTFS_URL,
      name: env.ROUTECONNECT_GTFS_SOURCE_NAME || 'Community APSRTC GTFS',
      type: env.ROUTECONNECT_GTFS_SOURCE_TYPE || 'community_gtfs',
      license: env.ROUTECONNECT_GTFS_LICENSE || 'unknown',
      confidence: env.ROUTECONNECT_GTFS_CONFIDENCE || 'published',
      // Deliberately NOT configurable: nothing about a community feed is operator-verified.
      verified: false
    }
  };
}

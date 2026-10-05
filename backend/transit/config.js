// Single place for transit-data configuration (paths, feed URL, provenance labels).
// Values come from the environment (see backend/.env.example); nothing here is imported by routing code.
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export const TRANSIT_ROOT = __dirname;

// Community-maintained APSRTC GTFS feed. Prototype/local use only: the licence is unconfirmed,
// so the archive and the database built from it are git-ignored and must not be redistributed.
export const DEFAULT_GTFS_URL = 'https://github.com/Neo2308/apsrtc-gtfs/raw/refs/heads/main/gtfs/gtfs.zip';

// Read lazily so tests and scripts can override the environment before calling.
export function getTransitConfig(env = process.env) {
  const dataDir = path.join(TRANSIT_ROOT, 'data');
  return {
    dataDir,
    dbPath: env.ROUTECONNECT_TRANSIT_DATABASE_PATH || path.join(dataDir, 'transit.db'),
    feedZipPath: env.ROUTECONNECT_GTFS_ZIP_PATH || path.join(dataDir, 'feeds', 'apsrtc-gtfs.zip'),
    reportPath: env.ROUTECONNECT_TRANSIT_REPORT_PATH || path.join(TRANSIT_ROOT, 'reports', 'latest-validation.json'),
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

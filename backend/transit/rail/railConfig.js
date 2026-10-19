// Railway timetable configuration (paths, source, licence status, freshness policy). Read lazily from the environment.
//
// Train search is OFF unless ROUTECONNECT_RAIL_ENABLED=true. That switch is the deliberate, human decision to serve the
// configured rail source: the default community feed has NO stated licence and is derived from NTES data (see
// backend/transit/rail/README.md), so it must never be activated silently.
import fs from 'fs';
import path from 'path';
import { TRANSIT_ROOT } from '../config.js';

// Community GTFS export of the Indian Railways timetable (also mirrored as Mobility Database feed mdb-2867).
// Unofficial, licence not stated: local evaluation only unless the owner approves wider use.
export const DEFAULT_RAIL_GTFS_URL = 'https://github.com/Neo2308/indianrailways-gtfs/raw/refs/heads/main/gtfs/gtfs.zip';

const resolvePath = (value, fallback) => {
  if (typeof value === 'string' && value.trim() !== '') return path.isAbsolute(value) ? value : path.resolve(process.cwd(), value);
  return fallback;
};
const positiveNumber = (value, fallback) => {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : fallback;
};

export function getRailConfig(env = process.env) {
  const dataDir = path.join(TRANSIT_ROOT, 'data');
  const dbPath = resolvePath(env.ROUTECONNECT_RAIL_DATABASE_PATH, path.join(dataDir, 'rail.db'));
  // Keep the archive next to a custom database (e.g. on a persistent disk) unless told otherwise.
  const defaultZip = env.ROUTECONNECT_RAIL_DATABASE_PATH
    ? path.join(path.dirname(dbPath), 'feeds', 'indianrailways-gtfs.zip')
    : path.join(dataDir, 'feeds', 'indianrailways-gtfs.zip');
  const licenseStatus = ['cleared', 'unconfirmed', 'restricted'].includes(env.ROUTECONNECT_RAIL_LICENSE_STATUS)
    ? env.ROUTECONNECT_RAIL_LICENSE_STATUS
    : 'unconfirmed';
  return {
    enabled: env.ROUTECONNECT_RAIL_ENABLED === 'true',
    autoImport: env.ROUTECONNECT_AUTO_IMPORT_RAIL !== 'false',
    dbPath,
    feedZipPath: resolvePath(env.ROUTECONNECT_RAIL_GTFS_ZIP_PATH, defaultZip),
    reportPath: path.join(TRANSIT_ROOT, 'reports', 'rail-import.json'),
    source: {
      providerId: 'gtfs',
      url: env.ROUTECONNECT_RAIL_GTFS_URL || DEFAULT_RAIL_GTFS_URL,
      name: env.ROUTECONNECT_RAIL_SOURCE_NAME || 'Community Indian Railways GTFS (unofficial)',
      type: ['official', 'open_data', 'community'].includes(env.ROUTECONNECT_RAIL_SOURCE_TYPE) ? env.ROUTECONNECT_RAIL_SOURCE_TYPE : 'community',
      license: env.ROUTECONNECT_RAIL_LICENSE || 'Not stated by the publisher',
      licenseStatus,
      operator: 'Indian Railways',
      provenanceNote: env.ROUTECONNECT_RAIL_PROVENANCE_NOTE
        || 'Community export of the Indian Railways public timetable as served by NTES (via the UMANG API gateway). Not published or endorsed by Indian Railways, CRIS or NTES.'
    },
    freshness: {
      // Older than this, results carry a "check before travelling" notice.
      staleWarningDays: positiveNumber(env.ROUTECONNECT_RAIL_STALE_WARNING_DAYS, 45),
      // Older than this, train search is switched off: an old snapshot is reported, never silently stretched.
      maxSnapshotAgeDays: positiveNumber(env.ROUTECONNECT_RAIL_MAX_SNAPSHOT_AGE_DAYS, 120)
    },
    search: {
      // Station discovery around each end of the journey.
      stationRadiusMeters: positiveNumber(env.ROUTECONNECT_RAIL_STATION_RADIUS_METERS, 40000),
      // Same-station train-to-train change. Indian trains often run late, so this is deliberately generous.
      minTransferSeconds: positiveNumber(env.ROUTECONNECT_RAIL_MIN_TRANSFER_MINUTES, 45) * 60,
      maxTransferWaitSeconds: positiveNumber(env.ROUTECONNECT_RAIL_MAX_TRANSFER_WAIT_MINUTES, 180) * 60
    }
  };
}

export function railDataPresent(config = getRailConfig()) {
  try {
    return fs.existsSync(config.dbPath) && fs.statSync(config.dbPath).size > 4096;
  } catch {
    return false;
  }
}

// Estimated Rail Connection: configuration. This feature uses mapped railway INFRASTRUCTURE (OpenStreetMap, ODbL) and an
// assumed travel-time model. It never uses or produces timetable data, and it is technically separate from the
// scheduled-train engine in backend/transit/rail.
import path from 'path';
import { TRANSIT_ROOT } from '../config.js';

const resolvePath = (value, fallback) => {
  if (typeof value === 'string' && value.trim() !== '') return path.isAbsolute(value) ? value : path.resolve(process.cwd(), value);
  return fallback;
};
const num = (value, fallback) => {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : fallback;
};

// Regions extracted by default (OSM admin_level=4 boundaries).
export const DEFAULT_REGIONS = Object.freeze(['Andhra Pradesh', 'Telangana']);

export function getRailNetworkConfig(env = process.env) {
  const dir = resolvePath(env.ROUTECONNECT_RAIL_NETWORK_DIR, path.join(TRANSIT_ROOT, 'data', 'railNetwork'));
  return {
    enabled: env.ROUTECONNECT_RAIL_NETWORK_ENABLED !== 'false',
    // Server start-up may fetch the one regional extract itself when no extract exists yet (set "false" to forbid).
    autoExtract: env.ROUTECONNECT_RAIL_NETWORK_AUTO_EXTRACT !== 'false',
    dir,
    rawPath: path.join(dir, 'osm-railways.raw.json'),
    graphPath: path.join(dir, 'rail-network.json'),
    overpassUrl: env.ROUTECONNECT_OVERPASS_URL || 'https://overpass-api.de/api/interpreter',
    regions: (env.ROUTECONNECT_RAIL_NETWORK_REGIONS || DEFAULT_REGIONS.join(',')).split(',').map(s => s.trim()).filter(Boolean),
    // Snapshots older than this are reported as needing a refresh (infrastructure changes slowly).
    refreshAfterDays: num(env.ROUTECONNECT_RAIL_NETWORK_REFRESH_DAYS, 180),
    model: estimateModel(env)
  };
}

// The assumed travel-time model. Two scenarios bracket typical Indian Railways passenger running:
//   faster  - an express that stops rarely   (higher running speed, a short stop every ~60 km)
//   slower  - a train that calls at most stations (lower running speed, a stop at each mapped station passed)
// Values are deliberately round and documented; they are NOT fitted to any timetable.
export function estimateModel(env = process.env) {
  return Object.freeze({
    faster: Object.freeze({
      mainKph: num(env.ROUTECONNECT_EST_RAIL_FAST_MAIN_KPH, 65),
      branchKph: num(env.ROUTECONNECT_EST_RAIL_FAST_BRANCH_KPH, 50),
      stopEveryKm: num(env.ROUTECONNECT_EST_RAIL_FAST_STOP_EVERY_KM, 60),
      stopMinutes: num(env.ROUTECONNECT_EST_RAIL_FAST_STOP_MINUTES, 3)
    }),
    slower: Object.freeze({
      mainKph: num(env.ROUTECONNECT_EST_RAIL_SLOW_MAIN_KPH, 45),
      branchKph: num(env.ROUTECONNECT_EST_RAIL_SLOW_BRANCH_KPH, 35),
      stopMinutesPerStation: num(env.ROUTECONNECT_EST_RAIL_SLOW_STOP_MINUTES, 1.5)
    }),
    // A reversal (the line continues out of a station the way it came in) costs extra time.
    reversalMinutes: num(env.ROUTECONNECT_EST_RAIL_REVERSAL_MINUTES, 20)
  });
}

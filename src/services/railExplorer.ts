// Client for GET /api/v2/rail-explorer: ESTIMATED rail connections over mapped railway track (OpenStreetMap).
// Deliberately a separate contract from the journey planner: no clock times, no train identity, no fares, no ranking
// against scheduled journeys.

export const ESTIMATED_RAIL_LABEL = 'Estimated rail connection — not a scheduled train';

export interface ExplorerStation {
  name: string;
  code: string | null;
  lat: number;
  lon: number;
  distanceFromOriginKm?: number;
  distanceToDestinationKm?: number;
}

export interface EstimatedRailConnection {
  id: string;
  kind: 'estimated_rail_connection';
  label: string;
  alternative: boolean;
  startStation: ExplorerStation;
  endStation: ExplorerStation;
  corridor: { names: string[]; via: string[] };
  distanceKm: number;
  trackKmByClass: { main: number; branch: number; unknown: number };
  estimatedDuration: {
    minMinutes: number;
    maxMinutes: number;
    breakdown: {
      faster: { runningMinutes: number; stops: number; stopMinutes: number; mainKph: number; branchKph: number };
      slower: { runningMinutes: number; stops: number; stopMinutes: number; mainKph: number; branchKph: number };
      reversals: number;
      reversalMinutes: number;
    };
  };
  intermediateStationCount: number;
  intermediateStations: { name: string; code: string | null; km: number }[];
  reversals: number;
  geometry: [number, number][];
}

export interface RailExplorerResponse {
  available: boolean;
  state?: string;
  label: string;
  reason?: string;
  message?: string;
  assumptions?: string[];
  network?: { attribution: string; licence: string; coverage: string[]; snapshot: string | null };
  connections?: EstimatedRailConnection[];
}

// The search flow fetches while the discovery animation plays and hands the answer to the results page (no second request).
const cache = new Map<string, { value: RailExplorerResponse; at: number }>();
export const explorerKey = (c: { fromLat: number; fromLng: number; toLat: number; toLng: number }) => [c.fromLat, c.fromLng, c.toLat, c.toLng].map(n => n.toFixed(5)).join(',');
export function rememberRailExplorer(key: string, value: RailExplorerResponse, now = Date.now()): void {
  cache.set(key, { value, at: now });
  while (cache.size > 8) cache.delete(cache.keys().next().value as string);
}
export function recallRailExplorer(key: string, now = Date.now()): RailExplorerResponse | null {
  const hit = cache.get(key);
  return hit && now - hit.at < 5 * 60 * 1000 ? hit.value : null;
}

export async function fetchRailExplorer(
  coords: { fromLat: number; fromLng: number; toLat: number; toLng: number },
  signal?: AbortSignal
): Promise<RailExplorerResponse> {
  const query = new URLSearchParams(Object.fromEntries(Object.entries(coords).map(([k, v]) => [k, String(v)])));
  const response = await fetch(`/api/v2/rail-explorer?${query.toString()}`, { signal });
  const body = await response.json().catch(() => null);
  if (!body) throw new Error('Estimated rail connections are unavailable right now.');
  if ((body as RailExplorerResponse).available) rememberRailExplorer(explorerKey(coords), body as RailExplorerResponse);
  return body as RailExplorerResponse;
}

// "4 h 50 min – 8 h 5 min": always a range, never a clock time.
export function durationRange(minMinutes: number, maxMinutes: number): string {
  const fmt = (m: number) => {
    const h = Math.floor(m / 60);
    const mm = m % 60;
    return h === 0 ? `${mm} min` : mm === 0 ? `${h} h` : `${h} h ${mm} min`;
  };
  return minMinutes === maxMinutes ? `about ${fmt(minMinutes)}` : `${fmt(minMinutes)} – ${fmt(maxMinutes)}`;
}

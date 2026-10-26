// Which travel modes have genuinely usable data right now (GET /api/v2/capabilities).
// Until the server answers — or if it cannot be reached — only buses are offered: a mode is never unlocked on a guess.
import { useCallback, useEffect, useState } from 'react';
import type { TransportMode } from '../utils/travelPreferences';

export interface TrainCapability {
  available: boolean;
  reason: string | null;
  snapshotDate: string | null;
  freshness: 'fresh' | 'stale' | 'expired' | null;
  sourceName: string | null;
  official: boolean;
  live: false;
}

// The separate Estimated Rail Connection explorer (mapped track + assumed speeds). Never a scheduled train.
export interface EstimatedRailCapability {
  available: boolean;
  state: 'ready' | 'preparing' | 'missing' | 'failed' | 'disabled' | 'unknown' | null;
  reason: string | null;
  coverage: string[];
  attribution: string | null;
}

export interface Capabilities {
  loaded: boolean;
  availableModes: TransportMode[];
  train: TrainCapability;
  estimatedRail: EstimatedRailCapability;
}

export const DEFAULT_CAPABILITIES: Capabilities = Object.freeze({
  loaded: false,
  availableModes: ['bus'],
  train: { available: false, reason: null, snapshotDate: null, freshness: null, sourceName: null, official: false, live: false },
  estimatedRail: { available: false, state: null, reason: null, coverage: [], attribution: null }
}) as Capabilities;

export function capabilitiesFromResponse(body: unknown): Capabilities {
  const train = (body as { modes?: { train?: Partial<TrainCapability> } } | null)?.modes?.train ?? {};
  const explorer = (body as { estimatedRail?: Partial<EstimatedRailCapability> } | null)?.estimatedRail ?? {};
  const available = train.available === true;
  return {
    loaded: true,
    availableModes: available ? ['bus', 'train'] : ['bus'],
    train: {
      available,
      reason: typeof train.reason === 'string' ? train.reason : null,
      snapshotDate: typeof train.snapshotDate === 'string' ? train.snapshotDate : null,
      freshness: train.freshness === 'fresh' || train.freshness === 'stale' || train.freshness === 'expired' ? train.freshness : null,
      sourceName: typeof train.sourceName === 'string' ? train.sourceName : null,
      official: train.official === true,
      live: false
    },
    estimatedRail: {
      available: explorer.available === true,
      state: ['ready', 'preparing', 'missing', 'failed', 'disabled', 'unknown'].includes(explorer.state as string) ? explorer.state as EstimatedRailCapability['state'] : null,
      reason: typeof explorer.reason === 'string' ? explorer.reason : null,
      coverage: Array.isArray(explorer.coverage) ? explorer.coverage.filter(c => typeof c === 'string') : [],
      attribution: typeof explorer.attribution === 'string' ? explorer.attribution : null
    }
  };
}

// The server could not be asked (unreachable, or an older server without /api/v2/capabilities): say so plainly.
export function unreachableCapabilities(detail: string): Capabilities {
  console.warn(`[RouteConnect] Could not read /api/v2/capabilities (${detail}). If the backend was started before an update, restart it.`);
  return {
    ...DEFAULT_CAPABILITIES,
    loaded: true,
    estimatedRail: { ...DEFAULT_CAPABILITIES.estimatedRail, state: 'unknown', reason: 'Train availability could not be checked with the route server.' }
  };
}

let cached: { value: Capabilities; at: number } | null = null;
let inflight: Promise<Capabilities> | null = null;
// A settled answer is kept for a while; one that can still change on its own (preparing, server not reached) is asked
// again soon. A failed or missing explorer only changes after a server restart, and scheduled trains do not depend on it.
const READY_TTL_MS = 5 * 60 * 1000;
const RETRY_TTL_MS = 4 * 1000;
export const capabilitiesSettled = (value: Capabilities): boolean =>
  value.loaded && value.estimatedRail.state !== 'preparing' && value.estimatedRail.state !== 'unknown';

export function fetchCapabilities({ force = false } = {}): Promise<Capabilities> {
  const ttl = cached && capabilitiesSettled(cached.value) ? READY_TTL_MS : RETRY_TTL_MS;
  if (!force && cached && Date.now() - cached.at < ttl) return Promise.resolve(cached.value);
  if (!inflight) {
    inflight = fetch('/api/v2/capabilities')
      .then(async response => (response.ok ? capabilitiesFromResponse(await response.json()) : unreachableCapabilities(`HTTP ${response.status}`)))
      .catch(error => unreachableCapabilities((error as Error).message))
      .then(value => {
        cached = { value, at: Date.now() };
        return value;
      })
      .finally(() => { inflight = null; });
  }
  return inflight;
}

// Current capabilities plus `refresh()` (the dialog re-checks each time it opens). While Train is not ready and
// `poll` is on, it re-checks every few seconds, so "Preparing…" turns into a usable Train choice without a reload.
export function useCapabilities({ poll = false }: { poll?: boolean } = {}): Capabilities & { refresh: () => void } {
  const [value, setValue] = useState<Capabilities>(cached?.value ?? DEFAULT_CAPABILITIES);
  const refresh = useCallback(() => { fetchCapabilities().then(setValue); }, []);
  useEffect(() => {
    let active = true;
    fetchCapabilities().then(next => { if (active) setValue(next); });
    return () => { active = false; };
  }, []);
  const settled = capabilitiesSettled(value);
  useEffect(() => {
    if (!poll || settled) return;
    const timer = window.setInterval(() => { fetchCapabilities().then(setValue); }, RETRY_TTL_MS);
    return () => window.clearInterval(timer);
  }, [poll, settled]);
  return { ...value, refresh };
}

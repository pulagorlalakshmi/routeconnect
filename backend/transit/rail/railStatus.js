// Public summary of railway timetable availability, for GET /api/v2/capabilities and GET /api/transit/status.
// Provenance, freshness and coverage only: no file paths, no SQL, no raw rows.
import { railAvailability } from '../sources/rail/railSource.js';
import { isoToDayNumber } from '../routing/serviceCalendar.js';
import { railNetworkStatus } from '../railNetwork/railExplorer.js';
import { createRailRadarSource } from '../sources/rail/railRadarSource.js';
import { getSharedRailRadarClient } from './verification/railRadar.js';

// How many imported trains have calendars that ended before `today` (they are no longer offered).
function expiredTrainCount(network, today) {
  const day = isoToDayNumber(today);
  let count = 0;
  for (const train of network.trains) {
    const calendar = network.serviceIndex.calendarByService[train.serviceIdx];
    if (calendar && calendar.endDay < day) count++;
  }
  return count;
}

export function getRailStatus({ env = process.env, now = new Date(), getNetwork } = {}) {
  const state = railAvailability({ env, now, ...(getNetwork ? { getNetwork } : {}) });
  const base = { available: state.available, code: state.code ?? null, reason: state.reason ?? null, live: false, realtime: 'not_available' };
  if (!state.network) return base;
  const { dataset } = state.network;
  return {
    ...base,
    scheduleKind: 'scheduled_timetable',
    source: {
      name: dataset.name,
      type: dataset.sourceType,
      official: dataset.sourceType === 'official',
      license: dataset.license,
      licenseStatus: dataset.licenseStatus,
      provenance: dataset.provenanceNote,
      url: dataset.sourceUrl
    },
    snapshotDate: dataset.snapshotDate,
    retrievedAt: dataset.retrievedAt,
    importedAt: dataset.importedAt,
    publisherFeedEndDate: dataset.feedEndDate,
    calendarCoverage: { from: dataset.validFrom, to: dataset.validTo },
    freshness: state.freshness,
    coverage: {
      stations: dataset.stats.stations ?? state.network.stations.length,
      trains: state.network.trains.length,
      trainsExcludedAtImport: dataset.stats.trainsExcluded ?? null,
      trainsWithExpiredCalendars: state.freshness ? expiredTrainCount(state.network, state.freshness.checkedOn) : null,
      importIssues: dataset.stats.issueCounts ?? {}
    },
    fares: 'not_available'
  };
}

// The compact form the frontend needs to decide which travel choices to offer.
// `train` is SCHEDULED trains (timetable data); `estimatedRail` is the separate infrastructure explorer.
export function getCapabilities({ env = process.env, now = new Date(), getNetwork, railNetwork = () => railNetworkStatus({ now }), railRadar = env.RAILRADAR_API_KEY?.trim() ? createRailRadarSource({ env, client: getSharedRailRadarClient(env) }) : null } = {}) {
  // Scheduled trains: RailRadar when configured (and within its budget), otherwise the imported timetable's own status.
  let rail = getRailStatus({ env, now, getNetwork });
  if (railRadar) {
    const state = railRadar.status({ crowFliesMeters: Number.MAX_SAFE_INTEGER });
    rail = state.configured
      ? { available: true, reason: null, snapshotDate: null, freshness: null, source: { name: 'RailRadar', official: false }, provider: 'railradar' }
      : { available: false, reason: state.reason, provider: 'railradar' };
  }
  let explorer = { available: false };
  try { explorer = railNetwork(); } catch { explorer = { available: false }; }
  return {
    estimatedRail: {
      available: explorer.available === true,
      state: explorer.state ?? (explorer.available ? 'ready' : 'missing'),
      reason: explorer.available ? null : explorer.reason ?? null,
      label: explorer.label ?? null,
      coverage: explorer.coverage ?? [],
      attribution: explorer.attribution ?? null
    },
    modes: {
      bus: { available: true },
      train: {
        available: rail.available,
        reason: rail.available ? null : rail.reason,
        snapshotDate: rail.snapshotDate ?? null,
        freshness: rail.freshness?.status ?? null,
        sourceName: rail.source?.name ?? null,
        provider: rail.provider ?? 'timetable',
        official: rail.source?.official ?? false,
        live: false
      }
    }
  };
}

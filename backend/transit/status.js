// Read-only summary of the imported transit dataset, for GET /api/transit/status.
// Exposes provenance, validity and counts only: no file paths, no SQL, no raw rows.
import { getTransitConfig } from './config.js';
import { openTransitDb } from './transitDb.js';
import { effectiveConfidence, getValidity, todayInTimezone } from './datasetMetadata.js';

export function getTransitStatus({ dbPath = getTransitConfig().dbPath, now = new Date() } = {}) {
  let db;
  try {
    db = openTransitDb(dbPath, { readOnly: true });
  } catch {
    return { datasetLoaded: false, message: 'No transit dataset has been imported yet.' };
  }

  try {
    const dataset = db.prepare('SELECT * FROM datasets ORDER BY imported_at DESC, id DESC LIMIT 1').get();
    if (!dataset) return { datasetLoaded: false, message: 'No transit dataset has been imported yet.' };

    const agency = db.prepare('SELECT timezone FROM agencies WHERE dataset_id = ? LIMIT 1').get(dataset.id);
    const asOf = todayInTimezone(agency?.timezone || 'UTC', now);
    const validity = getValidity({ validFrom: dataset.valid_from, validTo: dataset.valid_to }, asOf);
    const stats = dataset.stats_json ? JSON.parse(dataset.stats_json) : {};
    const counts = stats.counts ?? {};

    return {
      datasetLoaded: true,
      source: dataset.name,
      sourceType: dataset.source_type,
      sourceUrl: dataset.source_url,
      license: dataset.license,
      confidence: dataset.confidence_default,
      effectiveConfidence: effectiveConfidence(dataset, asOf),
      verified: dataset.verified === 1,
      retrievedAt: dataset.retrieved_at,
      importedAt: dataset.imported_at,
      validFrom: dataset.valid_from,
      validTo: dataset.valid_to,
      checkedOn: asOf,
      validityStatus: validity.status,
      currentlyValid: validity.currentlyValid,
      counts: {
        agencies: counts.agencies ?? 0,
        stops: counts.stops ?? 0,
        routes: counts.routes ?? 0,
        trips: counts.trips ?? 0,
        stopTimes: counts.stopTimes ?? 0,
        shapePoints: counts.shapePoints ?? 0
      },
      timeQuality: stats.timeQuality ?? null,
      notice: validity.currentlyValid
        ? 'Community-maintained feed; not verified by the operator.'
        : 'Feed validity window does not cover today; schedules are treated as inferred. Community-maintained feed; not verified by the operator.'
    };
  } finally {
    db.close();
  }
}

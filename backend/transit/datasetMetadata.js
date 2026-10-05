// Dataset provenance, validity and confidence handling.
import { CONFIDENCE, isConfidence, requiresVerification, capConfidence } from './confidence.js';

// ---------- Dates (ISO "YYYY-MM-DD" strings; pure string/integer math, no timezone surprises) ----------

// GTFS "20260830" -> "2026-08-30"; returns null when invalid.
export function gtfsDateToIso(value) {
  const text = String(value ?? '').trim();
  const match = /^(\d{4})(\d{2})(\d{2})$/.exec(text);
  if (!match) return null;
  const [, y, m, d] = match;
  const date = new Date(Date.UTC(Number(y), Number(m) - 1, Number(d)));
  if (date.getUTCFullYear() !== Number(y) || date.getUTCMonth() !== Number(m) - 1 || date.getUTCDate() !== Number(d)) {
    return null;
  }
  return `${y}-${m}-${d}`;
}

// Today's date in the given IANA timezone, as "YYYY-MM-DD".
export function todayInTimezone(timeZone = 'UTC', now = new Date()) {
  try {
    return new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(now);
  } catch {
    return now.toISOString().slice(0, 10);
  }
}

// Derives the timetable validity window from calendar.txt / calendar_dates.txt (falling back to feed_info.txt).
export function deriveValidity({ calendarRows = [], calendarDateRows = [], feedInfoRow = null } = {}) {
  const dates = [];
  for (const row of calendarRows) {
    const start = gtfsDateToIso(row.start_date);
    const end = gtfsDateToIso(row.end_date);
    if (start) dates.push(start);
    if (end) dates.push(end);
  }
  for (const row of calendarDateRows) {
    // Only additions (type 1) prove service exists on that date.
    if (String(row.exception_type).trim() !== '1') continue;
    const date = gtfsDateToIso(row.date);
    if (date) dates.push(date);
  }
  dates.sort();

  const feedStart = gtfsDateToIso(feedInfoRow?.feed_start_date);
  const feedEnd = gtfsDateToIso(feedInfoRow?.feed_end_date);

  return {
    validFrom: dates.length ? dates[0] : feedStart,
    validTo: dates.length ? dates[dates.length - 1] : feedEnd,
    feedStart,
    feedEnd
  };
}

// status: 'valid' | 'expired' | 'not_yet_valid' | 'unknown'
export function getValidity({ validFrom, validTo } = {}, asOf) {
  if (!validFrom || !validTo || !asOf) return { status: 'unknown', currentlyValid: false };
  if (asOf < validFrom) return { status: 'not_yet_valid', currentlyValid: false };
  if (asOf > validTo) return { status: 'expired', currentlyValid: false };
  return { status: 'valid', currentlyValid: true };
}

// The confidence a dataset can honestly claim on a given date.
// An expired / not-yet-valid / undated timetable is downgraded to "inferred": the pattern may still repeat,
// but nobody has published it for that date.
export function effectiveConfidence(dataset, asOf) {
  const base = dataset?.confidence_default ?? dataset?.confidenceDefault ?? CONFIDENCE.UNKNOWN;
  const validity = getValidity(
    { validFrom: dataset?.valid_from ?? dataset?.validFrom, validTo: dataset?.valid_to ?? dataset?.validTo },
    asOf
  );
  return validity.currentlyValid ? base : capConfidence(base, CONFIDENCE.INFERRED);
}

// ---------- Source provenance ----------

// Validates and normalises the provenance of a feed. Throws on dishonest combinations.
export function normalizeSource(source = {}) {
  const name = String(source.name ?? '').trim();
  const type = String(source.type ?? '').trim();
  if (!name) throw new Error('Dataset source requires a name.');
  if (!type) throw new Error('Dataset source requires a type (e.g. "community_gtfs").');

  const confidence = source.confidence ?? CONFIDENCE.PUBLISHED;
  if (!isConfidence(confidence)) {
    throw new Error(`Unknown confidence "${confidence}".`);
  }
  const verified = source.verified === true;
  if (requiresVerification(confidence) && !verified) {
    throw new Error(`Confidence "${confidence}" requires verified=true; refusing to label unverified data as ${confidence}.`);
  }
  if (verified && !requiresVerification(confidence)) {
    throw new Error('verified=true is only valid together with confidence "verified" or "live".');
  }

  return {
    name,
    type,
    url: source.url ? String(source.url) : null,
    license: String(source.license ?? 'unknown').trim() || 'unknown',
    confidence,
    verified
  };
}

export function makeSourceKey(source) {
  return `${source.type}|${source.name}`;
}

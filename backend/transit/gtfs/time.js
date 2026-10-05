// GTFS time handling.
//
// GTFS times are "HH:MM:SS" measured from the START OF THE SERVICE DAY (noon minus 12h),
// and may exceed 24:00:00 for trips that run past midnight (e.g. "25:30:00" = 01:30 the next
// calendar day, still part of the same service day). We store them as integer seconds so
// they sort and subtract correctly across midnight.

const TIME_PATTERN = /^(\d{1,2}):([0-5]\d):([0-5]\d)$/;

// "25:30:00" -> 91800.  Empty string -> null.  Invalid text -> null (use isInvalidGtfsTime to tell them apart).
export function parseGtfsTime(value) {
  if (value === undefined || value === null) return null;
  const match = TIME_PATTERN.exec(String(value).trim());
  if (!match) return null;
  return Number(match[1]) * 3600 + Number(match[2]) * 60 + Number(match[3]);
}

// True when a value is present but not a valid GTFS time (empty is valid: it means "no time").
export function isInvalidGtfsTime(value) {
  const text = value === undefined || value === null ? '' : String(value).trim();
  return text !== '' && parseGtfsTime(text) === null;
}

// 91800 -> "25:30:00"
export function formatGtfsTime(seconds) {
  if (!Number.isFinite(seconds) || seconds < 0) return null;
  const total = Math.round(seconds);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}

export const SECONDS_PER_DAY = 86400;

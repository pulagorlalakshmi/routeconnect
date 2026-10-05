// GTFS service-day resolution.
//
// Everything here works on integer "day numbers" (days since 1970-01-01 of the CALENDAR DATE, computed from
// year/month/day only). No Date objects are formatted in a timezone, so UTC midnight boundaries can never shift
// a service date. Wall-clock seconds are measured from 00:00 local time of a day; GTFS times past 24:00:00 are
// simply seconds >= 86400 on the service day they belong to:
//   service day Oct 3, stop time 25:30:00  ->  Oct 3 + 91800 s  ->  Oct 4 01:30 local.
import { SECONDS_PER_DAY } from './types.js';

const MS_PER_DAY = 86400000;

// "2026-10-04" -> integer day number; null when not a real calendar date.
export function isoToDayNumber(iso) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(iso ?? ''));
  if (!match) return null;
  const [y, m, d] = [Number(match[1]), Number(match[2]), Number(match[3])];
  const ms = Date.UTC(y, m - 1, d);
  const check = new Date(ms);
  if (check.getUTCFullYear() !== y || check.getUTCMonth() !== m - 1 || check.getUTCDate() !== d) return null;
  return ms / MS_PER_DAY;
}

export function dayNumberToIso(dayNumber) {
  return new Date(dayNumber * MS_PER_DAY).toISOString().slice(0, 10);
}

// 0 = Monday ... 6 = Sunday (1970-01-01 was a Thursday).
export function weekdayIndex(dayNumber) {
  return (((dayNumber + 3) % 7) + 7) % 7;
}

// "08:30" or "08:30:15" -> seconds after midnight; null when invalid.
export function parseClockTime(text) {
  const match = /^([01]\d|2[0-3]):([0-5]\d)(?::([0-5]\d))?$/.exec(String(text ?? ''));
  if (!match) return null;
  return Number(match[1]) * 3600 + Number(match[2]) * 60 + Number(match[3] ?? 0);
}

// Seconds since 00:00 of `anchorDayNumber` (may be negative or > 86400) -> "2026-10-04T01:30:00+05:30".
export function formatLocalDateTime(anchorDayNumber, absoluteSeconds, utcOffset) {
  const dayShift = Math.floor(absoluteSeconds / SECONDS_PER_DAY);
  const secondOfDay = absoluteSeconds - dayShift * SECONDS_PER_DAY;
  const hh = String(Math.floor(secondOfDay / 3600)).padStart(2, '0');
  const mm = String(Math.floor((secondOfDay % 3600) / 60)).padStart(2, '0');
  const ss = String(secondOfDay % 60).padStart(2, '0');
  return `${dayNumberToIso(anchorDayNumber + dayShift)}T${hh}:${mm}:${ss}${utcOffset}`;
}

// Builds a compact service index from calendar rows and calendar_dates rows.
// calendars:     [{ serviceId, days: [mon..sun as 0/1], start: 'YYYY-MM-DD', end: 'YYYY-MM-DD' }]
// calendarDates: [{ serviceId, date: 'YYYY-MM-DD', type: 1 (added) | 2 (removed) }]
export function buildServiceIndex({ calendars = [], calendarDates = [], extraServiceIds = [] } = {}) {
  const idToIndex = new Map();
  const serviceIds = [];
  const ensure = serviceId => {
    let index = idToIndex.get(serviceId);
    if (index === undefined) {
      index = serviceIds.length;
      idToIndex.set(serviceId, index);
      serviceIds.push(serviceId);
    }
    return index;
  };

  const calendarByService = [];
  for (const row of calendars) {
    const index = ensure(row.serviceId);
    calendarByService[index] = {
      days: Uint8Array.from(row.days),
      startDay: isoToDayNumber(row.start),
      endDay: isoToDayNumber(row.end)
    };
  }

  const exceptions = []; // exceptions[serviceIndex] = Map<dayNumber, 1|2>
  for (const row of calendarDates) {
    const index = ensure(row.serviceId);
    const day = isoToDayNumber(row.date);
    if (day === null) continue;
    (exceptions[index] ??= new Map()).set(day, row.type === 2 ? 2 : 1);
  }
  for (const serviceId of extraServiceIds) ensure(serviceId);

  return { serviceIds, idToIndex, calendarByService, exceptions };
}

// Which services run on `dayNumber`?  Returns Uint8Array indexed by service index.
// extrapolate: ignore the calendar start/end dates and reuse the weekly pattern (used only when the feed's
//              validity window does not cover the day; callers must downgrade confidence when they do this).
export function resolveActiveServices(serviceIndex, dayNumber, { extrapolate = false } = {}) {
  const active = new Uint8Array(serviceIndex.serviceIds.length);
  const weekday = weekdayIndex(dayNumber);

  for (let s = 0; s < active.length; s++) {
    const calendar = serviceIndex.calendarByService[s];
    let runs = false;
    if (calendar) {
      const inRange = extrapolate || (dayNumber >= calendar.startDay && dayNumber <= calendar.endDay);
      runs = inRange && calendar.days[weekday] === 1;
    }
    const exception = serviceIndex.exceptions[s]?.get(dayNumber);
    if (exception === 1) runs = true;
    else if (exception === 2) runs = false;
    active[s] = runs ? 1 : 0;
  }
  return active;
}

// Is `dayNumber` inside [validFromIso, validToIso]?  Unknown bounds -> true (nothing to extrapolate from).
export function isDayWithinValidity(dayNumber, validFromIso, validToIso) {
  const from = isoToDayNumber(validFromIso);
  const to = isoToDayNumber(validToIso);
  if (from === null || to === null) return true;
  return dayNumber >= from && dayNumber <= to;
}

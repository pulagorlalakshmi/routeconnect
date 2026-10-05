// Date/time helpers. The planner API uses local wall-clock times with a fixed +05:30 offset
// (e.g. "2026-10-04T01:30:00+05:30"), so the clock part of those strings is displayed as-is.

const pad = (value: number) => String(value).padStart(2, '0');

// Local calendar date of the browser, as YYYY-MM-DD (toISOString() would give the UTC date, which can be yesterday).
export function todayLocalIso(now: Date = new Date()): string {
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}

export function nowLocalHHMM(now: Date = new Date()): string {
  return `${pad(now.getHours())}:${pad(now.getMinutes())}`;
}

// "2026-10-04T01:30:00+05:30" -> "01:30"
export function clockOf(iso: string): string {
  return iso.slice(11, 16);
}

export function dateOf(iso: string): string {
  return iso.slice(0, 10);
}

const dayNumber = (isoDate: string) => {
  const [y, m, d] = isoDate.split('-').map(Number);
  return Math.round(Date.UTC(y, m - 1, d) / 86400000);
};

// Calendar days from one ISO date(-time) to another (0 = same day, 1 = next day).
export function dayDifference(fromIso: string, toIso: string): number {
  return dayNumber(dateOf(toIso)) - dayNumber(dateOf(fromIso));
}

export function formatDateLabel(isoDate: string): string {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(isoDate)) return isoDate;
  const [y, m, d] = isoDate.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d)).toLocaleDateString('en-GB', {
    weekday: 'short', day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC'
  });
}

export function formatDuration(totalSeconds: number): string {
  const minutes = Math.max(0, Math.round(totalSeconds / 60));
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  if (hours === 0) return `${rest} min`;
  if (rest === 0) return `${hours} h`;
  return `${hours} h ${rest} min`;
}

// Adds minutes to a date + HH:MM pair (calendar arithmetic only, no timezone involved).
export function addMinutes(date: string, time: string, minutes: number): { date: string; time: string } {
  const [h, mi] = time.split(':').map(Number);
  const total = h * 60 + mi + minutes;
  const dayShift = Math.floor(total / 1440);
  const minuteOfDay = total - dayShift * 1440;
  const [y, m, d] = date.split('-').map(Number);
  const shifted = new Date(Date.UTC(y, m - 1, d + dayShift));
  return {
    date: `${shifted.getUTCFullYear()}-${pad(shifted.getUTCMonth() + 1)}-${pad(shifted.getUTCDate())}`,
    time: `${pad(Math.floor(minuteOfDay / 60))}:${pad(minuteOfDay % 60)}`
  };
}

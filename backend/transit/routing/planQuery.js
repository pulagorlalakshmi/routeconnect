// Validation of GET /api/v2/plan query parameters. Pure: no Express, no database.
import { isoToDayNumber, parseClockTime } from './serviceCalendar.js';
import { todayInTimezone } from '../datasetMetadata.js';

const DECIMAL = /^-?\d+(\.\d+)?$/;
const INTEGER = /^\d+$/;

function currentClockTime(timeZone, now) {
  try {
    return new Intl.DateTimeFormat('en-GB', { timeZone, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(now);
  } catch {
    return now.toISOString().slice(11, 16);
  }
}

// Returns { ok: true, value } or { ok: false, errors: string[] }.
export function parsePlanQuery(raw, config, now = new Date()) {
  const errors = [];
  const input = raw ?? {};

  const single = name => {
    const value = input[name];
    if (Array.isArray(value)) {
      errors.push(`${name} must be provided once`);
      return undefined;
    }
    return value === undefined || value === '' ? undefined : String(value);
  };

  const coordinate = (name, min, max) => {
    const value = single(name);
    if (value === undefined) { errors.push(`${name} is required`); return null; }
    const number = DECIMAL.test(value) ? Number(value) : NaN;
    if (!Number.isFinite(number) || number < min || number > max) {
      errors.push(`${name} must be a decimal number between ${min} and ${max}`);
      return null;
    }
    return number;
  };

  const integer = (name, fallback, min, max) => {
    const value = single(name);
    if (value === undefined) return fallback;
    const number = INTEGER.test(value) ? Number(value) : NaN;
    if (!Number.isFinite(number) || number < min || number > max) {
      errors.push(`${name} must be an integer between ${min} and ${max}`);
      return fallback;
    }
    return number;
  };

  const fromLat = coordinate('fromLat', -90, 90);
  const fromLng = coordinate('fromLng', -180, 180);
  const toLat = coordinate('toLat', -90, 90);
  const toLng = coordinate('toLng', -180, 180);

  const today = todayInTimezone(config.timezone, now);
  let date = today;
  const dateText = single('date');
  if (dateText !== undefined) {
    if (isoToDayNumber(dateText) === null) errors.push('date must be a real calendar date in YYYY-MM-DD format');
    else date = dateText;
  }

  let time = date === today ? currentClockTime(config.timezone, now) : '00:00';
  const timeText = single('time');
  if (timeText !== undefined) {
    if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(timeText)) errors.push('time must be HH:MM in 24-hour format');
    else time = timeText;
  }

  const maxTransfers = integer('maxTransfers', config.defaultMaxTransfers, 0, config.maxMaxTransfers);
  const windowMinutes = integer('windowMinutes', config.defaultWindowMinutes, 0, config.maxWindowMinutes);

  if (errors.length > 0) return { ok: false, errors };
  return {
    ok: true,
    value: { fromLat, fromLng, toLat, toLng, date, time, timeSeconds: parseClockTime(time), maxTransfers, windowMinutes }
  };
}

// Bus identification helpers. A SERVICE number (from the timetable) is not a VEHICLE registration number.
// A registration is shown only when the backend supplied one from a trustworthy source; it is never derived.
import type { TransitLeg } from '../services/planService';
import type { ApsrtcTracker } from '../config/apsrtcTrackers';


// The PUBLIC service number only. A route code is never promoted to a service number here (see routeLabelOf).
export function serviceNumberOf(leg: Pick<TransitLeg, 'serviceNumber'>): string | null {
  const value = leg.serviceNumber ?? null;
  return value && value.trim() !== '' ? value.trim() : null;
}

// What to call a leg's identifier when there is no public service number: "Route 952054" (or a train / flight number).
export function routeLabelOf(leg: Partial<Pick<TransitLeg, 'serviceNumber' | 'routeCode' | 'routeShortName' | 'routeId' | 'trainNumber' | 'trainName' | 'flightNumber'>>): string | null {
  if (leg.trainNumber) return `Train ${leg.trainNumber}${leg.trainName ? ` ${leg.trainName}` : ''}`;
  if (leg.flightNumber) return `Flight ${leg.flightNumber}`;
  const code = leg.routeCode ?? leg.routeShortName ?? leg.routeId ?? null;
  return code ? `Route ${code}` : null;
}

export const OPERATOR_NOT_IDENTIFIED = 'Operator not identified';

// "APSRTC" / "Indian Railways" / "IndiGo", or the honest fallback. Never inferred from a code.
export function operatorLabelOf(leg: Pick<TransitLeg, 'operator' | 'operatorInfo'>): string {
  return leg.operatorInfo?.name ?? leg.operator ?? OPERATOR_NOT_IDENTIFIED;
}

export type VehicleFamily = 'bus' | 'train' | 'flight';
export function vehicleFamilyOf(leg: Pick<TransitLeg, 'mode'>): VehicleFamily {
  const mode = String(leg.mode ?? '').toLowerCase();
  if (/rail|train|subway|metro|tram|monorail|funicular/.test(mode)) return 'train';
  if (/air|flight|plane/.test(mode)) return 'flight';
  return 'bus';
}

// "APSRTC Bus", "Indian Railways Train", "IndiGo Flight", "Bus" (operator unknown).
export function vehicleTitleOf(leg: Pick<TransitLeg, 'mode' | 'operator' | 'operatorInfo'>): string {
  const family = vehicleFamilyOf(leg);
  const noun = family === 'bus' ? 'Bus' : family === 'train' ? 'Train' : 'Flight';
  const operator = leg.operatorInfo?.name ?? leg.operator ?? null;
  return operator ? `${operator} ${noun}` : noun;
}

export function vehicleNumberOf(leg: Pick<TransitLeg, 'vehicleNumber' | 'vehicleNumberSource'>): string | null {
  const value = leg.vehicleNumber?.trim();
  // A vehicle number without a named trustworthy source is not shown.
  return value && leg.vehicleNumberSource ? value : null;
}

export function operatorBusName(operator: string | null | undefined, count = 1): string {
  const name = operator ? `${operator} ` : '';
  if (count > 1) return `${count} ${name}buses`;
  return `${name}Bus`;
}

// What choosing a tracker does: the service number is copied first (the trackers have a field to paste it into) and the
// tracker's own page opens in a new tab. Only the service number is involved, and only on the clipboard: nothing is
// auto-submitted, no query parameter is added, and nothing else about the user is sent.
export interface TrackingPlan {
  url: string;
  copyFirst: boolean;
  copiedMessage: string | null;
  copyFailedMessage: string | null;
}

export function trackingPlan(tracker: ApsrtcTracker, serviceNumber: string | null): TrackingPlan {
  if (!serviceNumber || !tracker.supportsServiceNumber) return { url: tracker.url, copyFirst: false, copiedMessage: null, copyFailedMessage: null };
  return {
    url: tracker.url,
    copyFirst: true,
    copiedMessage: `Service ${serviceNumber} copied`,
    copyFailedMessage: `Service number: ${serviceNumber}`
  };
}

// Runs the copy half of a tracker click and returns the toast text (null when there is nothing to say).
export async function runTrackingClick(plan: TrackingPlan, serviceNumber: string | null, copy: (text: string) => Promise<boolean> = copyText): Promise<string | null> {
  if (!plan.copyFirst || !serviceNumber) return null;
  return (await copy(serviceNumber)) ? plan.copiedMessage : plan.copyFailedMessage;
}

// Copies text to the clipboard. Resolves false (never throws) when the browser refuses.
export async function copyText(
  text: string,
  env: { clipboard?: { writeText(value: string): Promise<void> } | null; fallback?: (value: string) => boolean } = {
    clipboard: typeof navigator !== 'undefined' ? navigator.clipboard : null,
    fallback: legacyCopy
  }
): Promise<boolean> {
  try {
    if (env.clipboard) {
      await env.clipboard.writeText(text);
      return true;
    }
  } catch {
    /* fall through to the legacy path */
  }
  try {
    return env.fallback ? env.fallback(text) : false;
  } catch {
    return false;
  }
}

function legacyCopy(text: string): boolean {
  if (typeof document === 'undefined') return false;
  const area = document.createElement('textarea');
  area.value = text;
  area.setAttribute('readonly', '');
  area.style.position = 'fixed';
  area.style.opacity = '0';
  document.body.appendChild(area);
  area.select();
  const ok = document.execCommand('copy');
  document.body.removeChild(area);
  return ok;
}

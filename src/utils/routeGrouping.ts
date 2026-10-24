// Route grouping logic: groups identical journeys that follow the same actual route,
// with the same ordered stops, boarding and dropping points, and travel modes into a single
// result card, displaying all available departure times inside that card.
import type { DepartureOption, Journey, Leg, PlaceRef, TransitLeg } from '../services/planService';
import { isLocalRideLeg, isTransitLeg, isWalkLeg } from '../services/planService';

export type { DepartureOption };

export interface GroupedRoute {
  id: string;
  signature: string;
  representativeJourney: Journey;
  departures: DepartureOption[];
  origin: string;
  destination: string;
  totalDistanceMeters: number;
  travelMode: 'bus' | 'train' | 'flight' | 'combined' | 'other';
  stopsSummary: string;
  transferSummary: string | null;
}

function normalize(text: string | null | undefined): string {
  if (!text) return '';
  return text.trim().toLowerCase().replace(/\s+/g, ' ');
}

function normalizePlace(place?: PlaceRef | null): string {
  if (!place) return '';
  if (place.stopId) return normalize(place.stopId);
  if (place.code) return normalize(place.code);
  if (place.name) return normalize(place.name);
  if (place.type) return normalize(place.type);
  return '';
}

function normalizeRouteId(leg: TransitLeg): string {
  const raw = leg.routeId || leg.routeCode || leg.serviceNumber || leg.trainNumber || leg.flightNumber || '';
  const cleaned = normalize(String(raw));
  // Strip leading zeros for numeric routes (e.g. "03846" and "3846" refer to the same route number)
  const withoutZeros = cleaned.replace(/^0+/, '');
  return withoutZeros || cleaned;
}

function normalizeOperator(leg: TransitLeg): string {
  const op = leg.operatorInfo?.name || leg.operator || '';
  return normalize(op);
}

function normalizeMode(mode: string): string {
  const m = normalize(mode);
  if (/rail|train|subway|metro|tram/.test(m)) return 'train';
  if (/air|flight/.test(m)) return 'flight';
  if (/bus/.test(m)) return 'bus';
  return m;
}

/**
 * Computes a deterministic route signature for a journey.
 * Two journeys have the same signature IF AND ONLY IF they follow the exact same route:
 * - Same ordered sequence of legs
 * - Same travel modes
 * - Same boarding and alighting stops
 * - Same ordered intermediate stops
 * - Same route identifier and operator
 * Different departure times do NOT change the signature.
 */
export function computeRouteSignature(journey: Journey): string {
  if (!journey || !Array.isArray(journey.legs) || journey.legs.length === 0) {
    return journey?.id || 'empty_journey';
  }

  const parts = journey.legs.map((leg: Leg) => {
    if (isWalkLeg(leg)) {
      const from = normalizePlace(leg.from);
      const to = normalizePlace(leg.to);
      return `walk:${leg.kind}:${from}->${to}`;
    }

    if (isLocalRideLeg(leg)) {
      const from = normalizePlace(leg.from);
      const to = normalizePlace(leg.to);
      return `ride:${leg.kind}:${from}->${to}`;
    }

    if (isTransitLeg(leg)) {
      const mode = normalizeMode(leg.mode);
      const routeId = normalizeRouteId(leg);
      const fromStop = normalizePlace(leg.fromStop);
      const toStop = normalizePlace(leg.toStop);
      const operator = normalizeOperator(leg);

      let stopsPart = '';
      if (Array.isArray(leg.intermediateStops) && leg.intermediateStops.length > 0) {
        stopsPart = leg.intermediateStops.map(s => normalize(s)).join('>');
      } else {
        stopsPart = `count:${leg.intermediateStopCount ?? 0}`;
      }

      return `${mode}:${routeId}:${fromStop}->${toStop}:stops[${stopsPart}]:op[${operator}]`;
    }

    return 'unknown_leg';
  });

  return parts.join('||');
}

export function isSameRoute(a: Journey, b: Journey): boolean {
  return computeRouteSignature(a) === computeRouteSignature(b);
}

export function getRouteDistanceMeters(journey: Journey): number {
  if (!journey || !Array.isArray(journey.legs)) return 0;
  const legsDist = journey.legs.reduce((sum, leg) => sum + (leg.distanceMeters ?? 0), 0);
  return Math.round(legsDist);
}

export function getRouteTravelMode(journey: Journey): 'bus' | 'train' | 'flight' | 'combined' | 'other' {
  if (!journey || !Array.isArray(journey.legs)) return 'other';
  const transitLegs = journey.legs.filter(isTransitLeg);
  if (transitLegs.length === 0) return 'other';
  const modes = new Set(transitLegs.map(l => normalizeMode(l.mode)));
  if (modes.size === 1) {
    const only = [...modes][0];
    if (only === 'bus') return 'bus';
    if (only === 'train') return 'train';
    if (only === 'flight') return 'flight';
  }
  if (modes.has('bus') && modes.has('train')) return 'combined';
  return 'combined';
}

export function getRouteCorridor(journey: Journey, fallbackFrom = '', fallbackTo = ''): { from: string; to: string } {
  if (!journey || !Array.isArray(journey.legs) || journey.legs.length === 0) {
    return { from: fallbackFrom, to: fallbackTo };
  }
  const first = journey.legs[0];
  const last = journey.legs.at(-1)!;
  const fromName = (isTransitLeg(first) ? first.fromStop?.name : first.from?.name) || fallbackFrom;
  const toName = (isTransitLeg(last) ? last.toStop?.name : last.to?.name) || fallbackTo;
  return { from: fromName, to: toName };
}

export function getRouteStopsSummary(journey: Journey): string {
  if (!journey || !Array.isArray(journey.legs)) return '';
  const transitLegs = journey.legs.filter(isTransitLeg);
  if (transitLegs.length === 0) return 'Direct route';

  if (transitLegs.length === 1) {
    const leg = transitLegs[0];
    if (Array.isArray(leg.intermediateStops) && leg.intermediateStops.length > 0) {
      const names = leg.intermediateStops;
      return `Direct · ${names.length} stop${names.length === 1 ? '' : 's'}`;
    }
    if (leg.intermediateStopCount && leg.intermediateStopCount > 0) {
      return `Direct · ${leg.intermediateStopCount} stop${leg.intermediateStopCount === 1 ? '' : 's'}`;
    }
    return 'Direct · Non-stop';
  }

  // Multimodal / Transfer route
  const transferStops: string[] = [];
  for (let i = 0; i < transitLegs.length - 1; i++) {
    const current = transitLegs[i];
    const next = transitLegs[i + 1];
    const changeAt = current.toStop?.name || next.fromStop?.name || 'transfer';
    transferStops.push(changeAt);
  }

  return `Change at ${transferStops.join(', ')}`;
}

export function getTransferSummary(journey: Journey): string | null {
  if (!journey || journey.transfers === 0) return null;
  const transitLegs = journey.legs.filter(isTransitLeg);
  if (transitLegs.length <= 1) return null;

  const transfers: string[] = [];
  for (let i = 0; i < transitLegs.length - 1; i++) {
    const fromLeg = transitLegs[i];
    const toLeg = transitLegs[i + 1];
    const place = fromLeg.toStop?.name || toLeg.fromStop?.name || 'Transfer point';
    transfers.push(place);
  }

  return `Transfer at ${transfers.join(', ')}`;
}

/**
 * Groups an array of journeys by their actual route into single GroupedRoute items.
 * Preserves all valid departure times in chronological order inside each group.
 */
export function groupJourneysByRoute(journeys: Journey[], defaultFrom = '', defaultTo = ''): GroupedRoute[] {
  if (!Array.isArray(journeys) || journeys.length === 0) return [];

  const groupsMap = new Map<string, GroupedRoute>();

  for (const journey of journeys) {
    const signature = computeRouteSignature(journey);

    // Extract all departures this journey knows about (itself + any pre-attached options)
    const options: DepartureOption[] = [];
    if (Array.isArray(journey.departureOptions) && journey.departureOptions.length > 0) {
      for (const opt of journey.departureOptions) {
        options.push({
          tripId: opt.tripId,
          departureTime: opt.departureTime,
          arrivalTime: opt.arrivalTime,
          durationSeconds: opt.durationSeconds,
          journey: opt.journey || journey
        });
      }
    }
    // Always include this journey itself
    const mainTripId = journey.legs.find(isTransitLeg)?.tripId || journey.id;
    options.push({
      tripId: mainTripId,
      departureTime: journey.departureTime,
      arrivalTime: journey.arrivalTime,
      durationSeconds: journey.totalDurationSeconds,
      journey
    });

    if (!groupsMap.has(signature)) {
      const corridor = getRouteCorridor(journey, defaultFrom, defaultTo);
      groupsMap.set(signature, {
        id: `route_${journey.id}`,
        signature,
        representativeJourney: journey,
        departures: [...options],
        origin: corridor.from,
        destination: corridor.to,
        totalDistanceMeters: getRouteDistanceMeters(journey),
        travelMode: getRouteTravelMode(journey),
        stopsSummary: getRouteStopsSummary(journey),
        transferSummary: getTransferSummary(journey)
      });
    } else {
      const existing = groupsMap.get(signature)!;
      // Add all new departures
      existing.departures.push(...options);

      // Merge labels from this journey into representative if not already present
      for (const label of journey.labels || []) {
        if (!existing.representativeJourney.labels.includes(label)) {
          existing.representativeJourney.labels.push(label);
        }
      }

      // If this journey has a higher rating score, prefer it as representative
      const currentScore = existing.representativeJourney.rating?.raw ?? existing.representativeJourney.rating?.score ?? -1;
      const candidateScore = journey.rating?.raw ?? journey.rating?.score ?? -1;
      if (candidateScore > currentScore) {
        existing.representativeJourney = journey;
      }
    }
  }

  // Deduplicate and sort departures chronologically inside each group
  const groupedList = Array.from(groupsMap.values());
  for (const group of groupedList) {
    const seenTimes = new Set<string>();
    const uniqueDepartures: DepartureOption[] = [];

    for (const dep of group.departures) {
      const key = `${dep.departureTime}@${dep.tripId}`;
      if (!seenTimes.has(key)) {
        seenTimes.add(key);
        uniqueDepartures.push(dep);
      }
    }

    // Sort in ascending chronological order
    uniqueDepartures.sort((a, b) => {
      const timeDiff = new Date(a.departureTime).getTime() - new Date(b.departureTime).getTime();
      if (timeDiff !== 0) return timeDiff;
      return a.departureTime.localeCompare(b.departureTime);
    });

    group.departures = uniqueDepartures;
    // Attach departures onto representative journey without circular references
    group.representativeJourney.departureOptions = uniqueDepartures.map(d => ({
      tripId: d.tripId,
      departureTime: d.departureTime,
      arrivalTime: d.arrivalTime,
      durationSeconds: d.durationSeconds
    }));
  }

  return groupedList;
}

// The journey simulation model: the journey's own legs turned into nodes and segments for a stylised route strip.
// Nothing is added: one segment per real leg (trivial walks of a few seconds are left out, as in the card), and every
// node is a real place from the data. No coordinates or map geometry are used or invented.
import type { Journey, Leg } from '../services/planService';
import { isLocalRideLeg, isTransitLeg, isWalkLeg } from '../services/planService';
import { formatDuration } from './dateTime';
import { serviceNumberOf } from './busIdentity';

export type SimMode = 'walk' | 'local_ride' | 'bike' | 'bus' | 'train' | 'flight' | 'ferry';

export interface SimNode {
  name: string;
  kind: 'origin' | 'transfer' | 'change' | 'destination';
  time: string | null; // ISO time at this node (departure for the origin, arrival otherwise)
  waitSeconds: number; // time spent at this node before the next leg leaves (0 for the origin and destination)
}

export interface SimSegment {
  mode: SimMode;
  modeName: string;   // "APSRTC bus", "Local ride", "Train", ...
  shortName: string;  // "Bus", "Local ride", "Train", ...: the word shown under the segment's time
  label: string;      // accessible sentence for the segment
  durationSeconds: number;
  durationText: string;
}

export interface Simulation {
  nodes: SimNode[];        // segments.length + 1
  segments: SimSegment[];
  summary: string;         // one sentence for screen readers
}

const TRIVIAL_WALK_SECONDS = 30;

// Coarse transit mode from the leg's mode string (GTFS route_type is already mapped to words by the importer).
export function simulationModeOf(leg: Leg): SimMode {
  if (isWalkLeg(leg)) return 'walk';
  if (isLocalRideLeg(leg)) {
    const vehicle = String((leg as { vehicleType?: string }).vehicleType ?? '').toLowerCase();
    return /bike|scooter|motorcycle|two.?wheeler/.test(vehicle) ? 'bike' : 'local_ride';
  }
  const mode = String(leg.mode ?? '').toLowerCase();
  if (/rail|train|subway|metro|tram|monorail|funicular/.test(mode)) return 'train';
  if (/air|flight|plane/.test(mode)) return 'flight';
  if (/ferry|boat/.test(mode)) return 'ferry';
  return 'bus';
}

const MODE_NAME: Record<SimMode, string> = {
  walk: 'Walk', local_ride: 'Local ride', bike: 'Bike ride', bus: 'Bus', train: 'Train', flight: 'Flight', ferry: 'Ferry'
};

function endpoints(leg: Leg): { from: string; to: string; dep: string; arr: string } {
  if (isTransitLeg(leg)) return { from: leg.fromStop.name, to: leg.toStop.name, dep: leg.departureTime, arr: leg.arrivalTime };
  return { from: leg.from.name, to: leg.to.name, dep: leg.departureTime, arr: leg.arrivalTime };
}

function modeName(leg: Leg, mode: SimMode): string {
  if (isTransitLeg(leg) && mode === 'bus') return leg.operator ? `${leg.operator} bus` : 'Bus';
  if (isTransitLeg(leg) && leg.operator && mode !== 'bus') return `${leg.operator} ${MODE_NAME[mode].toLowerCase()}`;
  return MODE_NAME[mode];
}

export function buildSimulation(journey: Pick<Journey, 'legs'>): Simulation {
  const legs = journey.legs.filter(leg => !(isWalkLeg(leg) && leg.durationSeconds < TRIVIAL_WALK_SECONDS));
  const segments: SimSegment[] = [];
  const nodes: SimNode[] = [];

  legs.forEach((leg, i) => {
    const mode = simulationModeOf(leg);
    const { from, to, dep, arr } = endpoints(leg);
    if (i === 0) nodes.push({ name: from, kind: 'origin', time: dep, waitSeconds: 0 });
    // Waiting at the node before this leg: the gap between arriving there and this leg leaving (never negative).
    else nodes[i].waitSeconds = Math.max(0, Math.round((Date.parse(dep) - Date.parse(nodes[i].time ?? dep)) / 1000)) || 0;
    const service = isTransitLeg(leg) ? (serviceNumberOf(leg) ?? leg.trainNumber ?? leg.flightNumber ?? null) : null;
    const name = modeName(leg, mode);
    const durationText = formatDuration(leg.durationSeconds);
    segments.push({
      mode,
      modeName: name,
      shortName: MODE_NAME[mode],
      label: `${name}${service ? ` ${service}` : ''} from ${from} to ${to}, ${durationText}${isLocalRideLeg(leg) || isWalkLeg(leg) ? ' (estimated)' : ''}`,
      durationSeconds: leg.durationSeconds,
      durationText
    });
    nodes.push({ name: to, kind: 'destination', time: arr, waitSeconds: 0 });
  });

  // Inner nodes: a transfer between two transit legs, otherwise a change of mode (e.g. local ride -> bus at a stop).
  for (let i = 1; i < nodes.length - 1; i++) {
    const before = segments[i - 1].mode;
    const after = segments[i].mode;
    const transit = (m: SimMode) => m === 'bus' || m === 'train' || m === 'flight' || m === 'ferry';
    nodes[i].kind = transit(before) && transit(after) ? 'transfer' : 'change';
  }

  const summary = segments.length
    ? `Route: ${nodes[0].name}, ${segments.map((s, i) => `${s.modeName.toLowerCase()} to ${nodes[i + 1].name}`).join(', then ')}.`
    : 'Route not available.';
  return { nodes, segments, summary };
}

// Visual weight of a segment: longer legs get more room, but square-root scaled so short feeders stay readable.
export function segmentWeight(durationSeconds: number): number {
  return Math.max(1, Math.sqrt(Math.max(0, durationSeconds) / 60));
}

// "KUNCHANAPALLI CROSS ROAD NEAR APSDMA" -> "Kunchanapalli Cross…": readable, short labels; the full name stays in a title.
export function shortPlaceName(name: string, max = 14): string {
  const pretty = name === name.toUpperCase() ? name.toLowerCase().replace(/\b([a-z])/g, c => c.toUpperCase()) : name;
  return pretty.length <= max ? pretty : `${pretty.slice(0, max - 1).trimEnd()}…`;
}

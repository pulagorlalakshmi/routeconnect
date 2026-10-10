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

// ---------------------------------------------------------------------------------------------------------------------
// One timeline for the whole journey. The strip is driven by a SINGLE normalized progress value p in [0, 1): the loop.
// Everything that moves (the vehicle chip, its icon and colour, the "completed" part of the line) is derived from p, so
// nothing is animated per leg and nothing can restart in the middle of a journey. This is a stylised timeline, not a GPS
// replay: leg durations only decide how long the vehicle spends on each leg.
// ---------------------------------------------------------------------------------------------------------------------

export const LOOP_MS = 10000;          // one full journey, whatever its real length (a 6 h trip does not take 6 h)
const START_HOLD_MS = 400;             // vehicle fades in at the origin
const END_HOLD_MS = 1100;              // rests at the destination, fades out, then the loop restarts
const PAUSE_BASE_MS = 600;             // a pause at every transfer / change of mode
const PAUSE_EXTRA_MS = 400;            // up to this much more when the real wait is a large share of the journey
const MIN_TRAVEL_SHARE = 0.1;          // a very short leg still gets at least this share of the travelling time

export type PhaseKind = 'hold-start' | 'travel' | 'pause' | 'hold-end';

export interface TimelinePhase {
  kind: PhaseKind;
  segment: number;   // the leg being travelled; for a pause, the leg that is about to start
  from: number;      // start of the phase, as a fraction of the loop
  to: number;        // end of the phase, as a fraction of the loop
  startPos: number;  // position along the line (0..1) at the start of the phase
  endPos: number;    // ... and at its end (equal for holds and pauses)
}

export interface Timeline {
  loopMs: number;
  phases: TimelinePhase[];
  nodePositions: number[]; // position of every node along the line, 0..1 (segments.length + 1 values)
}

export interface TimelineState {
  progress: number;        // normalized loop progress that produced this state
  phase: PhaseKind;
  segment: number;         // leg whose vehicle is shown: switches to the next leg at the START of a transfer pause
  mode: SimMode;
  position: number;        // 0..1 along the connected line
  opacity: number;         // vehicle (and completed part of the line) fades in at the start and out at the end
}

// Width of each leg on the line: half equal share, half square-root of its duration, so short feeder legs stay readable
// and long legs still look longer. (The loop time is proportional to the real duration; this is only layout.)
export function layoutFractions(segments: Pick<SimSegment, 'durationSeconds'>[]): number[] {
  const n = segments.length;
  if (n === 0) return [];
  const roots = segments.map(s => segmentWeight(s.durationSeconds));
  const total = roots.reduce((a, b) => a + b, 0) || 1;
  return roots.map(r => 0.5 / n + 0.5 * (r / total));
}

export function nodePositionsOf(segments: Pick<SimSegment, 'durationSeconds'>[]): number[] {
  const positions = [0];
  for (const fraction of layoutFractions(segments)) positions.push(Math.min(1, positions[positions.length - 1] + fraction));
  if (positions.length > 1) positions[positions.length - 1] = 1;
  return positions;
}

export function buildTimeline(sim: Pick<Simulation, 'segments' | 'nodes'>, loopMs = LOOP_MS): Timeline {
  const { segments, nodes } = sim;
  const n = segments.length;
  const nodePositions = nodePositionsOf(segments);
  if (n === 0) return { loopMs, phases: [], nodePositions };

  const totalSeconds = segments.reduce((sum, s) => sum + Math.max(0, s.durationSeconds), 0) || 1;
  // Pauses sit at the inner nodes; a longer real wait gives a (slightly) longer pause, never a long idle gap.
  const pauseMs = Array.from({ length: Math.max(0, n - 1) }, (_, k) =>
    PAUSE_BASE_MS + PAUSE_EXTRA_MS * Math.min(1, Math.max(0, nodes[k + 1]?.waitSeconds ?? 0) / totalSeconds));
  const travelBudget = Math.max(0, loopMs - START_HOLD_MS - END_HOLD_MS - pauseMs.reduce((a, b) => a + b, 0));
  const rawShares = segments.map(s => Math.max(Math.max(0, s.durationSeconds) / totalSeconds, MIN_TRAVEL_SHARE));
  const shareTotal = rawShares.reduce((a, b) => a + b, 0);
  const travelMs = rawShares.map(share => (share / shareTotal) * travelBudget);

  const phases: TimelinePhase[] = [];
  let cursor = 0;
  const push = (kind: PhaseKind, segment: number, ms: number, startPos: number, endPos: number) => {
    const from = cursor / loopMs;
    cursor += ms;
    phases.push({ kind, segment, from, to: Math.min(1, cursor / loopMs), startPos, endPos });
  };
  push('hold-start', 0, START_HOLD_MS, 0, 0);
  for (let i = 0; i < n; i++) {
    push('travel', i, travelMs[i], nodePositions[i], nodePositions[i + 1]);
    if (i < n - 1) push('pause', i + 1, pauseMs[i], nodePositions[i + 1], nodePositions[i + 1]);
  }
  push('hold-end', n - 1, END_HOLD_MS, 1, 1);
  phases[phases.length - 1].to = 1; // absorb floating point drift: the loop ends exactly at 1
  return { loopMs, phases, nodePositions };
}

// Slow in, slow out: the vehicle decelerates into every stop and accelerates away from it.
export const easeInOut = (t: number) => { const x = Math.min(1, Math.max(0, t)); return x * x * (3 - 2 * x); };

export function stateAt(timeline: Timeline, segments: Pick<SimSegment, 'mode'>[], progress: number): TimelineState {
  if (timeline.phases.length === 0 || segments.length === 0) {
    return { progress: 0, phase: 'hold-start', segment: 0, mode: 'bus', position: 0, opacity: 1 };
  }
  const p = ((progress % 1) + 1) % 1;
  const phase = timeline.phases.find(candidate => p >= candidate.from && p < candidate.to) ?? timeline.phases[timeline.phases.length - 1];
  const local = phase.to > phase.from ? (p - phase.from) / (phase.to - phase.from) : 1;
  const position = phase.kind === 'travel' ? phase.startPos + (phase.endPos - phase.startPos) * easeInOut(local) : phase.startPos;
  let opacity = 1;
  if (phase.kind === 'hold-start') opacity = easeInOut(local / 0.6);
  if (phase.kind === 'hold-end') opacity = 1 - easeInOut((local - 0.6) / 0.4);
  const segment = Math.min(segments.length - 1, phase.segment);
  return { progress: p, phase: phase.kind, segment, mode: segments[segment].mode, position, opacity };
}

// The only thing that advances time: a requestAnimationFrame loop with injectable scheduling, so it can be tested without
// a browser. Elapsed time is accumulated (a hidden tab or a long frame never makes the vehicle jump), and stop() hands
// the elapsed time back so a card that scrolls out of view resumes where it left off instead of restarting.
export interface LoopDriver { start(): void; stop(): number; elapsed(): number }
export function createLoopDriver(options: {
  loopMs: number;
  onFrame: (progress: number) => void;
  raf: (callback: (time: number) => void) => number;
  caf: (handle: number) => void;
  startElapsedMs?: number;
}): LoopDriver {
  const MAX_STEP_MS = 100;
  let elapsed = options.startElapsedMs ?? 0;
  let last: number | null = null;
  let handle: number | null = null;
  const tick = (time: number) => {
    if (last !== null) elapsed += Math.min(Math.max(0, time - last), MAX_STEP_MS);
    last = time;
    options.onFrame((elapsed % options.loopMs) / options.loopMs);
    handle = options.raf(tick);
  };
  return {
    start() { if (handle === null) { last = null; handle = options.raf(tick); } },
    stop() { if (handle !== null) options.caf(handle); handle = null; return elapsed; },
    elapsed: () => elapsed
  };
}

// A strip wider than its card scrolls sideways. In motion the strip follows the vehicle like a camera: the target keeps
// the vehicle centred (clamped to the ends, so the first and last stretch do not pan), and the real scroll position eases
// towards it, so it can never jump (not even when the loop restarts and the target swings back to the start).
export function cameraTarget(geometry: { originX: number; trackWidth: number; viewWidth: number; maxScroll: number }, position: number): number {
  const vehicleX = geometry.originX + position * geometry.trackWidth;
  return Math.min(Math.max(0, geometry.maxScroll), Math.max(0, vehicleX - geometry.viewWidth / 2));
}

export function easeCamera(current: number, target: number, dtMs: number, timeConstantMs = 160): number {
  return current + (target - current) * (1 - Math.exp(-Math.max(0, dtMs) / timeConstantMs));
}

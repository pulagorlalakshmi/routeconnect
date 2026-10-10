import { useEffect, useMemo, useRef, useState } from 'react';

import { Bike, Bus, CarTaxiFront, Footprints, Plane, Ship, TrainFront } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import type { Journey } from '../services/planService';
import { buildSimulation, buildTimeline, cameraTarget, createLoopDriver, easeCamera, LOOP_MS, shortPlaceName, stateAt } from '../utils/journeySimulation';
import type { SimMode, SimNode, SimSegment, Timeline } from '../utils/journeySimulation';
import { prefersReducedMotion } from '../utils/trackingLaunch';
import { clockOf, formatDuration } from '../utils/dateTime';

// The journey strip: the visual centrepiece of a card, built from the journey's real legs. One connected line runs from
// the origin to the destination; each leg has its time and mode written above it and each transfer shows its wait.
//
// Motion is ONE vehicle driven by ONE progress value (see buildTimeline/stateAt in utils/journeySimulation): the vehicle
// glides along the whole line, eases into each stop, pauses there while its icon and colour cross-fade into the next
// mode, and carries on from exactly the same spot. The part already travelled is highlighted by clipping one full-colour
// copy of the line; nothing is animated per leg and nothing restarts until the destination has been reached.
//
// A strip wider than its card (many legs, or a phone) scrolls sideways; in motion it follows the vehicle with an eased
// camera so the vehicle is never out of view, and it leaves the scrolling alone for a few seconds after the user touches it.
//
// It is a stylised timeline, not a map: no geometry is drawn and loop time is not real time.
//
// Lightweight by design: a single requestAnimationFrame loop per VISIBLE card that writes three inline styles (no React
// re-render per frame), paused while the card is off-screen, and no motion at all under prefers-reduced-motion, where the
// static diagram (mode chips on each leg) is shown instead.

// Waits shorter than this are noise in the strip (a stop-to-stop change that is effectively immediate).
const MIN_WAIT_SHOWN_SECONDS = 60;
const MIN_SEGMENT_PX = 168;
// After the user scrolls the strip themselves, the camera stays out of the way for this long.
const USER_SCROLL_GRACE_MS = 4000;

const MODE_STYLE: Record<SimMode, { Icon: LucideIcon; hex: string; chip: { bg: string; fg: string; border: string }; chipClass: string }> = {
  walk: { Icon: Footprints, hex: '#98A2B3', chip: { bg: '#FFFFFF', fg: '#475467', border: '#D0D5DD' }, chipClass: 'bg-white text-[#475467] border-[#D0D5DD]' },
  local_ride: { Icon: CarTaxiFront, hex: '#E5A93D', chip: { bg: '#FFF7E8', fg: '#8A5D0C', border: '#E9C27A' }, chipClass: 'bg-[#FFF7E8] text-[#8A5D0C] border-[#E9C27A]' },
  bike: { Icon: Bike, hex: '#E5A93D', chip: { bg: '#FFF7E8', fg: '#8A5D0C', border: '#E9C27A' }, chipClass: 'bg-[#FFF7E8] text-[#8A5D0C] border-[#E9C27A]' },
  bus: { Icon: Bus, hex: '#146B5B', chip: { bg: '#146B5B', fg: '#FFFFFF', border: '#146B5B' }, chipClass: 'bg-[#146B5B] text-white border-[#146B5B]' },
  train: { Icon: TrainFront, hex: '#2F5D8C', chip: { bg: '#2F5D8C', fg: '#FFFFFF', border: '#2F5D8C' }, chipClass: 'bg-[#2F5D8C] text-white border-[#2F5D8C]' },
  flight: { Icon: Plane, hex: '#5B5F97', chip: { bg: '#5B5F97', fg: '#FFFFFF', border: '#5B5F97' }, chipClass: 'bg-[#5B5F97] text-white border-[#5B5F97]' },
  ferry: { Icon: Ship, hex: '#2B7A9B', chip: { bg: '#2B7A9B', fg: '#FFFFFF', border: '#2B7A9B' }, chipClass: 'bg-[#2B7A9B] text-white border-[#2B7A9B]' }
};

export function modeIconName(mode: SimMode): string {
  return { walk: 'footprints', local_ride: 'car-taxi-front', bike: 'bike', bus: 'bus', train: 'train-front', flight: 'plane', ferry: 'ship' }[mode];
}

const pct = (fraction: number) => `${(fraction * 100).toFixed(3)}%`;

// One gradient for the whole line: each leg its own colour, blended over a short stretch at every boundary, so the line is
// a single connected bar (no gaps, no steps in height) whose colour changes smoothly with the mode.
export function lineGradient(segments: Pick<SimSegment, 'mode'>[], positions: number[]): string {
  if (segments.length === 0) return 'none';
  const stops: string[] = [];
  segments.forEach((segment, i) => {
    const color = MODE_STYLE[segment.mode].hex;
    const width = positions[i + 1] - positions[i];
    const blend = Math.min(0.02, width * 0.25);
    const from = i === 0 ? positions[i] : positions[i] + blend;
    const to = i === segments.length - 1 ? positions[i + 1] : positions[i + 1] - blend;
    stops.push(`${color} ${pct(from)}`, `${color} ${pct(to)}`);
  });
  return `linear-gradient(90deg, ${stops.join(', ')})`;
}

// The vehicle chip's colours follow the leg it is on; its icon cross-fades (CSS transitions, started by changing
// data attributes: no second vehicle is ever drawn).
function setVehicleMode(runner: HTMLElement, mode: SimMode) {
  const { chip } = MODE_STYLE[mode];
  runner.dataset.mode = mode;
  runner.style.backgroundColor = chip.bg;
  runner.style.borderColor = chip.border;
  runner.style.color = chip.fg;
  runner.querySelectorAll<HTMLElement>('[data-vehicle]').forEach(icon => {
    icon.dataset.active = String(icon.dataset.vehicle === mode);
  });
}

export default function JourneySimulation({ journey, detailed = false, animate, progress: fixedProgress }: {
  journey: Pick<Journey, 'legs'>;
  detailed?: boolean;
  // Test/preview override; normally decided from prefers-reduced-motion and visibility. `false` always gives the static diagram.
  animate?: boolean;
  // Render the moving layout frozen at this loop progress (0..1): used for previews and tests; starts no timers.
  progress?: number;
}) {
  const sim = useMemo(() => buildSimulation(journey), [journey]);
  const timeline: Timeline = useMemo(() => buildTimeline(sim), [sim]);
  const root = useRef<HTMLDivElement | null>(null);
  const runner = useRef<HTMLSpanElement | null>(null);
  const completed = useRef<HTMLSpanElement | null>(null);
  const elapsedMs = useRef(0);
  const [visible, setVisible] = useState(false);

  const frozen = fixedProgress !== undefined;
  const moving = frozen || visible;

  // Motion only when allowed and on screen.
  useEffect(() => {
    if (frozen || animate === false || sim.segments.length === 0) return;
    if (animate !== true && prefersReducedMotion()) return;
    const element = root.current;
    if (!element || typeof IntersectionObserver === 'undefined') { setVisible(true); return; }
    const observer = new IntersectionObserver(([entry]) => setVisible(entry.isIntersecting), { threshold: 0.2 });
    observer.observe(element);
    return () => observer.disconnect();
  }, [animate, frozen, sim.segments.length]);

  // The single loop. Everything on screen is derived from the one progress value it produces; leaving the screen (or
  // unmounting) cancels the frame request and remembers the elapsed time so the card resumes instead of restarting.
  useEffect(() => {
    if (frozen || !visible) return;
    const container = root.current;
    const camera = { x: null as number | null, last: 0, userUntil: 0, originX: 0, trackWidth: 0, viewWidth: 0, maxScroll: 0 };
    const measure = () => {
      const track = container?.firstElementChild?.firstElementChild as HTMLElement | null | undefined;
      if (!container || !track) return;
      camera.originX = track.getBoundingClientRect().left - container.getBoundingClientRect().left + container.scrollLeft;
      camera.trackWidth = track.offsetWidth;
      camera.viewWidth = container.clientWidth;
      camera.maxScroll = container.scrollWidth - container.clientWidth;
    };
    const userTouched = () => { camera.userUntil = performance.now() + USER_SCROLL_GRACE_MS; camera.x = null; };
    const userEvents = ['wheel', 'touchstart', 'pointerdown', 'keydown'] as const;
    measure();
    window.addEventListener('resize', measure);
    userEvents.forEach(name => container?.addEventListener(name, userTouched, { passive: true }));

    const apply = (progress: number) => {
      const state = stateAt(timeline, sim.segments, progress);
      const vehicle = runner.current;
      const done = completed.current;
      if (vehicle) {
        vehicle.style.left = pct(state.position);
        vehicle.style.opacity = String(state.opacity);
        if (vehicle.dataset.mode !== state.mode) setVehicleMode(vehicle, state.mode);
      }
      if (done) {
        done.style.clipPath = `inset(0 ${pct(1 - state.position)} 0 0)`;
        done.style.opacity = String(state.opacity);
      }
      // Camera: follow the vehicle when the strip scrolls and the user is not driving it.
      if (container && camera.maxScroll > 1) {
        const now = performance.now();
        if (now >= camera.userUntil) {
          if (camera.x === null) { camera.x = container.scrollLeft; camera.last = now; }
          camera.x = easeCamera(camera.x, cameraTarget(camera, state.position), Math.min(64, now - camera.last));
          camera.last = now;
          container.scrollLeft = camera.x;
        }
      }
    };
    const driver = createLoopDriver({
      loopMs: timeline.loopMs,
      startElapsedMs: elapsedMs.current,
      onFrame: apply,
      raf: callback => requestAnimationFrame(callback),
      caf: handle => cancelAnimationFrame(handle)
    });
    driver.start();
    return () => {
      elapsedMs.current = driver.stop();
      window.removeEventListener('resize', measure);
      userEvents.forEach(name => container?.removeEventListener(name, userTouched));
    };
  }, [frozen, visible, timeline, sim.segments]);

  // Where the vehicle starts when the moving layout is first drawn (the frozen preview, or resuming after being off-screen).
  const initial = useMemo(
    () => stateAt(timeline, sim.segments, fixedProgress ?? (elapsedMs.current % LOOP_MS) / LOOP_MS),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [timeline, sim.segments, frozen, fixedProgress, moving]
  );

  if (sim.segments.length === 0) return null;
  const positions = timeline.nodePositions;
  const last = sim.nodes.length - 1;
  const gradient = lineGradient(sim.segments, positions);
  const vehicleModes = [...new Set(sim.segments.map(segment => segment.mode))];
  const minWidth = sim.segments.length * MIN_SEGMENT_PX + 32;

  return (
    <div
      ref={root}
      role="group"
      aria-label={sim.summary}
      data-motion={moving ? 'on' : 'off'}
      className={`rc-sim ${moving ? '' : 'rc-sim-static'} -mx-1 overflow-x-auto overflow-y-hidden px-1`}
    >
      <div className="relative px-4" style={{ minWidth }}>
        <div className={`relative ${detailed ? 'h-[184px]' : 'h-[154px]'}`}>
          {/* The connected line: a subtle copy for the road ahead, and a full-colour copy that is revealed as the vehicle
              advances (always fully shown in the static diagram). Same box, so they can never drift apart. */}
          <span aria-hidden className={`absolute inset-x-0 top-[64px] h-[6px] -translate-y-1/2 rounded-full ${moving ? 'opacity-30' : 'opacity-0'}`} style={{ background: gradient }} />
          <span
            ref={completed}
            aria-hidden
            data-line="completed"
            className="absolute inset-x-0 top-[64px] h-[6px] -translate-y-1/2 rounded-full"
            style={{ background: gradient, ...(moving ? { clipPath: `inset(0 ${pct(1 - initial.position)} 0 0)`, opacity: initial.opacity } : {}) }}
          />

          {sim.segments.map((segment, i) => {
            const { Icon, hex, chipClass } = MODE_STYLE[segment.mode];
            return (
              <div key={i} className="contents">
                <Node node={sim.nodes[i]} left={positions[i]} align={i === 0 ? 'start' : 'center'} detailed={detailed} />
                {/* What this leg is, at a glance: its time, then its mode. */}
                <div
                  aria-label={segment.label}
                  role="img"
                  data-segment={segment.mode}
                  className="absolute top-0 flex h-10 flex-col items-center justify-end leading-tight"
                  style={{ left: pct(positions[i]), width: pct(positions[i + 1] - positions[i]) }}
                >
                  <span aria-hidden className="text-sm font-black tabular-nums text-[#1F2933]">{segment.durationText}</span>
                  <span aria-hidden className="flex items-center gap-1 text-[11px] font-semibold text-[#667085]">
                    {moving && <Icon className="h-3 w-3" strokeWidth={2.4} style={{ color: hex }} />}
                    {segment.shortName}
                  </span>
                </div>
                {/* Static diagram only: with the vehicle in motion the leg icons are the labels' small icons. */}
                {!moving && (
                  <span
                    data-mode={segment.mode}
                    data-icon={modeIconName(segment.mode)}
                    className={`absolute top-[64px] z-10 flex h-10 w-10 -translate-x-1/2 -translate-y-1/2 items-center justify-center rounded-full border-2 shadow-sm ${chipClass}`}
                    style={{ left: pct((positions[i] + positions[i + 1]) / 2) }}
                  >
                    <Icon aria-hidden className="h-5 w-5" strokeWidth={2.2} />
                  </span>
                )}
              </div>
            );
          })}
          <Node node={sim.nodes[last]} left={positions[last]} align="end" detailed={detailed} />

          {/* The one vehicle. Its icons are stacked and cross-faded; only one is visible at a time. */}
          {moving && (
            <span
              ref={runner}
              aria-hidden
              data-runner
              data-mode={initial.mode}
              className="rc-sim-runner pointer-events-none absolute top-[64px] z-20 flex h-10 w-10 -translate-x-1/2 -translate-y-1/2 items-center justify-center rounded-full border-2 shadow-sm [contain:layout]"
              style={{
                left: pct(initial.position),
                opacity: initial.opacity,
                backgroundColor: MODE_STYLE[initial.mode].chip.bg,
                borderColor: MODE_STYLE[initial.mode].chip.border,
                color: MODE_STYLE[initial.mode].chip.fg
              }}
            >
              {vehicleModes.map(mode => {
                const { Icon } = MODE_STYLE[mode];
                return (
                  <Icon
                    key={mode}
                    data-vehicle={mode}
                    data-active={mode === initial.mode}
                    className="absolute h-5 w-5 opacity-0 transition-opacity duration-500 data-[active=true]:opacity-100"
                    strokeWidth={2.2}
                  />
                );
              })}
            </span>
          )}
        </div>
      </div>
    </div>
  );
}

function Node({ node, left, align, detailed }: { node: SimNode; left: number; align: 'start' | 'center' | 'end'; detailed: boolean }) {
  const end = node.kind === 'origin' || node.kind === 'destination';
  const labelShift = align === 'start' ? 'translate-x-[-10px]' : align === 'end' ? 'translate-x-[calc(-100%+10px)]' : '-translate-x-1/2';
  const textAlign = align === 'start' ? 'text-left' : align === 'end' ? 'text-right' : 'text-center';
  const showWait = !end && node.waitSeconds >= MIN_WAIT_SHOWN_SECONDS;
  return (
    <div className="absolute top-0 h-0 w-0" style={{ left: pct(left) }} data-node={node.kind}>
      <span aria-hidden className={`absolute left-0 top-[64px] z-10 -translate-x-1/2 -translate-y-1/2 rounded-full ${end
        ? 'h-5 w-5 border-[3px] border-[#1F2933] bg-white'
        : node.kind === 'transfer' ? 'h-5 w-5 border-[3px] border-white bg-[#E5A93D] shadow' : 'h-3.5 w-3.5 border-2 border-white bg-[#667085] shadow'}`} />
      <span title={node.name} className={`absolute left-0 top-[96px] ${labelShift} ${textAlign} w-max max-w-[132px]`}>
        <span className="block truncate text-[13px] font-semibold leading-tight text-[#1F2933]">{shortPlaceName(node.name, 16)}</span>
        {detailed && node.time && <span className="block text-xs tabular-nums text-[#667085]">{clockOf(node.time)}</span>}
        {node.kind === 'transfer' && <span className="block text-[10px] font-bold uppercase tracking-wide text-[#8A5D0C]">Transfer</span>}
        {showWait && (
          <span data-wait className="mt-0.5 inline-block rounded-full bg-[#FFF7E8] px-1.5 py-px text-[11px] font-semibold tabular-nums text-[#8A5D0C]">
            {formatDuration(node.waitSeconds)} wait
          </span>
        )}
      </span>
    </div>
  );
}

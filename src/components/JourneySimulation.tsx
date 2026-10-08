import { useEffect, useRef, useState } from 'react';
import type { CSSProperties } from 'react';

import { Bike, Bus, CarTaxiFront, Footprints, Plane, Ship, TrainFront } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import type { Journey } from '../services/planService';
import { buildSimulation, segmentWeight, shortPlaceName } from '../utils/journeySimulation';
import type { SimMode } from '../utils/journeySimulation';
import { prefersReducedMotion } from '../utils/trackingLaunch';
import { clockOf } from '../utils/dateTime';

// A compact, stylised route strip built from the journey's real legs: nodes for the places, one segment per leg with
// that leg's mode icon. In motion, the legs "play" one after another (a slow relay: the icon of the active leg glides
// along it, then the next leg takes over) and transfer points pulse softly. It is not a map: no geometry is drawn.
//
// Lightweight by design: plain DOM + CSS (one small absolutely-positioned chip moves, layout-contained to its track), one timer per VISIBLE card (an IntersectionObserver pauses cards
// that are off-screen or in a hidden tab), and no motion at all under prefers-reduced-motion.

export const SIM_SLOT_MS = 2800;

const MODE_STYLE: Record<SimMode, { Icon: LucideIcon; line: string; chip: string }> = {
  walk: { Icon: Footprints, line: 'rc-sim-line-dashed text-[#98A2B3]', chip: 'bg-white text-[#667085] border-[#D0D5DD]' },
  local_ride: { Icon: CarTaxiFront, line: 'bg-[#E5A93D]', chip: 'bg-[#FFF7E8] text-[#9A6A12] border-[#F1D29A]' },
  bike: { Icon: Bike, line: 'bg-[#E5A93D]', chip: 'bg-[#FFF7E8] text-[#9A6A12] border-[#F1D29A]' },
  bus: { Icon: Bus, line: 'bg-[#146B5B]', chip: 'bg-[#146B5B] text-white border-[#146B5B]' },
  train: { Icon: TrainFront, line: 'bg-[#2F5D8C]', chip: 'bg-[#2F5D8C] text-white border-[#2F5D8C]' },
  flight: { Icon: Plane, line: 'bg-[#5B5F97]', chip: 'bg-[#5B5F97] text-white border-[#5B5F97]' },
  ferry: { Icon: Ship, line: 'bg-[#2B7A9B]', chip: 'bg-[#2B7A9B] text-white border-[#2B7A9B]' }
};

export function modeIconName(mode: SimMode): string {
  return { walk: 'footprints', local_ride: 'car-taxi-front', bike: 'bike', bus: 'bus', train: 'train-front', flight: 'plane', ferry: 'ship' }[mode];
}

export default function JourneySimulation({ journey, detailed = false, animate }: {
  journey: Pick<Journey, 'legs'>;
  detailed?: boolean;
  // Test/preview override; normally decided from prefers-reduced-motion and visibility.
  animate?: boolean;
}) {
  const sim = buildSimulation(journey);
  const root = useRef<HTMLDivElement | null>(null);
  const [motion, setMotion] = useState(false);
  const [active, setActive] = useState(0);
  const [tick, setTick] = useState(0);

  // Motion only when allowed and on screen.
  useEffect(() => {
    if (animate === false || sim.segments.length === 0) return;
    if (animate !== true && prefersReducedMotion()) return;
    const element = root.current;
    if (!element || typeof IntersectionObserver === 'undefined') { setMotion(true); return; }
    const observer = new IntersectionObserver(([entry]) => setMotion(entry.isIntersecting), { threshold: 0.2 });
    observer.observe(element);
    return () => observer.disconnect();
  }, [animate, sim.segments.length]);

  // The relay: one leg at a time, slowly. Paused while the tab is hidden.
  useEffect(() => {
    if (!motion) return;
    const timer = setInterval(() => {
      if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return;
      setActive(index => (index + 1) % sim.segments.length);
      setTick(value => value + 1);
    }, SIM_SLOT_MS);
    return () => clearInterval(timer);
  }, [motion, sim.segments.length]);

  if (sim.segments.length === 0) return null;
  const last = sim.nodes.length - 1;

  return (
    <div
      ref={root}
      role="group"
      aria-label={sim.summary}
      data-motion={motion ? 'on' : 'off'}
      className={`rc-sim ${motion ? '' : 'rc-sim-static'} -mx-1 overflow-x-auto overflow-y-hidden px-1`}
    >
      <ol className={`flex min-w-max items-start sm:min-w-0 ${detailed ? 'pb-10' : 'pb-7'}`}>
        {sim.segments.map((segment, i) => {
          const style = MODE_STYLE[segment.mode];
          const isActive = motion && i === active;
          const node = sim.nodes[i];
          return (
            <li key={i} className="contents">
              <Node node={node} align={i === 0 ? 'start' : 'center'} detailed={detailed} />
              <div
                aria-label={segment.label}
                role="img"
                className="relative flex min-w-[112px] flex-col"
                style={{ flexGrow: segmentWeight(segment.durationSeconds), flexBasis: 0 }}
              >
                <span className="block h-3.5 text-center text-[10px] font-semibold leading-none text-[#667085] tabular-nums" aria-hidden>
                  {segment.durationText}
                </span>
                <span className="relative block h-7" aria-hidden>
                  <span className={`absolute inset-x-1.5 top-1/2 h-[3px] -translate-y-1/2 rounded-full transition-opacity duration-500 ${style.line} ${isActive || !motion ? 'opacity-100' : 'opacity-45'} ${isActive ? 'rc-sim-glow' : ''}`} />
                  {isActive ? (
                    // The track box stays put; only the chip moves inside it (its `left`, contained to this box), so the
                    // strip never grows a scrollbar while the icon travels.
                    <span key={`${i}-${tick}`} className="absolute inset-y-0 left-1.5 right-1.5 [contain:layout]">
                      <ModeChip mode={segment.mode} className="rc-sim-runner absolute top-1/2 -translate-x-1/2 -translate-y-1/2" style={{ animationDuration: `${SIM_SLOT_MS}ms` }} />
                    </span>
                  ) : (
                    <ModeChip mode={segment.mode} className={`absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 transition-opacity duration-500 ${motion ? 'opacity-70' : ''}`} />
                  )}
                </span>
              </div>
            </li>
          );
        })}
        <li className="contents">
          <Node node={sim.nodes[last]} align="end" detailed={detailed} />
        </li>
      </ol>
    </div>
  );
}

function ModeChip({ mode, className, style }: { mode: SimMode; className: string; style?: CSSProperties }) {
  const { Icon, chip } = MODE_STYLE[mode];
  return (
    <span data-mode={mode} data-icon={modeIconName(mode)} style={style} className={`flex h-[22px] w-[22px] items-center justify-center rounded-full border shadow-sm ${chip} ${className}`}>
      <Icon className="h-3 w-3" strokeWidth={2.2} />
    </span>
  );
}

function Node({ node, align, detailed }: { node: { name: string; kind: string; time: string | null }; align: 'start' | 'center' | 'end'; detailed: boolean }) {
  const end = node.kind === 'origin' || node.kind === 'destination';
  const position = align === 'start' ? 'left-0' : align === 'end' ? 'right-0' : 'left-1/2 -translate-x-1/2';
  const textAlign = align === 'start' ? 'text-left' : align === 'end' ? 'text-right' : 'text-center';
  return (
    <div className="relative flex w-3 flex-none flex-col items-center" data-node={node.kind}>
      <span className="block h-3.5" aria-hidden />
      <span className="relative flex h-7 items-center justify-center" aria-hidden>
        {node.kind === 'transfer' && <span className="rc-sim-pulse absolute h-3 w-3 rounded-full bg-[#E5A93D]/50" />}
        <span className={`relative block rounded-full border-2 ${end ? 'h-3 w-3 border-[#1F2933] bg-white' : node.kind === 'transfer' ? 'h-3 w-3 border-white bg-[#E5A93D] shadow' : 'h-2.5 w-2.5 border-white bg-[#667085]'}`} />
      </span>
      <span title={node.name} className={`absolute top-[42px] ${position} ${textAlign} w-max max-w-[100px]`}>
        <span className="block truncate text-[10px] font-semibold leading-tight text-[#1F2933]">{shortPlaceName(node.name)}</span>
        {node.kind === 'transfer' && <span className="block text-[9px] font-semibold uppercase tracking-wide text-[#9A6A12]">Transfer</span>}
        {detailed && node.time && <span className="block text-[10px] tabular-nums text-[#667085]">{clockOf(node.time)}</span>}
      </span>
    </div>
  );
}

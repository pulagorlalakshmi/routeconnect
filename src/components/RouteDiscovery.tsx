import { useEffect, useId, useRef, useState } from 'react';
import { AlertCircle, ArrowRight, RotateCcw, SlidersHorizontal } from 'lucide-react';
import { prefersReducedMotion } from '../utils/trackingLaunch';
import { modeSummary, rankingLabel } from '../utils/travelPreferences';
import type { TravelPreferences } from '../utils/travelPreferences';

// "Finding your best routes…": shown while the REAL plan request is pending (see Dashboard / SearchResults).
//
// Honest by construction: the server does not report stages, so there is one neutral status line, a gentle "still
// searching" note after a few seconds (true by elapsed time), and no percentage. The scene is decorative: a stylised
// curve, not the geographical route, and the marker is not a vehicle position.
//
// Motion: SMIL along one path (marker + drawn trail share a timeline, so they stay in sync) plus a few CSS
// transform/opacity/stroke-dashoffset loops. With reduced motion everything is static.

export type DiscoveryState = 'searching' | 'leaving' | 'error';

export interface DiscoveryError {
  title: string;
  message: string;
  canRetry: boolean;
}

interface RouteDiscoveryProps {
  from: string;
  to: string;
  preferences: TravelPreferences;
  state: DiscoveryState;
  error?: DiscoveryError | null;
  variant?: 'overlay' | 'inline';
  animate?: boolean;
  slowAfterMs?: number;
  onCancel?: () => void;
  onRetry?: () => void;
  onEditPreferences?: () => void;
  onChangeSearch?: () => void;
  // Estimated rail search: the panel says what is being looked for (mapped railway corridors), not ranked journeys.
  estimatedRail?: boolean;
}

const ROUTE = 'M36 112 C 96 112, 104 44, 164 50 S 238 112, 286 40';
const NODES: [number, number][] = [[100, 79], [164, 50], [230, 74]];
const CYCLE = '3.2s';
const KEY_TIMES = '0;0.78;0.9;1';
const SPLINES = '0.45 0 0.2 1;0 0 1 1;0 0 1 1';

export const NEUTRAL_STATUS = 'Finding available journeys…';
export const RAIL_STATUS = 'Finding connected railway corridors…';
export const SLOW_STATUS = 'Still searching… this can take a few seconds.';

function BusGlyph() {
  return (
    <g>
      <rect x="-6" y="-5" width="12" height="9" rx="2.2" fill="#146B5B" />
      <rect x="-4.4" y="-3.6" width="8.8" height="3.2" rx="0.8" fill="#E8FBF5" />
      <circle cx="-3.2" cy="4.4" r="1.4" fill="#0F3D34" />
      <circle cx="3.2" cy="4.4" r="1.4" fill="#0F3D34" />
    </g>
  );
}

function Pin({ x, y, tone }: { x: number; y: number; tone: 'from' | 'to' }) {
  const fill = tone === 'from' ? '#146B5B' : '#E5A93D';
  return (
    <g transform={`translate(${x} ${y})`}>
      <circle r="13" fill={fill} fillOpacity="0.14" className="rc-disc-halo" />
      {tone === 'from'
        ? <><circle r="7" fill="#fff" stroke={fill} strokeWidth="3" /><circle r="2.5" fill={fill} /></>
        : <path d="M0 6 C -7 -2, -8 -6, -8 -9 A 8 8 0 1 1 8 -9 C 8 -6, 7 -2, 0 6 Z" transform="translate(0 -4)" fill={fill} stroke="#fff" strokeWidth="2" />}
    </g>
  );
}

export function DiscoveryScene({ busOnly, animate }: { busOnly: boolean; animate: boolean }) {
  const gradientId = `rc-disc-grad-${useId().replace(/:/g, '')}`;
  return (
    <svg viewBox="0 0 320 150" className="block h-auto w-full" aria-hidden="true" focusable="false" data-animated={animate ? 'true' : 'false'}>
      <defs>
        <linearGradient id={gradientId} x1="0" x2="1" y1="0" y2="0">
          <stop offset="0" stopColor="#146B5B" />
          <stop offset="1" stopColor="#2FA58A" />
        </linearGradient>
      </defs>
      {/* Map-like ground: faint blocks and side roads */}
      <rect x="0" y="0" width="320" height="150" rx="18" fill="#EEF6F3" />
      <g fill="#DCEBE5">
        <rect x="18" y="16" width="44" height="26" rx="5" /><rect x="214" y="104" width="52" height="30" rx="5" />
        <rect x="120" y="96" width="34" height="38" rx="5" /><rect x="252" y="12" width="48" height="16" rx="5" />
      </g>
      <g fill="none" stroke="#C9DED6" strokeWidth="2" strokeDasharray="1 7" strokeLinecap="round">
        <path d="M0 58 C 70 70, 120 20, 200 22 S 300 60, 320 54" className="rc-disc-flow" />
        <path d="M70 150 C 90 120, 140 128, 180 110 S 250 90, 320 112" className="rc-disc-flow rc-disc-flow-slow" />
      </g>
      {!busOnly && <g opacity="0.5" transform="translate(208 26)"><BusGlyph /></g>}
      <g opacity="0.45" transform="translate(66 132) scale(0.7)"><Pin x={0} y={0} tone="to" /></g>

      {/* The route: glow, base, drawn trail, flowing dots */}
      <path d={ROUTE} fill="none" stroke="#146B5B" strokeOpacity="0.1" strokeWidth="14" strokeLinecap="round" />
      <path d={ROUTE} fill="none" stroke="#CFE3DC" strokeWidth="5" strokeLinecap="round" />
      <path d={ROUTE} fill="none" stroke={`url(#${gradientId})`} strokeWidth="5" strokeLinecap="round" pathLength={1} strokeDasharray="1 1" strokeDashoffset={animate ? 1 : 0}>
        {animate && (
          <>
            <animate attributeName="stroke-dashoffset" values="1;0;0;0" keyTimes={KEY_TIMES} calcMode="spline" keySplines={SPLINES} dur={CYCLE} repeatCount="indefinite" />
            <animate attributeName="opacity" values="1;1;1;0" keyTimes={KEY_TIMES} dur={CYCLE} repeatCount="indefinite" />
          </>
        )}
      </path>
      <path d={ROUTE} fill="none" stroke="#FFFFFF" strokeOpacity="0.8" strokeWidth="1.6" strokeDasharray="1 9" strokeLinecap="round" className="rc-disc-flow" />

      {NODES.map(([x, y], i) => (
        <g key={`${x}-${y}`} className="rc-disc-node" style={{ animationDelay: `${i * 0.35}s` }}>
          <circle cx={x} cy={y} r="7" fill="#2FA58A" fillOpacity="0.18" />
          <circle cx={x} cy={y} r="3.4" fill="#fff" stroke="#146B5B" strokeWidth="1.6" />
        </g>
      ))}

      <Pin x={36} y={112} tone="from" />
      <Pin x={286} y={44} tone="to" />

      {/* The traveller: a bus for Bus only, a neutral marker otherwise (no train visuals: train search is unavailable). */}
      <g data-marker={busOnly ? 'bus' : 'generic'} transform={animate ? undefined : 'translate(164 50)'}>
        {animate && (
          <>
            <animateMotion path={ROUTE} keyPoints="0;1;1;1" keyTimes={KEY_TIMES} calcMode="spline" keySplines={SPLINES} dur={CYCLE} repeatCount="indefinite" />
            <animate attributeName="opacity" values="1;1;1;0" keyTimes={KEY_TIMES} dur={CYCLE} repeatCount="indefinite" />
          </>
        )}
        <circle r="15" fill="#2FA58A" fillOpacity="0.22" />
        {busOnly
          ? <><circle r="11" fill="#fff" stroke="#146B5B" strokeWidth="2" /><BusGlyph /></>
          : <><circle r="8" fill="#146B5B" stroke="#fff" strokeWidth="3" /><circle r="2.4" fill="#fff" /></>}
      </g>
    </svg>
  );
}

export default function RouteDiscovery({
  from, to, preferences, state, error = null, variant = 'overlay', animate = !prefersReducedMotion(), slowAfterMs = 6000,
  onCancel, onRetry, onEditPreferences, onChangeSearch, estimatedRail = false
}: RouteDiscoveryProps) {
  const headingId = `rc-disc-${useId()}`;
  const [slow, setSlow] = useState(false);
  const panelRef = useRef<HTMLDivElement>(null);
  const primaryRef = useRef<HTMLButtonElement>(null);
  const busOnly = preferences.modes.length === 1 && preferences.modes[0] === 'bus';

  // A truthful "still searching" after a few seconds; reset whenever a new search starts.
  useEffect(() => {
    if (state !== 'searching') return;
    setSlow(false);
    const timer = window.setTimeout(() => setSlow(true), slowAfterMs);
    return () => window.clearTimeout(timer);
  }, [state, slowAfterMs]);

  // Focus: the panel while searching (so screen readers land on it), the first recovery action on error.
  useEffect(() => {
    if (variant !== 'overlay') return;
    if (state === 'error') primaryRef.current?.focus();
    else if (state === 'searching') panelRef.current?.focus();
  }, [state, variant]);

  const isError = state === 'error' && error;

  return (
    <div
      ref={panelRef}
      tabIndex={-1}
      aria-labelledby={headingId}
      aria-busy={state === 'searching'}
      data-state={state}
      className={`${state === 'leaving' ? 'rc-disc-exit' : 'rc-disc-enter'} w-full overflow-hidden rounded-3xl bg-white outline-none ${
        variant === 'overlay' ? 'shadow-2xl shadow-black/30' : 'border border-[#D9E2DE] shadow-sm'
      }`}
    >
      <div className="p-4 sm:p-5">
        <DiscoveryScene busOnly={busOnly} animate={animate && state !== 'error'} />
      </div>

      <div className="px-5 pb-6 text-center sm:px-7">
        {isError ? (
          <>
            <AlertCircle aria-hidden className="mx-auto h-7 w-7 text-amber-600" />
            <h2 id={headingId} className="mt-2 text-xl font-black tracking-tight text-[#1F2933]">{error.title}</h2>
            <p role="alert" className="mt-1.5 text-sm leading-6 text-[#667085]">{error.message}</p>
            <div className="mt-5 grid grid-cols-1 gap-2 sm:grid-cols-2">
              {error.canRetry && onRetry && (
                <button ref={primaryRef} type="button" onClick={onRetry} className="inline-flex items-center justify-center gap-2 rounded-xl bg-[#146B5B] px-5 py-3 text-sm font-extrabold text-white transition hover:bg-[#0f5447] focus:outline-none focus-visible:ring-4 focus-visible:ring-[#146B5B]/30 sm:col-span-2">
                  <RotateCcw aria-hidden className="h-4 w-4" /> Try again
                </button>
              )}
              {onEditPreferences && (
                <button ref={error.canRetry && onRetry ? undefined : primaryRef} type="button" onClick={onEditPreferences} className="inline-flex items-center justify-center gap-2 rounded-xl border border-[#D0D9D5] bg-white px-4 py-3 text-sm font-bold text-[#1F2933] transition hover:bg-[#F7FAF9] focus:outline-none focus-visible:ring-2 focus-visible:ring-[#146B5B]">
                  <SlidersHorizontal aria-hidden className="h-4 w-4" /> Edit preferences
                </button>
              )}
              {onChangeSearch && (
                <button type="button" onClick={onChangeSearch} className="rounded-xl border border-[#D0D9D5] bg-white px-4 py-3 text-sm font-bold text-[#1F2933] transition hover:bg-[#F7FAF9] focus:outline-none focus-visible:ring-2 focus-visible:ring-[#146B5B]">
                  Change search
                </button>
              )}
            </div>
          </>
        ) : (
          <>
            <h2 id={headingId} className="text-xl font-black tracking-tight text-[#1F2933] sm:text-2xl">Finding your best routes...</h2>
            <p className="mt-2 flex flex-wrap items-center justify-center gap-x-2 gap-y-1 text-sm font-bold text-[#1F2933]">
              <span className="max-w-[40%] truncate sm:max-w-[45%]">{from}</span>
              <ArrowRight aria-hidden className="h-4 w-4 shrink-0 text-[#146B5B]" />
              <span className="max-w-[40%] truncate sm:max-w-[45%]">{to}</span>
            </p>
            <p className="mt-2 text-xs font-semibold text-[#667085]">
              {estimatedRail ? 'Train · estimated railway connections' : `${modeSummary(preferences.modes)} · ${rankingLabel(preferences.ranking)}`}
            </p>
            <p role="status" aria-live="polite" className="mt-4 text-sm text-[#475467]">
              {state === 'leaving' ? 'Routes ready.' : slow ? SLOW_STATUS : estimatedRail ? RAIL_STATUS : NEUTRAL_STATUS}
            </p>
            {onCancel && state === 'searching' && (
              <button type="button" onClick={onCancel} className="mt-4 rounded-xl px-4 py-2 text-sm font-bold text-[#667085] transition hover:bg-[#F1F4F3] hover:text-[#1F2933] focus:outline-none focus-visible:ring-2 focus-visible:ring-[#146B5B]">
                Cancel
              </button>
            )}
          </>
        )}
      </div>
    </div>
  );
}

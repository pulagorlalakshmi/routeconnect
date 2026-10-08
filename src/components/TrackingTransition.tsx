import { useEffect, useRef, useState } from 'react';
import { Bus, MapPin } from 'lucide-react';
import { TRANSITION_MS } from '../utils/trackingLaunch';

// The ~1 s hand-off shown after "Track Bus": RouteConnect pin -> route line draws -> bus moves along it -> GPS pulse at
// the tracker end -> "Opening <tracker>". It only animates; it makes no requests and does not navigate itself
// (launchTracking opens the tracker when the timer ends). Escape or Cancel calls onCancel and nothing is opened.
// The motion lives in index.css (rc-track-*) and is switched off under prefers-reduced-motion.

export function transitionStages(serviceNumber: string | null, trackerName: string): string[] {
  return [
    serviceNumber ? `Preparing service ${serviceNumber}` : 'Preparing live tracking',
    'Connecting to live bus tracking',
    `Opening ${trackerName}`
  ];
}

// When each stage's text appears, as a fraction of the transition.
const STAGE_AT = [0, 0.4, 0.75];

export default function TrackingTransition({ serviceNumber, trackerName, onCancel, initialStage = 0 }: {
  serviceNumber: string | null;
  trackerName: string;
  onCancel: () => void;
  initialStage?: number;
}) {
  const stages = transitionStages(serviceNumber, trackerName);
  const [stage, setStage] = useState(initialStage);
  const cancelButton = useRef<HTMLButtonElement | null>(null);

  useEffect(() => {
    const timers = STAGE_AT.slice(1).map((at, i) => setTimeout(() => setStage(i + 1), at * TRANSITION_MS));
    return () => timers.forEach(clearTimeout);
  }, []);

  useEffect(() => {
    cancelButton.current?.focus({ preventScroll: true });
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') { event.preventDefault(); onCancel(); }
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [onCancel]);

  return (
    <div className="rc-track-overlay fixed inset-0 z-[100] flex items-center justify-center bg-[#1F2933]/35 px-4 backdrop-blur-[2px]">
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="rc-track-title"
        className="rc-track-card w-full max-w-[320px] rounded-2xl border border-[#D9DED9] bg-white px-5 pb-4 pt-5 text-center shadow-[0_18px_50px_rgba(31,41,51,0.18)]"
      >
        <div className="rc-track-scene relative mx-auto h-12 w-[232px]" aria-hidden="true">
          <span className="absolute left-0 top-1/2 flex h-7 w-7 -translate-y-1/2 items-center justify-center rounded-full bg-[#1F2933] text-[#E5A93D]">
            <MapPin className="h-4 w-4" strokeWidth={2.4} />
          </span>
          <span className="absolute left-9 right-9 top-1/2 h-[2px] -translate-y-1/2 rounded bg-[#E7ECE9]" />
          <span className="rc-track-line absolute left-9 right-9 top-1/2 h-[2px] -translate-y-1/2 origin-left rounded bg-[#146B5B]" />
          <span className="rc-track-bus absolute left-7 top-1/2 flex h-6 w-6 -translate-y-1/2 items-center justify-center rounded-md bg-[#146B5B] text-white shadow-sm">
            <Bus className="h-3.5 w-3.5" />
          </span>
          <span className="absolute right-0 top-1/2 flex h-7 w-7 -translate-y-1/2 items-center justify-center">
            <span className="rc-track-pulse absolute inset-0 rounded-full bg-[#E5A93D]/40" />
            <span className="relative h-3 w-3 rounded-full border-2 border-white bg-[#E5A93D] shadow" />
          </span>
        </div>

        <p id="rc-track-title" className="mt-3 text-sm font-semibold text-[#1F2933]">Opening live APSRTC tracking</p>
        <p role="status" aria-live="polite" className="mt-0.5 h-4 text-xs text-[#667085]">{stages[Math.min(stage, stages.length - 1)]}</p>

        <div className="mx-auto mt-3 h-[3px] w-full overflow-hidden rounded bg-[#F0F4F2]" aria-hidden="true">
          <div className="rc-track-progress h-full origin-left bg-[#146B5B]" style={{ animationDuration: `${TRANSITION_MS}ms` }} />
        </div>

        <button
          ref={cancelButton}
          type="button"
          onClick={onCancel}
          className="mt-3 rounded px-2 py-0.5 text-[11px] font-semibold text-[#667085] hover:bg-gray-100 hover:text-[#1F2933] focus:outline-none focus-visible:ring-2 focus-visible:ring-[#146B5B]/40 cursor-pointer"
        >
          Cancel
        </button>
      </div>
    </div>
  );
}

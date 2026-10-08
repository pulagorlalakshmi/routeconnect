// What happens between "Track Bus" being clicked and the tracker opening.
//
// 1. The service number is copied at once, inside the click (browsers only allow clipboard writes from a user gesture).
// 2. A short transition plays (TRANSITION_MS), then the tracker's own page opens in a new tab.
//    With prefers-reduced-motion the transition is skipped and the tracker opens immediately.
// 3. Cancelling (Escape, the Cancel button, or the card unmounting) before the end means nothing is opened.
//
// Only the tracker URL from the registry is opened: no query parameters, no referrer, no opener, nothing about the user.
// Nothing here makes a network request.
import type { ApsrtcTracker } from '../config/apsrtcTrackers';
import type { TrackingPlan } from './busIdentity';
import { copyText, runTrackingClick, trackingPlan } from './busIdentity';

export const TRANSITION_MS = 1100;
export const TRACKER_WINDOW_FEATURES = 'noopener,noreferrer';

export interface LaunchEnv {
  reducedMotion: boolean;
  copy: (text: string) => Promise<boolean>;
  open: (url: string) => void;
  schedule: (fn: () => void, ms: number) => unknown;
  cancelSchedule: (handle: unknown) => void;
}

export interface TrackingLaunch {
  tracker: ApsrtcTracker;
  plan: TrackingPlan;
  // Resolves to the toast text ("Service 03846 copied") or null when there was nothing to copy.
  copied: Promise<string | null>;
  // True when the transition is being shown (false with reduced motion: the tracker has already opened).
  animated: boolean;
  isDone(): boolean;
  cancel(): void;
}

export function launchTracking(
  tracker: ApsrtcTracker,
  serviceNumber: string | null,
  onOpened: () => void,
  env: LaunchEnv = browserLaunchEnv()
): TrackingLaunch {
  const plan = trackingPlan(tracker, serviceNumber);
  const copied = runTrackingClick(plan, serviceNumber, env.copy);
  let done = false;
  let handle: unknown = null;

  const finish = () => {
    if (done) return;
    done = true;
    env.open(plan.url);
    onOpened();
  };

  if (env.reducedMotion) finish();
  else handle = env.schedule(finish, TRANSITION_MS);

  return {
    tracker,
    plan,
    copied,
    animated: !env.reducedMotion,
    isDone: () => done,
    cancel: () => {
      if (done) return;
      done = true;
      if (handle !== null) env.cancelSchedule(handle);
    }
  };
}

export function prefersReducedMotion(win: Pick<Window, 'matchMedia'> | undefined = typeof window !== 'undefined' ? window : undefined): boolean {
  try {
    return !!win?.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
  } catch {
    return false;
  }
}

export function openTrackerUrl(url: string, win: Pick<Window, 'open'> | undefined = typeof window !== 'undefined' ? window : undefined): void {
  win?.open(url, '_blank', TRACKER_WINDOW_FEATURES);
}

export function browserLaunchEnv(): LaunchEnv {
  return {
    reducedMotion: prefersReducedMotion(),
    copy: copyText,
    open: url => openTrackerUrl(url),
    schedule: (fn, ms) => setTimeout(fn, ms),
    cancelSchedule: handle => clearTimeout(handle as ReturnType<typeof setTimeout>)
  };
}

// A plain left click with no modifier keys runs the transition. Ctrl/Cmd/Shift/middle clicks keep the browser's own
// link behaviour (open in a background tab etc.), and the number is still copied.
export function isPlainClick(event: { button: number; metaKey: boolean; ctrlKey: boolean; shiftKey: boolean; altKey: boolean }): boolean {
  return event.button === 0 && !event.metaKey && !event.ctrlKey && !event.shiftKey && !event.altKey;
}

import { useCallback, useEffect, useRef, useState } from 'react';
import type { ReactNode, Ref } from 'react';
import { createPortal } from 'react-dom';
import { Check, ChevronDown, Copy, Info, MapPin } from 'lucide-react';
import type { TransitLeg } from '../services/planService';
import { TRACKER_INFO, TRACKER_LINK_REL, trackersForLeg } from '../config/apsrtcTrackers';
import type { ApsrtcTracker } from '../config/apsrtcTrackers';
import { copyText, operatorLabelOf, routeLabelOf, runTrackingClick, serviceNumberOf, trackingPlan, vehicleFamilyOf, vehicleNumberOf } from '../utils/busIdentity';
import { isPlainClick, launchTracking } from '../utils/trackingLaunch';
import type { TrackingLaunch } from '../utils/trackingLaunch';
import TrackingTransition from './TrackingTransition';
import { routeTrustOf, scheduleTooltip, SCHEDULE_TRUST_TEXT, TRACKING_TEXT, trackingStatusOf, trackingTooltip, verifiedTrackers } from '../utils/trackingTrust';

// "Service No. 03846 [copy]": the timetable service number, with a small copy control and a tiny toast.
export function ServiceNumber({ value }: { value: string }) {
  const [copied, setCopied] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => { if (timer.current) clearTimeout(timer.current); }, []);

  const handleCopy = async () => {
    if (!(await copyText(value))) return;
    setCopied(true);
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => setCopied(false), 1800);
  };

  return (
    <span className="relative inline-flex items-center gap-1">
      <span>Service No. <strong className="font-bold text-[#1F2933]">{value}</strong></span>
      <button
        type="button"
        onClick={handleCopy}
        aria-label={`Copy service number ${value}`}
        title="Copy service number"
        className="inline-flex h-5 w-5 items-center justify-center rounded text-[#667085] hover:bg-gray-100 hover:text-[#146B5B] cursor-pointer"
      >
        {copied ? <Check className="h-3 w-3 text-emerald-600" /> : <Copy className="h-3 w-3" />}
      </button>
      {copied && (
        <span role="status" className="absolute left-full top-1/2 ml-1 -translate-y-1/2 whitespace-nowrap rounded bg-[#1F2933] px-2 py-0.5 text-[10px] font-semibold text-white shadow">
          Service {value} copied
        </span>
      )}
    </span>
  );
}

const linkClass = 'text-[11px] font-semibold text-[#667085] hover:text-[#146B5B]';

// One tracker as a real external link (so ctrl/middle-click and "copy link" still work). A plain click is taken over:
// the service number is copied, the short transition plays, then the tracker opens in a new tab. Other clicks keep the
// browser's own behaviour and still copy the number. No query parameters are added and nothing else is sent.
function TrackerLink({ tracker, serviceNumber, onLaunch, onResult, className, children, linkRef }: {
  tracker: ApsrtcTracker;
  serviceNumber: string | null;
  onLaunch: (tracker: ApsrtcTracker) => void;
  onResult: (message: string | null) => void;
  className: string;
  children: ReactNode;
  linkRef?: Ref<HTMLAnchorElement>;
}) {
  const plan = trackingPlan(tracker, serviceNumber);
  return (
    <a
      ref={linkRef}
      href={plan.url}
      target="_blank"
      rel={TRACKER_LINK_REL}
      className={className}
      onClick={event => {
        if (isPlainClick(event)) {
          event.preventDefault();
          onLaunch(tracker);
        } else {
          // The copy starts inside the click, as browsers require.
          void runTrackingClick(plan, serviceNumber).then(onResult);
        }
      }}
    >
      {children}
    </a>
  );
}

// The "Track with" list: best tracker first. Rendered only while the menu is open.
export function TrackerMenu({ trackers, serviceNumber, onLaunch, onResult, markDefault = true }: {
  trackers: ApsrtcTracker[];
  serviceNumber: string | null;
  onLaunch: (tracker: ApsrtcTracker) => void;
  onResult: (message: string | null) => void;
  markDefault?: boolean;
}) {
  return (
    <div role="menu" aria-label="Track with" className="absolute right-0 top-full z-20 mt-1 w-44 rounded-lg border border-[#D9DED9] bg-white p-1 text-left shadow-lg">
      <p className="px-2 pb-0.5 pt-1 text-[10px] font-semibold uppercase tracking-wide text-[#667085]">Track with</p>
      {trackers.map((tracker, i) => (
        <TrackerLink
          key={tracker.id}
          tracker={tracker}
          serviceNumber={serviceNumber}
          onLaunch={onLaunch}
          onResult={onResult}
          className="flex items-center justify-between rounded px-2 py-1 text-xs font-medium text-[#1F2933] hover:bg-[#F0F4F2]"
        >
          <span role="menuitem">{tracker.name}</span>
          {markDefault && i === 0 && <span className="text-[10px] font-semibold text-[#98A2B3]">Default</span>}
        </TrackerLink>
      ))}
    </div>
  );
}

type TrackableLeg = Pick<TransitLeg, 'operator' | 'tracking' | 'serviceNumber' | 'routeShortName'>;

// Two modes, never mixed up:
//   track - "Track Bus ▾", ONLY for a service a tracker is verified to recognise, and only with those trackers
//           (the preferred one on the main link, the other verified ones in the menu). Otherwise nothing is rendered,
//           so there is never a Track Bus button that may lead nowhere.
//   check - "Check Live Tracking ▾" for a service that has not been verified (the normal case): a menu of every
//           APSRTC tracker the user may try. Nothing is claimed about whether it will find this service.
// Either way a choice copies the service number, plays the short transition and opens the tracker's own page.
// RouteConnect does not know whether any bus has active GPS.
export function TrackBus({ leg, mode = 'track' }: { leg: TrackableLeg; mode?: 'track' | 'check' }) {
  const [open, setOpen] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [fallback, setFallback] = useState<ApsrtcTracker | null>(null);
  const [launch, setLaunch] = useState<TrackingLaunch | null>(null);
  const root = useRef<HTMLSpanElement | null>(null);
  const mainLink = useRef<HTMLAnchorElement | null>(null);
  const active = useRef<TrackingLaunch | null>(null);
  const timers = useRef<ReturnType<typeof setTimeout>[]>([]);

  useEffect(() => () => {
    // Leaving the page mid-transition cancels the hand-off: nothing opens later.
    active.current?.cancel();
    timers.current.forEach(clearTimeout);
  }, []);

  useEffect(() => {
    if (!open) return;
    const onMouseDown = (event: MouseEvent) => { if (root.current && !root.current.contains(event.target as Node)) setOpen(false); };
    const onKeyDown = (event: KeyboardEvent) => { if (event.key === 'Escape') setOpen(false); };
    document.addEventListener('mousedown', onMouseDown);
    document.addEventListener('keydown', onKeyDown);
    return () => { document.removeEventListener('mousedown', onMouseDown); document.removeEventListener('keydown', onKeyDown); };
  }, [open]);

  const cancel = useCallback(() => {
    active.current?.cancel();
    active.current = null;
    setLaunch(null);
    (mainLink.current ?? root.current?.querySelector('button'))?.focus();
  }, []);

  const trackers = mode === 'track' ? verifiedTrackers(leg) : trackersForLeg(leg);
  if (trackers.length === 0) return null;
  const serviceNumber = serviceNumberOf(leg);
  const [best] = trackers;

  const later = (fn: () => void, ms: number) => { timers.current.push(setTimeout(fn, ms)); };

  const showResult = (text: string | null) => {
    setOpen(false);
    if (!text) return;
    setMessage(text);
    later(() => { setMessage(null); setFallback(null); }, 3500);
  };

  const start = (tracker: ApsrtcTracker) => {
    setOpen(false);
    setFallback(null);
    active.current?.cancel();
    const started = launchTracking(tracker, serviceNumber, () => {
      active.current = null;
      setLaunch(null);
      // A new tab normally takes focus. If this page still has it shortly after, the browser probably held the tab
      // back (popup blocker), so the toast offers a direct link to the same tracker.
      later(() => {
        if (document.visibilityState === 'visible' && document.hasFocus()) {
          setFallback(tracker);
          setMessage(current => current ?? (serviceNumber ? `Service ${serviceNumber} copied` : 'Tracker ready'));
          later(() => { setMessage(null); setFallback(null); }, 6000);
        }
      }, 500);
    });
    active.current = started;
    void started.copied.then(showResult);
    if (started.animated) setLaunch(started);
  };

  return (
    <span ref={root} className="relative inline-flex items-center gap-1">
      {mode === 'track' ? (
        <span className="inline-flex overflow-hidden rounded-md border border-[#D9DED9]">
          <TrackerLink
            linkRef={mainLink}
            tracker={best}
            serviceNumber={serviceNumber}
            onLaunch={start}
            onResult={showResult}
            className={`inline-flex items-center gap-1 px-2 py-0.5 hover:bg-gray-50 ${linkClass}`}
          >
            <MapPin className="h-3 w-3" /> Track Bus
          </TrackerLink>
          {trackers.length > 1 && (
            <button
              type="button"
              onClick={() => setOpen(value => !value)}
              aria-haspopup="menu"
              aria-expanded={open}
              aria-label="Choose tracker"
              title="Choose tracker"
              className={`inline-flex items-center border-l border-[#D9DED9] px-1 hover:bg-gray-50 cursor-pointer ${linkClass}`}
            >
              <ChevronDown className="h-3 w-3" />
            </button>
          )}
        </span>
      ) : (
        <button
          type="button"
          onClick={() => setOpen(value => !value)}
          aria-haspopup="menu"
          aria-expanded={open}
          className={`inline-flex items-center gap-0.5 rounded px-1 py-0.5 hover:bg-gray-50 cursor-pointer ${linkClass}`}
        >
          Check Live Tracking <ChevronDown className="h-3 w-3" />
        </button>
      )}
      <span title={TRACKER_INFO} aria-label={TRACKER_INFO} role="img" className="text-[#98A2B3]"><Info className="h-3 w-3" /></span>
      {open && <TrackerMenu trackers={trackers} serviceNumber={serviceNumber} onLaunch={start} onResult={showResult} markDefault={mode === 'track'} />}
      {message && (
        <span role="status" className="absolute right-0 top-full z-10 mt-1 inline-flex items-center gap-2 whitespace-nowrap rounded border border-gray-500 bg-[#1F2933] px-2 py-1 text-[11px] font-medium text-white shadow">
          {message}
          {fallback && (
            <a href={fallback.url} target="_blank" rel={TRACKER_LINK_REL} className="font-semibold text-[#E5A93D] underline-offset-2 hover:underline">
              Open {fallback.name}
            </a>
          )}
        </span>
      )}
      {launch && typeof document !== 'undefined' && createPortal(
        <TrackingTransition serviceNumber={serviceNumber} trackerName={launch.tracker.name} onCancel={cancel} />,
        document.body
      )}
    </span>
  );
}

// Shown only when a trustworthy source provided a vehicle number; nothing is rendered otherwise (never a made-up plate).
export function VehicleLine({ leg }: { leg: TransitLeg }) {
  const vehicle = vehicleNumberOf(leg);
  if (!vehicle) return null;
  return (
    <p className="text-[11px] text-[#98A2B3]">
      Vehicle No. <strong className="font-semibold text-[#1F2933]">{vehicle}</strong>
      {leg.vehicleNumberConfidence === 'live' && <span className="ml-1 text-emerald-700">(live)</span>}
    </p>
  );
}

// The two trust answers for one bus, side by side but independent:
//   route    - "Timetable-backed" + the schedule level (tooltip says where the schedule comes from)
//   tracking - verified / not verified / no public tracker found, with the matching action (or none)
export function LegTrust({ leg }: { leg: TransitLeg }) {
  const trust = routeTrustOf(leg);
  const status = trackingStatusOf(leg);
  const scheduleTip = scheduleTooltip(trust);
  return (
    <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-[11px]" aria-label="Trust">
      {trust.timetableBacked && (
        <span className="rounded-full border border-[#CFE3DC] bg-[#F0F7F4] px-2 py-px font-semibold text-[#146B5B]">Timetable-backed</span>
      )}
      <span className="inline-flex items-center gap-1 rounded-full border border-[#E4E9E6] bg-white px-2 py-px font-semibold text-[#667085]">
        {SCHEDULE_TRUST_TEXT[trust.scheduleConfidence]}
        <span title={scheduleTip} aria-label={scheduleTip} role="img" className="text-[#98A2B3]"><Info className="h-3 w-3" /></span>
      </span>
      {status && (
        <>
          <span aria-hidden className="hidden text-[#D0D5DD] sm:inline">·</span>
          <span title={trackingTooltip(leg)} className={`inline-flex items-center gap-1 font-medium ${status === 'verified' ? 'text-emerald-700' : 'text-[#667085]'}`}>
            <span aria-hidden className={`h-1.5 w-1.5 rounded-full ${status === 'verified' ? 'bg-emerald-500' : status === 'options_available' ? 'bg-[#9EC5B8]' : 'bg-[#D0D5DD]'}`} />
            {TRACKING_TEXT[status]}
          </span>
          {status === 'verified' && <span className="ml-auto"><TrackBus leg={leg} mode="track" /></span>}
          {status === 'options_available' && <span className="ml-auto"><TrackBus leg={leg} mode="check" /></span>}
        </>
      )}
    </div>
  );
}

const FAMILY_ICON = { bus: '🚌', train: '🚆', flight: '✈️' } as const;

// The leg's identifier: "Service No. 3846 [copy]" only for a proven public service number, otherwise "Route 952054"
// (or the train / flight number). A route code is never presented as a service number.
export function LegIdentifier({ leg }: { leg: TransitLeg }) {
  const service = serviceNumberOf(leg);
  if (service) return <ServiceNumber value={service} />;
  const label = routeLabelOf(leg);
  return label ? <span title="Identifier from the timetable source">{label}</span> : <span>Identifier not available</span>;
}

// One compact block per vehicle in the journey card: identifier, operator and real stops, then the trust row, then
// the vehicle registration only when known.
export function BusSummaryRow({ leg }: { leg: TransitLeg }) {
  const operator = operatorLabelOf(leg);
  return (
    <li className="space-y-1">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-[#667085]">
        <span aria-hidden>{FAMILY_ICON[vehicleFamilyOf(leg)]}</span>
        <LegIdentifier leg={leg} />
        <span title={leg.operatorInfo ? `Operator from ${leg.operatorInfo.source}` : undefined} className={leg.operatorInfo?.name || leg.operator ? 'font-semibold text-[#1F2933]' : 'italic'}>{operator}</span>
        <span className="min-w-0 truncate">{leg.fromStop.name} → {leg.toStop.name}</span>
      </div>
      <div className="pl-6"><LegTrust leg={leg} /></div>
      <div className="pl-6"><VehicleLine leg={leg} /></div>
    </li>
  );
}

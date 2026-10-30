import { useId, useState, useMemo } from 'react';
import type { ReactNode } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { Bookmark, Check, ChevronDown, ChevronUp, Clock } from 'lucide-react';
import { useAuth } from '../context/AuthContext';
import { isLocalRideLeg, isTransitLeg, isWalkLeg, TransitLeg } from '../services/planService';
import type { DataConfidence, Journey, JourneyLabel, Leg } from '../services/planService';
import { clockOf, dateOf, dayDifference, formatDateLabel, formatDuration } from '../utils/dateTime';
import { formatFareRange } from '../utils/fare';
import { operatorBusName, serviceNumberOf, vehicleFamilyOf, vehicleTitleOf } from '../utils/busIdentity';
import { headerLabels } from '../utils/journeyBadges';
import type { DepartureOption, GroupedRoute } from '../utils/routeGrouping';
import { getRouteCorridor, getRouteDistanceMeters, getRouteStopsSummary } from '../utils/routeGrouping';
import { BusSummaryRow } from './BusIdentity';
import JourneySimulation from './JourneySimulation';
import JourneyTimeline from './JourneyTimeline';
import RideProviders from './RideProviders';

// A journey card is summary-first: title, the journey strip, four key numbers, a few short facts, and two actions.
// Everything else (stops, service numbers, fares per leg, tracking, schedule trust, rating) is behind "More details".

const LABELS: Record<JourneyLabel, { text: string; hint: string; className: string }> = {
  BEST_PATH: { text: 'Best path', hint: 'Highest overall Best Path Rating among the options shown.', className: 'bg-[#EEF6F3] text-[#146B5B] border-[#CFE3DC]' },
  FASTEST: { text: 'Fastest', hint: 'Shortest complete door-to-door travel time.', className: 'bg-[#FFF7E8] text-[#8A5D0C] border-[#F1D29A]' },
  LEAST_TRANSFERS: { text: 'Fewest transfers', hint: 'Fewest vehicle changes.', className: 'bg-[#EFF5FB] text-[#2F5D8C] border-[#CBDDF0]' },
  BEST_BALANCED: { text: 'Best balanced', hint: 'Best mix of travel time, transfers, walking, waiting and local-ride time.', className: 'bg-[#EEF6F3] text-[#146B5B] border-[#CFE3DC]' },
  LOWER_ESTIMATED_COST: { text: 'Lower cost', hint: 'Its estimated fare range is clearly below every other option shown. Estimates are approximate.', className: 'bg-[#EEF6F3] text-[#146B5B] border-[#CFE3DC]' }
};

// How much each level of confidence may be trusted. Estimated values are never presented as verified.
const CONFIDENCE: Record<DataConfidence, { text: string; hint: string; className: string }> = {
  live: { text: 'Live', hint: 'Real-time data from the operator.', className: 'bg-emerald-50 border-emerald-300 text-emerald-900' },
  verified: { text: 'Verified', hint: 'Confirmed with the operator.', className: 'bg-emerald-50 border-emerald-300 text-emerald-900' },
  published: { text: 'Published timetable', hint: 'Taken from a published timetable that covers this date.', className: 'bg-emerald-50 border-emerald-300 text-emerald-900' },
  inferred: { text: 'Inferred schedule', hint: 'Not confirmed for this date: the timetable does not cover it, its snapshot may be out of date, or some stop times are interpolated. Confirm before travelling.', className: 'bg-amber-50 border-amber-300 text-amber-900' },
  estimated: { text: 'Estimated', hint: 'Calculated by RouteConnect, not taken from a timetable.', className: 'bg-amber-50 border-amber-300 text-amber-900' },
  unknown: { text: 'Unverified', hint: 'The source of this information is unknown.', className: 'bg-slate-50 border-slate-300 text-slate-700' }
};

export function ConfidenceBadge({ level, prefix }: { level: DataConfidence; prefix?: string }) {
  const info = CONFIDENCE[level] ?? CONFIDENCE.unknown;
  return (
    <span title={info.hint} className={`inline-flex items-center rounded-full border px-2 py-0.5 text-[11px] font-bold ${info.className}`}>
      {prefix ? `${prefix} ` : ''}{info.text}
    </span>
  );
}

const minutesBetween = (fromIso: string, toIso: string) => Math.max(0, Math.round((new Date(toIso).getTime() - new Date(fromIso).getTime()) / 60000));

// "🚕 Local ride + 🚌 APSRTC Bus", "🚆 Indian Railways Train", "🚌 Bus + 🚆 Train": the shape of the journey at a glance,
// one part per run of the same vehicle type. Identifiers are listed in the details.
const FAMILY_ICON = { bus: '🚌', train: '🚆', flight: '✈️' } as const;
export function journeyTitle(journey: Journey): string {
  const parts: string[] = [];
  const vehicles = journey.legs.filter(isTransitLeg);
  const first = journey.legs.find(l => isLocalRideLeg(l) && l.kind === 'access');
  const last = journey.legs.find(l => isLocalRideLeg(l) && l.kind === 'egress');
  if (first) parts.push('🚕 Local ride');
  const runs: TransitLeg[][] = [];
  for (const leg of vehicles) {
    const run = runs.at(-1);
    if (run && vehicleFamilyOf(run[0]) === vehicleFamilyOf(leg)) run.push(leg);
    else runs.push([leg]);
  }
  const mixed = runs.length > 1;
  for (const run of runs) {
    const family = vehicleFamilyOf(run[0]);
    const operators = new Set(run.map(leg => leg.operatorInfo?.name ?? leg.operator ?? ''));
    const operator = operators.size === 1 ? [...operators][0] || null : null;
    // In a mixed journey keep it short ("Bus + Train"); otherwise name the operator ("APSRTC Bus", "2 APSRTC buses").
    const text = family === 'bus'
      ? (mixed ? (run.length > 1 ? `${run.length} buses` : 'Bus') : operatorBusName(operator, run.length))
      : mixed ? (family === 'train' ? 'Train' : 'Flight') : vehicleTitleOf(run[0]);
    parts.push(`${FAMILY_ICON[family]} ${text}`);
  }
  if (last) parts.push('🚕 Local ride');
  return parts.join(' + ');
}

export const transfersText = (n: number) => (n === 0 ? 'Direct' : `${n} transfer${n === 1 ? '' : 's'}`);

// The card heading: the journey's shape, plus the number of changes when it combines bus and train
// ("🚌 Bus + 🚆 Train — 1 transfer"), so a connecting journey is recognisable before opening the details.
export function journeyHeading(journey: Journey): string {
  const families = new Set(journey.legs.filter(isTransitLeg).map(leg => vehicleFamilyOf(leg)));
  let title = journeyTitle(journey);
  const startsFromCurrentLocation = Boolean(
    journey.legs.length > 0 &&
    /current\s*location/i.test((isTransitLeg(journey.legs[0]) ? journey.legs[0].fromStop?.name : (journey.legs[0] as { from?: { name?: string } }).from?.name) || '')
  );
  // For railway journeys, strip "local ride" from the heading unless the traveller started from their current location
  if (families.has('train') && !startsFromCurrentLocation) {
    title = title.replace(/🚕 Local ride \+ /g, '').replace(/ \+ 🚕 Local ride/g, '').replace(/^🚕 Local ride$/, '');
  }
  return families.size > 1 ? `${title} — ${transfersText(journey.transfers)}` : title;
}

// In this feed a headsign is often just the route number again; only a real destination name is worth showing.
const showHeadsign = (leg: TransitLeg) => Boolean(leg.headsign) && !/^\d+$/.test(leg.headsign!.trim()) && leg.headsign!.trim() !== serviceNumberOf(leg) && leg.headsign!.trim() !== leg.routeCode;

function cleanDisplayName(name: string | null | undefined, fallback: string): string {
  if (!name) return fallback;
  const trimmed = name.trim();
  if (/^origin$/i.test(trimmed) || /^destination$/i.test(trimmed)) {
    return fallback;
  }
  return trimmed;
}

function walkText(leg: Extract<Leg, { mode: 'walk' }>, from = '', to = ''): string {
  const fromName = cleanDisplayName(leg.from?.name, from);
  const toName = cleanDisplayName(leg.to?.name, to);
  if (leg.kind === 'access') return `Local ride to ${toName}`;
  if (leg.kind === 'egress') return `Local ride to ${toName || 'your destination'}`;
  // Between a bus stand and a railway station (bus + train): the two are different places, said plainly.
  if (isStation(leg.to) || isStation(leg.from)) return `Local ride from ${fromName} to ${toName}`;
  return `Local ride between stops: ${fromName} → ${toName}`;
}

function legName(leg: Leg, to = ''): string {
  if (isWalkLeg(leg)) return 'Local ride';
  if (isLocalRideLeg(leg)) {
    const toName = cleanDisplayName(leg.to?.name, to);
    return leg.kind === 'egress' ? `Local ride to ${toName || 'To'}` : leg.kind === 'transfer' ? `Local ride to ${toName}` : isStation(leg.to) ? 'Local ride to the station' : 'Local ride to the stop';
  }
  const number = serviceNumberOf(leg) ?? leg.trainNumber ?? leg.flightNumber ?? null;
  return `${vehicleTitleOf(leg)}${number ? ` ${number}` : ''}`;
}

const FARE_DISCLAIMER = 'Estimated from route distance.';
const TRAIN_FARE_NOTE = 'Train fares depend on class and quota and are not in the timetable, so no train fare is estimated. Check IRCTC for fares.';

const isTrainLeg = (leg: Leg): leg is TransitLeg => isTransitLeg(leg) && vehicleFamilyOf(leg) === 'train';
const isStation = (place: { type?: string }) => place.type === 'station';

function Metric({ label, children, hint }: { label: string; children: ReactNode; hint?: string }) {
  return (
    <div className="min-w-0">
      <dt className="text-[11px] font-semibold uppercase tracking-wide text-[#667085]">{label}</dt>
      <dd title={hint} className="mt-0.5 text-lg md:text-xl font-black text-[#1F2933] tabular-nums leading-tight">{children}</dd>
    </div>
  );
}

function FactChip({ title, children }: { title?: string; children: ReactNode }) {
  return (
    <li title={title} className="rounded-full bg-[#F1F4F3] px-2.5 py-1 text-xs font-semibold text-[#475467]">
      {children}
    </li>
  );
}

function DetailSection({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section aria-label={title} className="space-y-2.5">
      <h4 className="text-xs font-black uppercase tracking-wider text-[#667085]">{title}</h4>
      {children}
    </section>
  );
}

function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="contents">
      <dt className="text-[#667085]">{label}</dt>
      <dd className="font-semibold text-[#1F2933] tabular-nums">{children}</dd>
    </div>
  );
}

export interface JourneyCardProps {
  journey: Journey;
  index: number;
  from: string;
  to: string;
  initialShowDetails?: boolean;
  departures?: DepartureOption[];
  routeInfo?: GroupedRoute;
}

export default function JourneyCard({
  journey,
  index,
  from,
  to,
  initialShowDetails = false,
  departures,
  routeInfo
}: JourneyCardProps) {
  const { user } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();
  const [showDetails, setShowDetails] = useState(initialShowDetails);
  const [saved, setSaved] = useState(false);
  const detailsId = `journey-details-${useId()}`;

  const availableDepartures: DepartureOption[] = useMemo(() => {
    if (departures && departures.length > 0) return departures;
    if (journey.departureOptions && journey.departureOptions.length > 0) return journey.departureOptions;
    return [{
      tripId: journey.id,
      departureTime: journey.departureTime,
      arrivalTime: journey.arrivalTime,
      durationSeconds: journey.totalDurationSeconds,
      journey
    }];
  }, [departures, journey]);

  const [selectedTime, setSelectedTime] = useState<string>(() => journey.departureTime);

  const activeDeparture = useMemo(() => {
    const found = availableDepartures.find(d => d.departureTime === selectedTime);
    return found || availableDepartures[0];
  }, [availableDepartures, selectedTime]);

  const activeJourney = activeDeparture.journey || journey;

  // Walks of a few seconds (the origin/destination is essentially at the stop) are noise in the step list.
  const visibleLegs = activeJourney.legs.filter(leg => !(isWalkLeg(leg) && leg.durationSeconds < 30));
  const transitLegs = activeJourney.legs.filter(isTransitLeg);
  const extraDays = dayDifference(activeJourney.departureTime, activeJourney.arrivalTime);
  const walks = activeJourney.walkingDurationSeconds >= 30;
  const hasRide = activeJourney.localRideCount > 0;
  const totalFare = activeJourney.fareEstimate && activeJourney.fareEstimate.min !== null ? formatFareRange(activeJourney.fareEstimate) : null;
  const partialFare = Boolean(activeJourney.fareEstimate && !activeJourney.fareEstimate.complete);
  const onBoardSeconds = transitLegs.reduce((sum, leg) => sum + leg.durationSeconds, 0);
  const trainLegs = transitLegs.filter(isTrainLeg);

  const corridor = {
    from: cleanDisplayName(from, routeInfo?.origin || getRouteCorridor(activeJourney, from, to).from),
    to: cleanDisplayName(to, routeInfo?.destination || getRouteCorridor(activeJourney, from, to).to)
  };
  const stopsInfo = routeInfo?.stopsSummary || getRouteStopsSummary(activeJourney);
  const distanceMeters = routeInfo?.totalDistanceMeters || getRouteDistanceMeters(activeJourney);
  const distanceKm = distanceMeters > 0 ? `≈ ${(distanceMeters / 1000).toFixed(distanceMeters >= 100000 ? 0 : 1)} km` : null;

  const handleSave = () => {
    const entry = {
      id: activeJourney.id,
      from,
      to,
      price: totalFare,
      duration: Math.round(activeJourney.totalDurationSeconds / 60),
      transfers: activeJourney.transfers,
      modes: [...(hasRide ? ['local_ride'] : []), ...new Set(transitLegs.map(leg => vehicleFamilyOf(leg)))],
      journey: activeJourney,
      date: dateOf(activeJourney.departureTime),
      searchUrl: `${location.pathname}${location.search}`
    };
    if (!user) {
      try {
        localStorage.setItem('pending_save_route', JSON.stringify(entry));
      } catch (error) {
        console.error('Failed to store pending route:', error);
      }
      const returnUrl = encodeURIComponent(`${location.pathname}${location.search}`);
      navigate(`/login?reason=save_route&from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}&returnUrl=${returnUrl}`);
      return;
    }
    try {
      const savedRoutes = JSON.parse(localStorage.getItem('saved_routes') || '[]');
      if (!savedRoutes.some((r: { id: string }) => r.id === entry.id)) {
        savedRoutes.push(entry);
        localStorage.setItem('saved_routes', JSON.stringify(savedRoutes));
      }
      setSaved(true);
      setTimeout(() => setSaved(false), 2500);
    } catch (error) {
      console.error('Failed to save route:', error);
    }
  };

  const badges = headerLabels(activeJourney.labels);

  return (
    <article
      aria-label={`Journey option ${index}`}
      className="bg-white border border-[#D9E2DE] rounded-2xl p-4 sm:p-6 shadow-sm transition-colors duration-200 hover:border-[#146B5B]/40"
    >
      {/* 1. What this route is */}
      <header className="flex flex-col-reverse gap-2 sm:flex-row sm:items-start sm:justify-between">
        <h3 className="text-lg md:text-xl font-black leading-snug text-[#1F2933]">{journeyHeading(activeJourney)}</h3>
        {badges.length > 0 && (
          <ul aria-label="Highlights" className="flex shrink-0 flex-wrap gap-1.5">
            {badges.map(label => (
              <li key={label} title={LABELS[label].hint} className={`rounded-full border px-2.5 py-0.5 text-xs font-bold ${LABELS[label].className}`}>
                {LABELS[label].text}
              </li>
            ))}
          </ul>
        )}
      </header>

      {/* Route Corridor & Stops Overview */}
      <div className="mt-2 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-[#667085] font-semibold">
        <span className="text-[#1F2933] font-bold">
          <span className="text-[#667085] font-semibold">From: </span>{corridor.from}
          <span className="mx-1.5 text-[#98A2B3]">➔</span>
          <span className="text-[#667085] font-semibold">To: </span>{corridor.to}
        </span>
        {distanceKm && <span>· {distanceKm}</span>}
        {stopsInfo && <span>· {stopsInfo}</span>}
      </div>

      {/* Horizontal journey timeline with moving dot */}
      <JourneyTimeline journey={activeJourney} from={from} to={to} corridor={corridor} />

      {/* 2. How it goes: the journey strip / slidescroller is hidden per user preference */}
      <section aria-label="Route preview" className="hidden" aria-hidden="true">
        <JourneySimulation journey={activeJourney} from={from} to={to} animate={false} hidden />
      </section>

      {/* Available departure times inside this route card */}
      {availableDepartures.length > 1 && (
        <section aria-label="Available departures" className="mt-4 rounded-xl border border-[#D9E2DE] bg-[#FAFCFB] p-3 sm:p-4 space-y-2">
          <div className="flex flex-wrap items-center justify-between gap-1.5">
            <span className="text-xs font-black uppercase tracking-wider text-[#146B5B] flex items-center gap-1.5">
              <Clock className="h-3.5 w-3.5" />
              Available departures ({availableDepartures.length})
            </span>
            <span className="text-[11px] text-[#667085]">
              Select a departure time
            </span>
          </div>
          <div className="flex flex-wrap gap-2" role="radiogroup" aria-label="Available departure times">
            {availableDepartures.map((option, idx) => {
              const isSelected = option.departureTime === activeJourney.departureTime;
              return (
                <button
                  key={`${option.tripId || option.departureTime}-${idx}`}
                  type="button"
                  role="radio"
                  aria-checked={isSelected}
                  onClick={() => setSelectedTime(option.departureTime)}
                  className={`px-3 py-1.5 rounded-xl text-xs font-bold transition-all cursor-pointer flex items-center gap-1.5 border ${
                    isSelected
                      ? 'bg-[#146B5B] text-white border-[#146B5B] shadow-sm'
                      : 'bg-white text-[#1F2933] border-[#D9DED9] hover:border-[#146B5B] hover:bg-[#F5FAF8]'
                  }`}
                >
                  <span className="tabular-nums">{clockOf(option.departureTime)}</span>
                  <span className={`text-[10px] ${isSelected ? 'text-white/80' : 'text-[#667085]'}`}>
                    (arr {clockOf(option.arrivalTime)})
                  </span>
                  {isSelected && <Check className="h-3 w-3 shrink-0 ml-0.5" />}
                </button>
              );
            })}
          </div>
        </section>
      )}

      {/* 3. The numbers that decide */}
      <dl aria-label="Key facts" className="mt-4 grid grid-cols-2 gap-x-4 gap-y-3 sm:grid-cols-4">
        <Metric label="Total time">{formatDuration(activeJourney.totalDurationSeconds)}</Metric>
        <Metric label="Approx. budget" hint={totalFare ? `${partialFare ? 'Partial estimate: some parts could not be priced. ' : ''}Estimated fare range.` : 'No fare could be estimated for this journey.'}>
          {totalFare ? <>{totalFare}{partialFare && <span aria-label="partial estimate">+</span>}</> : <>—<span className="sr-only"> fare unknown</span></>}
          {/* A train fare is never estimated: say it is extra, rather than letting the bus-only total pass for the whole. */}
          {trainLegs.some(leg => !leg.fare) && <span className="block text-[11px] font-semibold text-[#667085]">+ train fare (not known)</span>}
        </Metric>
        <Metric label="Depart → Arrive">
          {clockOf(activeJourney.departureTime)} → {clockOf(activeJourney.arrivalTime)}
          {extraDays > 0 && <span className="ml-1 text-xs font-bold text-amber-700">+{extraDays}d</span>}
        </Metric>
        <Metric label="Transfers">{transfersText(activeJourney.transfers)}</Metric>
      </dl>

      {/* 4. A few short facts, only when they apply */}
      {(hasRide || walks || activeJourney.waitingDurationSeconds > 0) && (
        <ul aria-label="Journey facts" className="mt-3 flex flex-wrap gap-1.5">
          {(hasRide || walks) && trainLegs.length === 0 && <FactChip title="A generic auto / cab ride to or from a stop; time and fare are estimates.">Local ride included</FactChip>}
          {activeJourney.waitingDurationSeconds > 0 && <FactChip title="Time spent waiting at transfer stops.">Waiting {formatDuration(activeJourney.waitingDurationSeconds)}</FactChip>}
        </ul>
      )}

      {/* 5. Actions */}
      <div className="mt-4 pt-3 flex items-center justify-end gap-2 border-t border-[#EEF1EF]">
        <button
          type="button"
          onClick={handleSave}
          className="inline-flex items-center gap-1.5 rounded-xl border border-[#D9DED9] px-3.5 py-2 text-sm font-bold text-[#1F2933] hover:bg-gray-50 transition-colors cursor-pointer focus:outline-none focus-visible:ring-2 focus-visible:ring-[#146B5B]"
        >
          {saved ? <><Check className="h-4 w-4 text-emerald-600" /> Saved</> : <><Bookmark className="h-4 w-4 text-[#667085]" /> Save</>}
        </button>
        <button
          type="button"
          onClick={() => setShowDetails(!showDetails)}
          aria-expanded={showDetails}
          aria-controls={detailsId}
          className="inline-flex items-center gap-1.5 rounded-xl bg-[#EEF6F3] px-4 py-2 text-sm font-bold text-[#146B5B] hover:bg-[#E0EFE9] transition-colors cursor-pointer focus:outline-none focus-visible:ring-2 focus-visible:ring-[#146B5B]"
        >
          <span>{showDetails ? 'Hide details' : 'More details'}</span>
          {showDetails ? <ChevronUp className="h-4 w-4" /> : <ChevronDown className="h-4 w-4" />}
        </button>
      </div>

      {/* Everything else, organised, only on request */}
      {showDetails && (
        <div id={detailsId} className="mt-4 space-y-6 border-t border-[#EEF1EF] pt-5">
          <DetailSection title="Journey breakdown">
            <div className="rounded-xl bg-[#F7FAF9] px-3 sm:px-5 pt-3">
              {/* Static here: the summary strip above is the card's one moving vehicle. */}
              <JourneySimulation journey={activeJourney} from={from} to={to} detailed animate={false} />
            </div>
            <ol className="space-y-2">
              {visibleLegs.map((leg, i) => {
                const previous = visibleLegs[i - 1];
                const waited = previous ? minutesBetween(previous.arrivalTime, leg.departureTime) : 0;
                const waitAt = isTransitLeg(leg) ? leg.fromStop.name : leg.from.name;
                return (
                  <li key={i} className="space-y-2">
                    {previous && waited > 0 && (
                      <p className="rounded-lg border border-dashed border-[#D9DED9] px-3 py-1.5 text-xs font-semibold text-[#667085]">
                        Wait {formatDuration(waited * 60)} at {waitAt}
                      </p>
                    )}
                    <LegStep leg={leg} step={i + 1} from={from} to={to} isTrainJourney={trainLegs.length > 0} />
                  </li>
                );
              })}
            </ol>
          </DetailSection>

          <div className="grid gap-6 md:grid-cols-2">
            <DetailSection title="Timing">
              <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-sm">
                <Row label="Departure">{clockOf(activeJourney.departureTime)} · {formatDateLabel(dateOf(activeJourney.departureTime))}</Row>
                <Row label="Arrival">{clockOf(activeJourney.arrivalTime)}{extraDays > 0 ? ` · ${formatDateLabel(dateOf(activeJourney.arrivalTime))}` : ''}</Row>
                <Row label="Total time">{formatDuration(activeJourney.totalDurationSeconds)}</Row>
                {onBoardSeconds > 0 && <Row label="On board">{formatDuration(onBoardSeconds)}</Row>}
                {activeJourney.waitingDurationSeconds > 0 && <Row label="Waiting">{formatDuration(activeJourney.waitingDurationSeconds)}</Row>}
                {(hasRide || walks) && <Row label="Local ride">≈ {formatDuration((activeJourney.localRideDurationSeconds || 0) + (activeJourney.walkingDurationSeconds || 0))}</Row>}
              </dl>
            </DetailSection>

            <DetailSection title="Fare breakdown">
              <dl className="grid grid-cols-[1fr_auto] gap-x-4 gap-y-1 text-sm">
                {visibleLegs.filter(leg => !isWalkLeg(leg)).map((leg, i) => {
                  const fare = isWalkLeg(leg) ? null : formatFareRange(leg.fare);
                  return <Row key={i} label={legName(leg, to)}>{fare ?? (isTrainLeg(leg) ? 'Fare unavailable' : 'Not priced')}</Row>;
                })}
                <div className="contents">
                  <dt className="border-t border-[#EEF1EF] pt-1 font-bold text-[#1F2933]">{partialFare ? 'Approx. total (partial)' : 'Approx. total'}</dt>
                  <dd className="border-t border-[#EEF1EF] pt-1 font-black text-[#1F2933] tabular-nums">{totalFare ?? '—'}</dd>
                </div>
              </dl>
              <p className="text-[11px] text-[#667085]">{FARE_DISCLAIMER}</p>
              {trainLegs.length > 0 && <p className="text-[11px] text-[#667085]">{TRAIN_FARE_NOTE}</p>}
            </DetailSection>
          </div>

          {transitLegs.length > 0 && (
            <DetailSection title="Service & tracking">
              <ul aria-label="Vehicles in this journey" className="space-y-3">
                {transitLegs.map((leg, i) => <BusSummaryRow key={`${leg.tripId}-${i}`} leg={leg} hideConfidenceBadges />)}
              </ul>
            </DetailSection>
          )}
        </div>
      )}
    </article>
  );
}

// One step of the journey, in plain words: what to take, where to board and get off, and for how long.
function LegStep({ leg, step, from = '', to = '', isTrainJourney = false }: { leg: Leg; step: number; from?: string; to?: string; isTrainJourney?: boolean }) {
  const base = 'rounded-xl border px-3.5 py-3 space-y-1';
  const fromName = cleanDisplayName(isTransitLeg(leg) ? leg.fromStop?.name : leg.from?.name, from);
  const toName = cleanDisplayName(isTransitLeg(leg) ? leg.toStop?.name : leg.to?.name, to);

  if (isWalkLeg(leg)) {
    return (
      <div className={`${base} border-[#F1D29A] bg-[#FFFBF2]`}>
        <p className="text-sm font-bold text-[#1F2933]"><span aria-hidden>🚕 </span>{step}. {walkText(leg, from, to)}</p>
        <p className="text-sm text-[#1F2933]">{fromName} → <strong>{toName}</strong></p>
        <p className="text-xs text-[#667085]">≈ {formatDuration(leg.durationSeconds)} · about {(leg.distanceMeters / 1000).toFixed(1)} km by road · {clockOf(leg.departureTime)} → {clockOf(leg.arrivalTime)}</p>
      </div>
    );
  }

  if (isLocalRideLeg(leg)) {
    const titleText = isTrainJourney
      ? `Transfer to ${toName}`
      : `${leg.label}${leg.kind === 'egress' ? ' to your destination' : leg.kind === 'transfer' ? ` to ${toName}` : isStation(leg.to) ? ' to the station' : ' to the bus stop'}`;
    return (
      <div className={`${base} border-[#F1D29A] bg-[#FFFBF2]`}>
        <p className="text-sm font-bold text-[#1F2933]"><span aria-hidden>🚕 </span>{step}. {titleText}</p>
        <p className="text-sm text-[#1F2933]">{fromName} → <strong>{toName}</strong></p>
        <p className="text-xs text-[#667085]">
          ≈ {formatDuration(leg.durationSeconds)} including pickup · about {(leg.distanceMeters / 1000).toFixed(1)} km by road · {clockOf(leg.departureTime)} → {clockOf(leg.arrivalTime)}
        </p>
        <RideProviders city={leg.providerCity} options={leg.providerOptions} />
      </div>
    );
  }

  const overnightNote = leg.gtfsArrivalTime && Number(leg.gtfsArrivalTime.slice(0, 2)) >= 24
    ? `Scheduled as ${leg.gtfsArrivalTime.slice(0, 5)} on the ${formatDateLabel(leg.serviceDate)} service day (after midnight).`
    : null;
  return (
    <div className={`${base} border-[#CFE3DC] bg-[#F5FAF8]`}>
      <p className="text-sm font-bold text-[#1F2933]"><span aria-hidden>{FAMILY_ICON[vehicleFamilyOf(leg)]} </span>{step}. {legName(leg)}</p>
      <p className="text-sm text-[#1F2933]"><strong className="tabular-nums">{clockOf(leg.departureTime)}</strong> board at <strong>{leg.fromStop.name}</strong></p>
      <p className="text-sm text-[#1F2933]">
        <strong className="tabular-nums">{clockOf(leg.arrivalTime)}</strong> get off at <strong>{leg.toStop.name}</strong>
        {dateOf(leg.arrivalTime) !== dateOf(leg.departureTime) && <span className="ml-1 text-xs font-bold text-amber-700">(next day)</span>}
      </p>
      <p className="text-xs text-[#667085]">
        {formatDuration(leg.durationSeconds)} on board · {leg.intermediateStopCount} stop{leg.intermediateStopCount === 1 ? '' : 's'} in between
        {showHeadsign(leg) && ` · towards ${leg.headsign}`}
        {leg.daysOfOperation && leg.daysOfOperation.length > 0 && leg.daysOfOperation.length < 7 && ` · Runs ${leg.daysOfOperation.join(', ')}`}
      </p>
      {overnightNote && <p className="text-[11px] text-[#667085]">{overnightNote}</p>}
      {isTrainLeg(leg) && leg.scheduleEvidence && <TrainEvidence leg={leg} />}
    </div>
  );
}

// The timetable facts behind a train leg, exactly as the source gives them: train number and name, station codes, stop
// positions, scheduled clock times with the journey day, running days and the snapshot the schedule comes from.
function TrainEvidence({ leg }: { leg: TransitLeg }) {
  const e = leg.scheduleEvidence!;
  const days = leg.daysOfOperation && leg.daysOfOperation.length === 7 ? 'Daily' : leg.daysOfOperation?.join(', ') ?? null;
  const day = (n: number) => (n > 1 ? ` (day ${n})` : '');
  return (
    <dl aria-label="Schedule evidence" className="mt-2 grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5 rounded-lg bg-white/70 px-3 py-2 text-[11px] text-[#475467]">
      <dt className="text-[#667085]">Train</dt>
      <dd className="font-semibold text-[#1F2933]">{e.trainNumber}{e.trainName ? ` ${e.trainName}` : ''}</dd>
      <dt className="text-[#667085]">Scheduled</dt>
      <dd className="tabular-nums">{e.fromCode} {e.scheduledDeparture}{day(e.departureRunDay)} → {e.toCode} {e.scheduledArrival}{day(e.arrivalRunDay)}</dd>
      {e.boardStopNumber !== null && e.alightStopNumber !== null && e.totalStops !== null ? (
        <><dt className="text-[#667085]">Stops</dt><dd>Stop {e.boardStopNumber} to {e.alightStopNumber} of {e.totalStops}{e.distanceKm ? ` · about ${e.distanceKm} km` : ''}</dd></>
      ) : (e.haltsBetween !== null && e.haltsBetween !== undefined) || e.distanceKm ? (
        <><dt className="text-[#667085]">Stops</dt><dd>{e.haltsBetween !== null && e.haltsBetween !== undefined ? `${e.haltsBetween} halt${e.haltsBetween === 1 ? '' : 's'} in between` : ''}{e.haltsBetween !== null && e.haltsBetween !== undefined && e.distanceKm ? ' · ' : ''}{e.distanceKm ? `about ${e.distanceKm} km` : ''}</dd></>
      ) : null}
      {days && (<><dt className="text-[#667085]">Runs</dt><dd>{days} from {leg.fromStop.name}</dd></>)}
      <dt className="text-[#667085]">This run</dt>
      <dd>Leaves its first station on {formatDateLabel(e.runStartDate)}</dd>
      <dt className="text-[#667085]">Source</dt>
      <dd>{leg.source?.name ?? 'Railway timetable'}{e.snapshotDate ? `, snapshot ${formatDateLabel(e.snapshotDate)}` : ''} · scheduled, not live</dd>
    </dl>
  );
}

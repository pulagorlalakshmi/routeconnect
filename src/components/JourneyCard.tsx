import { useId, useState } from 'react';
import type { ReactNode } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { Bookmark, Check, ChevronDown, ChevronUp } from 'lucide-react';
import { useAuth } from '../context/AuthContext';
import { isLocalRideLeg, isTransitLeg, isWalkLeg, TransitLeg } from '../services/planService';
import type { DataConfidence, Journey, JourneyLabel, Leg } from '../services/planService';
import { clockOf, dateOf, dayDifference, formatDateLabel, formatDuration } from '../utils/dateTime';
import { formatFareRange } from '../utils/fare';
import { operatorBusName, serviceNumberOf, vehicleFamilyOf, vehicleTitleOf } from '../utils/busIdentity';
import { headerLabels } from '../utils/journeyBadges';
import { journeyTrustSummary } from '../utils/trackingTrust';
import { BusSummaryRow } from './BusIdentity';
import PathRating from './PathRating';
import JourneySimulation from './JourneySimulation';
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
  inferred: { text: 'Inferred schedule', hint: 'The timetable does not cover this date (or some stop times are interpolated), so the weekly pattern is assumed to repeat. Confirm before travelling.', className: 'bg-amber-50 border-amber-300 text-amber-900' },
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

// In this feed a headsign is often just the route number again; only a real destination name is worth showing.
const showHeadsign = (leg: TransitLeg) => Boolean(leg.headsign) && !/^\d+$/.test(leg.headsign!.trim()) && leg.headsign!.trim() !== serviceNumberOf(leg) && leg.headsign!.trim() !== leg.routeCode;

function walkText(leg: Extract<Leg, { mode: 'walk' }>): string {
  if (leg.kind === 'access') return `Walk to ${leg.to.name}`;
  if (leg.kind === 'egress') return 'Walk to your destination';
  return `Walk between stops: ${leg.from.name} → ${leg.to.name}`;
}

function legName(leg: Leg): string {
  if (isWalkLeg(leg)) return 'Walk';
  if (isLocalRideLeg(leg)) return leg.kind === 'egress' ? 'Local ride to your destination' : 'Local ride to the stop';
  const number = serviceNumberOf(leg) ?? leg.trainNumber ?? leg.flightNumber ?? null;
  return `${vehicleTitleOf(leg)}${number ? ` ${number}` : ''}`;
}

const FARE_DISCLAIMER = 'Estimated from route distance and available transit data. Service class is not in the dataset, so the actual fare may vary.';

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

export default function JourneyCard({ journey, index, from, to, initialShowDetails = false }: { journey: Journey; index: number; from: string; to: string; initialShowDetails?: boolean }) {
  const { user } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();
  const [showDetails, setShowDetails] = useState(initialShowDetails);
  const [saved, setSaved] = useState(false);
  const detailsId = `journey-details-${useId()}`;

  // Walks of a few seconds (the origin/destination is essentially at the stop) are noise in the step list.
  const visibleLegs = journey.legs.filter(leg => !(isWalkLeg(leg) && leg.durationSeconds < 30));
  const transitLegs = journey.legs.filter(isTransitLeg);
  const extraDays = dayDifference(journey.departureTime, journey.arrivalTime);
  const walks = journey.walkingDurationSeconds >= 30;
  const hasRide = journey.localRideCount > 0;
  const totalFare = journey.fareEstimate && journey.fareEstimate.min !== null ? formatFareRange(journey.fareEstimate) : null;
  const partialFare = Boolean(journey.fareEstimate && !journey.fareEstimate.complete);
  const onBoardSeconds = transitLegs.reduce((sum, leg) => sum + leg.durationSeconds, 0);
  const extrapolated = transitLegs.filter(leg => leg.scheduleBasis === 'extrapolated_weekly_pattern');

  const handleSave = () => {
    const entry = {
      id: journey.id,
      from,
      to,
      price: null, // fares are estimated ranges, so no single price is stored
      duration: Math.round(journey.totalDurationSeconds / 60),
      transfers: journey.transfers,
      modes: hasRide ? ['local_ride', 'bus'] : ['bus']
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

  const badges = headerLabels(journey.labels);

  return (
    <article
      aria-label={`Journey option ${index}`}
      className="bg-white border border-[#D9E2DE] rounded-2xl p-4 sm:p-6 shadow-sm transition-colors duration-200 hover:border-[#146B5B]/40"
    >
      {/* 1. What this route is */}
      <header className="flex flex-col-reverse gap-2 sm:flex-row sm:items-start sm:justify-between">
        <h3 className="text-lg md:text-xl font-black leading-snug text-[#1F2933]">{journeyTitle(journey)}</h3>
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

      {/* 2. How it goes: the journey strip is the centrepiece */}
      <section aria-label="Route preview" className="mt-4 rounded-xl bg-[#F7FAF9] px-3 sm:px-5 pt-3">
        <JourneySimulation journey={journey} />
      </section>

      {/* 3. The numbers that decide */}
      <dl aria-label="Key facts" className="mt-4 grid grid-cols-2 gap-x-4 gap-y-3 sm:grid-cols-4">
        <Metric label="Total time">{formatDuration(journey.totalDurationSeconds)}</Metric>
        <Metric label="Approx. budget" hint={totalFare ? `${partialFare ? 'Partial estimate: some parts could not be priced. ' : ''}Estimated fare range.` : 'No fare could be estimated for this journey.'}>
          {totalFare ? <>{totalFare}{partialFare && <span aria-label="partial estimate">+</span>}</> : <>—<span className="sr-only"> fare unknown</span></>}
        </Metric>
        <Metric label="Depart → Arrive">
          {clockOf(journey.departureTime)} → {clockOf(journey.arrivalTime)}
          {extraDays > 0 && <span className="ml-1 text-xs font-bold text-amber-700">+{extraDays}d</span>}
        </Metric>
        <Metric label="Transfers">{transfersText(journey.transfers)}</Metric>
      </dl>

      {/* 4. A few short facts, only when they apply */}
      {(hasRide || walks || journey.waitingDurationSeconds > 0) && (
        <ul aria-label="Journey facts" className="mt-3 flex flex-wrap gap-1.5">
          {hasRide && <FactChip title="A generic auto / cab ride to or from a stop; time and fare are estimates.">Local ride included</FactChip>}
          {journey.waitingDurationSeconds > 0 && <FactChip title="Time spent waiting at transfer stops.">Waiting {formatDuration(journey.waitingDurationSeconds)}</FactChip>}
          {walks && <FactChip title="Straight-line walking estimate.">Walk {formatDuration(journey.walkingDurationSeconds)}</FactChip>}
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
              <JourneySimulation journey={journey} detailed animate={false} />
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
                    <LegStep leg={leg} step={i + 1} />
                  </li>
                );
              })}
            </ol>
          </DetailSection>

          <div className="grid gap-6 md:grid-cols-2">
            <DetailSection title="Timing">
              <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-sm">
                <Row label="Departure">{clockOf(journey.departureTime)} · {formatDateLabel(dateOf(journey.departureTime))}</Row>
                <Row label="Arrival">{clockOf(journey.arrivalTime)}{extraDays > 0 ? ` · ${formatDateLabel(dateOf(journey.arrivalTime))}` : ''}</Row>
                <Row label="Total time">{formatDuration(journey.totalDurationSeconds)}</Row>
                {onBoardSeconds > 0 && <Row label="On board">{formatDuration(onBoardSeconds)}</Row>}
                {journey.waitingDurationSeconds > 0 && <Row label="Waiting">{formatDuration(journey.waitingDurationSeconds)}</Row>}
                {walks && <Row label="Walking">≈ {formatDuration(journey.walkingDurationSeconds)}</Row>}
                {hasRide && <Row label="Local ride">≈ {formatDuration(journey.localRideDurationSeconds)}</Row>}
              </dl>
            </DetailSection>

            <DetailSection title="Fare breakdown">
              <dl className="grid grid-cols-[1fr_auto] gap-x-4 gap-y-1 text-sm">
                {visibleLegs.filter(leg => !isWalkLeg(leg)).map((leg, i) => {
                  const fare = isWalkLeg(leg) ? null : formatFareRange(leg.fare);
                  return <Row key={i} label={legName(leg)}>{fare ?? 'Not priced'}</Row>;
                })}
                <div className="contents">
                  <dt className="border-t border-[#EEF1EF] pt-1 font-bold text-[#1F2933]">{partialFare ? 'Approx. total (partial)' : 'Approx. total'}</dt>
                  <dd className="border-t border-[#EEF1EF] pt-1 font-black text-[#1F2933] tabular-nums">{totalFare ?? '—'}</dd>
                </div>
              </dl>
              <p className="text-[11px] text-[#667085]">
                {partialFare ? 'Some parts could not be priced and are not included. ' : ''}{FARE_DISCLAIMER}
              </p>
            </DetailSection>
          </div>

          {transitLegs.length > 0 && (
            <DetailSection title="Service & tracking">
              <ul aria-label="Vehicles in this journey" className="space-y-3">
                {transitLegs.map((leg, i) => <BusSummaryRow key={`${leg.tripId}-${i}`} leg={leg} />)}
              </ul>
            </DetailSection>
          )}

          <DetailSection title="Data quality">
            <div className="flex flex-wrap items-center gap-2">
              <ConfidenceBadge level={journey.scheduleConfidence} />
              {journey.timeQuality !== 'exact' && <span className="text-xs text-[#667085]">Approx. stop times</span>}
            </div>
            <ul className="list-disc space-y-1 pl-5 text-xs text-[#667085]">
              {extrapolated.length > 0 && (
                <li>The timetable does not cover {formatDateLabel(extrapolated[0].serviceDate)}; this assumes the weekly pattern repeats.</li>
              )}
              {hasRide && <li>Local ride times and fares are estimates for a generic auto / cab. No ride provider is connected, so availability is not verified.</li>}
              {walks && <li>Walking is estimated from straight-line distance, not road routing.</li>}
              <li>Bus times come from a community-maintained dataset that has not been verified by the operator. Confirm with the operator before travelling.</li>
            </ul>
            {journey.rating && <PathRating rating={journey.rating} isBest={journey.labels.includes('BEST_PATH')} trust={journeyTrustSummary(journey)} />}
          </DetailSection>
        </div>
      )}
    </article>
  );
}

// One step of the journey, in plain words: what to take, where to board and get off, and for how long.
function LegStep({ leg, step }: { leg: Leg; step: number }) {
  const base = 'rounded-xl border px-3.5 py-3 space-y-1';
  if (isWalkLeg(leg)) {
    return (
      <div className={`${base} border-[#E4E9E6] bg-[#FAFBFA]`}>
        <p className="text-sm font-bold text-[#1F2933]"><span aria-hidden>🚶 </span>{step}. {walkText(leg)}</p>
        <p className="text-xs text-[#667085]">≈ {formatDuration(leg.durationSeconds)} · about {Math.round(leg.distanceMeters)} m · {clockOf(leg.departureTime)} → {clockOf(leg.arrivalTime)}</p>
      </div>
    );
  }

  if (isLocalRideLeg(leg)) {
    return (
      <div className={`${base} border-[#F1D29A] bg-[#FFFBF2]`}>
        <p className="text-sm font-bold text-[#1F2933]"><span aria-hidden>🚕 </span>{step}. {leg.label}{leg.kind === 'egress' ? ' to your destination' : ' to the bus stop'}</p>
        <p className="text-sm text-[#1F2933]">{leg.from.name} → <strong>{leg.to.name}</strong></p>
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
    </div>
  );
}

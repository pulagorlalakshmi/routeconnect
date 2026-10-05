import { useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { Bookmark, Check, ChevronDown, ChevronUp } from 'lucide-react';
import { useAuth } from '../context/AuthContext';
import { isLocalRideLeg, isTransitLeg, isWalkLeg } from '../services/planService';
import type { DataConfidence, Journey, JourneyLabel, Leg, TransitLeg } from '../services/planService';
import { clockOf, dateOf, dayDifference, formatDateLabel, formatDuration } from '../utils/dateTime';
import { formatFareRange } from '../utils/fare';

const LABELS: Record<JourneyLabel, { text: string; hint: string; className: string }> = {
  FASTEST: { text: '⚡ Fastest', hint: 'Shortest complete door-to-door travel time.', className: 'bg-amber-100 border-amber-300 text-amber-900' },
  LEAST_TRANSFERS: { text: '🔁 Fewest transfers', hint: 'Fewest bus changes.', className: 'bg-sky-100 border-sky-300 text-sky-900' },
  BEST_BALANCED: { text: '⭐ Best balanced', hint: 'Best mix of travel time, transfers, walking, waiting and local-ride time.', className: 'bg-purple-100 border-purple-300 text-purple-900' },
  LOWER_ESTIMATED_COST: { text: '💰 Lower estimated cost', hint: 'Its estimated fare range is clearly below every other option shown. Estimates are approximate.', className: 'bg-emerald-100 border-emerald-300 text-emerald-900' }
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

const serviceName = (leg: TransitLeg) => leg.routeShortName || leg.routeLongName || leg.routeId;
const minutesBetween = (fromIso: string, toIso: string) => Math.max(0, Math.round((new Date(toIso).getTime() - new Date(fromIso).getTime()) / 60000));

// "🚕 Local ride + 🚌 Bus 03663 → 06378": the multimodal shape of the journey at a glance.
function journeyTitle(journey: Journey): string {
  const parts: string[] = [];
  const buses = journey.legs.filter(isTransitLeg).map(serviceName);
  const first = journey.legs.find(l => isLocalRideLeg(l) && l.kind === 'access');
  const last = journey.legs.find(l => isLocalRideLeg(l) && l.kind === 'egress');
  if (first) parts.push('🚕 Local ride');
  parts.push(`🚌 Bus ${buses.join(' → ')}`);
  if (last) parts.push('🚕 Local ride');
  return parts.join(' + ');
}

function walkText(leg: Extract<Leg, { mode: 'walk' }>): string {
  if (leg.kind === 'access') return `Walk to ${leg.to.name}`;
  if (leg.kind === 'egress') return 'Walk to your destination';
  return `Walk between stops: ${leg.from.name} → ${leg.to.name}`;
}

const FARE_DISCLAIMER = 'Estimated from route distance and available transit data. Actual fare may vary.';

export default function JourneyCard({ journey, index, from, to }: { journey: Journey; index: number; from: string; to: string }) {
  const { user } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();
  const [showDetails, setShowDetails] = useState(false);
  const [saved, setSaved] = useState(false);

  // Walks of a few seconds (the origin/destination is essentially at the stop) are noise in the step list.
  const visibleLegs = journey.legs.filter(leg => !(isWalkLeg(leg) && leg.durationSeconds < 30));
  const extraDays = dayDifference(journey.departureTime, journey.arrivalTime);
  const busCount = journey.legs.filter(isTransitLeg).length;
  const approximate = journey.timeQuality !== 'exact';
  const hasRide = journey.localRideCount > 0;
  const totalFare = journey.fareEstimate && journey.fareEstimate.min !== null ? formatFareRange(journey.fareEstimate) : null;
  const partialFare = Boolean(journey.fareEstimate && !journey.fareEstimate.complete);

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

  return (
    <article
      aria-label={`Journey option ${index}`}
      className={`bg-white border rounded-2xl p-5 md:p-6 shadow-xs transition-all duration-200 ${
        journey.labels.includes('FASTEST') ? 'border-amber-300/90 ring-1 ring-amber-200/50 hover:border-amber-400' : 'border-[#D4DEDA] hover:border-[#146B5B]/50'
      }`}
    >
      {/* Header */}
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3 pb-3.5 border-b border-gray-100">
        <div className="flex items-center gap-2.5 flex-wrap">
          <span className="text-xs font-black uppercase tracking-wider bg-[#146B5B]/10 text-[#146B5B] border border-[#146B5B]/25 px-2.5 py-1 rounded-md">
            Option {index}
          </span>
          <h3 className="text-lg md:text-xl font-black text-[#1F2933]">{journeyTitle(journey)}</h3>
        </div>
        <div className="flex items-center gap-2 flex-wrap">
          {journey.labels.map(label => (
            <span key={label} title={LABELS[label].hint} className={`inline-flex items-center gap-1 border px-2.5 py-1 rounded-full text-xs font-black shadow-2xs ${LABELS[label].className}`}>
              {LABELS[label].text}
            </span>
          ))}
          <ConfidenceBadge level={journey.scheduleConfidence} />
          {hasRide && (
            <span title="A generic local ride (auto / cab) connects you to or from a bus stop. No ride provider is connected." className="inline-flex items-center rounded-full border border-amber-300 bg-amber-50 px-2 py-0.5 text-[11px] font-bold text-amber-900">
              Local ride estimated
            </span>
          )}
        </div>
      </div>

      {/* Key facts */}
      <div className="py-4 grid grid-cols-2 sm:grid-cols-4 gap-4 items-center">
        <div className="space-y-0.5 p-2">
          <span className="text-[11px] font-bold uppercase tracking-wider text-[#667085]">Departs</span>
          <p className="text-base md:text-lg font-black text-[#1F2933]">{clockOf(journey.departureTime)}</p>
        </div>
        <div className="space-y-0.5 p-2">
          <span className="text-[11px] font-bold uppercase tracking-wider text-[#667085]">Arrives</span>
          <p className="text-base md:text-lg font-black text-[#1F2933]">
            {clockOf(journey.arrivalTime)}
            {extraDays > 0 && <span className="ml-1.5 text-xs font-bold text-amber-700">+{extraDays} day{extraDays > 1 ? 's' : ''}</span>}
          </p>
        </div>
        <div className="space-y-0.5 p-2">
          <span className="text-[11px] font-bold uppercase tracking-wider text-[#667085]">Travel time</span>
          <p className="text-base md:text-lg font-black text-[#1F2933]">{formatDuration(journey.totalDurationSeconds)}</p>
          {hasRide && <p className="text-[10px] font-semibold text-amber-800">includes estimated ride</p>}
        </div>
        <div className="space-y-0.5 p-2">
          <span className="text-[11px] font-bold uppercase tracking-wider text-[#667085]">Transfers</span>
          <p className="text-base md:text-lg font-black text-[#1F2933]">
            {journey.transfers === 0 ? 'Direct (0)' : `${journey.transfers} transfer${journey.transfers === 1 ? '' : 's'}`}
          </p>
        </div>
      </div>

      {/* Approximate fare: always a range, always labelled as an estimate */}
      <div className="rounded-xl border border-[#E4E9E6] bg-[#F8FAF9] px-4 py-3 mb-3">
        {totalFare ? (
          <>
            <div className="flex items-baseline justify-between gap-2 flex-wrap">
              <span className="text-[11px] font-bold uppercase tracking-wider text-[#667085]">{partialFare ? 'Approx. fare (partial)' : 'Approx. total fare'}</span>
              <span className="text-lg font-black text-[#1F2933]">{totalFare} <span className="text-xs font-bold text-amber-800">estimated</span></span>
            </div>
            <p className="mt-1 text-[11px] text-[#667085]">
              {partialFare ? 'Some parts of this journey could not be priced and are not included. ' : ''}{FARE_DISCLAIMER}
            </p>
          </>
        ) : (
          <p className="text-xs font-semibold text-[#667085]" title="No fare could be estimated for this journey.">💳 Fare not available</p>
        )}
      </div>

      <div className="flex flex-wrap items-center gap-x-5 gap-y-1 text-xs font-semibold text-[#667085] pb-3">
        {hasRide && <span title="Estimated from road distance and an assumed speed; not live or traffic-aware.">🚕 Local ride ≈ {formatDuration(journey.localRideDurationSeconds)} (approx.)</span>}
        <span>🚶 Walking {journey.walkingDurationSeconds >= 30 ? `≈ ${formatDuration(journey.walkingDurationSeconds)} (estimated)` : 'none'}</span>
        <span>⏳ Waiting {journey.waitingDurationSeconds > 0 ? formatDuration(journey.waitingDurationSeconds) : 'none'}</span>
        {approximate && <span title="This dataset publishes approximate stop times, not exact timepoints.">🕒 Approximate stop times</span>}
      </div>
      <p className="text-[11px] font-semibold text-[#667085] pb-3">
        Schedule: {CONFIDENCE[journey.scheduleConfidence]?.text ?? 'Unverified'}
        {hasRide && ' · Local transport: Estimated (availability not verified)'}
      </p>

      {/* Action row */}
      <div className="pt-3 flex items-center justify-between border-t border-gray-100 flex-wrap gap-2">
        <div className="text-xs text-[#667085] font-medium flex items-center gap-1.5 truncate">
          <span className="font-bold text-gray-800">{from}</span>
          <span className="text-gray-400">➔</span>
          <span className="font-bold text-gray-800">{to}</span>
          <span className="text-gray-500 text-[11px] ml-1">· {busCount} bus{busCount === 1 ? '' : 'es'}{hasRide ? ` + ${journey.localRideCount} local ride${journey.localRideCount === 1 ? '' : 's'}` : ''}</span>
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={handleSave}
            className="inline-flex items-center gap-1.5 rounded-xl border border-[#D9DED9] px-3 py-2 text-xs font-bold text-[#1F2933] hover:bg-gray-50 transition-colors cursor-pointer"
          >
            {saved ? <><Check className="h-4 w-4 text-emerald-600" /> Saved</> : <><Bookmark className="h-4 w-4 text-[#667085]" /> Save</>}
          </button>
          <button
            onClick={() => setShowDetails(!showDetails)}
            className="inline-flex items-center gap-1.5 rounded-xl bg-[#F0F4F2] px-4 py-2 text-xs font-bold text-[#146B5B] hover:bg-[#E2EBE6] transition-colors cursor-pointer"
            aria-expanded={showDetails}
          >
            <span>{showDetails ? 'Hide Details' : 'Show Details'}</span>
            {showDetails ? <ChevronUp className="h-4 w-4" /> : <ChevronDown className="h-4 w-4" />}
          </button>
        </div>
      </div>

      {/* Step by step */}
      {showDetails && (
        <div className="mt-6 pt-6 border-t border-gray-200 space-y-4">
          <h4 className="text-xs font-black uppercase tracking-wider text-[#667085]">🗺 Step-by-step journey</h4>
          <ol className="relative space-y-4 border-l-2 border-gray-200 pl-6 ml-2">
            {visibleLegs.map((leg, i) => {
              if (isWalkLeg(leg)) {
                return (
                  <li key={i} className="relative bg-gray-50 border border-gray-200 rounded-xl p-4 space-y-1">
                    <span className="absolute -left-[34px] top-4 flex h-6 w-6 items-center justify-center rounded-full bg-slate-500 text-white text-xs border-2 border-white">🚶</span>
                    <p className="text-sm font-bold text-[#1F2933]">{walkText(leg)}</p>
                    <p className="text-xs text-[#667085]">
                      ≈ {formatDuration(leg.durationSeconds)} · about {Math.round(leg.distanceMeters)} m · {clockOf(leg.departureTime)} → {clockOf(leg.arrivalTime)}
                    </p>
                    <p className="text-[11px] font-semibold text-amber-800">Estimated from straight-line distance, not road routing.</p>
                  </li>
                );
              }

              if (isLocalRideLeg(leg)) {
                const fare = formatFareRange(leg.fare);
                return (
                  <li key={i} className="relative bg-amber-50/50 border border-amber-200 rounded-xl p-4 space-y-1.5">
                    <span className="absolute -left-[34px] top-4 flex h-6 w-6 items-center justify-center rounded-full bg-amber-500 text-white text-xs border-2 border-white">🚕</span>
                    <div className="flex items-center justify-between gap-2 flex-wrap">
                      <p className="text-sm font-black text-[#1F2933]">{leg.label}{leg.kind === 'egress' ? ' to your destination' : ' to the bus stop'}</p>
                      <ConfidenceBadge level="estimated" />
                    </div>
                    <p className="text-sm text-[#1F2933]">{leg.from.name} → <strong>{leg.to.name}</strong></p>
                    <p className="text-xs text-[#667085]">
                      Approx. duration ≈ {formatDuration(leg.durationSeconds)} (about {(leg.distanceMeters / 1000).toFixed(1)} km by road, including pickup) · {clockOf(leg.departureTime)} → {clockOf(leg.arrivalTime)}
                    </p>
                    {fare && <p className="text-sm font-bold text-[#1F2933]">Approx. fare {fare} <span className="text-xs font-semibold text-amber-800">estimated</span></p>}
                    <p className="text-[11px] font-semibold text-amber-800">
                      Availability not verified. A generic auto / cab estimate: no ride provider is connected, and duration and fare are approximate.
                    </p>
                  </li>
                );
              }

              // Timetable bus
              const previous = visibleLegs[i - 1];
              const waited = previous ? minutesBetween(previous.arrivalTime, leg.departureTime) : 0;
              const overnightNote = leg.gtfsArrivalTime && Number(leg.gtfsArrivalTime.slice(0, 2)) >= 24
                ? `Scheduled as ${leg.gtfsArrivalTime.slice(0, 5)} on the ${formatDateLabel(leg.serviceDate)} service day (after midnight).`
                : null;
              const busFare = formatFareRange(leg.fare);
              return (
                <li key={i} className="space-y-3">
                  {previous && waited > 0 && (
                    <div className="text-xs font-semibold text-[#667085] bg-white border border-dashed border-gray-300 rounded-lg px-3 py-2">
                      ⏳ Wait {formatDuration(waited * 60)} at {leg.fromStop.name} for the next bus
                    </div>
                  )}
                  <div className="relative bg-emerald-50/40 border border-emerald-200 rounded-xl p-4 space-y-2">
                    <span className="absolute -left-[34px] top-4 flex h-6 w-6 items-center justify-center rounded-full bg-[#146B5B] text-white text-xs border-2 border-white">🚌</span>
                    <div className="flex items-center justify-between gap-2 flex-wrap">
                      <p className="text-sm font-black text-[#1F2933]">Bus service {serviceName(leg)}</p>
                      <ConfidenceBadge level={leg.dataConfidence} />
                    </div>
                    <p className="text-sm text-[#1F2933]">
                      <strong>{clockOf(leg.departureTime)}</strong> board at <strong>{leg.fromStop.name}</strong>
                    </p>
                    <p className="text-sm text-[#1F2933]">
                      <strong>{clockOf(leg.arrivalTime)}</strong> get off at <strong>{leg.toStop.name}</strong>
                      {dateOf(leg.arrivalTime) !== dateOf(leg.departureTime) && <span className="ml-1 text-xs font-bold text-amber-700">(next day)</span>}
                    </p>
                    <p className="text-xs text-[#667085]">
                      {formatDuration(leg.durationSeconds)} on board · {leg.intermediateStopCount} stop{leg.intermediateStopCount === 1 ? '' : 's'} in between
                      {leg.timeQuality !== 'exact' && ` · ${leg.timeQuality} stop times`}
                    </p>
                    {busFare && (
                      <>
                        <p className="text-sm font-bold text-[#1F2933]">Approx. bus fare {busFare} <span className="text-xs font-semibold text-amber-800">estimated</span></p>
                        <p className="text-[11px] text-[#667085]">Service class is not available in the current dataset; actual fare may vary.</p>
                      </>
                    )}
                    {leg.scheduleBasis === 'extrapolated_weekly_pattern' && (
                      <p className="text-[11px] font-semibold text-amber-800">
                        The timetable does not cover {formatDateLabel(leg.serviceDate)}; this assumes the weekly pattern repeats.
                      </p>
                    )}
                    {overnightNote && <p className="text-[11px] font-semibold text-slate-600">{overnightNote}</p>}
                  </div>
                </li>
              );
            })}
          </ol>
          <p className="text-[11px] text-[#667085]">
            Bus times come from a community-maintained dataset that has not been verified by the operator. Confirm with the operator before travelling.
          </p>
        </div>
      )}
    </article>
  );
}

import { useState, useEffect, useMemo, useRef } from 'react';
import type { ReactNode } from 'react';
import { Link, useSearchParams, useNavigate } from 'react-router-dom';
import Navbar from '../components/Navbar';
import JourneyCard from '../components/JourneyCard';
import { useAuth } from '../context/AuthContext';
import { recordSearchTrip } from '../utils/tripHistory';
import { groupJourneysByRoute } from '../utils/routeGrouping';
import type { SourceReport } from '../services/planService';

// One compact line saying which modes were searched, so a bus-only result is never mistaken for "no trains exist".
const MODE_NAME: Record<string, string> = { bus: 'Buses', rail: 'Scheduled trains', air: 'Flights' };
function sourceState(source: SourceReport): string {
  if (source.status === 'ok') return source.count > 0 ? `${source.count} found` : 'none found';
  if (source.status === 'not_configured') return 'no data source yet';
  if (source.status === 'not_applicable') return 'not relevant for this trip';
  if (source.status === 'timeout') return 'timed out';
  return 'unavailable';
}
function SourcesLine({ sources }: { sources: SourceReport[] }) {
  const parts = sources.filter(source => source.id !== 'private_bus' || source.status === 'ok');
  const privateBus = sources.find(source => source.id === 'private_bus');
  return (
    <p aria-label="Sources searched" className="text-[11px] text-[#667085]">
      {parts.map((source, i) => (
        <span key={source.id} title={source.message ?? source.label}>
          {i > 0 && ' · '}
          {source.id === 'gtfs' ? `${source.label} buses` : MODE_NAME[source.mode] ?? source.label}: {sourceState(source)}
        </span>
      ))}
      {privateBus && privateBus.status !== 'ok' && <span title={privateBus.message ?? undefined}> · Private buses: no licensed source</span>}
    </p>
  );
}
function Notice({ children, title }: { children: ReactNode; title?: string }) {
  return (
    <li title={title} className="flex items-start gap-2 rounded-lg bg-white/70 border border-[#E4E9E6] px-3 py-2 text-xs font-medium text-[#475467]">
      <Info aria-hidden className="mt-px h-3.5 w-3.5 shrink-0 text-[#98A2B3]" />
      <span>{children}</span>
    </li>
  );
}
import RouteDiscovery from '../components/RouteDiscovery';
import { EstimatedRailHeading, EstimatedRailList, useRailExplorer } from '../components/EstimatedRailSection';
import EstimatedRailResults from './EstimatedRailResults';
import { useCapabilities } from '../services/capabilities';
import { PlanError } from '../services/planService';
import { planKey, planParamsFromSearch, recallPlan, runPlanSearch } from '../services/planRequest';
import type { FailureCode, Journey, PlanResponse } from '../services/planService';
import { addMinutes, clockOf, dateOf, formatDateLabel, nowLocalHHMM, todayLocalIso } from '../utils/dateTime';
import { SlidersHorizontal, ArrowUpDown, X, Filter, ChevronLeft, Info, FileText, ArrowRight } from 'lucide-react';
import { comparableFare, compareJourneysFor, journeyMatchesModes, legTransportMode, modeSummary, readExploreParam, readPreferenceParams, readViewParam, TRANSPORT_MODES, writePreferenceParams } from '../utils/travelPreferences';
import type { RankingPreference } from '../utils/travelPreferences';

type SortKey = 'recommended' | 'earliest' | 'arrival' | 'fastest' | 'transfers' | 'cost';

const SORT_OPTIONS: { id: SortKey; label: string }[] = [
  { id: 'recommended', label: '⭐ Best overall' },
  { id: 'earliest', label: '🌅 Earliest departure' },
  { id: 'arrival', label: '🏁 Earliest arrival' },
  { id: 'fastest', label: '⚡ Fastest' },
  { id: 'transfers', label: '🔄 Fewest transfers' },
  { id: 'cost', label: '💰 Lowest estimated cost' }
];

// Plain wording for the subtle "Sorted by" line under the search summary.
const SORT_LABEL: Record<SortKey, string> = {
  // Same words as the preference dialog's "Show first" choices.
  recommended: 'Best overall', earliest: 'Earliest departure', arrival: 'Earliest arrival',
  fastest: 'Fastest', transfers: 'Fewest transfers', cost: 'Lowest estimated cost'
};

// General explanations live on the Data & policies page; only notes about THIS search stay on the results page.
const SEARCH_SPECIFIC_INFO = new Set(['ORIGIN_DESTINATION_WALKABLE', 'SEARCH_WINDOW_EXPANDED', 'LOCAL_RIDE_HEAVY', 'RAIL_SCHEDULED_ONLY', 'MIXED_ONLY']);

// The preference step's "Show first" choice (URL `rank`) IS the sort for these four keys; choosing one of them here
// writes it back to the URL, so refresh, back/forward and "later departures" keep it. Earliest departure / arrival are
// view-only orderings of the same list.
const SORT_FOR_RANKING: Record<RankingPreference, SortKey> = { best: 'recommended', fastest: 'fastest', cost: 'cost', transfers: 'transfers' };
const RANKING_FOR_SORT: Partial<Record<SortKey, RankingPreference>> = { recommended: 'best', fastest: 'fastest', cost: 'cost', transfers: 'transfers' };

const NOTICE_HIDDEN = new Set([
  'SEARCH_DATE_OUTSIDE_FEED_VALIDITY',
  'FEED_EXPIRED',
  'NO_JOURNEY_FOUND',
  'RAIL_SNAPSHOT_STALE',
  'RAIL_SCHEDULED_ONLY'
]);

// Plain-language reason for an empty result. The backend knows more; users do not need the internals.
function noRouteMessage(code?: FailureCode): string | null {
  switch (code) {
    case 'NO_ACCESS_CANDIDATE':
    case 'NO_TIMETABLE_SERVICE':
      return 'No timetable service found from nearby transit hubs.';
    case 'NO_DESTINATION_EGRESS':
      return 'No destination-side transit coverage is available in the current dataset.';
    case 'DATASET_COVERAGE_LIMITATION':
      return 'Current dataset may not cover this area.';
    default:
      return null;
  }
}

const finiteOrNull = (text: string | null) => {
  if (text === null || text.trim() === '') return null;
  const value = Number(text);
  return Number.isFinite(value) ? value : null;
};

const departureSlot = (journey: Journey): 'morning' | 'afternoon' | 'evening' | 'night' => {
  const hour = Number(clockOf(journey.departureTime).slice(0, 2));
  if (hour >= 6 && hour < 12) return 'morning';
  if (hour >= 12 && hour < 17) return 'afternoon';
  if (hour >= 17 && hour < 21) return 'evening';
  return 'night';
};

// The results page shows one of two experiences, never mixed: estimated rail connections only ("Estimated rail"), or
// timetable journeys with, for "No preference", estimated rail connections in their own section below.
export default function SearchResults() {
  const [searchParams] = useSearchParams();
  return readViewParam(searchParams) === 'estimated_rail' ? <EstimatedRailResults /> : <PlannedResults />;
}

function PlannedResults() {
  const { user, sessionId } = useAuth();
  const [searchParams, setSearchParams] = useSearchParams();
  const navigate = useNavigate();

  const from = searchParams.get('from') || '';
  const to = searchParams.get('to') || '';
  const date = searchParams.get('date') || todayLocalIso();
  const time = searchParams.get('time') || nowLocalHHMM();

  useEffect(() => {
    if (from.trim() && to.trim() && date) {
      recordSearchTrip({ from, to, date, time }, user, sessionId);
    }
  }, [from, to, date, time, user, sessionId]);
  const fromLat = finiteOrNull(searchParams.get('fromLat'));
  const fromLng = finiteOrNull(searchParams.get('fromLng'));
  const toLat = finiteOrNull(searchParams.get('toLat'));
  const toLng = finiteOrNull(searchParams.get('toLng'));
  const preferences = useMemo(() => readPreferenceParams(searchParams, TRANSPORT_MODES), [searchParams]);
  const modesKey = preferences.modes.join(',');
  // The latest URL, read when a request starts (changing only the sort must not trigger a new request).
  const searchParamsRef = useRef(searchParams);
  searchParamsRef.current = searchParams;

  // Seeded synchronously from the search flow's answer, so the first paint is already the results (no loader flash).
  const [initialPlan] = useState(() => recallPlan(planKey(planParamsFromSearch(searchParams))));
  const [loading, setLoading] = useState(initialPlan === null);
  const [error, setError] = useState<PlanError | Error | null>(null);
  const [retryCount, setRetryCount] = useState(0);
  const [plan, setPlan] = useState<PlanResponse | null>(initialPlan);
  const capabilities = useCapabilities();
  // Estimated train suggestions are a FALLBACK: shown for Any transport / Train only while scheduled trains are not
  // working (no provider, or the provider failed for this search). "Bus" never shows them.
  const railSourceReport = plan?.sources?.find(source => source.id === 'rail') ?? null;
  const scheduledTrainsOk = capabilities.train.available && railSourceReport?.status === 'ok';
  const scheduledPending = capabilities.train.available && (loading || !plan);
  const trainOrAny = preferences.modes.length === 0 || (preferences.modes.length === 1 && preferences.modes[0] === 'train');
  const exploreRail = readExploreParam(searchParams) || (trainOrAny && capabilities.estimatedRail.available && !scheduledTrainsOk && !scheduledPending);
  const scheduledFailed = capabilities.train.available && Boolean(railSourceReport) && !scheduledTrainsOk && railSourceReport?.status !== 'not_applicable';
  // Estimated train suggestions are fetched on their own (never through the bus planner) and shown as their own cards.
  const railCoords = fromLat !== null && fromLng !== null && toLat !== null && toLng !== null ? { fromLat, fromLng, toLat, toLng } : null;
  const railState = useRailExplorer(exploreRail ? railCoords : null);
  const railCount = railState.data?.connections?.length ?? 0;
  // All / Bus / Train: a view filter only. Bus journeys are ranked among themselves; train suggestions are never ranked
  // against them (no shared Fastest / Lowest cost / Best path).
  const [typeFilter, setTypeFilter] = useState<'all' | 'bus' | 'train'>('all');
  const isTrainJourney = (journey: Journey) => journey.legs.some(leg => legTransportMode(leg.mode) === 'train');
  const trainJourneyCount = (plan?.journeys ?? []).filter(journey => journeyMatchesModes(journey, preferences.modes) && isTrainJourney(journey)).length;
  const busJourneyCount = (plan?.journeys ?? []).filter(journey => journeyMatchesModes(journey, preferences.modes) && !isTrainJourney(journey)).length;
  const trainOnly = preferences.modes.length === 1 && preferences.modes[0] === 'train';
  // All / Bus / Train tabs belong to Any transport only (a Train search has nothing to switch to).
  const showTabs = preferences.modes.length === 0 && (exploreRail || (trainJourneyCount > 0 && busJourneyCount > 0));
  const showBus = !(typeFilter === 'train' && trainJourneyCount === 0);
  const showRailGroup = exploreRail && typeFilter !== 'bus';
  const [showFilterPanel, setShowFilterPanel] = useState(false);
  const [showSortDropdown, setShowSortDropdown] = useState(false);

  const [viewSort, setViewSort] = useState<'earliest' | 'arrival' | null>(null);
  const sortBy: SortKey = viewSort ?? SORT_FOR_RANKING[preferences.ranking];
  const chooseSort = (key: SortKey) => {
    const ranking = RANKING_FOR_SORT[key];
    if (!ranking) { setViewSort(key as 'earliest' | 'arrival'); return; }
    setViewSort(null);
    setSearchParams(writePreferenceParams({ ...preferences, ranking }, new URLSearchParams(searchParams), TRANSPORT_MODES), { replace: true });
  };
  const [transfers, setTransfers] = useState({ trans0: true, trans1: true, trans2: true, trans3plus: true });
  const [departureTimes, setDepartureTimes] = useState({ morning: true, afternoon: true, evening: true, night: true });
  const [durations, setDurations] = useState({ under2: true, hours2to4: true, hours4to8: true, over8: true });

  useEffect(() => {
    const hasFrom = from.trim() !== '' || (fromLat !== null && fromLng !== null);
    const hasTo = to.trim() !== '' || (toLat !== null && toLng !== null);
    if (!hasFrom || !hasTo) {
      navigate('/dashboard');
      return;
    }

    // Arriving from the search flow: the response is already here (the discovery animation waited for it).
    const params = planParamsFromSearch(searchParamsRef.current);
    const cached = retryCount === 0 ? recallPlan(planKey(params)) : null;
    if (cached) {
      setPlan(cached);
      setError(null);
      setLoading(false);
      return;
    }

    // Refresh, a shared link, "later departures", My Trips: run the request here.
    const controller = new AbortController();
    setLoading(true);
    setError(null);
    runPlanSearch(params, controller.signal)
      .then(response => {
        if (controller.signal.aborted) return;
        setPlan(response);
        setLoading(false);
      })
      .catch(err => {
        if (controller.signal.aborted) return;
        setPlan(null);
        setError(err as Error);
        setLoading(false);
      });
    return () => controller.abort();
  }, [from, to, date, time, fromLat, fromLng, toLat, toLng, modesKey, retryCount, navigate]);

  const handleClearFilters = () => {
    setTransfers({ trans0: true, trans1: true, trans2: true, trans3plus: true });
    setDepartureTimes({ morning: true, afternoon: true, evening: true, night: true });
    setDurations({ under2: true, hours2to4: true, hours4to8: true, over8: true });
  };

  // Transport modes are a hard constraint from the search form, applied before the user's own filters.
  const eligibleJourneys = useMemo(
    () => (plan?.journeys ?? []).filter(journey => journeyMatchesModes(journey, preferences.modes)),
    [plan, preferences]
  );

  const visibleJourneys = useMemo(() => {
    let result = [...eligibleJourneys];

    result = result.filter(journey => {
      const t = journey.transfers;
      if (t === 0) return transfers.trans0;
      if (t === 1) return transfers.trans1;
      if (t === 2) return transfers.trans2;
      return transfers.trans3plus;
    });

    result = result.filter(journey => departureTimes[departureSlot(journey)]);

    result = result.filter(journey => {
      const hours = journey.totalDurationSeconds / 3600;
      if (hours < 2) return durations.under2;
      if (hours < 4) return durations.hours2to4;
      if (hours < 8) return durations.hours4to8;
      return durations.over8;
    });

    // The All / Bus / Train tab only narrows what is shown; it never reorders.
    if (typeFilter === 'bus') result = result.filter(journey => !journey.legs.some(leg => legTransportMode(leg.mode) === 'train'));
    if (typeFilter === 'train') result = result.filter(journey => journey.legs.some(leg => legTransportMode(leg.mode) === 'train'));

    // Same ordering as the server for the four preferences (compareJourneysFor mirrors its comparator); filters only
    // remove journeys, they never reorder them.
    const byDeparture = (a: Journey, b: Journey) => a.departureTime.localeCompare(b.departureTime) || a.arrivalTime.localeCompare(b.arrivalTime);
    const ranking = RANKING_FOR_SORT[sortBy];
    if (ranking) result.sort(compareJourneysFor(ranking));
    else if (sortBy === 'arrival') result.sort((a, b) => a.arrivalTime.localeCompare(b.arrivalTime) || byDeparture(a, b));
    else result.sort(byDeparture);
    return result;
  }, [eligibleJourneys, sortBy, transfers, departureTimes, durations, typeFilter]);

  const showAllModes = () => {
    const params = new URLSearchParams(searchParams);
    params.delete('modes');
    setSearchParams(params);
  };
  const unpricedShown = sortBy === 'cost' && visibleJourneys.some(journey => comparableFare(journey) === null);


  const fromLabel = plan?.resolved?.from?.name ?? from;
  const toLabel = plan?.resolved?.to?.name ?? to;

  const groupedJourneys = useMemo(
    () => groupJourneysByRoute(visibleJourneys, fromLabel, toLabel),
    [visibleJourneys, fromLabel, toLabel]
  );

  // Move the search to just after the last departure shown, to look further ahead.
  const showLaterDepartures = () => {
    if (!plan || plan.journeys.length === 0) return;
    const latest = plan.journeys.reduce((a, b) => (a.departureTime > b.departureTime ? a : b)).departureTime;
    const next = addMinutes(dateOf(latest), clockOf(latest), 1);
    const params = new URLSearchParams(searchParams);
    params.set('date', next.date);
    params.set('time', next.time);
    setSearchParams(params);
  };

  const noticeWarnings = (plan?.warnings ?? []).filter(w => w.severity === 'warning' && !NOTICE_HIDDEN.has(w.code) && !w.code.startsWith('NO_STOPS'));
  const searchNotes = (plan?.warnings ?? []).filter(w => w.severity === 'info' && SEARCH_SPECIFIC_INFO.has(w.code));
  const noRouteDetail = noRouteMessage(plan?.diagnostics?.failureCode);

  // Clear labels: while scheduled trains are not available, every planned journey is a bus journey.
  const journeysHeading = (plan?.journeys ?? []).some(j => j.legs.some(leg => legTransportMode(leg.mode) === 'train')) ? 'Journeys' : 'Bus journeys';

  const busResultsShown = showBus && !loading && !error && Boolean(plan && plan.journeys.length > 0);
  // Estimated train suggestions: their own labelled group, right after the bus journeys (or alone on the Train tab).
  const railGroup = (
    <section aria-labelledby="estimated-rail-heading" className="space-y-4 pt-2">
      {scheduledFailed && (
        <ul aria-label="Scheduled trains" className="space-y-1.5">
          <Notice>Scheduled trains are unavailable for this search{railSourceReport?.message ? ` (${railSourceReport.message})` : ''}. Estimated railway connections are shown instead.</Notice>
        </ul>
      )}
      <EstimatedRailHeading />
      <EstimatedRailList state={railState} />
    </section>
  );

  const checkbox = 'w-4 h-4 rounded text-[#146B5B] border-[#D9DED9] focus:ring-[#146B5B]';

  return (
    <div className="min-h-screen bg-[#F1F4F3] text-[#1F2933] flex flex-col">
      <Navbar />

      <main className="rc-results-enter flex-1 w-full max-w-4xl mx-auto px-4 py-8 space-y-6">
        <button
          onClick={() => navigate('/dashboard')}
          className="inline-flex items-center gap-1 text-xs font-black uppercase text-[#146B5B] hover:text-[#0f5447] transition mb-2"
        >
          <ChevronLeft className="h-4 w-4" /> Back to Search
        </button>

        {/* Search summary */}
        <div className="bg-white border border-[#D9DED9] p-5 md:p-6 rounded-xl shadow-sm flex flex-col md:flex-row md:items-center justify-between gap-4">
          <div>
            <h1 className="text-2xl font-black text-[#1F2933]">{fromLabel} ➔ {toLabel}</h1>
            <p className="text-sm font-semibold text-[#667085] mt-1">
              📅 {formatDateLabel(date)} · 🕒 Departing after {time}
            </p>
            <p aria-label="Search preferences" className="text-xs font-semibold text-[#667085] mt-1.5">
              Preference: {modeSummary(preferences.modes)} · Sorted by: {SORT_LABEL[sortBy]}
            </p>
          </div>

          {showBus && !loading && !error && plan && plan.journeys.length > 0 && (
            <div className="flex items-center gap-2.5 self-start md:self-center">
              <button
                onClick={() => setShowFilterPanel(true)}
                className="inline-flex items-center gap-2 rounded-xl border border-[#D9DED9] bg-white px-4 py-2.5 text-xs font-extrabold text-[#1F2933] hover:bg-gray-50 transition cursor-pointer"
              >
                <SlidersHorizontal className="h-4 w-4 text-[#146B5B]" />
                <span>Filters</span>
              </button>

              <div className="relative">
                <button
                  onClick={() => setShowSortDropdown(!showSortDropdown)}
                  className="inline-flex items-center gap-2 rounded-xl border border-[#D9DED9] bg-white px-4 py-2.5 text-xs font-extrabold text-[#1F2933] hover:bg-gray-50 transition cursor-pointer"
                >
                  <ArrowUpDown className="h-4 w-4 text-[#146B5B]" />
                  <span>Sort</span>
                </button>
                {showSortDropdown && (
                  <div className="absolute right-0 mt-2 w-52 rounded-xl bg-white shadow-lg border border-[#D9DED9] z-30 overflow-hidden">
                    {SORT_OPTIONS.map(option => (
                      <button
                        key={option.id}
                        onClick={() => { chooseSort(option.id); setShowSortDropdown(false); }}
                        className={`w-full text-left px-4 py-2.5 text-xs font-bold transition hover:bg-gray-50 ${sortBy === option.id ? 'bg-[#F4F2ED] text-[#146B5B]' : 'text-[#1F2933]'}`}
                      >
                        {option.label}
                      </button>
                    ))}
                  </div>
                )}
              </div>
            </div>
          )}
        </div>

        {showTabs && (
          <div role="group" aria-label="Show travel options" className="flex flex-wrap items-center gap-2">
            {([
              ['all', 'All'],
              ['bus', `Bus${plan ? ` · ${busJourneyCount}` : ''}`],
              ['train', exploreRail ? `Train${railState.loading ? '' : ` · ${railCount}`} (estimated)` : `Train · ${trainJourneyCount}`]
            ] as const).map(([id, label]) => (
              <button
                key={id}
                type="button"
                aria-pressed={typeFilter === id}
                onClick={() => setTypeFilter(id)}
                className={`rounded-full border px-3.5 py-1.5 text-xs font-extrabold transition focus:outline-none focus-visible:ring-2 focus-visible:ring-[#146B5B] ${typeFilter === id ? 'border-[#146B5B] bg-[#146B5B] text-white' : 'border-[#D9DED9] bg-white text-[#1F2933] hover:bg-gray-50'}`}
              >
                {label}
              </button>
            ))}
          </div>
        )}

        {showBus && loading && (
          <div className="mx-auto w-full max-w-md">
            <RouteDiscovery variant="inline" from={from || 'Your start'} to={to || 'Your destination'} preferences={preferences} state="searching" />
          </div>
        )}

        {/* Errors */}
        {showBus && !loading && error && (
          <div className="bg-white border border-[#D9DED9] rounded-xl p-10 text-center">
            <p className="text-xs uppercase tracking-widest font-extrabold text-red-700">
              {error instanceof PlanError && error.code === 'PLACE_NOT_FOUND' ? 'Place not found' : 'Search unavailable'}
            </p>
            <p className="mt-2 text-xl font-black text-[#1F2933]">
              {error instanceof PlanError && error.code === 'PLACE_NOT_FOUND'
                ? `We couldn't find “${error.query}” among the stops in the transit dataset.`
                : error.message}
            </p>
            <p className="mt-3 text-sm text-[#667085] leading-relaxed max-w-md mx-auto">
              {error instanceof PlanError && error.code === 'PLACE_NOT_FOUND'
                ? 'Choose a suggestion from the list while typing, or try a nearby town or bus stand.'
                : 'Your search is still here. Check the connection, then try again.'}
            </p>
            <div className="mt-6 flex flex-col sm:flex-row justify-center gap-3">
              {!(error instanceof PlanError && error.code === 'PLACE_NOT_FOUND') && (
                <button
                  type="button"
                  onClick={() => setRetryCount(count => count + 1)}
                  className="rounded-lg bg-[#146B5B] px-5 py-2.5 text-sm font-bold text-white hover:bg-[#0f5447] transition"
                >
                  Try again
                </button>
              )}
              <button
                type="button"
                onClick={() => navigate('/dashboard')}
                className="rounded-lg border border-[#D9DED9] px-5 py-2.5 text-sm font-bold text-[#1F2933] hover:bg-gray-50 transition"
              >
                Change search
              </button>
            </div>
          </div>
        )}

        {/* Train only, nothing scheduled: one train-worded line (the estimated fallback below explains an outage itself) */}
        {trainOnly && !loading && !error && plan && plan.journeys.length === 0 && !scheduledFailed && (
          <div className="bg-white border border-[#D9DED9] rounded-xl p-8 text-center" role="status">
            <p className="text-xs uppercase tracking-widest font-extrabold text-[#146B5B]">No scheduled train found</p>
            {/* The server says what was actually checked (and whether the train search was limited); never more than that. */}
            <p className="mt-2 text-lg font-black text-[#1F2933]">{plan.message ?? 'No scheduled train runs between stations near these places for this date and time.'}</p>
            <button type="button" onClick={() => navigate('/dashboard')} className="mt-5 rounded-lg bg-[#146B5B] px-5 py-2.5 text-sm font-bold text-white hover:bg-[#0f5447] transition">
              Change search
            </button>
          </div>
        )}

        {/* No timetable-supported route: nothing is substituted */}
        {showBus && !trainOnly && !loading && !error && plan && plan.journeys.length === 0 && (
          <div className="bg-white border border-[#D9DED9] rounded-xl p-10 text-center" role="status">
            <p className="text-xs uppercase tracking-widest font-extrabold text-[#146B5B]">No route found</p>
            <p className="mt-2 text-xl font-black text-[#1F2933]">
              {plan.message ?? 'No timetable-supported public-transport journey was found within the configured access range.'}
            </p>
            {noRouteDetail && <p className="mt-3 text-sm font-semibold text-[#1F2933]">{noRouteDetail}</p>}
            <p className="mt-3 text-sm text-[#667085] leading-relaxed max-w-md mx-auto">
              Walking and local-ride access to timetable stops were both considered. RouteConnect only shows journeys that include a published bus timetable. Try another date or time, or a nearby town or bus stand.
            </p>
            {plan.datasetWarning && (
              <p className="mt-4 text-xs font-semibold text-amber-800 bg-amber-50 border border-amber-200 rounded-lg px-3 py-2 max-w-xl mx-auto">{plan.datasetWarning}</p>
            )}
            <button
              type="button"
              onClick={() => navigate('/dashboard')}
              className="mt-6 rounded-lg bg-[#146B5B] px-5 py-2.5 text-sm font-bold text-white hover:bg-[#0f5447] transition"
            >
              Change search
            </button>
          </div>
        )}

        {/* Results */}
        {busResultsShown && plan && (
          <div className="space-y-5">
            <div className="flex flex-col sm:flex-row sm:items-end sm:justify-between gap-1 pt-1">
              <h2 className="text-xl font-black text-[#1F2933]">{journeysHeading} ({groupedJourneys.length}{groupedJourneys.length !== visibleJourneys.length ? ` · ${visibleJourneys.length} departure options` : ''})</h2>
              {plan.sources && plan.sources.length > 0 && <SourcesLine sources={plan.sources} />}
            </div>

            {/* Page notices: one short line each, calm styling; the full explanations are on the Data & policies page. */}
            {(noticeWarnings.length > 0 || unpricedShown || searchNotes.length > 0) && (
              <ul aria-label="Notices" className="space-y-1.5">
                {unpricedShown && <Notice>Options without a complete fare estimate are listed last, not treated as cheaper.</Notice>}
                {noticeWarnings.map(w => <Notice key={w.code}>{w.message}</Notice>)}
                {searchNotes.map(w => <Notice key={w.code}>{w.message}</Notice>)}
              </ul>
            )}

            {eligibleJourneys.length === 0 ? (
              <div className="bg-white border border-[#D9DED9] rounded-xl p-10 text-center" role="status">
                <p className="text-lg font-black text-[#1F2933]">No {modeSummary(preferences.modes).toLowerCase()} journeys found</p>
                <p className="mt-1 text-xs text-[#667085]">Other options exist for this trip but do not match your travel preferences.</p>
                <button
                  type="button"
                  onClick={showAllModes}
                  className="mt-4 inline-flex items-center gap-1.5 rounded-lg bg-[#146B5B] px-4 py-2 text-xs font-bold text-white hover:bg-[#0f5447] transition"
                >
                  Show every available mode
                </button>
              </div>
            ) : visibleJourneys.length === 0 ? (
              <div className="bg-white border border-[#D9DED9] rounded-xl p-10 text-center">
                <p className="text-lg font-black text-[#1F2933]">No options match your filters</p>
                <p className="mt-1 text-xs text-[#667085]">Open "Filters" to widen them.</p>
                <button
                  onClick={handleClearFilters}
                  className="mt-4 inline-flex items-center gap-1.5 rounded-lg bg-[#146B5B] px-4 py-2 text-xs font-bold text-white hover:bg-[#0f5447] transition"
                >
                  Reset all filters
                </button>
              </div>
            ) : (
              <div className="space-y-5" aria-label="Journey options">
                {groupedJourneys.map((group, i) => (
                  <JourneyCard
                    key={group.id}
                    journey={group.representativeJourney}
                    departures={group.departures}
                    routeInfo={group}
                    index={i + 1}
                    from={fromLabel}
                    to={toLabel}
                  />
                ))}
              </div>
            )}

            {showRailGroup && railGroup}

            <div className="flex justify-center">
              <button
                onClick={showLaterDepartures}
                className="rounded-xl border border-[#D9DED9] bg-white px-5 py-2.5 text-xs font-extrabold text-[#146B5B] hover:bg-gray-50 transition"
              >
                Show later departures ➔
              </button>
            </div>

            <p className="text-center text-xs text-[#667085]">
              Where these routes, times and fares come from:{' '}
              <Link
                to="/about-data"
                className="inline-flex items-center gap-1 font-bold text-[#146B5B] underline-offset-2 hover:underline focus:outline-none focus-visible:ring-2 focus-visible:ring-[#146B5B] rounded"
              >
                <FileText aria-hidden className="h-3.5 w-3.5" />
                Data &amp; policies
                <ArrowRight aria-hidden className="h-3 w-3" />
              </Link>
            </p>
          </div>
        )}

        {/* Train suggestions when there is no bus list to sit beside (Train tab, bus search still running, failed or empty). */}
        {showRailGroup && !busResultsShown && railGroup}
      </main>

      {/* Filter drawer */}
      {showFilterPanel && (
        <div className="fixed inset-0 z-50 bg-[#1F2933]/55 backdrop-blur-sm flex justify-end items-end md:items-stretch animate-fadeIn">
          <div className="absolute inset-0" onClick={() => setShowFilterPanel(false)} />
          <div className="relative w-full md:max-w-md bg-white rounded-t-2xl md:rounded-t-none md:rounded-l-2xl shadow-xl p-6 overflow-y-auto flex flex-col max-h-[90vh] md:max-h-none z-10 animate-slideUp">
            <div className="flex items-center justify-between border-b border-[#D9DED9] pb-4 mb-5">
              <div className="flex items-center gap-2 text-[#1F2933]">
                <Filter className="h-5 w-5 text-[#146B5B]" />
                <h3 className="text-base font-black">Filters</h3>
              </div>
              <button onClick={() => setShowFilterPanel(false)} className="p-2 hover:bg-gray-50 rounded-full transition" aria-label="Close">
                <X className="h-4.5 w-4.5 text-[#667085]" />
              </button>
            </div>

            <div className="space-y-6 flex-1 pr-1">
              <div className="space-y-2">
                <h4 className="text-xs uppercase font-extrabold tracking-wider text-[#667085]">Transfers</h4>
                <div className="grid grid-cols-2 gap-2.5">
                  {([['trans0', '🔄 0 Transfers (Direct)'], ['trans1', '🔄 1 Transfer'], ['trans2', '🔄 2 Transfers'], ['trans3plus', '🔄 3+ Transfers']] as const).map(([id, label]) => (
                    <label key={id} className="flex items-center gap-2 cursor-pointer text-xs font-bold text-[#1F2933]">
                      <input type="checkbox" checked={transfers[id]} onChange={() => setTransfers(prev => ({ ...prev, [id]: !prev[id] }))} className={checkbox} />
                      {label}
                    </label>
                  ))}
                </div>
              </div>

              <div className="space-y-2">
                <h4 className="text-xs uppercase font-extrabold tracking-wider text-[#667085]">Journey Duration</h4>
                <div className="grid grid-cols-2 gap-2.5">
                  {([['under2', '⏱ Under 2 hours'], ['hours2to4', '⏱ 2–4 hours'], ['hours4to8', '⏱ 4–8 hours'], ['over8', '⏱ More than 8 hours']] as const).map(([id, label]) => (
                    <label key={id} className="flex items-center gap-2 cursor-pointer text-xs font-bold text-[#1F2933]">
                      <input type="checkbox" checked={durations[id]} onChange={() => setDurations(prev => ({ ...prev, [id]: !prev[id] }))} className={checkbox} />
                      {label}
                    </label>
                  ))}
                </div>
              </div>

              <div className="space-y-2">
                <h4 className="text-xs uppercase font-extrabold tracking-wider text-[#667085]">Departure Time</h4>
                <div className="grid grid-cols-2 gap-2.5">
                  {([['morning', '🌅 Morning (6am-12pm)'], ['afternoon', '☀️ Afternoon (12pm-5pm)'], ['evening', '🌙 Evening (5pm-9pm)'], ['night', '🌃 Night (9pm-6am)']] as const).map(([id, label]) => (
                    <label key={id} className="flex items-center gap-2 cursor-pointer text-xs font-bold text-[#1F2933]">
                      <input type="checkbox" checked={departureTimes[id]} onChange={() => setDepartureTimes(prev => ({ ...prev, [id]: !prev[id] }))} className={checkbox} />
                      {label}
                    </label>
                  ))}
                </div>
              </div>
            </div>

            <div className="mt-8 pt-4 border-t border-[#D9DED9] flex gap-4 shrink-0">
              <button type="button" onClick={handleClearFilters} className="flex-1 py-3 border border-[#D9DED9] hover:bg-gray-50 text-[#1F2933] font-bold rounded-xl text-xs transition">
                Clear All
              </button>
              <button type="button" onClick={() => setShowFilterPanel(false)} className="flex-1 py-3 bg-[#146B5B] hover:bg-[#0f5447] text-white font-extrabold rounded-xl text-xs transition shadow-sm">
                Apply Filters
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

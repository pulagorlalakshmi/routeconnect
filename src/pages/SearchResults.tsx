import { useState, useEffect, useMemo } from 'react';
import { useSearchParams, useNavigate } from 'react-router-dom';
import Navbar from '../components/Navbar';
import JourneyCard from '../components/JourneyCard';
import LoadingState from '../components/LoadingState';
import { fetchPlan, PlanError } from '../services/planService';
import type { Journey, PlanResponse } from '../services/planService';
import { addMinutes, clockOf, dateOf, formatDateLabel, nowLocalHHMM, todayLocalIso } from '../utils/dateTime';
import { SlidersHorizontal, ArrowUpDown, X, Filter, ChevronLeft } from 'lucide-react';

// Rural services are sparse, so look several hours ahead of the requested time.
const WINDOW_MINUTES = 360;

type SortKey = 'recommended' | 'earliest' | 'arrival' | 'fastest' | 'transfers';

const SORT_OPTIONS: { id: SortKey; label: string }[] = [
  { id: 'recommended', label: '⭐ Recommended' },
  { id: 'earliest', label: '🌅 Earliest departure' },
  { id: 'arrival', label: '🏁 Earliest arrival' },
  { id: 'fastest', label: '⚡ Shortest duration' },
  { id: 'transfers', label: '🔄 Fewest transfers' }
];

const NOTICE_HIDDEN = new Set(['SEARCH_DATE_OUTSIDE_FEED_VALIDITY', 'FEED_EXPIRED', 'NO_JOURNEY_FOUND']);

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

const labelWeight = (journey: Journey) => {
  if (journey.labels.includes('BEST_BALANCED')) return -100;
  if (journey.labels.includes('FASTEST')) return -70;
  if (journey.labels.includes('LEAST_TRANSFERS')) return -50;
  return 0;
};

export default function SearchResults() {
  const [searchParams, setSearchParams] = useSearchParams();
  const navigate = useNavigate();

  const from = searchParams.get('from') || '';
  const to = searchParams.get('to') || '';
  const date = searchParams.get('date') || todayLocalIso();
  const time = searchParams.get('time') || nowLocalHHMM();
  const fromLat = finiteOrNull(searchParams.get('fromLat'));
  const fromLng = finiteOrNull(searchParams.get('fromLng'));
  const toLat = finiteOrNull(searchParams.get('toLat'));
  const toLng = finiteOrNull(searchParams.get('toLng'));

  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<PlanError | Error | null>(null);
  const [retryCount, setRetryCount] = useState(0);
  const [plan, setPlan] = useState<PlanResponse | null>(null);
  const [showFilterPanel, setShowFilterPanel] = useState(false);
  const [showSortDropdown, setShowSortDropdown] = useState(false);

  const [sortBy, setSortBy] = useState<SortKey>('recommended');
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

    const controller = new AbortController();
    setLoading(true);
    setError(null);
    fetchPlan({
      from,
      to,
      fromCoords: fromLat !== null && fromLng !== null ? { lat: fromLat, lng: fromLng } : null,
      toCoords: toLat !== null && toLng !== null ? { lat: toLat, lng: toLng } : null,
      date,
      time,
      windowMinutes: WINDOW_MINUTES
    }, controller.signal)
      .then(response => {
        setPlan(response);
        setLoading(false);
      })
      .catch(err => {
        if ((err as Error).name === 'AbortError') return;
        setPlan(null);
        setError(err as Error);
        setLoading(false);
      });
    return () => controller.abort();
  }, [from, to, date, time, fromLat, fromLng, toLat, toLng, retryCount, navigate]);

  const handleClearFilters = () => {
    setTransfers({ trans0: true, trans1: true, trans2: true, trans3plus: true });
    setDepartureTimes({ morning: true, afternoon: true, evening: true, night: true });
    setDurations({ under2: true, hours2to4: true, hours4to8: true, over8: true });
  };

  const visibleJourneys = useMemo(() => {
    let result = [...(plan?.journeys ?? [])];

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

    const byDeparture = (a: Journey, b: Journey) => a.departureTime.localeCompare(b.departureTime) || a.arrivalTime.localeCompare(b.arrivalTime);
    result.sort((a, b) => {
      if (sortBy === 'earliest') return byDeparture(a, b);
      if (sortBy === 'arrival') return a.arrivalTime.localeCompare(b.arrivalTime) || byDeparture(a, b);
      if (sortBy === 'fastest') return a.totalDurationSeconds - b.totalDurationSeconds || byDeparture(a, b);
      if (sortBy === 'transfers') return a.transfers - b.transfers || byDeparture(a, b);
      return labelWeight(a) - labelWeight(b) || byDeparture(a, b);
    });
    return result;
  }, [plan, sortBy, transfers, departureTimes, durations]);

  const fromLabel = plan?.resolved?.from?.name ?? from;
  const toLabel = plan?.resolved?.to?.name ?? to;

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
  const infoWarnings = (plan?.warnings ?? []).filter(w => w.severity === 'info');
  const noStopReasons = (plan?.warnings ?? []).filter(w => w.code.startsWith('NO_STOPS'));

  const checkbox = 'w-4 h-4 rounded text-[#146B5B] border-[#D9DED9] focus:ring-[#146B5B]';

  return (
    <div className="min-h-screen bg-[#F1F4F3] text-[#1F2933] flex flex-col">
      <Navbar />

      <main className="flex-1 w-full max-w-4xl mx-auto px-4 py-8 space-y-6">
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
          </div>

          {!loading && !error && plan && plan.journeys.length > 0 && (
            <div className="flex items-center gap-2.5 self-start md:self-center">
              <button
                onClick={() => setShowFilterPanel(true)}
                className="inline-flex items-center gap-2 rounded-xl border border-[#D9DED9] bg-white px-4 py-2.5 text-xs font-extrabold text-[#1F2933] hover:bg-gray-50 transition cursor-pointer"
              >
                <SlidersHorizontal className="h-4 w-4 text-[#146B5B]" />
                <span>Display Options</span>
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
                        onClick={() => { setSortBy(option.id); setShowSortDropdown(false); }}
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

        {loading && <LoadingState label="Searching published bus timetables..." />}

        {/* Errors */}
        {!loading && error && (
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

        {/* No timetable-supported route: nothing is substituted */}
        {!loading && !error && plan && plan.journeys.length === 0 && (
          <div className="bg-white border border-[#D9DED9] rounded-xl p-10 text-center" role="status">
            <p className="text-xs uppercase tracking-widest font-extrabold text-[#146B5B]">No route found</p>
            <p className="mt-2 text-xl font-black text-[#1F2933]">
              {plan.message ?? 'No timetable-supported public-transport journey was found within the configured access range.'}
            </p>
            {noStopReasons.map(reason => (
              <p key={reason.code} className="mt-3 text-sm text-[#667085]">{reason.message}</p>
            ))}
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
        {!loading && !error && plan && plan.journeys.length > 0 && (
          <div className="space-y-5">
            {plan.datasetWarning && (
              <div className="rounded-xl border border-amber-300 bg-amber-50 px-4 py-3 text-sm font-semibold text-amber-900" role="alert">
                ⚠ {plan.datasetWarning}
              </div>
            )}
            {noticeWarnings.map(w => (
              <div key={w.code} className="rounded-xl border border-amber-200 bg-amber-50/70 px-4 py-3 text-sm font-semibold text-amber-900">
                {w.message}
              </div>
            ))}
            {plan.journeys.some(j => j.localRideCount > 0) && (
              <div className="rounded-xl border border-slate-200 bg-slate-50 px-4 py-3 text-sm font-semibold text-slate-800" role="note">
                🚕 Some options include an <strong>estimated local ride</strong> to or from a bus stop. No ride provider is connected, so availability is not verified, and ride time and fare are approximate.
              </div>
            )}

            <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3 pt-1">
              <div>
                <h2 className="text-xl font-black text-[#1F2933]">Bus options ({visibleJourneys.length})</h2>
                <p className="text-xs text-[#667085] mt-0.5 font-medium">
                  From published timetables. Click "Show Details" for each stop and transfer.
                </p>
              </div>
              <span className="text-xs font-bold text-slate-700 bg-slate-50 border border-slate-200 px-3 py-1 rounded-full flex items-center gap-1.5 shadow-2xs self-start">
                <span className="h-2 w-2 rounded-full bg-slate-400"></span>
                Schedule confidence is shown on every option
              </span>
            </div>

            {visibleJourneys.length === 0 ? (
              <div className="bg-white border border-[#D9DED9] rounded-xl p-10 text-center">
                <p className="text-lg font-black text-[#1F2933]">No options match your filters</p>
                <p className="mt-1 text-xs text-[#667085]">Open "Display Options" to widen the filters.</p>
                <button
                  onClick={handleClearFilters}
                  className="mt-4 inline-flex items-center gap-1.5 rounded-lg bg-[#146B5B] px-4 py-2 text-xs font-bold text-white hover:bg-[#0f5447] transition"
                >
                  Reset all filters
                </button>
              </div>
            ) : (
              <div className="space-y-5" aria-label="Journey options">
                {visibleJourneys.map((journey, i) => (
                  <JourneyCard key={journey.id} journey={journey} index={i + 1} from={fromLabel} to={toLabel} />
                ))}
              </div>
            )}

            <div className="flex justify-center">
              <button
                onClick={showLaterDepartures}
                className="rounded-xl border border-[#D9DED9] bg-white px-5 py-2.5 text-xs font-extrabold text-[#146B5B] hover:bg-gray-50 transition"
              >
                Show later departures ➔
              </button>
            </div>

            <details className="rounded-xl border border-[#D9DED9] bg-white px-4 py-3 text-xs text-[#667085]">
              <summary className="cursor-pointer font-bold text-[#1F2933]">About this data</summary>
              <ul className="mt-2 list-disc pl-5 space-y-1">
                {infoWarnings.map(w => <li key={w.code}>{w.message}</li>)}
                <li>Every option contains at least one bus from the timetable. A local ride only connects you to or from a bus stop; ride-only journeys and named ride-hailing services are never shown.</li>
              </ul>
            </details>
          </div>
        )}
      </main>

      {/* Filter drawer */}
      {showFilterPanel && (
        <div className="fixed inset-0 z-50 bg-[#1F2933]/55 backdrop-blur-sm flex justify-end items-end md:items-stretch animate-fadeIn">
          <div className="absolute inset-0" onClick={() => setShowFilterPanel(false)} />
          <div className="relative w-full md:max-w-md bg-white rounded-t-2xl md:rounded-t-none md:rounded-l-2xl shadow-xl p-6 overflow-y-auto flex flex-col max-h-[90vh] md:max-h-none z-10 animate-slideUp">
            <div className="flex items-center justify-between border-b border-[#D9DED9] pb-4 mb-5">
              <div className="flex items-center gap-2 text-[#1F2933]">
                <Filter className="h-5 w-5 text-[#146B5B]" />
                <h3 className="text-base font-black">Display Options</h3>
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

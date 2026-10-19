import { useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { ArrowRight, ChevronLeft, FileText } from 'lucide-react';
import Navbar from '../components/Navbar';
import RouteDiscovery from '../components/RouteDiscovery';
import { EstimatedRailHeading, EstimatedRailList, useRailExplorer } from '../components/EstimatedRailSection';
import { DEFAULT_PREFERENCES } from '../utils/travelPreferences';

// Results for the "Estimated rail" choice: mapped railway corridors with an estimated travel-time range, and nothing
// else. No timetable planning is run. The searched date and time are deliberately NOT shown as if they applied: an
// estimated corridor is not a date-specific train service.

const finiteOrNull = (text: string | null) => {
  if (text === null || text.trim() === '') return null;
  const value = Number(text);
  return Number.isFinite(value) ? value : null;
};

export default function EstimatedRailResults() {
  const [searchParams] = useSearchParams();
  const navigate = useNavigate();
  const [retry, setRetry] = useState(0);
  const from = searchParams.get('from') || 'Your start';
  const to = searchParams.get('to') || 'Your destination';
  const [fromLat, fromLng, toLat, toLng] = ['fromLat', 'fromLng', 'toLat', 'toLng'].map(key => finiteOrNull(searchParams.get(key)));
  const coords = fromLat !== null && fromLng !== null && toLat !== null && toLng !== null ? { fromLat, fromLng, toLat, toLng } : null;
  const state = useRailExplorer(coords, retry);
  const retryable = !state.loading && (state.error !== null || state.data?.state === 'preparing');

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

        <div className="bg-white border border-[#D9DED9] p-5 md:p-6 rounded-xl shadow-sm">
          <h1 className="text-2xl font-black text-[#1F2933]">{from} ➔ {to}</h1>
          <p aria-label="Search preferences" className="text-xs font-semibold text-[#667085] mt-1.5">
            Preference: Train · estimated from mapped railway connections
          </p>
        </div>

        {state.loading ? (
          <div className="mx-auto w-full max-w-md">
            <RouteDiscovery variant="inline" from={from} to={to} preferences={DEFAULT_PREFERENCES} state="searching" estimatedRail />
          </div>
        ) : (
          <section aria-labelledby="estimated-rail-heading" className="space-y-4">
            <EstimatedRailHeading />
            <EstimatedRailList state={state} />
            {retryable && (
              <div className="flex justify-center">
                <button type="button" onClick={() => setRetry(n => n + 1)} className="rounded-lg bg-[#146B5B] px-5 py-2.5 text-sm font-bold text-white hover:bg-[#0f5447] transition">
                  Try again
                </button>
              </div>
            )}
          </section>
        )}

        <p className="text-center text-xs text-[#667085]">
          How estimated rail connections work:{' '}
          <Link to="/about-data#estimated-rail" className="inline-flex items-center gap-1 font-bold text-[#146B5B] underline-offset-2 hover:underline focus:outline-none focus-visible:ring-2 focus-visible:ring-[#146B5B] rounded">
            <FileText aria-hidden className="h-3.5 w-3.5" />
            Data &amp; policies
            <ArrowRight aria-hidden className="h-3 w-3" />
          </Link>
        </p>
      </main>
    </div>
  );
}

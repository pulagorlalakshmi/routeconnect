import { useNavigate } from 'react-router-dom';
import Navbar from '../components/Navbar';
import { ArrowLeft, Bus, MapPin, Route } from 'lucide-react';

export default function About() {
  const navigate = useNavigate();

  return (
    <div className="min-h-screen bg-[#E7F0EC] text-[#1F2933]">
      <Navbar />
      <main className="mx-auto max-w-4xl px-4 py-10 sm:px-6 lg:px-8">
        <button
          onClick={() => navigate(-1)}
          className="mb-10 inline-flex items-center gap-2 text-sm font-bold text-[#146B5B] hover:text-[#0f5447] transition"
        >
          <ArrowLeft className="h-4 w-4" />
          Back
        </button>

        <header className="max-w-2xl border-l-4 border-[#146B5B] pl-5">
          <p className="text-xs font-extrabold uppercase tracking-[0.2em] text-[#146B5B]">About RouteConnect</p>
          <h1 className="mt-3 text-4xl font-black tracking-tight sm:text-5xl">A clearer way to plan the in-between parts.</h1>
          <p className="mt-5 text-base leading-7 text-[#667085]">
            RouteConnect plans public bus journeys from published timetables: when each bus leaves, where to change, and how long the whole trip takes.
          </p>
        </header>

        <section className="mt-12 grid gap-4 sm:grid-cols-3" aria-label="What RouteConnect shows">
          <div className="border border-[#D9DED9] bg-white p-5">
            <Bus className="h-5 w-5 text-[#146B5B]" />
            <h2 className="mt-4 font-black">Published timetables</h2>
            <p className="mt-2 text-sm leading-6 text-[#667085]">Journeys are built from a community-maintained APSRTC timetable dataset, including transfers and services that run past midnight.</p>
          </div>
          <div className="border border-[#D9DED9] bg-white p-5">
            <Route className="h-5 w-5 text-[#146B5B]" />
            <h2 className="mt-4 font-black">Clear about what we know</h2>
            <p className="mt-2 text-sm leading-6 text-[#667085]">Every option shows how reliable its schedule is. Walking and local-ride legs are estimates, and fares are approximate ranges because the dataset has no published fares.</p>
          </div>
          <div className="border border-[#D9DED9] bg-white p-5">
            <MapPin className="h-5 w-5 text-[#146B5B]" />
            <h2 className="mt-4 font-black">The whole journey</h2>
            <p className="mt-2 text-sm leading-6 text-[#667085]">Expand a result to see where to board and get off each bus, any estimated local ride to or from a bus stop, and how long you wait at every transfer.</p>
          </div>
        </section>

        <section className="mt-12 grid gap-8 border-t border-[#D9DED9] pt-10 md:grid-cols-[1fr_240px]">
          <div>
            <h2 className="text-2xl font-black">Built for useful comparisons</h2>
            <div className="mt-4 space-y-4 text-sm leading-7 text-[#667085]">
              <p>Search by town, village, or bus stand. Suggestions come from the stops in the timetable, so every suggestion can actually be routed.</p>
              <p>Results come from a community-maintained dataset that has not been verified by the operator and may be out of date. If no timetable-supported route exists, RouteConnect says so instead of guessing. Confirm the final details with the operator before travelling.</p>
            </div>
          </div>
          <aside className="border border-[#D9DED9] bg-white p-5">
            <MapPin className="h-5 w-5 text-[#146B5B]" />
            <h2 className="mt-4 font-black">Start with a place</h2>
            <p className="mt-2 text-sm leading-6 text-[#667085]">Return to the dashboard whenever you are ready to plan another journey.</p>
            <button
              onClick={() => navigate('/dashboard')}
              className="mt-5 text-sm font-extrabold text-[#146B5B] hover:text-[#0f5447] transition"
            >
              Open planner <span aria-hidden="true">-&gt;</span>
            </button>
          </aside>
        </section>
      </main>
    </div>
  );
}

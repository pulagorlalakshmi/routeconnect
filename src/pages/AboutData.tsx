import { useEffect } from 'react';
import type { ReactNode } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  ArrowLeft, Bus, Car, Clock3, Database, ExternalLink, IndianRupee, Lock, Radio, Search, ShieldCheck, TrainFront
} from 'lucide-react';
import Navbar from '../components/Navbar';
import { DEFAULT_CAPABILITIES, useCapabilities } from '../services/capabilities';
import type { TrainCapability } from '../services/capabilities';

// "Data & policies": quick, concise overview of where routes, times and fares come from.
// Statements remain strictly honest: trains are described as available only when the server has them.

interface Section {
  id: string;
  title: string;
  icon: ReactNode;
  summary: string;
  points: ReactNode[];
}

const icon = (Icon: typeof Bus) => <Icon aria-hidden className="h-5 w-5" />;

const TRAINS_UNAVAILABLE: Section = {
  id: 'trains',
  title: 'Train availability',
  icon: icon(TrainFront),
  summary: 'Train journeys are not available yet, and we never show made-up trains.',
  points: [
    <><strong>No linked timetable</strong>: We only connect licensed public timetables.</>,
    <><strong>Coming soon</strong>: “Train only” and “Bus + Train” unlock when verified feeds are ready.</>,
    <><strong>Official sources</strong>: No train number, name, time or fare is ever generated. For trains, check official NTES (139) or IRCTC.</>
  ]
};

const trainsAvailable = (train: TrainCapability): Section => ({
  id: 'trains',
  title: 'Train availability',
  icon: icon(TrainFront),
  summary: 'Train journeys use scheduled timetable times. They are not live and not official.',
  points: [
    <><strong>Timetable snapshot</strong>: Times from {train.sourceName ?? 'community rail data'}{train.snapshotDate ? <> ({train.snapshotDate})</> : ''}; not live running status.</>,
    <><strong>Confirm before travelling</strong>: Always verify departures on official Indian Railways enquiry services (NTES, 139 or IRCTC).</>,
    <><strong>No fabricated trains</strong>: No train number, name, time or fare is ever generated.</>
  ]
});

export function dataPolicySections(train: TrainCapability = DEFAULT_CAPABILITIES.train): Section[] {
  return BASE_SECTIONS.map(section => {
    if (section.id === 'trains') return train.available ? trainsAvailable(train) : TRAINS_UNAVAILABLE;
    if (section.id === 'sources' && train.available) {
      return { ...section, points: section.points.map((point, i) => (i === 1 ? <><strong>Trains</strong>: an unofficial copy of the Indian Railways timetable (see Train availability below).</> : point)) };
    }
    return section;
  });
}

const BASE_SECTIONS: Section[] = [
  {
    id: 'route-data',
    title: 'About the route data',
    icon: icon(Bus),
    summary: 'Bus journeys are planned from a timetable dataset, not from live vehicle positions.',
    points: [
      <><strong>APSRTC GTFS</strong>: Routes, stops, and transfers come from community timetable data.</>,
      <><strong>Real stops only</strong>: Location suggestions correspond directly to timetable stops.</>,
      <><strong>No guessing</strong>: If no timetable-supported journey exists, we say so instead of guessing.</>
    ]
  },
  {
    id: 'timetable-accuracy',
    title: 'Timetable accuracy',
    icon: icon(Clock3),
    summary: 'Every bus leg carries a schedule confidence level. Confirm times before you travel.',
    points: [
      <><strong>Schedule status</strong>: Published timetable when covered, inferred weekly pattern if older.</>,
      <><strong>Approximate times</strong>: Stop timings are approximate guidelines; allow buffer margin.</>
    ]
  },
  {
    id: 'sources',
    title: 'Data sources',
    icon: icon(Database),
    summary: 'Each search lists which sources were searched and what each one returned.',
    points: [
      <><strong>Buses</strong>: Community APSRTC GTFS timetable dataset.</>,
      <><strong>Trains</strong>: No verified railway timetable is connected (see Train availability below).</>,
      <><strong>Private operators &amp; flights</strong>: Only shown when configured providers exist.</>
    ]
  },
  {
    id: 'fares',
    title: 'Fare estimates',
    icon: icon(IndianRupee),
    summary: 'Fares are approximate ranges, never exact ticket prices.',
    points: [
      <><strong>Distance-based</strong>: Estimated ranges across service classes (ordinary to deluxe).</>,
      <><strong>Incomplete pricing</strong>: Unpriced legs are clearly marked, never counted as free.</>,
      <><strong>Confirm at counter</strong>: Verify final ticket price with the operator or conductor.</>
    ]
  },
  {
    id: 'local-rides',
    title: 'Local ride estimates',
    icon: icon(Car),
    summary: 'A local ride is a generic auto or cab estimate to reach or leave a stop.',
    points: [
      <><strong>First / last mile</strong>: Connects you to and from transit stops; not an on-demand taxi app.</>,
      <><strong>Unverified availability</strong>: Times and fares are estimates; rides are not booked for you.</>
    ]
  },
  {
    id: 'tracking',
    title: 'Live tracking',
    icon: icon(Radio),
    summary: 'RouteConnect does not track buses itself. It can hand you over to an external tracker.',
    points: [
      <><strong>One-tap handover</strong>: Copies your bus service number and opens official APSRTC, redBus, or AbhiBus.</>,
      <><strong>External tracking</strong>: Shows verified tracker links. It is not a live position.</>
    ]
  },
  TRAINS_UNAVAILABLE,
  {
    id: 'estimated-rail',
    title: 'Train suggestions (estimated)',
    icon: icon(Search),
    summary: 'An optional explorer of railway track, with an estimated travel time. It never shows scheduled trains.',
    points: [
      <><strong>Physical track</strong>: Stations and lines mapped from <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener noreferrer" className="font-bold text-[#146B5B] underline">© OpenStreetMap contributors</a>.</>,
      <><strong>Estimated travel time</strong>: Calculated from track distance and speed; not scheduled runs or bookable trains.</>
    ]
  },
  {
    id: 'privacy',
    title: 'Privacy & external links',
    icon: icon(Lock),
    summary: 'Your location is used only to plan the search you asked for.',
    points: [
      <><strong>Search-only</strong>: Coordinates are used solely to locate nearby stops and plan routes.</>,
      <><strong>Browser storage</strong>: Recent searches and preferences stay on your device only.</>
    ]
  },
  {
    id: 'trust',
    title: 'Our promise',
    icon: icon(ShieldCheck),
    summary: 'Correct over complete: fewer routes we can stand behind, rather than more we cannot.',
    points: [
      <><strong>Honest data</strong>: Scheduled times are never presented as live GPS positions.</>,
      <><strong>Transparent estimates</strong>: Estimates are always clearly labelled as estimates.</>
    ]
  }
];

// The sections as they read before the server has answered (trains unavailable).
export const DATA_POLICY_SECTIONS: Section[] = dataPolicySections();

const atAGlance = (train: TrainCapability): { label: string; value: string; tone: 'ok' | 'warn' | 'off' }[] => [
  { label: 'Buses', value: 'Community timetable', tone: 'ok' },
  { label: 'Schedules', value: 'Mostly inferred', tone: 'warn' },
  { label: 'Fares', value: 'Estimated ranges', tone: 'warn' },
  train.available ? { label: 'Trains', value: 'Scheduled, not live', tone: 'warn' } : { label: 'Trains', value: 'Coming soon', tone: 'off' }
];

const TONE = {
  ok: 'bg-[#EEF6F3] text-[#146B5B]',
  warn: 'bg-amber-50 text-amber-800',
  off: 'bg-[#F2F4F7] text-[#667085]'
};

export default function AboutData() {
  const navigate = useNavigate();
  const { train } = useCapabilities();
  const sections = dataPolicySections(train);

  useEffect(() => {
    if (!window.location.hash) window.scrollTo(0, 0);
  }, []);

  return (
    <div className="min-h-screen bg-[#F1F4F3] text-[#1F2933]">
      <Navbar />
      <main className="mx-auto max-w-4xl px-4 py-8 sm:px-6 sm:py-10">
        <button
          type="button"
          onClick={() => (window.history.length > 1 ? navigate(-1) : navigate('/dashboard'))}
          className="inline-flex items-center gap-1.5 rounded text-xs font-black uppercase text-[#146B5B] transition hover:text-[#0f5447] focus:outline-none focus-visible:ring-2 focus-visible:ring-[#146B5B]"
        >
          <ArrowLeft aria-hidden className="h-4 w-4" /> Back
        </button>

        <header className="mt-6">
          <p className="text-xs font-extrabold uppercase tracking-[0.2em] text-[#146B5B]">Data &amp; policies</p>
          <h1 className="mt-2 text-3xl font-black tracking-tight sm:text-4xl">What’s behind every route</h1>
          <p className="mt-2 max-w-2xl text-sm font-semibold leading-relaxed text-[#667085]">
            Quick, shortcut guide to where our transit routes, times and fares come from and how they work.
          </p>
        </header>

        {/* Quick summary metrics */}
        <section aria-label="At a glance" className="mt-6 grid grid-cols-2 gap-2.5 sm:grid-cols-4">
          {atAGlance(train).map(item => (
            <div key={item.label} className="rounded-2xl border border-[#D9E2DE] bg-white px-4 py-3">
              <p className="text-[11px] font-bold uppercase tracking-wider text-[#667085]">{item.label}</p>
              <p className={`mt-1.5 inline-block rounded-md px-2 py-0.5 text-xs font-extrabold ${TONE[item.tone]}`}>{item.value}</p>
            </div>
          ))}
        </section>

        {/* Quick-jump navigation pills */}
        <nav aria-label="On this page" className="mt-6 flex flex-wrap gap-2">
          {sections.map(section => (
            <a
              key={section.id}
              href={`#${section.id}`}
              className="rounded-full border border-[#D9E2DE] bg-white px-3 py-1.5 text-xs font-bold text-[#475467] transition hover:border-[#146B5B] hover:text-[#146B5B] focus:outline-none focus-visible:ring-2 focus-visible:ring-[#146B5B]"
            >
              {section.title}
            </a>
          ))}
        </nav>

        {/* Concise topic cards */}
        <div className="mt-8 grid gap-4 md:grid-cols-2">
          {sections.map((section, index) => (
            <section
              key={section.id}
              id={section.id}
              aria-labelledby={`${section.id}-title`}
              className={`scroll-mt-24 rounded-2xl ${index === sections.length - 1 && sections.length % 2 === 1 ? 'md:col-span-2' : ''} border border-[#D9E2DE] bg-white p-5 shadow-sm transition hover:border-[#146B5B]/30 sm:p-6`}
            >
              <div className="flex items-center gap-3">
                <span className="inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-[#EEF6F3] text-[#146B5B]">{section.icon}</span>
                <h2 id={`${section.id}-title`} className="text-base font-black leading-tight">{section.title}</h2>
              </div>
              <p className="mt-2.5 text-xs font-bold leading-5 text-[#146B5B]">{section.summary}</p>
              <ul className="mt-3 space-y-2 text-xs leading-5 text-[#475467]">
                {section.points.map((point, i) => (
                  <li key={i} className="flex gap-2">
                    <span aria-hidden className="mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full bg-[#146B5B]" />
                    <span>{point}</span>
                  </li>
                ))}
              </ul>
            </section>
          ))}
        </div>

        <aside className="mt-8 flex flex-col items-start gap-4 rounded-2xl bg-[#146B5B] p-6 text-white sm:flex-row sm:items-center sm:justify-between">
          <div>
            <p className="text-lg font-black">Ready to plan a journey?</p>
            <p className="mt-1 text-xs text-white/80">Every result shows its schedule confidence and estimates clearly.</p>
          </div>
          <button
            type="button"
            onClick={() => navigate('/dashboard')}
            className="inline-flex shrink-0 items-center gap-2 rounded-xl bg-white px-5 py-3 text-xs font-black text-[#146B5B] transition hover:bg-[#EEF6F3] focus:outline-none focus-visible:ring-4 focus-visible:ring-white/40"
          >
            <Search aria-hidden className="h-4 w-4" />
            Plan a journey
          </button>
        </aside>

        <p className="mt-6 flex items-center gap-1.5 text-xs text-[#667085]">
          <ExternalLink aria-hidden className="h-3.5 w-3.5" />
          External trackers and maps open on their own websites.
        </p>
      </main>
    </div>
  );
}

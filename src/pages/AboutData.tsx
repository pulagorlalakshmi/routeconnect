import { useEffect } from 'react';
import type { ReactNode } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  ArrowLeft, Bus, Car, Clock3, Database, ExternalLink, IndianRupee, Lock, Radio, Search, ShieldCheck, TrainFront
} from 'lucide-react';
import Navbar from '../components/Navbar';
import { DEFAULT_CAPABILITIES, useCapabilities } from '../services/capabilities';
import type { TrainCapability } from '../services/capabilities';

// "Data & policies": everything RouteConnect wants people to know about where routes, times and fares come from and
// what is (and is not) known. It replaces the "About this data" accordion that used to sit under the results.
// Keep every statement true to the code: when behaviour changes, change this page in the same change. Train statements
// follow the server's live capability (GET /api/v2/capabilities): trains are described as available only when they are.

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
    'We have not found a current Indian Railways timetable that a public website is permitted to reuse, so no railway timetable is connected.',
    'Until one is, “Train only” and “Bus + Train” are shown as Coming soon and cannot be selected.',
    'No train number, name, time or fare is ever generated. For trains, check the official Indian Railways enquiry services (NTES or IRCTC).'
  ]
};

const trainsAvailable = (train: TrainCapability): Section => ({
  id: 'trains',
  title: 'Train availability',
  icon: icon(TrainFront),
  summary: 'Train journeys use scheduled timetable times. They are not live and not official.',
  points: [
    <>Train numbers, names, stops, times and running days come from {train.sourceName ?? 'a railway timetable dataset'}{train.snapshotDate ? <>, a copy of the Indian Railways public timetable taken on <strong>{train.snapshotDate}</strong></> : null}. It is not published or verified by Indian Railways.</>,
    'Only trains that the timetable says run on your travel date are shown. A train whose timetable entry has expired is left out rather than assumed to continue, so trains changed after the snapshot may be missing.',
    'There is no live running status, platform, seat availability or booking. Train fares are not in the timetable, so they are shown as unavailable rather than guessed.',
    'Walking and local rides to and from stations are estimates; a timetable bus is suggested when one reaches the station in time.',
    'Always confirm on the official Indian Railways enquiry services (NTES, 139 or IRCTC) before travelling.'
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
      'Journeys come from a community-maintained APSRTC timetable (GTFS) dataset, including transfers and services that run past midnight.',
      'The dataset has not been verified by APSRTC and may be out of date.',
      'Place suggestions are the stops in that timetable, so every suggestion can actually be routed.',
      'If no timetable-supported journey exists, we say so instead of guessing.'
    ]
  },
  {
    id: 'timetable-accuracy',
    title: 'Timetable accuracy',
    icon: icon(Clock3),
    summary: 'Every bus leg carries a schedule confidence level. Confirm times before you travel.',
    points: [
      <><strong>Published schedule</strong>: times come from a timetable that covers your travel date.</>,
      <><strong>Schedule inferred</strong>: the dataset has expired, so the last known weekly pattern is assumed to continue. This is the common case today.</>,
      <><strong>Schedule estimated / unconfirmed</strong>: times are approximate or could not be checked.</>,
      'Stop times in this dataset are often approximate rather than exact timepoints, so allow some margin.'
    ]
  },
  {
    id: 'sources',
    title: 'Data sources',
    icon: icon(Database),
    summary: 'Each search lists which sources were searched and what each one returned.',
    points: [
      <><strong>Buses</strong>: the community APSRTC GTFS dataset described above.</>,
      <><strong>Trains</strong>: no verified railway timetable is connected (see Train availability below).</>,
      <><strong>Private buses</strong>: no licensed data source. Booking websites are not scraped.</>,
      <><strong>Flights</strong>: only searched when a flight data provider is configured on the server.</>,
      'The "Sources searched" line above the results shows this for every search.'
    ]
  },
  {
    id: 'fares',
    title: 'Fare estimates',
    icon: icon(IndianRupee),
    summary: 'Fares are approximate ranges, never exact ticket prices.',
    points: [
      'The timetable has no fares and no bus service class, so each range is estimated from route distance and spans ordinary to deluxe services.',
      'When part of a journey cannot be priced, the estimate is marked incomplete and that part is never counted as free.',
      '"Lowest estimated cost" lists journeys without a complete estimate last, never as the cheapest.',
      'Check the fare with the operator or at the counter before travelling.'
    ]
  },
  {
    id: 'local-rides',
    title: 'Local ride estimates',
    icon: icon(Car),
    summary: 'A local ride is a generic auto or cab estimate to reach or leave a stop.',
    points: [
      'No ride provider is connected, so availability is not verified and nothing is booked for you.',
      'Ride time and fare are approximate. Walking legs are straight-line estimates, not road routes.',
      'A local ride only connects you to or from a timetable bus. Ride-only journeys and named ride-hailing services are never shown.'
    ]
  },
  {
    id: 'tracking',
    title: 'Live tracking',
    icon: icon(Radio),
    summary: 'RouteConnect does not track buses itself. It can hand you over to an external tracker.',
    points: [
      'Tracking links open the tracker’s own website (APSRTC Official, redBus or AbhiBus) in a new tab, after copying the service number for you.',
      '"Live tracking verified" means the service was once checked by hand and recognised by that tracker. It is not a live position.',
      '"Live tracking options" means trackers exist for APSRTC buses, but whether they recognise this service has not been checked.',
      'A bus is never hidden just because no tracker recognises it.'
    ]
  },
  TRAINS_UNAVAILABLE,
  {
    id: 'estimated-rail',
    title: 'Train suggestions (estimated)',
    icon: icon(Search),
    summary: 'An optional explorer of railway track, with an estimated travel time. It never shows scheduled trains.',
    points: [
      <>Railway track and stations come from <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener noreferrer" className="font-bold text-[#146B5B] underline">© OpenStreetMap contributors</a>, available under the Open Database License (ODbL). Coverage today: Andhra Pradesh and Telangana.</>,
      'Two stations count as connected only when the mapped track physically joins. Connected track does not mean a passenger train runs on it.',
      'The time is a range from the mapped distance, assumed average speeds and station-stop allowances. There are no departure times, train numbers, running days, fares or seat availability.',
      'Choose “Train” to see train suggestions only. With “Any transport” they appear as their own clearly labelled cards beside the bus journeys (filter with All / Bus / Train); with “Bus” they are not shown. They are never ranked against timetable journeys, never joined to a bus into a timed itinerary, and the date and time you search do not apply to them.'
    ]
  },
  {
    id: 'privacy',
    title: 'Privacy & external links',
    icon: icon(Lock),
    summary: 'Your location is used only to plan the search you asked for.',
    points: [
      'If you use your current location, its coordinates are sent to RouteConnect’s server to plan the journey and to look up an address (via OpenStreetMap Nominatim).',
      'Showing your location or choosing a point on the map loads Google Maps, which receives those coordinates.',
      'Recent searches, saved routes and your last travel preferences are stored in this browser only.',
      'External sites (trackers, maps) have their own privacy policies.'
    ]
  },
  {
    id: 'trust',
    title: 'Our promise',
    icon: icon(ShieldCheck),
    summary: 'Correct over complete: fewer routes we can stand behind, rather than more we cannot.',
    points: [
      'Scheduled times are never presented as live, and nothing is labelled bookable unless it really is.',
      'Estimates are always labelled as estimates.',
      'Found something wrong? Confirm with the operator first, and treat RouteConnect as a planning aid.'
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

  // Arriving from a long results page: start at the top unless a section was linked directly.
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
          <p className="mt-3 max-w-2xl text-base leading-7 text-[#667085]">
            Where our routes, times and fares come from, how sure we are about them, and what we will never pretend to know.
          </p>
        </header>

        <section aria-label="At a glance" className="mt-6 grid grid-cols-2 gap-2.5 sm:grid-cols-4">
          {atAGlance(train).map(item => (
            <div key={item.label} className="rounded-2xl border border-[#D9E2DE] bg-white px-4 py-3">
              <p className="text-[11px] font-bold uppercase tracking-wider text-[#667085]">{item.label}</p>
              <p className={`mt-1.5 inline-block rounded-md px-2 py-0.5 text-xs font-extrabold ${TONE[item.tone]}`}>{item.value}</p>
            </div>
          ))}
        </section>

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

        <div className="mt-8 grid gap-4 md:grid-cols-2">
          {sections.map((section, index) => (
            <section
              key={section.id}
              id={section.id}
              aria-labelledby={`${section.id}-title`}
              className={`scroll-mt-24 rounded-2xl ${index === sections.length - 1 && sections.length % 2 === 1 ? 'md:col-span-2' : ''} border border-[#D9E2DE] bg-white p-5 shadow-sm shadow-[#1F2933]/5 sm:p-6`}
            >
              <div className="flex items-center gap-3">
                <span className="inline-flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-[#EEF6F3] text-[#146B5B]">{section.icon}</span>
                <h2 id={`${section.id}-title`} className="text-lg font-black leading-tight">{section.title}</h2>
              </div>
              <p className="mt-3 text-sm font-semibold leading-6 text-[#1F2933]">{section.summary}</p>
              <ul className="mt-3 space-y-2 text-sm leading-6 text-[#667085]">
                {section.points.map((point, i) => (
                  <li key={i} className="flex gap-2.5">
                    <span aria-hidden className="mt-2.5 h-1.5 w-1.5 shrink-0 rounded-full bg-[#9DBFB5]" />
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
            <p className="mt-1 text-sm text-white/80">Every result shows its schedule confidence and estimates clearly.</p>
          </div>
          <button
            type="button"
            onClick={() => navigate('/dashboard')}
            className="inline-flex shrink-0 items-center gap-2 rounded-xl bg-white px-5 py-3 text-sm font-extrabold text-[#146B5B] transition hover:bg-[#EEF6F3] focus:outline-none focus-visible:ring-4 focus-visible:ring-white/40"
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

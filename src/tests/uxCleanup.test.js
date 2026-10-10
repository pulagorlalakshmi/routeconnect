// UX cleanup: a calm search card, origin-first current location, summary-first journey cards with a large journey
// strip, and everything else behind "More details". Display only: no routing logic is involved.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { bundle, sourceRoot } from './harness.js';

globalThis.localStorage = { getItem: () => null, setItem: () => {}, removeItem: () => {} };

const ui = bundle(`
  import { createElement } from 'react';
  import { renderToStaticMarkup } from 'react-dom/server';
  import { MemoryRouter } from 'react-router-dom';
  import { AuthProvider } from './context/AuthContext';
  import JourneyCard from './components/JourneyCard';
  import JourneySimulation from './components/JourneySimulation';
  import SearchCard from './components/SearchCard';
  import LocationInput, { quickActionsFor } from './components/LocationInput';
  import { buildSimulation } from './utils/journeySimulation';
  import { headerLabels, MAX_HEADER_BADGES } from './utils/journeyBadges';
  export const render = (Component, props) => renderToStaticMarkup(createElement(Component, props));
  export const renderCard = props => renderToStaticMarkup(
    createElement(MemoryRouter, null, createElement(AuthProvider, null, createElement(JourneyCard, props))));
  export { JourneySimulation, SearchCard, LocationInput, quickActionsFor, buildSimulation, headerLabels, MAX_HEADER_BADGES };
`, 'ux');

const strip = markup => markup.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
const read = (...parts) => readFileSync(path.join(sourceRoot, ...parts), 'utf8');
const noop = () => {};

const place = (name, type = 'stop') => ({ type, name, lat: 16, lon: 80 });
const t = hhmm => `2026-10-09T${hhmm}:00+05:30`;
const bus = (service, from, to, dep, arr) => ({
  mode: 'bus', routeId: service, routeShortName: service, routeLongName: null, operator: 'APSRTC', serviceNumber: service, tripId: `t${service}`,
  headsign: null, fromStop: place(from), toStop: place(to), departureTime: t(dep), arrivalTime: t(arr), gtfsDepartureTime: `${dep}:00`,
  gtfsArrivalTime: `${arr}:00`, serviceDate: '2026-10-09', scheduleBasis: 'extrapolated_weekly_pattern',
  durationSeconds: (Number(arr.slice(0, 2)) * 60 + Number(arr.slice(3)) - Number(dep.slice(0, 2)) * 60 - Number(dep.slice(3))) * 60,
  intermediateStopCount: 3, datasetId: 1, dataConfidence: 'inferred', timeQuality: 'approximate',
  fare: { type: 'estimated_range', min: 40, max: 60, currency: 'INR', confidence: 'estimated' },
  routeTrust: { sourceType: 'gtfs', sourceName: 'Community APSRTC GTFS', scheduleConfidence: 'inferred', timetableBacked: true },
  tracking: { serviceNumber: service, vehicleNumber: null, status: 'options_available', checkedOn: null, preferredProvider: null,
    providers: ['apsrtc', 'redbus', 'abhibus'].map(id => ({ id, recognized: null, availableAsExternalOption: true })) }
});
const ride = (from, to, dep, arr, minutes) => ({
  mode: 'local_ride', kind: 'access', label: 'Estimated local ride', from: place(from, 'origin'), to: place(to), distanceMeters: 4000,
  durationSeconds: minutes * 60, rideSeconds: minutes * 60, pickupWaitSeconds: 0, departureTime: t(dep), arrivalTime: t(arr),
  dataConfidence: 'estimated', durationConfidence: 'estimated', providerIntegration: false, availabilityStatus: 'unknown', isRealtime: false,
  fare: { type: 'estimated_range', min: 60, max: 90, currency: 'INR', confidence: 'estimated' }
});

// Local ride 12 min -> bus 15 min -> 20 min wait -> bus 40 min: the example from the brief.
const legs = [
  ride('Home', 'GUNTUR BUS STAND', '07:48', '08:00', 12),
  bus('03846', 'GUNTUR BUS STAND', 'PEDAKAKANI', '08:00', '08:15'),
  bus('05408', 'PEDAKAKANI', 'NARASARAOPET', '08:35', '09:15')
];
const journey = (extra = {}) => ({
  id: 'jr_ux', labels: ['BEST_PATH', 'FASTEST', 'LEAST_TRANSFERS', 'BEST_BALANCED', 'LOWER_ESTIMATED_COST'],
  departureTime: legs[0].departureTime, arrivalTime: legs.at(-1).arrivalTime, totalDurationSeconds: 87 * 60,
  walkingDurationSeconds: 0, waitingDurationSeconds: 20 * 60, transfers: 1, transitLegCount: 2,
  datasetConfidence: 'inferred', scheduleConfidence: 'inferred', confidence: 'inferred', timeQuality: 'approximate',
  localRideDurationSeconds: 12 * 60, localRideCount: 1, fare: null,
  fareEstimate: { min: 140, max: 210, currency: 'INR', confidence: 'estimated', complete: true, components: [], unknownComponents: [] },
  rating: { score: 8.2, label: 'Very Good', summary: 'Good balance.', comparedWith: 2, parameters: { time: { score: 8, weight: 1 } }, reasons: [] },
  legs, ...extra
});
const summary = (extra) => ui.renderCard({ journey: journey(extra), index: 1, from: 'Home', to: 'Narasaraopet' });
const details = (extra) => ui.renderCard({ journey: journey(extra), index: 1, from: 'Home', to: 'Narasaraopet', initialShowDetails: true });

describe('1. search form', () => {
  const card = () => ui.render(ui.SearchCard, {
    from: '', to: '', date: '2026-10-09', time: '08:00', onFromChange: noop, onCurrentLocation: noop, onToChange: noop,
    onDateChange: noop, onTimeChange: noop, onSwapLocations: noop, onSearch: noop, loading: false, isValid: true
  });

  test('keeps only From, To, Date, Depart after and one primary Search button, with the agreed wording', () => {
    const markup = card();
    const text = strip(markup);
    assert.match(text, /^Plan your journey From To Date Depart after \(India time\) Search routes$/);
    assert.equal((markup.match(/<input /g) || []).length, 4, 'four fields, nothing else');
    assert.equal((markup.match(/type="submit"/g) || []).length, 1, 'one primary action');
    assert.match(markup, /<form[^>]*aria-label="Plan your journey"/, 'Enter submits the search');
    assert.doesNotMatch(text, /Journey Planner|published timetables|Find All Routes/);
  });

  test('every field has a real label, and the swap button is a single obvious labelled control', () => {
    const markup = card();
    for (const id of [...markup.matchAll(/<input[^>]*id="([^"]+)"/g)].map(m => m[1])) {
      assert.match(markup, new RegExp(`<label[^>]*for="${id.replace(/[-[\]/{}()*+?.\\^$|]/g, '\\$&')}"`), `label for ${id}`);
    }
    assert.equal((markup.match(/aria-label="Swap From and To"/g) || []).length, 1);
  });
});

describe('2/3. origin and destination behave differently, on purpose', () => {
  test('the origin leads with "use my current location" and has a GPS button in the field', () => {
    const origin = ui.quickActionsFor('origin');
    assert.deepEqual(origin.top, ['current_location', 'select_on_map']);
    assert.equal(origin.gpsButtonInField, true);
    assert.equal(origin.locateOnMapOpen, true);
    const markup = ui.render(ui.LocationInput, { kind: 'origin', label: 'From', placeholder: 'x', value: '', onChange: noop });
    assert.match(markup, /aria-label="Use my current location"/);
  });

  test('the destination leads with "select on map", keeps current location as a quiet last option, and never locates on its own', () => {
    const destination = ui.quickActionsFor('destination');
    assert.deepEqual(destination.top, ['select_on_map']);
    assert.deepEqual(destination.bottom, ['current_location']);
    assert.equal(destination.gpsButtonInField, false);
    assert.equal(destination.locateOnMapOpen, false, 'opening the map for a destination does not request the location');
    const markup = ui.render(ui.LocationInput, { kind: 'destination', label: 'To', placeholder: 'x', value: '', onChange: noop });
    assert.doesNotMatch(markup, /Use my current location/);
    const source = read('components', 'LocationInput.tsx');
    assert.match(source, /Use my current location as the destination/, 'secondary wording cannot be mistaken for the start');
    assert.match(source, /\(onCurrentLocation \?\? onCoordinates\)/, 'a destination picked by GPS still reports its coordinates');
  });
});

describe('4/7. the summary shows only what decides', () => {
  test('title, journey strip, four key numbers, short facts and two actions', () => {
    const text = strip(summary());
    assert.match(text, /Local ride \+ .*2 APSRTC buses/);
    assert.match(text, /Total time 1 h 27 min/);
    assert.match(text, /Approx\. budget ₹140–₹210/);
    assert.match(text, /Depart → Arrive 07:48 → 09:15/);
    assert.match(text, /Transfers 1 transfer/);
    assert.match(text, /Local ride included/);
    assert.match(text, /Save More details$/);
  });

  test('no service numbers, tracking, trust prose, fare methodology or stop-level text in the summary', () => {
    const text = strip(summary());
    assert.doesNotMatch(text, /Service No|Track Bus|Check Live Tracking|Live tracking|Timetable-backed|Inferred schedule|Schedule inferred/);
    assert.doesNotMatch(text, /Estimated from route distance|Actual fare|availability not verified|community-maintained/i);
    assert.doesNotMatch(text, /board at|get off at|stops in between|Why this rating|Option 1/);
  });

  test('the summary stays short: few words, at most three fact chips', () => {
    const markup = summary();
    const words = strip(markup).split(' ').length;
    assert.ok(words < 70, `summary has ${words} words`);
    const facts = markup.match(/aria-label="Journey facts"[^>]*>(.*?)<\/ul>/)?.[1] ?? '';
    assert.ok((facts.match(/<li/g) || []).length <= 3);
  });
});

describe('5/6. the journey strip is the visual centrepiece', () => {
  test('it comes right after the title, before the numbers, and is drawn large', () => {
    const markup = summary();
    assert.ok(markup.indexOf('aria-label="Route preview"') < markup.indexOf('aria-label="Key facts"'));
    const strip_ = ui.render(ui.JourneySimulation, { journey: { legs } });
    assert.match(strip_, /h-10 w-10/, 'mode icons are 40px chips');
    assert.match(strip_, /h-5 w-5/, 'icons and end/transfer nodes are clearly visible');
    assert.match(strip_, /h-\[6px\]/, 'thick segment lines');
    assert.match(strip_, /text-\[13px\]/, 'readable place labels');
  });

  test('each segment shows its own time and mode, and the wait at the transfer is visible', () => {
    const text = strip(ui.render(ui.JourneySimulation, { journey: { legs } }));
    assert.match(text, /12 min Local ride/);
    assert.match(text, /15 min Bus/);
    assert.match(text, /Pedakakani Transfer 20 min wait/);
    assert.match(text, /40 min Bus/);
    const sim = ui.buildSimulation({ legs });
    assert.deepEqual(sim.nodes.map(n => n.waitSeconds), [0, 0, 1200, 0]);
  });

  test('mode-aware icons: local ride, bus, train, flight, walk', () => {
    const icons = markup => [...markup.matchAll(/data-icon="([^"]+)"/g)].map(m => m[1]);
    assert.deepEqual(icons(ui.render(ui.JourneySimulation, { journey: { legs } })), ['car-taxi-front', 'bus', 'bus']);
    const train = { ...legs[1], mode: 'rail' };
    const flight = { ...legs[1], mode: 'air' };
    const walk = { mode: 'walk', kind: 'access', from: place('Home', 'origin'), to: place('GUNTUR BUS STAND'), distanceMeters: 300, durationSeconds: 300, departureTime: t('07:55'), arrivalTime: t('08:00'), dataConfidence: 'estimated' };
    assert.deepEqual(icons(ui.render(ui.JourneySimulation, { journey: { legs: [walk, train, flight] } })), ['footprints', 'train-front', 'plane']);
  });
});

describe('8/9. "More details" holds the rest, organised', () => {
  test('a real toggle: collapsed by default, labelled, and wired to its panel', () => {
    const markup = summary();
    assert.match(markup, /aria-expanded="false" aria-controls="journey-details-[^"]+"/);
    const open = details();
    const id = open.match(/aria-controls="(journey-details-[^"]+)"/)[1];
    assert.match(open, new RegExp(`id="${id}"`));
    assert.match(strip(open), /Hide details/);
  });

  test('grouped sections with the hidden information', () => {
    const text = strip(details()).replace(/&amp;/g, "&");
    for (const heading of ['Journey breakdown', 'Timing', 'Fare breakdown', 'Service & tracking', 'Data quality']) {
      assert.ok(text.includes(heading), heading);
    }
    assert.match(text, /08:00 board at GUNTUR BUS STAND/);
    assert.match(text, /Wait 20 min at PEDAKAKANI/);
    assert.match(text, /Local ride to the stop ₹60–₹90/);
    assert.match(text, /APSRTC Bus 03846 ₹40–₹60/);
    assert.match(text, /Approx\. total ₹140–₹210/);
    assert.match(text, /Service No\. 03846/);
    assert.match(text, /Live tracking options/);
    assert.match(text, /Inferred schedule/);
    assert.match(text, /weekly pattern repeats/);
    assert.match(text, /Why this rating\?/);
    assert.ok(text.indexOf('Journey breakdown') < text.indexOf('Data quality'));
  });
});

describe('9/11. badges', () => {
  test('at most two, only decision-relevant ones', () => {
    assert.equal(ui.MAX_HEADER_BADGES, 2);
    const markup = summary();
    const highlights = markup.match(/aria-label="Highlights"[^>]*>(.*?)<\/ul>/)?.[1] ?? '';
    assert.equal((highlights.match(/<li/g) || []).length, 2);
    assert.deepEqual(strip(highlights).split(/(?<=path) /), ['Best path', 'Fastest']);
    assert.deepEqual(ui.headerLabels(['BEST_BALANCED']), []);
    assert.deepEqual(ui.headerLabels(['LOWER_ESTIMATED_COST', 'LEAST_TRANSFERS']), ['LOWER_ESTIMATED_COST', 'LEAST_TRANSFERS']);
  });
});

describe('12. page notices', () => {
  const page = read('pages', 'SearchResults.tsx');
  test('compact one-line notices instead of warning blocks', () => {
    assert.match(page, /aria-label="Notices"/);
    assert.match(page, /Schedules are estimated from a community timetable\. Confirm times before travelling\./);
    assert.match(page, /Local ride times and fares are estimates\./);
    assert.doesNotMatch(page, /role="alert">\s*⚠|Schedule confidence is shown on every option|Complete door-to-door journeys compared/);
    assert.doesNotMatch(page, /Bus options/);
  });
});

describe('15. mobile', () => {
  test('the strip scrolls sideways instead of squeezing; numbers and header stack on small screens', () => {
    const markup = summary();
    assert.match(markup, /overflow-x-auto/);
    assert.match(markup, /style="min-width:536px"/, 'three legs: the strip keeps its width and scrolls');
    assert.match(markup, /grid-cols-2 gap-x-4 gap-y-3 sm:grid-cols-4/);
    assert.match(markup, /flex-col-reverse gap-2 sm:flex-row/);
    assert.match(details(), /grid gap-6 md:grid-cols-2/, 'detail groups stack on phones');
    assert.match(read('components', 'SearchCard.tsx'), /grid-cols-1 gap-4 sm:grid-cols-2/);
  });
});

describe('16. accessibility and reduced motion', () => {
  test('the strip is static without motion and the CSS turns animation off under prefers-reduced-motion', () => {
    const markup = ui.render(ui.JourneySimulation, { journey: { legs }, animate: false });
    assert.match(markup, /data-motion="off"/);
    assert.doesNotMatch(markup, /rc-sim-runner/);
    assert.match(read('components', 'JourneySimulation.tsx'), /prefersReducedMotion\(\)/);
    const css = read('index.css');
    assert.match(css.slice(css.lastIndexOf('@media (prefers-reduced-motion: reduce)')), /\.rc-sim-runner, \.rc-sim-runner \* \{ transition: none !important; \}/);
  });

  test('the strip describes the whole route and each leg for screen readers', () => {
    const markup = ui.render(ui.JourneySimulation, { journey: { legs } });
    assert.match(markup, /role="group" aria-label="Route: Home, local ride to GUNTUR BUS STAND, then apsrtc bus to PEDAKAKANI, then apsrtc bus to NARASARAOPET\."/);
    assert.match(markup, /aria-label="APSRTC bus 05408 from PEDAKAKANI to NARASARAOPET, 40 min"/);
  });
});

describe('17. routing logic unchanged', () => {
  test('the redesigned UI only reads the journey it is given: no planning, ranking or fetching', () => {
    for (const file of [['components', 'JourneyCard.tsx'], ['components', 'JourneySimulation.tsx'], ['utils', 'journeySimulation.ts'], ['utils', 'journeyBadges.ts']]) {
      assert.doesNotMatch(read(...file), /fetchPlan|planJourneys|rankJourneys|raptor|fetch\(/, file.join('/'));
    }
  });

  test('labels are filtered for display only; the journey and its legs are not modified', () => {
    const j = journey();
    const before = JSON.stringify(j);
    ui.renderCard({ journey: j, index: 1, from: 'a', to: 'b' });
    ui.renderCard({ journey: j, index: 1, from: 'a', to: 'b', initialShowDetails: true });
    ui.buildSimulation(j); ui.headerLabels(j.labels);
    assert.equal(JSON.stringify(j), before);
  });
});

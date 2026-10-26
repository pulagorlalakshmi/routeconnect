import { useCallback, useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';
import Navbar from '../components/Navbar';
import SearchCard from '../components/SearchCard';
import PreferenceModal from '../components/PreferenceModal';
import RouteDiscovery from '../components/RouteDiscovery';
import type { DiscoveryError } from '../components/RouteDiscovery';
import { PlanError, searchPlaces } from '../services/planService';
import { fetchRailExplorer } from '../services/railExplorer';
import { planParamsFromSearch, runPlanSearch } from '../services/planRequest';
import { useCapabilities } from '../services/capabilities';
import { prefersReducedMotion } from '../utils/trackingLaunch';
import RouteBuddyMapBackground from '../components/RouteBuddyMapBackground';
import { formatDateLabel, nowLocalHHMM, todayLocalIso } from '../utils/dateTime';
import {
  CURRENT_LOCATION_LABEL,
  EMPTY_PLACE,
  editPlaceText,
  isCurrentLocationText,
  isSamePlace,
  swapPlaces
} from '../utils/locationValue';
import type { Coordinates, PlaceValue } from '../utils/locationValue';
import { DEFAULT_PREFERENCES, loadPreferences, loadView, savePreferences, saveView, writePreferenceParams, writeViewParam } from '../utils/travelPreferences';
import type { SearchView, TravelPreferences } from '../utils/travelPreferences';

const SAME_PLACE_MESSAGE = 'Your starting point and destination are the same. Choose two different places.';

// A fast search still shows the discovery panel briefly (no flash), then fades out; a slow one simply loops until the
// real request finishes. Nobody is made to wait for the animation beyond this.
const MIN_DISCOVERY_MS = 700;
const DISCOVERY_EXIT_MS = 200;
const pause = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

type SearchPhase =
  | { kind: 'choose' }
  | { kind: 'searching' | 'leaving'; preferences: TravelPreferences; view: SearchView }
  | { kind: 'error'; preferences: TravelPreferences; view: SearchView; error: DiscoveryError };

// Estimated rail is answered by the railway-network endpoint, which states plainly when it is not ready.
class RailUnavailableError extends Error {
  constructor(message: string, readonly retryable: boolean) { super(message); }
}

// What went wrong, in words, and whether simply trying again can help.
function describeSearchError(error: unknown): DiscoveryError {
  if (error instanceof PlanError) {
    switch (error.code) {
      case 'PLACE_NOT_FOUND':
        return { title: 'We couldn’t find that place', message: `“${error.query ?? 'That place'}” isn’t a stop in the transit timetable. Choose a suggestion while typing, or try a nearby town or bus stand.`, canRetry: false };
      case 'MODE_UNAVAILABLE':
        return { title: 'Not available yet', message: error.message, canRetry: false };
      case 'OFFLINE':
        return { title: 'Can’t reach RouteConnect', message: 'Check your connection, then try again.', canRetry: true };
      case 'TIMEOUT':
        return { title: 'This is taking too long', message: 'The search didn’t finish in time. Try again, or adjust the time or places.', canRetry: true };
      case 'DATA_UNAVAILABLE':
        return { title: 'Timetable data isn’t ready', message: 'The server is still loading its timetable data. Try again in a moment.', canRetry: true };
      case 'INVALID_QUERY':
        return { title: 'Something in this search isn’t valid', message: error.message, canRetry: false };
      default:
        return { title: 'Search unavailable', message: error.message, canRetry: true };
    }
  }
  return { title: 'Search unavailable', message: 'The route planner could not complete this search.', canRetry: true };
}

export default function Dashboard() {
  const { user } = useAuth();
  const navigate = useNavigate();
  // From and To are whole place objects (text + coordinates when known) held together, so a swap moves both at once.
  // Coordinates are only known when a place was picked from the list/map or GPS was used; typed names are resolved
  // against the timetable stops by the server.
  const [places, setPlaces] = useState<{ from: PlaceValue; to: PlaceValue }>({ from: EMPTY_PLACE, to: EMPTY_PLACE });
  const [validationError, setValidationError] = useState('');
  const [view, setView] = useState<SearchView>(() => loadView());
  const [date, setDate] = useState(() => todayLocalIso());
  const [time, setTime] = useState(() => nowLocalHHMM());
  // A validated search waiting for the preference step ("Any preferences?"); null while the form is in charge.
  const [pending, setPending] = useState<{ params: URLSearchParams; from: string; to: string; when: string; initial: TravelPreferences } | null>(null);
  // Re-checked every time the dialog opens, and polled while it is open and Train is still preparing.
  const capabilities = useCapabilities({ poll: pending !== null });
  // After "Show routes" / "Skip": the real search runs while the discovery panel plays in the same overlay.
  const [phase, setPhase] = useState<SearchPhase>({ kind: 'choose' });
  const phaseRef = useRef(phase);
  phaseRef.current = phase;
  // The one search in flight. Anything that finishes for an older or cancelled search is ignored, so there are no
  // duplicate submissions and no state updates after leaving the page.
  const searchRef = useRef<AbortController | null>(null);
  useEffect(() => () => { searchRef.current?.abort(); searchRef.current = null; }, []);

  const from = places.from.text;
  const to = places.to.text;
  const samePlace = from.trim().length > 0 && to.trim().length > 0 && isSamePlace(places.from, places.to);

  const handleSearch = async () => {
    if (pending) return;
    if (!from.trim() || !to.trim()) {
      setValidationError('Enter both a starting point and a destination to search.');
      return;
    }
    if (samePlace) {
      setValidationError(SAME_PLACE_MESSAGE);
      return;
    }
    if (!date || !time) {
      setValidationError('Choose a date and a departure time.');
      return;
    }
    // "Current location" is offered for the start only. It can reach To through a swap, but only with its coordinates.
    if (isCurrentLocationText(to) && !places.to.coords) {
      setValidationError('Choose a destination: search for a place or select it on the map.');
      return;
    }

    setValidationError('');

    let originCoordinates: Coordinates | null = places.from.coords;
    if (!originCoordinates && isCurrentLocationText(from)) {
      if (!navigator.geolocation) {
        setValidationError('Geolocation is not supported by your browser. Enter a starting place instead.');
        return;
      }
      try {
        const position = await new Promise<GeolocationPosition>((resolve, reject) => {
          navigator.geolocation.getCurrentPosition(resolve, reject, { enableHighAccuracy: true, timeout: 10000 });
        });
        originCoordinates = { lat: position.coords.latitude, lng: position.coords.longitude };
      } catch (error) {
        const locationError = error as GeolocationPositionError;
        setValidationError(locationError.code === locationError.PERMISSION_DENIED
          ? 'Location permission was denied. Allow location access and try again.'
          : 'Unable to determine your current location. Try again or enter a starting place.');
        return;
      }
      // The device location may turn out to be the chosen destination.
      if (isSamePlace({ text: from, coords: originCoordinates }, places.to)) {
        setValidationError(SAME_PLACE_MESSAGE);
        return;
      }
    }

    const params = new URLSearchParams({
      from: originCoordinates && isCurrentLocationText(from) ? CURRENT_LOCATION_LABEL : from.trim(),
      to: to.trim(),
      date,
      time
    });
    if (originCoordinates) {
      params.set('fromLat', String(originCoordinates.lat));
      params.set('fromLng', String(originCoordinates.lng));
    }
    if (places.to.coords) {
      params.set('toLat', String(places.to.coords.lat));
      params.set('toLng', String(places.to.coords.lng));
    }
    // Intent is confirmed: now (and only now) ask about preferences, pre-filled with the last choice.
    capabilities.refresh();
    setPending({
      params,
      from: params.get('from') ?? from.trim(),
      to: to.trim(),
      when: `${formatDateLabel(date)}, ${time}`,
      initial: loadPreferences(undefined, capabilities.availableModes)
    });
  };

  // Estimated rail needs coordinates: a typed place name is resolved through the same place search the form uses.
  const resolveRailCoords = async (params: URLSearchParams, signal: AbortSignal) => {
    const end = async (latKey: string, lngKey: string, nameKey: string) => {
      const lat = Number(params.get(latKey));
      const lng = Number(params.get(lngKey));
      if (params.get(latKey) && Number.isFinite(lat) && Number.isFinite(lng)) return { lat, lng };
      const name = params.get(nameKey) ?? '';
      const [place] = name.trim() ? await searchPlaces(name, signal) : [];
      if (!place) throw new RailUnavailableError(`We couldn’t locate “${name}”. Choose a suggestion from the list, or a point on the map.`, false);
      params.set(latKey, String(place.lat));
      params.set(lngKey, String(place.lon));
      return { lat: place.lat, lng: place.lon };
    };
    const from = await end('fromLat', 'fromLng', 'from');
    const to = await end('toLat', 'toLng', 'to');
    return { fromLat: from.lat, fromLng: from.lng, toLat: to.lat, toLng: to.lng };
  };

  // Runs the real search for these preferences. Resolves into navigation (results, empty or not) or an in-place error.
  // Estimated rail queries ONLY the railway-network endpoint: no bus search is needed or made.
  const startSearch = (preferences: TravelPreferences, baseParams: URLSearchParams, searchView: SearchView) => {
    if (searchRef.current) return; // a search is already running
    const url = searchView === 'estimated_rail'
      ? writeViewParam(new URLSearchParams(baseParams), 'estimated_rail')
      : writeViewParam(writePreferenceParams(preferences, new URLSearchParams(baseParams), capabilities.availableModes), 'planned');
    const controller = new AbortController();
    searchRef.current = controller;
    const isCurrent = () => searchRef.current === controller && !controller.signal.aborted;
    const started = performance.now();
    setPhase({ kind: 'searching', preferences, view: searchView });

    const request: Promise<unknown> = searchView === 'estimated_rail'
      ? resolveRailCoords(url, controller.signal).then(coords => fetchRailExplorer(coords, controller.signal)).then(answer => {
          if (!answer.available) throw new RailUnavailableError(answer.reason ?? 'Estimated rail connections are not available right now.', answer.state === 'preparing');
          return answer;
        })
      : runPlanSearch(planParamsFromSearch(url), controller.signal);
    request
      .then(async () => {
        // The response is cached for the results page, which shows it without asking the server again.
        await pause(Math.max(0, MIN_DISCOVERY_MS - (performance.now() - started)));
        if (!isCurrent()) return;
        setPhase({ kind: 'leaving', preferences, view: searchView });
        await pause(prefersReducedMotion() ? 0 : DISCOVERY_EXIT_MS);
        if (!isCurrent()) return;
        searchRef.current = null;
        navigate(`/search-results?${url.toString()}`);
      })
      .catch(error => {
        if (!isCurrent()) return; // cancelled, superseded or unmounted
        searchRef.current = null;
        setPhase({ kind: 'error', preferences, view: searchView,
          error: error instanceof RailUnavailableError
            ? { title: 'Estimated rail isn’t available', message: error.message, canRetry: error.retryable }
            : describeSearchError(error)
        });
      });
  };

  const handleConfirmPreferences = (preferences: TravelPreferences, choice: { view: SearchView }) => {
    if (!pending || phase.kind !== 'choose') return;
    savePreferences(preferences, undefined, capabilities.availableModes);
    saveView(choice.view);
    setView(choice.view);
    setPending({ ...pending, initial: preferences });

    // Remember the search in the browser (My Trips)
    try {
      const savedTrips = JSON.parse(localStorage.getItem('my_trips') || '[]');
      const isDup = savedTrips.some((t: { from: string; to: string; date: string; time?: string }) =>
        t.from.toLowerCase() === from.trim().toLowerCase() &&
        t.to.toLowerCase() === to.trim().toLowerCase() &&
        t.date === date && t.time === time
      );
      if (!isDup) {
        savedTrips.unshift({ from: from.trim(), to: to.trim(), date, time, id: Date.now() });
        localStorage.setItem('my_trips', JSON.stringify(savedTrips));
      }
    } catch (e) {
      console.error('Failed to save to localStorage:', e);
    }

    startSearch(preferences, pending.params, choice.view);
  };

  const cancelSearch = useCallback(() => {
    searchRef.current?.abort();
    searchRef.current = null;
  }, []);

  // Escape / Back / ✕: from the preferences, back to the form; from the search, stop it and return to the preferences.
  const handleClosePreferences = useCallback(() => {
    if (phaseRef.current.kind === 'choose') {
      setPending(null);
      return;
    }
    cancelSearch();
    setPhase({ kind: 'choose' });
  }, [cancelSearch]);

  const closeFlow = () => {
    cancelSearch();
    setPhase({ kind: 'choose' });
    setPending(null);
  };

  const setFromCoords = (lat: number, lng: number) => setPlaces(prev => ({ ...prev, from: { ...prev.from, coords: { lat, lng } } }));
  const setToCoords = (lat: number, lng: number) => setPlaces(prev => ({ ...prev, to: { ...prev.to, coords: { lat, lng } } }));
  // Editing the text invalidates coordinates picked earlier (unless it is still "current location").
  const handleFromChange = (value: string) => setPlaces(prev => ({ ...prev, from: editPlaceText(prev.from, value) }));
  const handleToChange = (value: string) => setPlaces(prev => ({ ...prev, to: editPlaceText(prev.to, value) }));
  const handleSwap = () => setPlaces(prev => swapPlaces(prev));

  const isValid = from.trim().length > 0 && to.trim().length > 0 && !samePlace && Boolean(date) && Boolean(time);
  const errorMessage = validationError || (samePlace ? SAME_PLACE_MESSAGE : '');

  return (
    <div className="route-buddy-dashboard min-h-screen text-[#1F2933] flex flex-col">
      <RouteBuddyMapBackground />
      <Navbar />

      <main className="relative z-10 flex-1 w-full max-w-7xl mx-auto px-4 py-10 md:py-16 flex flex-col justify-center">
        {/* Search card: the page's only task */}
        <div className="max-w-xl mx-auto w-full space-y-3">
          <p className="text-center text-xs uppercase tracking-[0.2em] font-extrabold text-[#146B5B]">
            {user ? `Welcome back, ${user.name}` : 'Public transport route planner'}
          </p>
          <SearchCard
            from={from}
            to={to}
            date={date}
            time={time}
            onFromChange={handleFromChange}
            onCurrentLocation={setFromCoords}
            onFromCoordinates={setFromCoords}
            onToChange={handleToChange}
            onToCoordinates={setToCoords}
            onDateChange={setDate}
            onTimeChange={setTime}
            onSwapLocations={handleSwap}
            onSearch={handleSearch}
            loading={false}
            isValid={isValid}
          />
          {errorMessage && (
            <p className="mt-3 rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm font-semibold text-red-700" role="alert">
              {errorMessage}
            </p>
          )}
        </div>
      </main>

      <PreferenceModal
        open={pending !== null}
        initial={pending?.initial ?? DEFAULT_PREFERENCES}
        trip={pending ? { from: pending.from, to: pending.to, when: pending.when } : undefined}
        onConfirm={handleConfirmPreferences}
        availableModes={capabilities.availableModes}
        trainSnapshotDate={capabilities.train.snapshotDate}
        trainSourceName={capabilities.train.sourceName}
        trainReason={capabilities.train.reason}
        estimatedRail={capabilities.estimatedRail}
        initialView={view}
        onClose={handleClosePreferences}
        stage={pending && phase.kind !== 'choose' ? (
          <RouteDiscovery
            from={pending.from}
            to={pending.to}
            preferences={phase.preferences}
            estimatedRail={phase.view === 'estimated_rail'}
            state={phase.kind}
            error={phase.kind === 'error' ? phase.error : null}
            onCancel={handleClosePreferences}
            onRetry={() => startSearch(phase.preferences, pending.params, phase.view)}
            onEditPreferences={() => setPhase({ kind: 'choose' })}
            onChangeSearch={closeFlow}
          />
        ) : undefined}
      />
    </div>
  );
}

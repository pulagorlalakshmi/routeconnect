import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';
import Navbar from '../components/Navbar';
import SearchCard from '../components/SearchCard';
import RouteBuddyMapBackground from '../components/RouteBuddyMapBackground';
import { nowLocalHHMM, todayLocalIso } from '../utils/dateTime';

interface Coordinates {
  lat: number;
  lng: number;
}

const CURRENT_LOCATION_PATTERN = /^(?:📍\s*)?(?:my\s+)?current\s*location$/i;

export default function Dashboard() {
  const { user } = useAuth();
  const navigate = useNavigate();
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  // Coordinates are only known when a place was picked from the list/map or GPS was used; typed names are
  // resolved against the timetable stops by the server.
  const [fromCoords, setFromCoords] = useState<Coordinates | null>(null);
  const [toCoords, setToCoords] = useState<Coordinates | null>(null);
  const [validationError, setValidationError] = useState('');
  const [date, setDate] = useState(() => todayLocalIso());
  const [time, setTime] = useState(() => nowLocalHHMM());

  const handleSearch = async () => {
    if (!from || !to) {
      setValidationError('Enter both a starting point and a destination to search.');
      return;
    }
    if (from.trim().toLowerCase() === to.trim().toLowerCase()) {
      setValidationError('Your starting point and destination are the same. Choose two different places.');
      return;
    }
    if (!date || !time) {
      setValidationError('Choose a date and a departure time.');
      return;
    }

    setValidationError('');

    let originCoordinates = fromCoords;
    if (!originCoordinates && CURRENT_LOCATION_PATTERN.test(from.trim())) {
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
    }

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

    const params = new URLSearchParams({
      from: originCoordinates && CURRENT_LOCATION_PATTERN.test(from.trim()) ? '📍 Current Location' : from.trim(),
      to: to.trim(),
      date,
      time
    });
    if (originCoordinates) {
      params.set('fromLat', String(originCoordinates.lat));
      params.set('fromLng', String(originCoordinates.lng));
    }
    if (toCoords) {
      params.set('toLat', String(toCoords.lat));
      params.set('toLng', String(toCoords.lng));
    }
    navigate(`/search-results?${params.toString()}`);
  };

  const handleFromChange = (value: string) => {
    setFrom(value);
    // Editing the text invalidates coordinates picked earlier (unless it is still "current location").
    if (!CURRENT_LOCATION_PATTERN.test(value.trim())) setFromCoords(null);
  };

  const handleToChange = (value: string) => {
    setTo(value);
    setToCoords(null);
  };

  const handleSwap = () => {
    setFrom(to);
    setTo(from);
    setFromCoords(toCoords);
    setToCoords(fromCoords);
  };

  const isValid = from.trim().length > 0 && to.trim().length > 0 && from.trim().toLowerCase() !== to.trim().toLowerCase() && Boolean(date) && Boolean(time);

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
            onCurrentLocation={(lat, lng) => setFromCoords({ lat, lng })}
            onFromCoordinates={(lat, lng) => setFromCoords({ lat, lng })}
            onToChange={handleToChange}
            onToCoordinates={(lat, lng) => setToCoords({ lat, lng })}
            onDateChange={setDate}
            onTimeChange={setTime}
            onSwapLocations={handleSwap}
            onSearch={handleSearch}
            loading={false}
            isValid={isValid}
          />
          {validationError && (
            <p className="mt-3 rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm font-semibold text-red-700" role="alert">
              {validationError}
            </p>
          )}
        </div>
      </main>
    </div>
  );
}

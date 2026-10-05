import { useState, useRef, useEffect } from 'react';
import { MapPin, Navigation, Map, X, Globe, Check, AlertCircle, Loader2 } from 'lucide-react';
import { searchPlaces } from '../services/planService';
import type { PlaceSuggestion } from '../services/planService';

declare global {
  interface Window {
    google?: any;
  }
}

export interface SuggestionItem {
  name: string;
  type: 'city' | 'station' | 'bus' | 'airport' | 'landmark' | 'nearby_station' | 'nearby_bus';
  subtitle: string;
  district: string;
  lat?: number;
  lon?: number;
}

const toSuggestion = (place: PlaceSuggestion): SuggestionItem => ({
  name: place.name,
  type: 'bus',
  subtitle: `${place.stopCount} stop${place.stopCount === 1 ? '' : 's'} · ${place.services} service${place.services === 1 ? '' : 's'}`,
  district: '',
  lat: place.lat,
  lon: place.lon
});

interface LocationInputProps {
  label: string;
  placeholder: string;
  value: string;
  onChange: (value: string) => void;
  onCurrentLocation?: (latitude: number, longitude: number) => void;
  // Called with the coordinates of a stop picked from the suggestions or of a point chosen on the map.
  onCoordinates?: (latitude: number, longitude: number) => void;
  suggestions?: string[];
}

export default function LocationInput({ label, placeholder, value, onChange, onCurrentLocation, onCoordinates }: LocationInputProps) {
  const [isFocused, setIsFocused] = useState(false);
  const [showMapPicker, setShowMapPicker] = useState(false);
  const [geoLoading, setGeoLoading] = useState(false);
  const [showDownwardMap, setShowDownwardMap] = useState(false);
  const [detectedCoords, setDetectedCoords] = useState<{ lat: number; lng: number } | null>(null);
  const [detectedAddress, setDetectedAddress] = useState('');
  const [permissionError, setPermissionError] = useState('');
  const [isRequestingPermission, setIsRequestingPermission] = useState(false);
  const [customPin, setCustomPin] = useState<{ x: number; y: number } | null>(null);
  const [googleMapError, setGoogleMapError] = useState('');
  const [googleLocationError, setGoogleLocationError] = useState('');
  const [googleMapLoading, setGoogleMapLoading] = useState(false);
  const [selectedMapLocation, setSelectedMapLocation] = useState<{ lat: number; lng: number; address: string; isCurrentLocation?: boolean } | null>(null);
  const [requestLocationOnOpen, setRequestLocationOnOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);
  const googleMapRef = useRef<HTMLDivElement>(null);
  const googleMapInstanceRef = useRef<any>(null);
  const googleMarkerRef = useRef<any>(null);
  const googleGeocoderRef = useRef<any>(null);
  const initialMapLocationRef = useRef<{ lat: number; lng: number } | null>(null);

  useEffect(() => {
    function handleClickOutside(event: MouseEvent) {
      if (containerRef.current && !containerRef.current.contains(event.target as Node)) {
        setIsFocused(false);
      }
    }
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, []);

  useEffect(() => {
    if (!showMapPicker || !googleMapRef.current) return;

    const apiKey = import.meta.env.VITE_GOOGLE_MAPS_API_KEY;
    if (!apiKey) {
      setGoogleMapLoading(false);
      return;
    }

    let cancelled = false;
    setGoogleMapLoading(true);
    setGoogleMapError('');
    setGoogleLocationError('');

    const loadGoogleMaps = () => new Promise<void>((resolve, reject) => {
      if (window.google?.maps) {
        resolve();
        return;
      }

      const existingScript = document.querySelector('script[data-google-maps="true"]') as HTMLScriptElement | null;
      if (existingScript) {
        existingScript.addEventListener('load', () => resolve(), { once: true });
        existingScript.addEventListener('error', () => reject(new Error('Google Maps failed to load.')), { once: true });
        return;
      }

      const script = document.createElement('script');
      script.src = `https://maps.googleapis.com/maps/api/js?key=${encodeURIComponent(apiKey)}&libraries=geocoding`;
      script.async = true;
      script.defer = true;
      script.dataset.googleMaps = 'true';
      script.onload = () => resolve();
      script.onerror = () => reject(new Error('Google Maps failed to load. Check the API key and enabled APIs.'));
      document.head.appendChild(script);
    });

    loadGoogleMaps()
      .then(() => {
        if (cancelled || !googleMapRef.current || !window.google?.maps) return;
        const defaultCenter = { lat: 16.3067, lng: 80.4365 };
        const map = new window.google.maps.Map(googleMapRef.current, {
          center: defaultCenter,
          zoom: 8,
          mapTypeControl: false,
          streetViewControl: false,
          fullscreenControl: true,
        });
        const marker = new window.google.maps.Marker({ map, position: defaultCenter, draggable: true, visible: false });
        const geocoder = new window.google.maps.Geocoder();
        googleMapInstanceRef.current = map;
        googleMarkerRef.current = marker;
        googleGeocoderRef.current = geocoder;

        const selectCoordinate = (lat: number, lng: number, isCurrentLocation = false) => {
          const position = { lat, lng };
          marker.setPosition(position);
          marker.setVisible(true);
          map.panTo(position);
          geocoder.geocode({ location: position }, (results: any[], status: string) => {
            const address = status === 'OK' && results?.[0]?.formatted_address
              ? results[0].formatted_address
              : `Pinned Location (${lat.toFixed(4)}, ${lng.toFixed(4)})`;
            if (!cancelled) setSelectedMapLocation({ lat, lng, address, isCurrentLocation });
          });
        };

        map.addListener('click', (event: any) => {
          if (event.latLng) selectCoordinate(event.latLng.lat(), event.latLng.lng());
        });
        marker.addListener('dragend', () => {
          const position = marker.getPosition();
          if (position) selectCoordinate(position.lat(), position.lng());
        });

        if (initialMapLocationRef.current) {
          const { lat, lng } = initialMapLocationRef.current;
          initialMapLocationRef.current = null;
          selectCoordinate(lat, lng, true);
        }

        if (requestLocationOnOpen && navigator.geolocation) {
          navigator.geolocation.getCurrentPosition(
            (position) => selectCoordinate(position.coords.latitude, position.coords.longitude, true),
            () => setGoogleLocationError('Location permission was denied. You can still click the map to choose a location.'),
            { enableHighAccuracy: true, timeout: 10000 }
          );
          setRequestLocationOnOpen(false);
        } else if (requestLocationOnOpen) {
          setGoogleLocationError('Location permission is not supported by this browser. You can still click the map to choose a location.');
          setRequestLocationOnOpen(false);
        }
      })
      .catch((error: Error) => {
        if (!cancelled) setGoogleMapError(error.message);
      })
      .finally(() => {
        if (!cancelled) setGoogleMapLoading(false);
      });

    return () => {
      cancelled = true;
      googleMapInstanceRef.current = null;
      googleMarkerRef.current = null;
      googleGeocoderRef.current = null;
    };
  }, [showMapPicker, requestLocationOnOpen]);

  // Suggestions come from the stops in the transit timetable, so every suggestion can actually be routed.
  const [placeSuggestions, setPlaceSuggestions] = useState<SuggestionItem[]>([]);
  const [suggestionsLoading, setSuggestionsLoading] = useState(false);

  useEffect(() => {
    const query = value.trim();
    if (!isFocused || query.length < 1 || /current\s*location/i.test(query)) {
      setPlaceSuggestions([]);
      setSuggestionsLoading(false);
      return;
    }
    const controller = new AbortController();
    setSuggestionsLoading(true);
    const timer = setTimeout(() => {
      searchPlaces(query, controller.signal)
        .then(places => {
          setPlaceSuggestions(places.map(toSuggestion));
          setSuggestionsLoading(false);
        })
        .catch(error => {
          if ((error as Error).name === 'AbortError') return;
          setPlaceSuggestions([]);
          setSuggestionsLoading(false);
        });
    }, 180);
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [value, isFocused]);

  const filteredSuggestions = placeSuggestions;

  const getEmojiForType = (type: SuggestionItem['type']) => {
    switch (type) {
      case 'city': return '📍';
      case 'station': return '🚆';
      case 'bus': return '🚌';
      case 'airport': return '✈️';
      case 'landmark': return '📍';
      case 'nearby_station': return '🚆';
      case 'nearby_bus': return '🚌';
    }
  };

  const handleUseCurrentLocation = () => {
    setIsFocused(false);
    setPermissionError('');
    if (!navigator.geolocation) {
      setPermissionError('Geolocation is not supported by your browser. Please enter your starting location manually.');
      return;
    }

    setIsRequestingPermission(true);
    setGeoLoading(true);

    navigator.geolocation.getCurrentPosition(
      async (position) => {
        const { latitude, longitude } = position.coords;
        setGeoLoading(false);
        setIsRequestingPermission(false);
        setPermissionError('');
        setDetectedCoords({ lat: latitude, lng: longitude });
        setDetectedAddress('Detecting address...');
        setShowDownwardMap(true);

        try {
          const res = await fetch(`/api/geo/reverse?lat=${latitude}&lng=${longitude}`);
          if (res.ok) {
            const data = await res.json();
            setDetectedAddress(data.address || data.name || `Location (${latitude.toFixed(4)}, ${longitude.toFixed(4)})`);
          } else {
            setDetectedAddress(`Location (${latitude.toFixed(4)}, ${longitude.toFixed(4)})`);
          }
        } catch {
          setDetectedAddress(`Location (${latitude.toFixed(4)}, ${longitude.toFixed(4)})`);
        }
      },
      (error) => {
        setGeoLoading(false);
        setIsRequestingPermission(false);
        if (error.code === error.PERMISSION_DENIED) {
          setPermissionError('Location permission was denied. Please allow location access in your browser settings to use your current location, or enter a location manually.');
        } else {
          setPermissionError('Unable to detect your current location. Please check your GPS or device location settings.');
        }
      },
      { enableHighAccuracy: true, timeout: 12000, maximumAge: 0 }
    );
  };

  const handleProceedWithCurrentLocation = () => {
    if (!detectedCoords) return;
    onChange('📍 Current Location');
    onCurrentLocation?.(detectedCoords.lat, detectedCoords.lng);
    setShowDownwardMap(false);
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter') {
      const trimmed = value.trim().toLowerCase();
      if (/^(?:📍\s*)?(?:use\s+)?(?:my\s+)?current\s*location$/i.test(trimmed) || trimmed === 'here' || trimmed === 'gps') {
        e.preventDefault();
        handleUseCurrentLocation();
      }
    }
  };

  const confirmMapSelection = (selectedName: string) => {
    onChange(selectedName);
    if (selectedMapLocation?.isCurrentLocation) {
      onCurrentLocation?.(selectedMapLocation.lat, selectedMapLocation.lng);
    } else if (selectedMapLocation) {
      onCoordinates?.(selectedMapLocation.lat, selectedMapLocation.lng);
    }
    initialMapLocationRef.current = null;
    setShowMapPicker(false);
    setCustomPin(null);
  };

  const useCurrentLocationOnGoogleMap = () => {
    if (!navigator.geolocation) {
      setGoogleLocationError('Location permission is not supported by this browser. You can still select a point on the map.');
      return;
    }

    setGoogleLocationError('');
    setGeoLoading(true);
    navigator.geolocation.getCurrentPosition(
      (position) => {
        const { latitude, longitude } = position.coords;
        if (!googleMapInstanceRef.current || !googleGeocoderRef.current) {
          setSelectedMapLocation({
            lat: latitude,
            lng: longitude,
            address: '📍 Current Location',
            isCurrentLocation: true
          });
          setGeoLoading(false);
          return;
        }
        googleMapInstanceRef.current?.setZoom(15);
        googleMapInstanceRef.current?.panTo({ lat: latitude, lng: longitude });
        googleMarkerRef.current?.setPosition({ lat: latitude, lng: longitude });
        googleMarkerRef.current?.setVisible(true);
        googleGeocoderRef.current?.geocode({ location: { lat: latitude, lng: longitude } }, (results: any[], status: string) => {
          const address = status === 'OK' && results?.[0]?.formatted_address
            ? results[0].formatted_address
            : `Current Location (${latitude.toFixed(4)}, ${longitude.toFixed(4)})`;
          setSelectedMapLocation({ lat: latitude, lng: longitude, address, isCurrentLocation: true });
          setGeoLoading(false);
        });
      },
      (error) => {
        setGeoLoading(false);
        setGoogleLocationError(error.code === error.PERMISSION_DENIED
          ? 'Location permission was denied. Allow location access in your browser, or select a point on the map.'
          : 'Unable to determine your current location. You can still select a point on the map.');
      },
      { enableHighAccuracy: true, timeout: 10000 }
    );
  };

  return (
    <div ref={containerRef} className="space-y-1.5 text-sm font-semibold text-[#1F2933] block relative">
      <span className="flex items-center justify-between">
        <span className="flex items-center gap-2">
          <span className="inline-flex h-8 w-8 items-center justify-center rounded-xl bg-gradient-to-br from-blue-100 to-blue-50 text-blue-600 shadow-sm border border-blue-200/50">
            <MapPin className="h-4 w-4" />
          </span>
          {label}
        </span>
      </span>

      <div className="relative">
        <input
          type="text"
          value={value}
          onChange={(event) => onChange(event.target.value)}
          onFocus={() => setIsFocused(true)}
          onKeyDown={handleKeyDown}
          placeholder={placeholder}
          className="w-full rounded-xl border border-[#D9DED9] bg-white pl-4 pr-11 py-3 text-sm text-[#1F2933] shadow-sm outline-none transition hover:border-[#B9C6C1] focus:border-[#146B5B] focus:ring-1 focus:ring-[#146B5B]"
        />

        {/* Quick GPS target button inside input */}
        <button
          type="button"
          onClick={handleUseCurrentLocation}
          title="Use My Current Location"
          className="absolute right-2.5 top-1/2 -translate-y-1/2 rounded-lg p-1.5 text-gray-400 hover:bg-emerald-50 hover:text-emerald-700 transition"
        >
          <Navigation className={`h-4 w-4 ${isRequestingPermission ? 'animate-spin text-emerald-600' : ''}`} />
        </button>

        {/* Dropdown suggestions popup */}
        {isFocused && (
          <div className="absolute left-0 right-0 top-full z-50 mt-2 overflow-hidden rounded-2xl border border-blue-200 bg-white shadow-xl max-h-[340px] overflow-y-auto">
            
            {/* Geolocation trigger */}
            <button
              type="button"
              onMouseDown={(e) => {
                e.preventDefault();
              }}
              onClick={handleUseCurrentLocation}
              className="w-full px-4 py-3 text-left text-sm text-emerald-700 hover:bg-emerald-50 flex items-center gap-2.5 border-b border-emerald-50 font-bold transition"
            >
              <Navigation className={`h-4 w-4 text-emerald-600 ${isRequestingPermission ? 'animate-spin' : ''}`} />
              {isRequestingPermission ? 'Asking for location permission...' : '📍 Use My Current Location'}
            </button>

            {/* Map selector trigger */}
            <button
              type="button"
              onMouseDown={(e) => {
                e.preventDefault();
                setRequestLocationOnOpen(true);
                setShowMapPicker(true);
                setIsFocused(false);
              }}
              className="w-full px-4 py-3 text-left text-sm text-blue-700 hover:bg-blue-50 flex items-center gap-2.5 border-b border-blue-50 font-bold transition"
            >
              <Map className="h-4 w-4 text-blue-500" />
              🗺 Select on Map
            </button>

            {/* Match suggestions */}
            {filteredSuggestions.length > 0 ? (
              filteredSuggestions.map((item, idx) => {
                const isNearby = item.type === 'nearby_station' || item.type === 'nearby_bus';
                return (
                  <button
                    key={idx}
                    type="button"
                    onMouseDown={() => {
                      if (item.name === '📍 Current Location' || item.name === '📍 Use My Current Location' || item.name.toLowerCase().includes('current location')) {
                        handleUseCurrentLocation();
                      } else {
                        onChange(item.name);
                        if (item.lat !== undefined && item.lon !== undefined) onCoordinates?.(item.lat, item.lon);
                        setIsFocused(false);
                      }
                    }}
                    className={`w-full px-4 py-3 text-left text-sm hover:bg-blue-50 flex items-center gap-3 transition border-b border-blue-50/50 last:border-b-0 ${isNearby ? 'bg-amber-50/30 pl-8' : ''}`}
                  >
                    <span className="text-base shrink-0">{getEmojiForType(item.type)}</span>
                    <div className="flex-1 min-w-0">
                      <p className={`font-extrabold truncate ${isNearby ? 'text-amber-800' : 'text-blue-900'}`}>{item.name}</p>
                      <p className="text-[10px] text-blue-400 font-semibold uppercase tracking-wider">{item.subtitle}</p>
                    </div>
                  </button>
                );
              })
            ) : (
              value.trim() !== '' && (
                <div className="px-4 py-3 text-xs text-blue-500 font-semibold text-center italic">
                  {suggestionsLoading ? 'Searching stops...' : 'No matching stop in the transit timetable.'}
                </div>
              )
            )}
          </div>
        )}
      </div>

      {/* Asking for Location Permission Status */}
      {isRequestingPermission && (
        <div className="mt-2 flex items-center gap-2.5 rounded-xl border border-blue-200 bg-blue-50/95 px-3.5 py-3 text-xs font-semibold text-blue-900 shadow-sm animate-pulse">
          <Loader2 className="h-4 w-4 animate-spin text-blue-600 shrink-0" />
          <span>Asking for location permission... Please click <strong>&ldquo;Allow&rdquo;</strong> in your browser prompt to view your location on Google Maps.</span>
        </div>
      )}

      {/* Permission Denied / Error Banner */}
      {permissionError && (
        <div className="mt-2 flex items-start justify-between gap-2 rounded-xl border border-amber-300 bg-amber-50 px-3.5 py-2.5 text-xs font-semibold text-amber-900 shadow-sm animate-in fade-in">
          <div className="flex items-start gap-2">
            <AlertCircle className="h-4 w-4 text-amber-600 mt-0.5 shrink-0" />
            <div>
              <p className="font-bold text-amber-950">Location Permission Required</p>
              <p className="text-[11px] text-amber-800 mt-0.5">{permissionError}</p>
            </div>
          </div>
          <button
            type="button"
            onClick={() => setPermissionError('')}
            className="text-amber-700 hover:text-amber-950 p-1 text-sm font-bold"
            title="Dismiss"
          >
            ✕
          </button>
        </div>
      )}

      {/* Downward Google Map with Current Location and Proceed Option */}
      {showDownwardMap && detectedCoords && (
        <div className="mt-2.5 w-full rounded-2xl border-2 border-emerald-500/40 bg-white p-3.5 shadow-xl transition-all animate-in fade-in slide-in-from-top-2 relative z-20">
          <div className="flex items-center justify-between border-b border-gray-100 pb-2.5">
            <div className="flex items-center gap-2">
              <span className="relative flex h-3 w-3">
                <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-emerald-400 opacity-75"></span>
                <span className="relative inline-flex rounded-full h-3 w-3 bg-emerald-500"></span>
              </span>
              <span className="text-xs font-extrabold text-[#146B5B] uppercase tracking-wider">
                Google Map — Current Location
              </span>
            </div>
            <button
              type="button"
              onClick={() => setShowDownwardMap(false)}
              className="rounded-full p-1 text-gray-400 hover:bg-gray-100 hover:text-gray-700 transition"
              title="Close Map"
            >
              <X className="h-4 w-4" />
            </button>
          </div>

          {/* Google Map View */}
          <div className="relative mt-2.5 h-56 sm:h-64 w-full overflow-hidden rounded-xl border border-gray-200 bg-gray-50 shadow-inner">
            <iframe
              title="Google Map Current Location"
              width="100%"
              height="100%"
              style={{ border: 0 }}
              loading="lazy"
              allowFullScreen
              referrerPolicy="no-referrer-when-downgrade"
              src={`https://maps.google.com/maps?q=${detectedCoords.lat},${detectedCoords.lng}&hl=en&z=15&output=embed`}
            />
          </div>

          {/* Detected Address Details */}
          <div className="mt-2.5 flex flex-col sm:flex-row sm:items-center justify-between gap-1.5 rounded-xl bg-[#F0FDF4] border border-emerald-100 p-2.5 text-xs text-emerald-950 font-medium">
            <div className="flex items-center gap-2 min-w-0">
              <MapPin className="h-4 w-4 text-emerald-600 shrink-0" />
              <span className="font-bold truncate text-emerald-900">{detectedAddress || '📍 Current GPS Location'}</span>
            </div>
            <span className="text-[11px] font-mono text-emerald-700 bg-emerald-100/60 px-2 py-0.5 rounded-md shrink-0 self-start sm:self-auto">
              {detectedCoords.lat.toFixed(4)}° N, {detectedCoords.lng.toFixed(4)}° E
            </span>
          </div>

          {/* Action buttons with Proceed option */}
          <div className="mt-3 flex items-center gap-2">
            <button
              type="button"
              onClick={handleProceedWithCurrentLocation}
              className="flex-1 py-3 px-4 bg-emerald-600 hover:bg-emerald-700 active:scale-[0.99] text-white font-extrabold text-sm rounded-xl transition shadow-md hover:shadow-lg flex items-center justify-center gap-2"
            >
              <Check className="h-4 w-4 stroke-[3]" />
              <span>Proceed with Current Location</span>
            </button>
            <button
              type="button"
              onClick={() => setShowDownwardMap(false)}
              className="py-3 px-4 rounded-xl border border-gray-200 bg-gray-50 hover:bg-gray-100 text-gray-700 font-bold text-xs transition"
            >
              Cancel
            </button>
          </div>
        </div>
      )}


      {/* Map selection Modal overlay */}
      {showMapPicker && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-[#1F2933]/45 backdrop-blur-sm p-4 animate-fadeIn">
          <div className="w-full max-w-xl bg-white rounded-[2rem] shadow-2xl border border-blue-200 overflow-hidden flex flex-col">
            <div className="flex items-center justify-between bg-gradient-to-r from-blue-600 to-blue-800 p-5 text-white">
              <div>
                <p className="text-xs uppercase tracking-[0.2em] font-bold text-blue-100">Select Location on Andhra Pradesh Map</p>
                <h3 className="text-lg font-black">{label}</h3>
              </div>
              <button
                onClick={() => {
                  setShowMapPicker(false);
                  setCustomPin(null);
                  setSelectedMapLocation(null);
                  initialMapLocationRef.current = null;
                }}
                className="rounded-full bg-white/20 p-2 hover:bg-white/30 transition"
              >
                <X className="h-4.5 w-4.5" />
              </button>
            </div>

            <div className="p-5 space-y-4 flex-1">
              <p className="text-xs text-blue-850 font-semibold flex items-center gap-1.5 bg-blue-50 p-3 rounded-xl border border-blue-100">
                🗺 Click anywhere on Google Maps, drag the pin, or use your current location. Google will identify the selected address.
              </p>

              <div ref={googleMapRef} className="relative min-h-[320px] rounded-2xl border border-blue-200 overflow-hidden bg-blue-50">
                {googleMapLoading && (
                  <div className="absolute inset-0 z-10 flex items-center justify-center bg-blue-50/90 text-sm font-bold text-blue-700">
                    Loading Google Maps...
                  </div>
                )}
                {googleMapError && (
                  <div className="absolute inset-0 z-10 flex items-center justify-center p-6 text-center text-sm font-bold text-red-700 bg-red-50">
                    {googleMapError}
                  </div>
                )}
                {!googleMapLoading && !googleMapError && !import.meta.env.VITE_GOOGLE_MAPS_API_KEY && (
                  <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 p-6 text-center bg-blue-50">
                    <Map className="h-10 w-10 text-blue-500" />
                    <p className="text-sm font-bold text-blue-900">Google Maps preview is unavailable in this environment.</p>
                    <a
                      href="https://www.google.com/maps/@16.3067,80.4365,8z"
                      target="_blank"
                      rel="noreferrer"
                      className="rounded-xl bg-blue-600 px-4 py-2 text-xs font-bold text-white hover:bg-blue-700"
                    >
                      Open Google Maps
                    </a>
                  </div>
                )}
              </div>
              {googleLocationError && (
                <p role="status" className="text-xs font-semibold text-amber-800 bg-amber-50 border border-amber-200 rounded-xl p-3">
                  {googleLocationError}
                </p>
              )}

              <div className="flex flex-col gap-3 sm:flex-row">
                <button
                  type="button"
                  onClick={useCurrentLocationOnGoogleMap}
                  disabled={geoLoading || Boolean(googleMapError)}
                  className="flex-1 py-3 bg-blue-600 hover:bg-blue-700 disabled:opacity-50 text-white font-bold rounded-xl transition shadow-md"
                >
                  {geoLoading ? 'Requesting location permission...' : '📍 Use My Current Location'}
                </button>
                <button
                  type="button"
                  onClick={() => selectedMapLocation && confirmMapSelection(selectedMapLocation.address)}
                  disabled={!selectedMapLocation}
                  className="flex-1 py-3 bg-emerald-600 hover:bg-emerald-700 disabled:opacity-50 text-white font-bold rounded-xl transition shadow-md"
                >
                  ✓ Proceed
                </button>
              </div>
              {selectedMapLocation && (
                <p className="text-xs font-bold text-[#1F2933] bg-emerald-50 border border-emerald-200 rounded-xl p-3">
                  Selected: {selectedMapLocation.address}
                </p>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

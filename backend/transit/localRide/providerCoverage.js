// Ride-provider COVERAGE metadata for local-ride (first/last-mile) legs.
//
// This is city-level, published coverage only. It is NOT availability: RouteConnect has no provider API, so no provider
// is ever reported as available, bookable or priced. A provider is listed for a city only when that provider's own
// public site has a page for that city (see `sourceUrl`). Coverage that could not be confirmed from an official page is
// deliberately absent: it is never filled in from memory or from the fact that a provider exists elsewhere in the state.
//
// Verified 2026-10-08 against the providers' public pages:
//   Uber   - official city pages (uber.com/global/en/r/cities/<city>-in/) exist for Guntur, Nellore, Rajahmundry, Hyderabad.
//            The same URLs return 404 for Vijayawada, Visakhapatnam, Tirupati and Kakinada, so Uber is NOT listed there.
//   Rapido - official city pages (rapido.bike/<City>/main-page) exist for the cities below; an unknown city returns 404.
//   Ola    - olacabs.com publishes only a "250+ cities" figure and no city list, so no Ola coverage is claimed anywhere.
import { haversineMeters } from '../routing/geo.js';

export const COVERAGE_TYPE = 'published_city_coverage';
export const LAST_CHECKED = '2026-10-08';

// Reference centres used ONLY to decide which city a ride is in. They say nothing about provider coverage.
export const CITIES = Object.freeze([
  { id: 'guntur', name: 'Guntur', lat: 16.3067, lon: 80.4365, radiusMeters: 10000 },
  { id: 'vijayawada', name: 'Vijayawada', lat: 16.5062, lon: 80.6480, radiusMeters: 12000 },
  { id: 'visakhapatnam', name: 'Visakhapatnam', lat: 17.6868, lon: 83.2185, radiusMeters: 15000 },
  { id: 'nellore', name: 'Nellore', lat: 14.4426, lon: 79.9865, radiusMeters: 9000 },
  { id: 'rajahmundry', name: 'Rajahmundry', lat: 17.0005, lon: 81.8040, radiusMeters: 9000 },
  { id: 'tirupati', name: 'Tirupati', lat: 13.6288, lon: 79.4192, radiusMeters: 9000 },
  { id: 'kakinada', name: 'Kakinada', lat: 16.9891, lon: 82.2475, radiusMeters: 9000 },
  { id: 'hyderabad', name: 'Hyderabad', lat: 17.3850, lon: 78.4867, radiusMeters: 25000 }
]);

// provider -> city id -> the official public page that supports the claim.
export const PROVIDER_COVERAGE = Object.freeze([
  Object.freeze({
    provider: 'Uber',
    sourceType: 'official_city_page',
    confidence: 'published_coverage',
    lastChecked: LAST_CHECKED,
    cities: Object.freeze({
      guntur: 'https://www.uber.com/global/en/r/cities/guntur-andhra-pradesh-in/',
      nellore: 'https://www.uber.com/global/en/r/cities/nellore-andhra-pradesh-in/',
      rajahmundry: 'https://www.uber.com/global/en/r/cities/rajahmundry-andhra-pradesh-in/',
      hyderabad: 'https://www.uber.com/global/en/r/cities/hyderabad-telangana-in/'
    })
  }),
  Object.freeze({
    provider: 'Rapido',
    sourceType: 'official_city_page',
    confidence: 'published_coverage',
    lastChecked: LAST_CHECKED,
    cities: Object.freeze({
      vijayawada: 'https://rapido.bike/Vijayawada/main-page',
      visakhapatnam: 'https://rapido.bike/Vishakapatnam/main-page',
      guntur: 'https://rapido.bike/Guntur/main-page',
      tirupati: 'https://rapido.bike/Tirupati/main-page',
      nellore: 'https://rapido.bike/Nellore/main-page',
      rajahmundry: 'https://rapido.bike/Rajahmundry/main-page',
      kakinada: 'https://rapido.bike/Kakinada/main-page',
      hyderabad: 'https://rapido.bike/Hyderabad/main-page'
    })
  }),
  // No official city list was found, so no city is claimed.
  Object.freeze({ provider: 'Ola', sourceType: 'none', confidence: 'unknown', lastChecked: LAST_CHECKED, cities: Object.freeze({}) })
]);

// The city a ride is in: BOTH ends must lie within the same city's radius (a ride that starts in a village outside the
// city is not claimed as city coverage). Returns the nearest such city, or null.
export function cityForRide(from, to, cities = CITIES) {
  let best = null;
  for (const city of cities) {
    const a = haversineMeters(from.lat, from.lon, city.lat, city.lon);
    const b = haversineMeters(to.lat, to.lon, city.lat, city.lon);
    if (a <= city.radiusMeters && b <= city.radiusMeters) {
      const score = Math.max(a, b);
      if (!best || score < best.score) best = { city, score };
    }
  }
  return best ? best.city : null;
}

/**
 * Possible ride services for a local ride between two points.
 * @returns {{ city: string|null, providerOptions: {name:string, coverage:string, realtimeAvailable:false}[] }}
 * `realtimeAvailable` is ALWAYS false: coverage is published city-level information, not live availability.
 */
export function providerOptionsForRide(from, to, { cities = CITIES, coverage = PROVIDER_COVERAGE } = {}) {
  const city = cityForRide(from, to, cities);
  if (!city) return { city: null, providerOptions: [] };
  const providerOptions = coverage
    .filter(entry => Boolean(entry.cities[city.id]))
    .map(entry => ({ name: entry.provider, coverage: COVERAGE_TYPE, realtimeAvailable: false }));
  return { city: providerOptions.length ? city.name : null, providerOptions };
}

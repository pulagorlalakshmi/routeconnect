// Flight source backed by the Duffel API (https://duffel.com/docs) - a legitimate, contract-based flight API.
// Active only when DUFFEL_ACCESS_TOKEN is set. Without it the source reports "not configured"; RouteConnect never
// falls back to the hand-written schedules in backend/db/staticFlightSchedules.js (they have no stated source).
//
// Search (only for trips where a flight could plausibly matter, see MIN_FLIGHT_DISTANCE_METERS):
//   1. GET  /places/suggestions?lat&lng&rad   -> airports near the origin and the destination (cached for hours)
//   2. POST /air/offer_requests?return_offers=true  for the nearest airport pair and the search date
//   3. Each offer's first slice becomes a sequence of flight TRUNK legs (one per segment) with the offer's total price.
// Requests carry only airports, the date and one adult passenger - nothing about the user.
import { operatorIdentity } from '../operators.js';
import { createTtlCache } from '../sourceRunner.js';

const API = 'https://api.duffel.com';
export const MIN_FLIGHT_DISTANCE_METERS = 250000;
const AIRPORT_RADIUS_METERS = 100000;
const MAX_OFFERS = 6;

const airportCache = createTtlCache({ ttlMs: 12 * 3600 * 1000 });

function headers(token) {
  return { Authorization: `Bearer ${token}`, 'Duffel-Version': 'v2', Accept: 'application/json', 'Content-Type': 'application/json' };
}

export async function nearbyAirports(point, { token, fetchImpl = fetch, cache = airportCache }) {
  const key = `${point.lat.toFixed(2)},${point.lon.toFixed(2)}`;
  const hit = cache.get(key);
  if (hit) return hit;
  const url = `${API}/places/suggestions?lat=${point.lat}&lng=${point.lon}&rad=${AIRPORT_RADIUS_METERS}`;
  const response = await fetchImpl(url, { headers: headers(token) });
  if (!response.ok) throw new Error(`Duffel places ${response.status}`);
  const body = await response.json();
  const airports = (body.data ?? [])
    .filter(place => place.type === 'airport' && place.iata_code)
    .map(place => ({ iata: place.iata_code, name: place.name, lat: place.latitude, lon: place.longitude }));
  return cache.set(key, airports);
}

// Converts one Duffel offer into flight trunk legs. Exported for tests.
export function offerToTrunks(offer) {
  const slice = offer.slices?.[0];
  if (!slice?.segments?.length) return null;
  const amount = Number(offer.total_amount);
  const fare = Number.isFinite(amount) ? { type: 'published', amount, currency: offer.total_currency ?? null, confidence: 'published', basis: 'flight_offer_total' } : null;
  return slice.segments.map((segment, index) => {
    const carrier = segment.operating_carrier?.name ?? segment.marketing_carrier?.name ?? null;
    const operator = operatorIdentity(carrier, { source: 'duffel', confidence: 'published', typeHint: 'airline' });
    const flightNumber = `${segment.marketing_carrier?.iata_code ?? ''}${segment.marketing_carrier_flight_number ?? ''}` || null;
    const departure = segment.departing_at;
    const arrival = segment.arriving_at;
    return {
      mode: 'air',
      operatorInfo: operator,
      operator: operator.name,
      flightNumber,
      displayName: flightNumber ? `${operator.name ?? 'Flight'} ${flightNumber}` : operator.name ?? 'Flight',
      from: { type: 'airport', name: segment.origin?.name ?? segment.origin?.iata_code, code: segment.origin?.iata_code, lat: segment.origin?.latitude, lon: segment.origin?.longitude },
      to: { type: 'airport', name: segment.destination?.name ?? segment.destination?.iata_code, code: segment.destination?.iata_code, lat: segment.destination?.latitude, lon: segment.destination?.longitude },
      // Duffel gives local times without an offset; the airport time zone is attached when known.
      departureTime: departure,
      arrivalTime: arrival,
      durationSeconds: Math.max(0, Math.round((Date.parse(arrival) - Date.parse(departure)) / 1000)),
      scheduleConfidence: 'published',
      timeQuality: 'exact',
      // The price is for the whole offer, so it is put on the first segment only.
      fare: index === 0 ? fare : null,
      offerId: offer.id,
      source: { id: 'duffel', name: 'Duffel', type: 'api' }
    };
  });
}

export function createDuffelSource({ env = process.env, fetchImpl = (...args) => fetch(...args) } = {}) {
  const token = env.DUFFEL_ACCESS_TOKEN ?? null;
  return {
    id: 'flights',
    label: 'Flights (Duffel)',
    mode: 'air',
    timeoutMs: 8000,
    status(ctx) {
      if (!token) return { configured: false, reason: 'No flight API is configured (DUFFEL_ACCESS_TOKEN). The old hand-written flight schedules are not used: they have no stated source.' };
      if (ctx.crowFliesMeters < MIN_FLIGHT_DISTANCE_METERS) return { configured: true, applicable: false, reason: `Flights are only searched for trips over ${MIN_FLIGHT_DISTANCE_METERS / 1000} km.` };
      return { configured: true };
    },
    async search(ctx) {
      const [fromAirports, toAirports] = await Promise.all([nearbyAirports(ctx.origin, { token, fetchImpl }), nearbyAirports(ctx.destination, { token, fetchImpl })]);
      if (fromAirports.length === 0 || toAirports.length === 0) return { trunks: [] };
      const body = {
        data: {
          slices: [{ origin: fromAirports[0].iata, destination: toAirports[0].iata, departure_date: ctx.date }],
          passengers: [{ type: 'adult' }],
          cabin_class: 'economy'
        }
      };
      const response = await fetchImpl(`${API}/air/offer_requests?return_offers=true`, { method: 'POST', headers: headers(token), body: JSON.stringify(body) });
      if (!response.ok) throw new Error(`Duffel offer request ${response.status}`);
      const offers = ((await response.json()).data?.offers ?? [])
        .sort((a, b) => Number(a.total_amount) - Number(b.total_amount))
        .slice(0, MAX_OFFERS);
      // Each offer is one trunk SEQUENCE (connecting flights stay together).
      return { trunks: offers.map(offerToTrunks).filter(Boolean) };
    }
  };
}

// How much a value can be trusted (weakest -> strongest). Estimated values must never be shown as verified.
export type DataConfidence = 'unknown' | 'estimated' | 'inferred' | 'published' | 'verified' | 'live';

export interface RouteSegment {
  mode: 'train' | 'bus' | 'auto' | 'cab' | 'uber' | 'rapido' | 'walking' | 'flight' | 'airport_transfer';
  provider: string;
  from: string;
  to: string;
  durationMinutes: number;
  distanceKm: number;
  price: number;
  departure: string | null;
  arrival: string | null;
  departureFormatted?: string;
  arrivalFormatted?: string;
  departureDate?: string;
  arrivalDate?: string;
  departureDateFormatted?: string;
  arrivalDateFormatted?: string;
  timingType?: 'scheduled' | 'estimated' | 'frequent';
  timingNote?: string;
  trainName?: string | null;
  trainNumber?: string | null;
  serviceName?: string | null;
  busType?: string | null;
  estimated?: boolean;
  estimatedNote?: string;
  fareAvailable?: boolean;
  detailsAvailable?: boolean;
  currency?: string | null;
  flightNumber?: string | null;
  departureAirport?: string | null;
  arrivalAirport?: string | null;
  departureIata?: string | null;
  arrivalIata?: string | null;
  fromCoordinates?: { latitude: number; longitude: number };
  toCoordinates?: { latitude: number; longitude: number };
  stopCount?: number;
  layoverMinutes?: number | null;
  baggage?: string | null;
  availabilityStatus?: string | null;
  offerExpiresAt?: string | null;
  stops?: string | null;
  // Set on estimated ride-hailing legs (no provider integration exists)
  providerIntegration?: boolean;
  dataConfidence?: DataConfidence;
  fareConfidence?: DataConfidence;
  durationConfidence?: DataConfidence;
  isRealtime?: boolean;
}

export interface RouteTransfer {
  transferNumber: number;
  location: string;
  fromMode: string;
  toMode: string;
  nextBoardingPoint: string;
  transferMode: string;
  transferDistanceKm: number;
  transferDurationMinutes: number;
  transferPrice: number;
  instruction: string;
  layoverMinutes?: number;
  window?: string;
}

export interface VillageAssistance {
  originIsVillage: boolean;
  villageName: string;
  nearestBusFacility: { name: string; distanceKm: number; type: string } | null;
  nearestRailwayStation: { name: string; distanceKm: number; type: string } | null;
  explanation: string;
}

export interface FlightDetails {
  airline: string;
  flightNumber: string;
  departureAirport: string;
  departureIata: string;
  departureTime: string;
  arrivalAirport: string;
  arrivalIata: string;
  arrivalTime: string;
  duration: string;
  durationMinutes: number;
  stops: string;
  fare: number;
  baggage?: string | null;
  availabilityStatus?: string | null;
  aircraft?: string | null;
  layoverDuration?: string | null;
  layoverAirport?: string | null;
  layoverIata?: string | null;
  airportTransferRequirements?: string | null;
}

export interface RouteTimeSync {
  synchronized: boolean;
  requestedDate: string;
  requestedTime: string;
  departureFormatted: string;
  arrivalFormatted: string;
  daysSpan: number;
  verifiedAt: string;
  timezone: string;
  scheduleStatus: string;
}

export interface RouteResult {
  id: string;
  from: string;
  to: string;
  totalPrice: number;
  totalDurationMinutes: number;
  totalTransfers: number;
  tag: 'cheapest' | 'fastest' | 'best' | 'budget' | null;
  isFastest?: boolean;
  isBudget?: boolean;
  segments: RouteSegment[];
  routeName?: string;
  via?: string;
  highway?: string;
  villages?: string[];
  distanceKm?: number;
  source?: string;
  retrievedAt?: string;
  currency?: string | null;
  priceIsPartial?: boolean;
  timeIsPartial?: boolean;
  availabilityStatus?: string | null;
  modes?: string[];
  transfers?: RouteTransfer[];
  villageAssistance?: VillageAssistance | null;
  walkingDistanceKm?: number;
  busDistanceKm?: number;
  trainDistanceKm?: number;
  cabAutoDistanceKm?: number;
  flightDistanceKm?: number;
  busStops?: string[];
  busStands?: string[];
  railwayStations?: string[];
  airports?: string[];
  intermediateLocations?: string[];
  flightDetails?: FlightDetails | null;
  departureTime?: string;
  arrivalTime?: string;
  departureTimeRaw?: string;
  arrivalTimeRaw?: string;
  departureDate?: string;
  arrivalDate?: string;
  departureDateISO?: string;
  arrivalDateISO?: string;
  isNextDay?: boolean;
  timeSynchronization?: RouteTimeSync;
  // Set on routes that contain an estimated ride-hailing (Uber/Rapido) leg
  providerIntegration?: boolean;
  dataConfidence?: DataConfidence;
  fareConfidence?: DataConfidence;
  durationConfidence?: DataConfidence;
  isRealtime?: boolean;
  rankingClass?: 'estimated_ride_hailing';
  rideHailingNote?: string;
}

export interface TimeSynchronizationInfo {
  date: string;
  time: string;
  synchronizedAt: string;
  verified: boolean;
  timezone: string;
}

export interface FlightSearchInfo {
  configured: boolean;
  provider: string;
  queriedAt: string;
  date: string | null;
  status: string;
  message: string;
  offerCount: number;
}

export interface RouteLocationInsight {
  placeId: string;
  name: string;
  latitude: number;
  longitude: number;
  type: string;
  district?: string | null;
  region?: string | null;
  distanceFromRouteKm?: number;
  associatedRoute?: { from: string; to: string };
  retrievedAt?: string;
  googleMapsUri?: string | null;
  source: string;
}

export interface RouteInsights {
  configured: boolean;
  retrievedAt: string;
  source: string;
  route: { from: string; to: string; distanceKm: number; durationMinutes: number } | null;
  locations: RouteLocationInsight[];
  nearestBusFacility: {
    name: string;
    type: 'Bus Station' | 'Bus Stop' | string;
    latitude?: number;
    longitude?: number;
    distanceFromOriginKm: number;
    displayDistanceText?: string;
    connectsToward?: string;
    connectsToDestination?: boolean;
    isInsideVillage?: boolean;
    onwardTransitDurationMinutes?: number | null;
    onwardTransitInfo?: string | null;
    accessDistanceKm?: number | null;
    accessDurationMinutes?: number | null;
    accessRoute?: {
      mode: 'walking' | 'auto' | 'feeder';
      durationMinutes: number;
      distanceKm: number;
      price: number;
      description: string;
    } | null;
    directionsUrl: string;
  } | null;
  error?: string;
}

export async function searchRoutes(from: string, to: string, routeType: 'budget' | 'fast'): Promise<RouteResult[]> {
  // Backward compatibility with legacy direct routes search
  try {
    const params = new URLSearchParams({
      from: from.trim(),
      to: to.trim(),
      type: routeType,
    });

    const response = await fetch(`/api/routes?${params.toString()}`);
    if (!response.ok) {
      throw new Error('Failed to fetch routes from server');
    }

    const data = await response.json();
    // Map simple routes to multi-modal structure
    const mapped: RouteResult[] = (data.routes || []).map((r: any) => {
      const mode = r.transport.toLowerCase().includes('train') ? 'train' : 'bus';
      const durationMatch = r.duration.match(/(\d+)h\s*(\d*)m?/);
      let durationMinutes = 180;
      if (durationMatch) {
        durationMinutes = parseInt(durationMatch[1]) * 60 + (parseInt(durationMatch[2]) || 0);
      }
      
      const distanceVal = parseFloat(r.distance.replace(/[^\d.]/g, '')) || 100;
      const priceVal = routeType === 'budget' ? 180 : 350;

      return {
        id: r.id,
        from: r.from,
        to: r.to,
        totalPrice: priceVal,
        totalDurationMinutes: durationMinutes,
        totalTransfers: r.connections,
        tag: null,
        segments: [
          {
            mode,
            provider: r.transport,
            from: r.from,
            to: r.to,
            durationMinutes,
            distanceKm: distanceVal,
            price: priceVal,
            departure: '10:00',
            arrival: '13:00'
          }
        ]
      };
    });
    return mapped;
  } catch (error) {
    console.error('searchRoutes error:', error);
    return [];
  }
}

export async function searchMultiModalRoutes(
  from: string,
  to: string,
  date: string,
  passengers: number = 1,
  originCoordinates?: { latitude: number; longitude: number }
): Promise<{
  routes: RouteResult[];
  originType: 'CURRENT_GPS_LOCATION' | 'NAMED_LOCATION';
  insights: RouteInsights;
  flightSearch: FlightSearchInfo;
  timeSynchronization?: TimeSynchronizationInfo;
}> {
  const params = new URLSearchParams({
    from: from.trim(),
    to: to.trim(),
    date,
    passengers: passengers.toString(),
  });
  if (originCoordinates) {
    params.set('origin', 'gps');
    params.set('fromLat', String(originCoordinates.latitude));
    params.set('fromLng', String(originCoordinates.longitude));
  }

  let response: Response;
  try {
    response = await fetch(`/api/planner?${params.toString()}`);
  } catch {
    throw new Error('The route planner is offline. Check your connection and try again.');
  }

  const contentType = response.headers.get('content-type') || '';
  if (!response.ok) {
    if (contentType.includes('application/json')) {
      const data = await response.json();
      throw new Error(data.error || 'The route planner could not complete this search.');
    }
    throw new Error('The route planner is unavailable. Check that the server is running and try again.');
  }

  if (!contentType.includes('application/json')) {
    throw new Error('The route planner returned an unexpected response.');
  }

  const data = await response.json();
  const routes: RouteResult[] = data.routes || [];
  // Ensure access/transfer walking is allowed up to 2.5 km (e.g. Walk 1.2 km to bus stop)
  // Whole-journey walking is restricted to 2.0 km
  return {
    routes: routes.filter(route => {
      const isSingleWalk = route.segments.length === 1 && route.segments[0].mode === 'walking';
      if (isSingleWalk && route.segments[0].distanceKm > 2.0) return false;
      if (route.segments.some(seg => seg.mode === 'walking' && seg.distanceKm > 2.5)) return false;
      return true;
    }),
    originType: data.originType,
    insights: data.insights,
    flightSearch: data.flightSearch,
    timeSynchronization: data.timeSynchronization
  };
}

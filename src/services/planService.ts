// Client for the GTFS time-aware planner: GET /api/v2/plan and GET /api/v2/places.
// Public-transport only. There is no ride-hailing, no fare and no fabricated fallback anywhere in this contract.

export type DataConfidence = 'unknown' | 'estimated' | 'inferred' | 'published' | 'verified' | 'live';
export type JourneyLabel = 'BEST_PATH' | 'FASTEST' | 'LEAST_TRANSFERS' | 'BEST_BALANCED' | 'LOWER_ESTIMATED_COST';

// Fares are ESTIMATED RANGES unless a published source exists (none does today). Never an exact made-up amount.
export interface EstimatedFareRange {
  type: 'estimated_range';
  min: number;
  max: number;
  currency: string;
  confidence: 'estimated';
  basis?: string;
  serviceClass?: string;
  distanceKm?: number;
  note?: string;
}
export interface PublishedFare {
  type: 'published';
  amount: number;
  currency: string;
  confidence: 'published';
}
export type LegFare = EstimatedFareRange | PublishedFare;

export interface FareEstimate {
  min: number | null;
  max: number | null;
  currency: string;
  confidence: DataConfidence;
  complete: boolean; // false: some part could not be priced and is NOT counted as zero
  basis?: string;
  note?: string;
  components: { legIndex: number; mode: string; kind: string | null; min: number; max: number; confidence: DataConfidence; basis: string | null }[];
  unknownComponents: { legIndex: number; mode: string; kind: string | null }[];
}

// Why a search found nothing. The UI maps the code to a short message and never shows the internals.
export type FailureCode = 'NO_ACCESS_CANDIDATE' | 'NO_TIMETABLE_SERVICE' | 'NO_DESTINATION_EGRESS' | 'DATASET_COVERAGE_LIMITATION' | 'NO_CONNECTION';
export interface PlanDiagnostics {
  failureCode: FailureCode;
  reasons: string[];
  sameNetwork: boolean | null;
}

export interface PlaceRef {
  type: 'stop' | 'origin' | 'destination';
  stopId?: string;
  name: string;
  lat: number;
  lon: number;
}

export interface WalkLeg {
  mode: 'walk';
  kind: 'access' | 'transfer' | 'egress';
  from: PlaceRef;
  to: PlaceRef;
  distanceMeters: number;
  straightLineMeters?: number;
  durationSeconds: number;
  departureTime: string;
  arrivalTime: string;
  dataConfidence: 'estimated';
}

// A GENERIC local ride (auto / cab) to or from a bus stop. Estimated: no provider is connected, availability is unknown.
export interface LocalRideLeg {
  mode: 'local_ride';
  kind: 'access' | 'egress';
  label: string;
  from: PlaceRef;
  to: PlaceRef;
  distanceMeters: number;
  straightLineMeters?: number;
  durationSeconds: number;
  rideSeconds: number;
  pickupWaitSeconds: number;
  departureTime: string;
  arrivalTime: string;
  dataConfidence: 'estimated';
  durationConfidence: 'estimated';
  providerIntegration: false;
  availabilityStatus: 'unknown';
  isRealtime: false;
  // Ride services that publish city-level coverage where this ride happens. NOT availability: realtimeAvailable is always false.
  providerCity?: string | null;
  providerOptions?: { name: string; coverage: 'published_city_coverage'; realtimeAvailable: false }[];
  fare: LegFare | null;
}

export type TrackingStatus = 'verified' | 'options_available' | 'not_found';
export type ScheduleTrust = 'published' | 'inferred' | 'estimated' | 'unknown';

export interface LegTracking {
  serviceNumber: string;
  vehicleNumber: string | null;
  // verified: a tracker was seen to recognise this service; options_available: trackers exist, this service is not
  // (fully) checked - the normal case; not_found: every supported tracker was checked and none recognised it.
  status?: TrackingStatus;
  // recognized: true / false from a manual check, null when that tracker was not checked.
  providers: { id: string; availableAsExternalOption: boolean; recognized?: boolean | null }[];
  preferredProvider?: string | null;
  checkedOn?: string | null;
}

export interface RouteTrust {
  sourceType: 'gtfs' | 'rail_timetable' | 'flight_api' | 'other';
  sourceName: string | null;
  scheduleConfidence: ScheduleTrust;
  timetableBacked: true;
}

export type OperatorType = 'state_transport' | 'private_bus' | 'rail' | 'airline' | 'local_transport' | 'unknown';
export interface OperatorInfo {
  name: string | null;      // from the data source only; null = "Operator not identified"
  type: OperatorType;
  source: string;
  confidence: 'verified' | 'published' | 'inferred' | 'unknown';
}

export interface TransitLeg {
  mode: string; // "bus"
  routeId: string;
  routeShortName: string | null;
  routeLongName: string | null;
  operator?: string | null;          // operator display name from the data source, or null
  operatorInfo?: OperatorInfo;
  routeCode?: string | null;         // the source's own route code as published (e.g. GTFS "03846")
  // A PUBLIC service number (e.g. "3846"), set only when the code is proven to be one. NOT a vehicle registration.
  serviceNumber?: string | null;
  serviceNumberSource?: 'tracker_verified' | 'feed_format' | null;
  displayName?: string | null;       // "APSRTC service 3846", "APSRTC route 952054", "12711 Pinakini Express", ...
  trainNumber?: string | null;
  trainName?: string | null;
  flightNumber?: string | null;
  daysOfOperation?: string[] | null;
  intermediateStops?: string[] | null;
  vehicleNumber?: string | null;     // only ever set from a trustworthy source; the GTFS feed has none, so normally null
  vehicleNumberSource?: 'apsrtc' | 'external_tracker' | null;
  vehicleNumberConfidence?: 'live' | 'published' | 'unknown';
  // LIVE-TRACKING trust, from manual tracker checks. Never live data: there is deliberately no liveAvailable field.
  tracking?: LegTracking | null;
  // ROUTE / SCHEDULE trust: independent of tracking. Every transit leg is a timetable trip.
  routeTrust?: RouteTrust;
  tripId: string;
  headsign: string | null;
  fromStop: PlaceRef;
  toStop: PlaceRef;
  departureTime: string;
  arrivalTime: string;
  gtfsDepartureTime?: string;
  gtfsArrivalTime?: string;
  serviceDate: string;
  scheduleBasis: 'published_calendar' | 'extrapolated_weekly_pattern' | 'published_timetable';
  durationSeconds: number;
  intermediateStopCount: number;
  distanceMeters?: number;
  fare?: LegFare | null;
  datasetId: number | null;
  dataConfidence: DataConfidence;
  timeQuality: 'exact' | 'approximate' | 'interpolated' | 'unknown';
}

export type Leg = WalkLeg | LocalRideLeg | TransitLeg;

export const isWalkLeg = (leg: Leg): leg is WalkLeg => leg.mode === 'walk';
export const isLocalRideLeg = (leg: Leg): leg is LocalRideLeg => leg.mode === 'local_ride';
export const isTransitLeg = (leg: Leg): leg is TransitLeg => leg.mode !== 'walk' && leg.mode !== 'local_ride';

export type RatingParameterKey = 'time' | 'cost' | 'transfers' | 'firstLastMile' | 'schedule' | 'tracking' | 'convenience';
export type RatingLabel = 'Excellent' | 'Very Good' | 'Good' | 'Fair' | 'Limited';

// Best Path Rating (0-10), computed by the backend from the journey data. A parameter score of null means N/A.
export interface PathRating {
  score: number;
  label: RatingLabel;
  summary: string;
  parameters: Record<RatingParameterKey, { score: number | null; weight: number }>;
  reasons: { type: 'positive' | 'caution'; metric: RatingParameterKey; text: string }[];
  comparedWith: number;
}

export interface Journey {
  id: string;
  labels: JourneyLabel[];
  departureTime: string;
  arrivalTime: string;
  totalDurationSeconds: number;
  walkingDurationSeconds: number;
  waitingDurationSeconds: number;
  transfers: number;
  transitLegCount: number;
  datasetConfidence: DataConfidence;
  scheduleConfidence: DataConfidence;
  confidence: DataConfidence;
  timeQuality: 'exact' | 'approximate' | 'interpolated' | 'unknown';
  localRideDurationSeconds: number;
  localRideCount: number;
  fare: null; // a PUBLISHED fare; none exists
  fareEstimate: FareEstimate | null;
  rating?: PathRating;
  generalizedCostSeconds?: number;
  primaryMode?: 'bus' | 'train' | 'flight' | 'other';
  modes?: string[];
  // Live-tracking summary over the APSRTC bus legs (independent of scheduleConfidence).
  tracking?: { busLegs: number; verifiedLegs: number; notFoundLegs: number; allVerified: boolean };
  legs: Leg[];
}

export interface PlanWarning {
  code: string;
  severity: 'info' | 'warning';
  message: string;
}

export interface ResolvedPlace {
  query: string;
  name: string;
  lat: number;
  lon: number;
  matchedBy: string;
  stopCount: number;
}

export interface SourceReport {
  id: string;
  label: string;
  mode: string;
  status: 'ok' | 'not_configured' | 'not_applicable' | 'timeout' | 'error';
  message: string | null;
  count: number;
  ms: number;
}

export interface PlanResponse {
  // Which transport sources were searched and what happened (ok / not_configured / not_applicable / timeout / error).
  sources?: SourceReport[];
  shortlist?: { candidates: number; afterDedupe: number; afterPareto: number; clusters: number; returned: number; modes?: Record<string, number> };
  query: { fromLat: number; fromLng: number; toLat: number; toLng: number; date: string; time: string; maxTransfers: number; windowMinutes: number; timezone: string };
  dataset: {
    name: string | null;
    confidence: DataConfidence;
    effectiveConfidence: DataConfidence;
    verified: boolean;
    validFrom: string | null;
    validTo: string | null;
    coversSearchDate: boolean;
    feedCurrentlyValid: boolean;
    scheduleBasis: 'published_calendar' | 'extrapolated_weekly_pattern';
  };
  resolved: { from: ResolvedPlace | null; to: ResolvedPlace | null } | null;
  message: string | null;
  datasetWarning: string | null;
  warnings: PlanWarning[];
  access?: { walkRadiusMeters: number; feederRadiusMeters: number; walkOriginStops: number; walkDestinationStops: number; usedLocalRide: boolean };
  search?: { windowRequestedMinutes: number; windowUsedMinutes: number | null; windowExpanded: boolean; stageUsed: string | null; radiusUsedMeters: number | null };
  diagnostics?: PlanDiagnostics | null;
  winners: { fastest: string | null; leastTransfers: string | null; bestBalanced: string | null; lowerEstimatedCost?: string | null; bestPath?: string | null };
  journeys: Journey[];
  performance: { queryTimeMs: number };
}

export interface PlaceSuggestion {
  id: string;
  name: string;
  lat: number;
  lon: number;
  stopCount: number;
  services: number;
  matchedBy: string;
}

export type PlanErrorCode = 'PLACE_NOT_FOUND' | 'INVALID_QUERY' | 'DATA_UNAVAILABLE' | 'OFFLINE' | 'SERVER_ERROR';

export class PlanError extends Error {
  code: PlanErrorCode;
  place?: 'from' | 'to';
  query?: string;
  details?: string[];

  constructor(code: PlanErrorCode, message: string, extra: { place?: 'from' | 'to'; query?: string; details?: string[] } = {}) {
    super(message);
    this.name = 'PlanError';
    this.code = code;
    Object.assign(this, extra);
  }
}

export interface PlanParams {
  from?: string;
  to?: string;
  fromCoords?: { lat: number; lng: number } | null;
  toCoords?: { lat: number; lng: number } | null;
  date: string;
  time: string;
  windowMinutes?: number;
  maxTransfers?: number;
}

async function readJson(response: Response): Promise<any> {
  try {
    return await response.json();
  } catch {
    return null;
  }
}

export async function fetchPlan(params: PlanParams, signal?: AbortSignal): Promise<PlanResponse> {
  const search = new URLSearchParams({ date: params.date, time: params.time });
  if (params.fromCoords) {
    search.set('fromLat', String(params.fromCoords.lat));
    search.set('fromLng', String(params.fromCoords.lng));
  } else if (params.from) {
    search.set('from', params.from.trim());
  }
  if (params.toCoords) {
    search.set('toLat', String(params.toCoords.lat));
    search.set('toLng', String(params.toCoords.lng));
  } else if (params.to) {
    search.set('to', params.to.trim());
  }
  if (params.windowMinutes !== undefined) search.set('windowMinutes', String(params.windowMinutes));
  if (params.maxTransfers !== undefined) search.set('maxTransfers', String(params.maxTransfers));

  let response: Response;
  try {
    response = await fetch(`/api/v2/plan?${search.toString()}`, { signal });
  } catch (error) {
    if ((error as Error).name === 'AbortError') throw error;
    throw new PlanError('OFFLINE', 'The route planner is unreachable. Check your connection and that the server is running.');
  }

  const body = await readJson(response);
  if (response.ok && body) return body as PlanResponse;

  if (response.status === 404 && body?.code === 'PLACE_NOT_FOUND') {
    throw new PlanError('PLACE_NOT_FOUND', body.error, { place: body.place, query: body.query });
  }
  if (response.status === 400) {
    throw new PlanError('INVALID_QUERY', body?.error ?? 'The search is not valid.', { details: body?.details });
  }
  if (response.status === 503) {
    throw new PlanError('DATA_UNAVAILABLE', body?.error ?? 'Transit data is not available on the server.');
  }
  throw new PlanError('SERVER_ERROR', body?.error ?? 'The route planner could not complete this search.');
}

export async function searchPlaces(query: string, signal?: AbortSignal): Promise<PlaceSuggestion[]> {
  const response = await fetch(`/api/v2/places?${new URLSearchParams({ query, limit: '8' }).toString()}`, { signal });
  if (!response.ok) return [];
  const body = await readJson(response);
  return Array.isArray(body?.places) ? body.places : [];
}

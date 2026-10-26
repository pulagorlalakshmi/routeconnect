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
  type: 'stop' | 'station' | 'origin' | 'destination';
  code?: string | null;   // railway station code for type 'station'
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
  kind: 'access' | 'egress' | 'transfer'; // transfer: between a bus and a train
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

export interface TrainScheduleEvidence {
  trainNumber: string;
  trainName: string | null;
  fromCode: string;
  toCode: string;
  boardStopNumber: number | null;   // null when the provider gives no stop positions (RailRadar)
  alightStopNumber: number | null;
  totalStops: number | null;
  haltsBetween?: number | null;
  trainType?: string | null;
  provider?: string;                // e.g. 'RailRadar'
  scheduledDeparture: string;   // "HH:MM" as published
  scheduledArrival: string;
  departureRunDay: number;      // 1 = the day the train leaves its first station
  arrivalRunDay: number;
  runStartDate: string;         // ISO date this run leaves its first station
  runStartWeekday: string;
  originRunningDays: string[] | null;
  calendarValidFrom: string | null;
  calendarValidTo: string | null;
  distanceKm: number | null;
  snapshotDate: string | null;
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
  // Train legs only: the timetable facts the leg was built from (see backend rail/railSearch.js toTrunk()).
  scheduleEvidence?: TrainScheduleEvidence | null;
  source?: { id: string; name: string; type: string; license?: string | null; licenseStatus?: string; snapshotDate?: string | null; url?: string | null } | null;
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
  raw?: number; // unrounded score; the Best overall ordering and the Best path badge both use it
  label: RatingLabel;
  summary: string;
  parameters: Record<RatingParameterKey, { score: number | null; weight: number }>;
  reasons: { type: 'positive' | 'caution'; metric: RatingParameterKey; text: string }[];
  comparedWith: number;
}

export interface DepartureOption {
  tripId: string;
  departureTime: string;
  arrivalTime: string;
  durationSeconds: number;
  journey?: Journey;
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
  departureOptions?: DepartureOption[];
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
  // The travel preferences the server applied (echo of the request).
  preferences?: { modes: string[]; rank: 'best' | 'fastest' | 'cost' | 'transfers' | null };
  journeys: Journey[];
  performance: { queryTimeMs: number };
  // What was searched: bus-only / train-only / bus + train journeys found, and how complete the train search was.
  searchCoverage?: SearchCoverage;
}

export interface SearchCoverage {
  windowMinutes: number;
  modes: string[];
  shown: { bus: number; train: number; mixed: number };
  found: { bus: number; train: number; mixed: number };
  rail: {
    status: 'ok' | 'not_configured' | 'not_applicable' | 'timeout' | 'error' | 'not_searched';
    message: string | null;
    // Why the train search stopped before asking about every promising station pair.
    limitedBy: 'budget' | 'quota' | 'time' | 'provider_error' | null;
    pairsChecked: number;
    pairsSkipped: number;
    requests: { made: number; cached: number; shared: number; allowed: number } | null;
    hubSearch: 'searched' | 'not_needed' | 'no_candidates' | 'not_applicable' | null;
  };
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

export type PlanErrorCode = 'PLACE_NOT_FOUND' | 'INVALID_QUERY' | 'DATA_UNAVAILABLE' | 'MODE_UNAVAILABLE' | 'OFFLINE' | 'TIMEOUT' | 'SERVER_ERROR';

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
  // Travel preferences: a hard mode filter and the ranking priority, applied by the server's shortlist.
  modes?: string[];
  rank?: string;
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
  if (params.modes && params.modes.length > 0) search.set('modes', params.modes.join(','));
  if (params.rank) search.set('rank', params.rank);

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
  if (response.status === 422 && body?.code === 'MODE_UNAVAILABLE') {
    throw new PlanError('MODE_UNAVAILABLE', body.error);
  }
  if (response.status === 503) {
    throw new PlanError('DATA_UNAVAILABLE', body?.error ?? 'Transit data is not available on the server.');
  }
  throw new PlanError('SERVER_ERROR', body?.error ?? 'The route planner could not complete this search.');
}

// Stop search failures, kept apart from "no matching stop": TIMEOUT / OFFLINE usually mean the free-tier server is still
// waking up; UNAVAILABLE means it answered but its timetable is not loaded yet (503) or it failed (5xx).
export type PlacesErrorCode = 'TIMEOUT' | 'OFFLINE' | 'UNAVAILABLE';
export class PlacesError extends Error {
  code: PlacesErrorCode;
  constructor(code: PlacesErrorCode, message: string) {
    super(message);
    this.name = 'PlacesError';
    this.code = code;
  }
}

export const PLACES_TIMEOUT_MS = 15000;
const PLACES_CACHE_LIMIT = 100;
const placesCache = new Map<string, PlaceSuggestion[]>();
export const clearPlacesCache = () => placesCache.clear();

// One stop search with a timeout. Answers are cached per query (typing, then deleting, a letter asks only once).
// Throws AbortError when `signal` aborts, PlacesError when the server cannot answer.
export async function fetchPlaces(query: string, signal?: AbortSignal, { timeoutMs = PLACES_TIMEOUT_MS }: { timeoutMs?: number } = {}): Promise<PlaceSuggestion[]> {
  const key = query.trim().toLowerCase();
  const hit = placesCache.get(key);
  if (hit) return hit;

  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => { timedOut = true; controller.abort(); }, timeoutMs);
  const forwardAbort = () => controller.abort();
  if (signal?.aborted) controller.abort();
  signal?.addEventListener('abort', forwardAbort);
  let response: Response;
  try {
    response = await fetch(`/api/v2/places?${new URLSearchParams({ query, limit: '8' }).toString()}`, { signal: controller.signal });
  } catch (error) {
    if (timedOut) throw new PlacesError('TIMEOUT', 'The stop search took too long to answer.');
    if ((error as Error).name === 'AbortError') throw error;
    throw new PlacesError('OFFLINE', 'The stop search could not be reached.');
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', forwardAbort);
  }
  if (response.status === 400) return [];
  if (!response.ok) throw new PlacesError('UNAVAILABLE', response.status === 503 ? 'The timetable is still loading on the server.' : 'The stop search failed on the server.');
  const body = await readJson(response);
  if (!Array.isArray(body?.places)) throw new PlacesError('UNAVAILABLE', 'The stop search returned an unexpected answer.');
  const places: PlaceSuggestion[] = body.places;
  if (placesCache.size >= PLACES_CACHE_LIMIT) placesCache.delete(placesCache.keys().next().value as string);
  placesCache.set(key, places);
  return places;
}

// Lenient form for callers that only need "a match or nothing" (failures read as no match; aborts still throw).
export async function searchPlaces(query: string, signal?: AbortSignal): Promise<PlaceSuggestion[]> {
  try {
    return await fetchPlaces(query, signal);
  } catch (error) {
    if (error instanceof PlacesError) return [];
    throw error;
  }
}

// The hosted backend sleeps after inactivity (Render free tier) and takes up to about a minute to wake. Nudging it once
// when the search form appears means it is usually awake by the time someone has typed a place name.
let warmedUp = false;
export function warmUpServer(): void {
  if (warmedUp) return;
  warmedUp = true;
  fetch('/api/health').catch(() => { /* nothing to do: the real requests report their own failures */ });
}

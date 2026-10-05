import { useState } from 'react';
import { useNavigate, useLocation } from 'react-router-dom';
import { ChevronDown, ChevronUp, Map, Bookmark, Check } from 'lucide-react';
import { useAuth } from '../context/AuthContext';
import type { RouteResult, RouteSegment } from '../services/routeService';
import { isRideHailingRoute, isStandaloneRideRoute, RIDE_HAILING_NOTE } from '../services/rideHailing';
import RouteMap from './RouteMap';

const MODE_CONFIG: Record<string, { label: string; icon: string }> = {
  train: { label: 'Train', icon: '🚆' },
  bus: { label: 'Bus', icon: '🚌' },
  auto: { label: 'Auto', icon: '🛺' },
  cab: { label: 'Cab', icon: '🚕' },
  rapido: { label: 'Rapido', icon: '🛵' },
  uber: { label: 'Uber', icon: '🚗' },
  walking: { label: 'Walking', icon: '🚶' },
  flight: { label: 'Flight', icon: '✈️' },
  airport_transfer: { label: 'Airport transfer', icon: '🚕' }
};

interface StepStart {
  type: 'start';
  stepNumber: number;
  location: string;
  subtext: string;
  departureFormatted?: string;
  departureDateFormatted?: string;
}

interface StepTransfer {
  type: 'transfer';
  stepNumber: number;
  getDownAt: string;
  travelTo: string;
  transferMode: string;
  distanceKm: number;
  durationMinutes: number;
  nextMode: string;
  nextVehicle: string;
  instruction?: string;
  window?: string;
  bufferMinutes?: number;
}

interface StepTransit {
  type: 'transit';
  stepNumber: number;
  mode: 'bus' | 'train' | 'flight' | 'auto' | 'cab' | 'uber' | 'rapido' | 'walking' | 'airport_transfer';
  title: string;
  from: string;
  to: string;
  departureTime?: string | null;
  arrivalTime?: string | null;
  departureFormatted?: string | null;
  arrivalFormatted?: string | null;
  departureDateFormatted?: string | null;
  arrivalDateFormatted?: string | null;
  timingType?: 'scheduled' | 'estimated' | 'frequent';
  timingNote?: string;
  durationMinutes: number;
  distanceKm: number;
  fare?: number | null;
  currency?: string | null;
  // Bus specific
  busName?: string;
  busServiceNumber?: string | null;
  busType?: string | null;
  busIntermediateStops?: string[];
  // Train specific
  trainName?: string | null;
  trainNumber?: string | null;
  trainMajorStations?: string[];
  // Flight specific
  airline?: string;
  flightNumber?: string;
  departureAirport?: string;
  departureIata?: string;
  arrivalAirport?: string;
  arrivalIata?: string;
  stops?: string;
  baggage?: string;
  layoverDuration?: string | null;
  layoverAirport?: string | null;
  provider?: string;
}

interface StepDestination {
  type: 'destination';
  stepNumber: number;
  location: string;
  subtext: string;
  arrivalFormatted?: string;
  arrivalDateFormatted?: string;
}

type JourneyStep = StepStart | StepTransfer | StepTransit | StepDestination;

const formatDuration = (mins: number) => {
  const hours = Math.floor(mins / 60);
  const minutes = mins % 60;
  if (hours === 0) return `${minutes}m`;
  if (minutes === 0) return `${hours}h`;
  return `${hours}h ${minutes}m`;
};

const formatPrice = (price: number, currency?: string | null) => new Intl.NumberFormat('en-IN', {
  style: 'currency',
  currency: currency || 'INR',
  minimumFractionDigits: 0,
  maximumFractionDigits: 2
}).format(price);

export function getRouteModeTitle(route: RouteResult): string {
  // If single ride-hailing option (Uber / Rapido)
  if (route.segments.length === 1 && (route.segments[0].mode === 'uber' || route.segments[0].mode === 'rapido')) {
    return route.segments[0].mode === 'uber' ? '🚗 Uber' : '🛵 Rapido';
  }

  // Parse if route.routeName already contains standard mode naming
  if (route.routeName) {
    const lower = route.routeName.toLowerCase();
    const hasBus = lower.includes('bus');
    const hasTrain = lower.includes('train');
    const hasFlight = lower.includes('flight');

    if (hasBus && hasFlight && hasTrain) return '🚌 Bus + ✈️ Flight + 🚆 Train';
    if (hasBus && hasFlight) return '🚌 Bus + ✈️ Flight';
    if (hasTrain && hasFlight) return '🚆 Train + ✈️ Flight';
    if (hasBus && hasTrain) return '🚌 Bus + 🚆 Train';
    if (lower.includes('bus only') || (hasBus && !hasTrain && !hasFlight)) return '🚌 Bus';
    if (lower.includes('train only') || (hasTrain && !hasBus && !hasFlight)) return '🚆 Train';
  }

  // Filter out pure walking legs unless walking is the only mode
  const nonWalking = route.segments.filter(s => s.mode !== 'walking');
  if (nonWalking.length === 0) return '🚶 Walking';

  // Major line modes (Bus, Train, Flight) take precedence over short auto/cab transfers
  const majorModes = nonWalking.filter(s => s.mode === 'bus' || s.mode === 'train' || s.mode === 'flight');
  const target = majorModes.length > 0 ? majorModes : nonWalking;

  const sequence: string[] = [];
  target.forEach((seg, idx) => {
    const prev = target[idx - 1];
    const icon = MODE_CONFIG[seg.mode]?.icon || '➡️';
    const label = MODE_CONFIG[seg.mode]?.label || seg.mode;
    if (!prev || prev.mode !== seg.mode) {
      sequence.push(`${icon} ${label}`);
    }
  });

  return sequence.join(' + ') || 'Transit Route';
}

function buildJourneySteps(route: RouteResult): JourneyStep[] {
  const steps: JourneyStep[] = [];
  let currentStepNum = 1;

  // 1. START STEP
  steps.push({
    type: 'start',
    stepNumber: currentStepNum++,
    location: route.from,
    subtext: 'Starting Location',
    departureFormatted: route.departureTime,
    departureDateFormatted: route.departureDate
  });

  const segs = route.segments;
  let i = 0;

  while (i < segs.length) {
    const seg = segs[i];
    const prevSeg = i > 0 ? segs[i - 1] : null;
    const nextSeg = i < segs.length - 1 ? segs[i + 1] : null;

    // Check if this segment itself is a feeder transfer between two major line legs (Bus, Train, Flight)
    const isFeederMode = seg.mode === 'auto' || seg.mode === 'cab' || seg.mode === 'walking' || seg.mode === 'airport_transfer';
    const isBetweenMajorLegs = prevSeg && nextSeg && (
      prevSeg.mode === 'bus' || prevSeg.mode === 'train' || prevSeg.mode === 'flight'
    ) && (
      nextSeg.mode === 'bus' || nextSeg.mode === 'train' || nextSeg.mode === 'flight'
    );

    if (isFeederMode && isBetweenMajorLegs) {
      let nextVehicle = '';
      if (nextSeg.mode === 'train') {
        nextVehicle = `Train ${nextSeg.trainName ? `(${nextSeg.trainName})` : ''} to ${nextSeg.to}`;
      } else if (nextSeg.mode === 'bus') {
        nextVehicle = `Bus ${nextSeg.serviceName ? `(${nextSeg.serviceName})` : ''} to ${nextSeg.to}`;
      } else if (nextSeg.mode === 'flight') {
        nextVehicle = `Flight ${nextSeg.flightNumber || ''} to ${nextSeg.to}`;
      } else {
        const modeLabel = MODE_CONFIG[nextSeg.mode]?.label || nextSeg.mode;
        nextVehicle = `${modeLabel} to ${nextSeg.to}`;
      }

      const transferModeLabel = seg.mode === 'auto' ? 'Local Auto' :
        seg.mode === 'cab' ? 'Local Cab' :
        seg.mode === 'airport_transfer' ? 'Airport Feeder Link' :
        'Walk / Local Transport';

      steps.push({
        type: 'transfer',
        stepNumber: currentStepNum++,
        getDownAt: seg.from,
        travelTo: seg.to,
        transferMode: `${transferModeLabel}${seg.price > 0 ? ` (₹${seg.price})` : ''}`,
        distanceKm: seg.distanceKm,
        durationMinutes: seg.durationMinutes,
        nextMode: nextSeg.mode,
        nextVehicle,
        instruction: `Travel from ${seg.from} to ${seg.to} to board next transport.`,
        window: seg.departureFormatted && seg.arrivalFormatted ? `${seg.departureFormatted} – ${seg.arrivalFormatted}` : undefined,
        bufferMinutes: seg.durationMinutes
      });

      i++;
      continue;
    }

    // Direct transition between two major transit legs at same station or without explicit feeder segment
    if (prevSeg) {
      const isPrevMajor = prevSeg.mode === 'bus' || prevSeg.mode === 'train' || prevSeg.mode === 'flight';
      const isCurMajor = seg.mode === 'bus' || seg.mode === 'train' || seg.mode === 'flight';

      if (isPrevMajor && isCurMajor) {
        const isInterStation = prevSeg.to.trim().toLowerCase() !== seg.from.trim().toLowerCase();
        let nextVehicle = '';
        if (seg.mode === 'train') {
          nextVehicle = `Train ${seg.trainName ? `(${seg.trainName})` : ''} to ${seg.to}`;
        } else if (seg.mode === 'bus') {
          nextVehicle = `Bus ${seg.serviceName ? `(${seg.serviceName})` : ''} to ${seg.to}`;
        } else if (seg.mode === 'flight') {
          nextVehicle = `Flight ${seg.flightNumber || ''} to ${seg.to}`;
        } else {
          nextVehicle = `${MODE_CONFIG[seg.mode]?.label || seg.mode} to ${seg.to}`;
        }

        const matchingTransfer = route.transfers?.find(t => t.transferNumber === i || t.location === prevSeg.to);
        const transferDist = matchingTransfer?.transferDistanceKm || (isInterStation ? 2.5 : 0.2);
        const transferDuration = matchingTransfer?.transferDurationMinutes || matchingTransfer?.layoverMinutes || seg.layoverMinutes || (isInterStation ? 15 : 10);
        const transferMode = matchingTransfer?.transferMode || (isInterStation ? (transferDist > 1.5 ? 'Local Auto / Cab' : 'Walk / Local Transport') : 'Station Interchange');

        steps.push({
          type: 'transfer',
          stepNumber: currentStepNum++,
          getDownAt: prevSeg.to,
          travelTo: seg.from,
          transferMode,
          distanceKm: transferDist,
          durationMinutes: transferDuration,
          nextMode: seg.mode,
          nextVehicle,
          instruction: matchingTransfer?.instruction || (isInterStation ? `Transfer from ${prevSeg.to} to ${seg.from}` : `Interchange platforms/terminals at ${seg.from}`),
          window: matchingTransfer?.window || (prevSeg.arrivalFormatted && seg.departureFormatted ? `${prevSeg.arrivalFormatted} – ${seg.departureFormatted}` : undefined),
          bufferMinutes: matchingTransfer?.layoverMinutes || transferDuration
        });
      }
    }

    // Transit Step
    const mode = seg.mode;
    let title = '';
    if (mode === 'bus') {
      title = seg.estimated ? seg.provider : (seg.serviceName ? `APSRTC ${seg.serviceName}` : (seg.provider || 'APSRTC Express'));
    } else if (mode === 'train') {
      title = seg.trainName ? `${seg.trainName}` : 'Express Train';
    } else if (mode === 'flight') {
      title = (seg as any).airline || seg.provider || 'Commercial Flight';
    } else if (mode === 'auto') {
      title = seg.provider || 'Local Auto Rickshaw';
    } else if (mode === 'cab') {
      title = seg.provider || 'Local Cab / Taxi';
    } else if (mode === 'uber') {
      title = seg.serviceName || 'Uber';
    } else if (mode === 'rapido') {
      title = seg.serviceName || 'Rapido';
    } else if (mode === 'walking') {
      title = 'Walking Transfer';
    } else {
      title = seg.provider || 'Transit';
    }

    let intermediateStops: string[] = [];
    if (seg.stops) {
      intermediateStops = seg.stops.split(',').map(s => s.trim()).filter(Boolean);
    }

    const transitStep: StepTransit = {
      type: 'transit',
      stepNumber: currentStepNum++,
      mode,
      title,
      from: seg.from,
      to: seg.to,
      departureTime: seg.departure,
      arrivalTime: seg.arrival,
      departureFormatted: seg.departureFormatted || seg.departure,
      arrivalFormatted: seg.arrivalFormatted || seg.arrival,
      departureDateFormatted: seg.departureDateFormatted,
      arrivalDateFormatted: seg.arrivalDateFormatted,
      timingType: seg.timingType || (mode === 'train' || mode === 'flight' ? 'scheduled' : 'estimated'),
      timingNote: seg.timingNote,
      durationMinutes: seg.durationMinutes,
      distanceKm: seg.distanceKm,
      fare: seg.fareAvailable !== false ? seg.price : null,
      currency: seg.currency || route.currency,
      busName: title,
      busServiceNumber: seg.serviceName || null,
      busType: seg.busType || (seg.serviceName?.toLowerCase().includes('express') ? 'Express' : 'Standard Express'),
      busIntermediateStops: intermediateStops,
      trainName: seg.trainName || title,
      trainNumber: seg.trainNumber || null,
      trainMajorStations: intermediateStops,
      airline: (seg as any).airline || route.flightDetails?.airline || seg.provider,
      flightNumber: seg.flightNumber || route.flightDetails?.flightNumber || 'Scheduled Flight',
      departureAirport: seg.departureAirport || route.flightDetails?.departureAirport || seg.from,
      departureIata: seg.departureIata || route.flightDetails?.departureIata || '',
      arrivalAirport: seg.arrivalAirport || route.flightDetails?.arrivalAirport || seg.to,
      arrivalIata: seg.arrivalIata || route.flightDetails?.arrivalIata || '',
      stops: seg.stopCount ? `${seg.stopCount} Stop(s)` : (seg.stops || route.flightDetails?.stops || 'Direct / Non-stop'),
      baggage: seg.baggage || route.flightDetails?.baggage || '15 kg Check-in, 7 kg Cabin',
      layoverDuration: seg.layoverMinutes ? formatDuration(seg.layoverMinutes) : (route.flightDetails?.layoverDuration || null),
      layoverAirport: (seg as any).layoverAirport || route.flightDetails?.layoverAirport || null,
      provider: seg.provider
    };

    steps.push(transitStep);
    i++;
  }

  // 3. DESTINATION STEP
  steps.push({
    type: 'destination',
    stepNumber: currentStepNum++,
    location: route.to,
    subtext: 'Final Destination',
    arrivalFormatted: route.arrivalTime,
    arrivalDateFormatted: route.arrivalDate
  });

  return steps;
}

export default function RouteCard({
  route,
  routeIndex,
  isFastest: propIsFastest,
  isBudget: propIsBudget
}: {
  route: RouteResult;
  routeIndex?: number;
  isFastest?: boolean;
  isBudget?: boolean;
}) {
  const { user } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();

  const [showDetails, setShowDetails] = useState(false);
  const [showMap, setShowMap] = useState(false);
  const [saved, setSaved] = useState(false);

  const totalDist = route.distanceKm || route.segments.reduce((acc, s) => acc + s.distanceKm, 0);

  // Uber/Rapido are formula-based estimates (no provider integration): never "available", never ranked as
  // Fastest / Budget Route / Recommended, whatever the parent passes in.
  const isRideOption = isStandaloneRideRoute(route);
  const hasEstimatedRide = isRideHailingRoute(route);
  const isFastest = !hasEstimatedRide && (propIsFastest !== undefined ? propIsFastest : (route.isFastest ?? route.tag === 'fastest'));
  const isBudget = !hasEstimatedRide && (propIsBudget !== undefined ? propIsBudget : (route.isBudget ?? (route.tag === 'budget' || route.tag === 'cheapest')));
  const isRecommended = !hasEstimatedRide && (route.tag === 'best' || (route.tag as string) === 'recommended') && !isFastest && !isBudget;

  const modeTitle = getRouteModeTitle(route);
  const journeySteps = buildJourneySteps(route);

  const handleSaveRoute = () => {
    const newRoute = {
      id: route.id,
      from: route.from,
      to: route.to,
      price: route.totalPrice,
      duration: route.totalDurationMinutes,
      transfers: route.totalTransfers,
      modes: route.segments.map(s => s.mode)
    };

    if (!user) {
      // User is not signed in: store pending route and display login page with sign in / sign up
      try {
        localStorage.setItem('pending_save_route', JSON.stringify(newRoute));
      } catch (err) {
        console.error('Failed to store pending route:', err);
      }
      const returnUrl = encodeURIComponent(`${location.pathname}${location.search}`);
      navigate(`/login?reason=save_route&from=${encodeURIComponent(route.from)}&to=${encodeURIComponent(route.to)}&returnUrl=${returnUrl}`);
      return;
    }

    try {
      const savedRoutes = JSON.parse(localStorage.getItem('saved_routes') || '[]');
      const isDup = savedRoutes.some((r: any) => r.id === route.id);
      if (!isDup) {
        savedRoutes.push(newRoute);
        localStorage.setItem('saved_routes', JSON.stringify(savedRoutes));
      }
      setSaved(true);
      setTimeout(() => setSaved(false), 2500);
    } catch (e) {
      console.error('Failed to save route to localStorage:', e);
    }
  };

  const renderStepNode = (step: JourneyStep) => {
    if (step.type === 'start') {
      return (
        <span className="flex h-8 w-8 sm:h-9 sm:w-9 items-center justify-center rounded-full bg-emerald-600 text-white font-black text-sm shadow-xs border-2 border-white">
          📍
        </span>
      );
    }
    if (step.type === 'destination') {
      return (
        <span className="flex h-8 w-8 sm:h-9 sm:w-9 items-center justify-center rounded-full bg-rose-600 text-white font-black text-sm shadow-xs border-2 border-white">
          📍
        </span>
      );
    }
    if (step.type === 'transfer') {
      return (
        <span className="flex h-8 w-8 sm:h-9 sm:w-9 items-center justify-center rounded-full bg-amber-500 text-white font-black text-sm shadow-xs border-2 border-white">
          🔄
        </span>
      );
    }
    const mode = step.mode;
    if (mode === 'bus') {
      return (
        <span className="flex h-8 w-8 sm:h-9 sm:w-9 items-center justify-center rounded-full bg-emerald-500 text-white font-black text-sm shadow-xs border-2 border-white">
          🚌
        </span>
      );
    }
    if (mode === 'train') {
      return (
        <span className="flex h-8 w-8 sm:h-9 sm:w-9 items-center justify-center rounded-full bg-blue-600 text-white font-black text-sm shadow-xs border-2 border-white">
          🚆
        </span>
      );
    }
    if (mode === 'flight') {
      return (
        <span className="flex h-8 w-8 sm:h-9 sm:w-9 items-center justify-center rounded-full bg-indigo-600 text-white font-black text-sm shadow-xs border-2 border-white">
          ✈️
        </span>
      );
    }
    if (mode === 'auto') {
      return (
        <span className="flex h-8 w-8 sm:h-9 sm:w-9 items-center justify-center rounded-full bg-yellow-500 text-white font-black text-sm shadow-xs border-2 border-white">
          🛺
        </span>
      );
    }
    if (mode === 'cab' || mode === 'uber') {
      return (
        <span className="flex h-8 w-8 sm:h-9 sm:w-9 items-center justify-center rounded-full bg-sky-600 text-white font-black text-sm shadow-xs border-2 border-white">
          🚕
        </span>
      );
    }
    if (mode === 'rapido') {
      return (
        <span className="flex h-8 w-8 sm:h-9 sm:w-9 items-center justify-center rounded-full bg-orange-500 text-white font-black text-sm shadow-xs border-2 border-white">
          🛵
        </span>
      );
    }
    return (
      <span className="flex h-8 w-8 sm:h-9 sm:w-9 items-center justify-center rounded-full bg-slate-500 text-white font-black text-sm shadow-xs border-2 border-white">
        🚶
      </span>
    );
  };

  const renderStepCard = (step: JourneyStep) => {
    // 1. START
    if (step.type === 'start') {
      return (
        <div className="bg-slate-50 border border-slate-200 rounded-xl p-4 sm:p-5 shadow-2xs">
          <div className="flex items-center justify-between">
            <span className="text-[11px] font-black uppercase tracking-wider text-slate-500">
              📍 STEP {step.stepNumber} — START
            </span>
            <span className="text-[11px] font-bold text-slate-500 bg-white border border-slate-200 px-2 py-0.5 rounded">
              Origin
            </span>
          </div>
          <p className="mt-2 text-base sm:text-lg font-black text-[#1F2933]">
            {step.location}
          </p>
          <div className="mt-1 text-xs text-[#667085] font-semibold">
            <span>Starting point of your journey</span>
          </div>
        </div>
      );
    }

    // 2. DESTINATION
    if (step.type === 'destination') {
      return (
        <div className="bg-slate-50 border border-slate-200 rounded-xl p-4 sm:p-5 shadow-2xs">
          <div className="flex items-center justify-between">
            <span className="text-[11px] font-black uppercase tracking-wider text-rose-800">
              📍 STEP {step.stepNumber} — DESTINATION
            </span>
            <span className="text-[11px] font-bold text-rose-800 bg-white border border-rose-200 px-2 py-0.5 rounded">
              Final Destination
            </span>
          </div>
          <p className="mt-2 text-base sm:text-lg font-black text-[#1F2933]">
            {step.location}
          </p>
          <div className="mt-1 text-xs text-rose-800 font-semibold">
            <span>Final arrival destination</span>
          </div>
        </div>
      );
    }

    // 3. TRANSFER
    if (step.type === 'transfer') {
      return (
        <div className="bg-amber-50/80 border border-amber-300 rounded-xl p-4 sm:p-5 shadow-2xs space-y-3">
          <div className="flex items-center justify-between flex-wrap gap-2">
            <span className="text-[11px] font-black uppercase tracking-wider text-amber-900 flex items-center gap-1.5">
              <span>🔄</span> STEP {step.stepNumber} — TRANSFER
            </span>
            <span className="text-[11px] font-extrabold text-amber-900 bg-white border border-amber-300 px-2.5 py-0.5 rounded-full shadow-2xs">
              via {step.transferMode}
            </span>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 text-xs">
            <div className="bg-white p-3 rounded-lg border border-amber-200 shadow-2xs">
              <p className="text-[10px] font-black uppercase text-[#667085]">Get down at:</p>
              <p className="font-extrabold text-[#1F2933] mt-0.5 text-sm">{step.getDownAt}</p>
              <p className="text-[11px] text-[#667085] mt-0.5">Alight from previous transport</p>
            </div>
            <div className="bg-white p-3 rounded-lg border border-amber-200 shadow-2xs">
              <p className="text-[10px] font-black uppercase text-[#667085]">Then travel to:</p>
              <p className="font-extrabold text-[#1F2933] mt-0.5 text-sm">{step.travelTo}</p>
              <p className="text-[11px] text-[#667085] mt-0.5">Boarding point for next vehicle</p>
            </div>
          </div>

          <div className="flex items-center justify-between text-xs text-[#667085] font-medium px-1">
            <span>Transfer duration: ~{formatDuration(step.durationMinutes)}</span>
            <span>Distance: {step.distanceKm} km</span>
          </div>

          <div className="bg-white p-2.5 rounded-lg border border-amber-300 text-xs font-bold text-amber-950 flex items-center gap-2">
            <span className="text-base">➡️</span>
            <span><strong>Next:</strong> {step.nextVehicle}</span>
          </div>
        </div>
      );
    }

    // 4. BUS TRANSIT STEP
    if (step.mode === 'bus') {
      return (
        <div className="bg-emerald-50/40 border border-emerald-200 rounded-xl p-4 sm:p-5 shadow-2xs space-y-3.5">
          <div className="flex items-start justify-between gap-3 flex-wrap">
            <div>
              <span className="text-[11px] font-black uppercase tracking-wider text-emerald-800 flex items-center gap-1.5">
                <span>🚌</span> STEP {step.stepNumber} — BUS
              </span>
              <h5 className="text-base font-black text-[#1F2933] mt-1">
                {step.busName}
              </h5>
              <div className="flex items-center gap-2 mt-1 flex-wrap">
                {step.busServiceNumber && (
                  <span className="bg-white border border-emerald-300 text-emerald-900 text-[11px] font-extrabold px-2 py-0.5 rounded">
                    Service: {step.busServiceNumber}
                  </span>
                )}
                {step.busType && (
                  <span className="bg-emerald-100 text-emerald-900 text-[11px] font-bold px-2 py-0.5 rounded">
                    Type: {step.busType}
                  </span>
                )}
              </div>
            </div>

            {step.fare !== null && step.fare !== undefined && (
              <div className="text-right">
                <span className="text-base font-black text-[#146B5B]">
                  {formatPrice(step.fare, step.currency)}
                </span>
                <p className="text-[10px] uppercase font-bold text-[#667085]">Bus Fare</p>
              </div>
            )}
          </div>

          {/* From / To & Schedule Grid */}
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-2.5 text-xs bg-white p-3 rounded-lg border border-emerald-100 shadow-2xs">
            <div>
              <span className="text-[10px] font-bold uppercase text-[#667085]">Starting Bus Stop</span>
              <p className="font-extrabold text-[#1F2933] text-sm mt-0.5">{step.from}</p>
              {step.departureTime && (
                <p className="text-[11px] text-emerald-800 font-bold mt-0.5">🕒 Departure: {step.departureTime}</p>
              )}
            </div>
            <div>
              <span className="text-[10px] font-bold uppercase text-[#667085]">Destination Bus Stop</span>
              <p className="font-extrabold text-[#1F2933] text-sm mt-0.5">{step.to}</p>
              {step.arrivalTime && (
                <p className="text-[11px] text-emerald-800 font-bold mt-0.5">🕒 Arrival: {step.arrivalTime}</p>
              )}
            </div>
          </div>

          {/* Metrics */}
          <div className="flex flex-wrap items-center gap-3 text-xs text-[#667085]">
            <span>⏱ <strong>Duration:</strong> {formatDuration(step.durationMinutes)}</span>
            <span>•</span>
            <span>📍 <strong>Distance:</strong> {step.distanceKm} km</span>
          </div>

          {/* Route / Path Followed (Requirement 4) */}
          <div className="pt-2 border-t border-emerald-200/70 space-y-1.5">
            <p className="text-[10px] font-black uppercase text-[#667085] tracking-wider">
              Route / Path Followed:
            </p>
            <div className="flex flex-wrap items-center gap-1.5 text-xs font-semibold text-[#1F2933]">
              <span className="bg-white border border-emerald-300 text-emerald-950 px-2.5 py-1 rounded-md font-bold shadow-2xs">
                {step.from}
              </span>
              {step.busIntermediateStops && step.busIntermediateStops.length > 0 ? (
                step.busIntermediateStops.map((stop, sIdx) => (
                  <span key={sIdx} className="inline-flex items-center gap-1.5">
                    <span className="text-gray-400 font-bold">→</span>
                    <span className="bg-white border border-gray-200 px-2.5 py-1 rounded-md font-medium text-gray-800 shadow-2xs">
                      {stop}
                    </span>
                  </span>
                ))
              ) : (
                <span className="inline-flex items-center gap-1.5">
                  <span className="text-gray-400 font-bold">→</span>
                  <span className="bg-white border border-gray-200 px-2 py-0.5 rounded text-gray-700 font-medium">
                    Direct Highway Corridor
                  </span>
                </span>
              )}
              <span className="text-gray-400 font-bold">→</span>
              <span className="bg-white border border-emerald-300 text-emerald-950 px-2.5 py-1 rounded-md font-bold shadow-2xs">
                {step.to}
              </span>
            </div>
          </div>
        </div>
      );
    }

    // 5. TRAIN TRANSIT STEP
    if (step.mode === 'train') {
      return (
        <div className="bg-blue-50/40 border border-blue-200 rounded-xl p-4 sm:p-5 shadow-2xs space-y-3.5">
          <div className="flex items-start justify-between gap-3 flex-wrap">
            <div>
              <span className="text-[11px] font-black uppercase tracking-wider text-blue-800 flex items-center gap-1.5">
                <span>🚆</span> STEP {step.stepNumber} — TRAIN
              </span>
              <h5 className="text-base font-black text-[#1F2933] mt-1">
                Train: {step.trainName}
              </h5>
              {step.trainNumber && (
                <span className="inline-block mt-1 bg-white border border-blue-300 text-blue-900 text-[11px] font-extrabold px-2 py-0.5 rounded">
                  Train No: {step.trainNumber}
                </span>
              )}
            </div>

            {step.fare !== null && step.fare !== undefined && (
              <div className="text-right">
                <span className="text-base font-black text-blue-800">
                  {formatPrice(step.fare, step.currency)}
                </span>
                <p className="text-[10px] uppercase font-bold text-[#667085]">Rail Fare</p>
              </div>
            )}
          </div>

          {/* From / To & Schedule Grid */}
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-2.5 text-xs bg-white p-3 rounded-lg border border-blue-100 shadow-2xs">
            <div>
              <span className="text-[10px] font-bold uppercase text-[#667085]">From Railway Station</span>
              <p className="font-extrabold text-[#1F2933] text-sm mt-0.5">{step.from}</p>
              {step.departureTime && (
                <p className="text-[11px] text-blue-800 font-bold mt-0.5">🕒 Departure: {step.departureTime}</p>
              )}
            </div>
            <div>
              <span className="text-[10px] font-bold uppercase text-[#667085]">To Railway Station</span>
              <p className="font-extrabold text-[#1F2933] text-sm mt-0.5">{step.to}</p>
              {step.arrivalTime && (
                <p className="text-[11px] text-blue-800 font-bold mt-0.5">🕒 Arrival: {step.arrivalTime}</p>
              )}
            </div>
          </div>

          {/* Metrics */}
          <div className="flex flex-wrap items-center gap-3 text-xs text-[#667085]">
            <span>⏱ <strong>Duration:</strong> {formatDuration(step.durationMinutes)}</span>
            <span>•</span>
            <span>📍 <strong>Distance:</strong> {step.distanceKm} km</span>
          </div>

          {/* Major Stations (Requirement 5) */}
          <div className="pt-2 border-t border-blue-200/70 space-y-1.5">
            <p className="text-[10px] font-black uppercase text-[#667085] tracking-wider">
              Major Stations:
            </p>
            <div className="flex flex-wrap items-center gap-1.5 text-xs font-semibold text-[#1F2933]">
              <span className="bg-white border border-blue-300 text-blue-950 px-2.5 py-1 rounded-md font-bold shadow-2xs">
                {step.from}
              </span>
              {step.trainMajorStations && step.trainMajorStations.length > 0 ? (
                step.trainMajorStations.map((stn, sIdx) => (
                  <span key={sIdx} className="inline-flex items-center gap-1.5">
                    <span className="text-gray-400 font-bold">→</span>
                    <span className="bg-white border border-gray-200 px-2.5 py-1 rounded-md font-medium text-gray-800 shadow-2xs">
                      {stn}
                    </span>
                  </span>
                ))
              ) : (
                <span className="inline-flex items-center gap-1.5">
                  <span className="text-gray-400 font-bold">→</span>
                  <span className="bg-white border border-gray-200 px-2 py-0.5 rounded text-gray-700 font-medium">
                    Direct Rail Line
                  </span>
                </span>
              )}
              <span className="text-gray-400 font-bold">→</span>
              <span className="bg-white border border-blue-300 text-blue-950 px-2.5 py-1 rounded-md font-bold shadow-2xs">
                {step.to}
              </span>
            </div>
          </div>
        </div>
      );
    }

    // 6. FLIGHT TRANSIT STEP
    if (step.mode === 'flight') {
      return (
        <div className="bg-indigo-50/40 border border-indigo-200 rounded-xl p-4 sm:p-5 shadow-2xs space-y-3.5">
          <div className="flex items-start justify-between gap-3 flex-wrap">
            <div>
              <span className="text-[11px] font-black uppercase tracking-wider text-indigo-800 flex items-center gap-1.5">
                <span>✈️</span> STEP {step.stepNumber} — FLIGHT
              </span>
              <h5 className="text-base font-black text-[#1F2933] mt-1">
                Airline: {step.airline}
              </h5>
              <span className="inline-block mt-1 bg-white border border-indigo-300 text-indigo-900 text-[11px] font-extrabold px-2 py-0.5 rounded">
                Flight: {step.flightNumber}
              </span>
            </div>

            {step.fare !== null && step.fare !== undefined && (
              <div className="text-right">
                <span className="text-base font-black text-indigo-900">
                  {formatPrice(step.fare, step.currency)}
                </span>
                <p className="text-[10px] uppercase font-bold text-[#667085]">Air Fare</p>
              </div>
            )}
          </div>

          {/* From / To & Schedule Grid */}
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-2.5 text-xs bg-white p-3 rounded-lg border border-indigo-100 shadow-2xs">
            <div>
              <span className="text-[10px] font-bold uppercase text-[#667085]">From Departure Airport</span>
              <p className="font-extrabold text-[#1F2933] text-sm mt-0.5">
                {step.departureAirport} {step.departureIata ? `(${step.departureIata})` : ''}
              </p>
              {step.departureTime && (
                <p className="text-[11px] text-indigo-800 font-bold mt-0.5">🕒 Departure: {step.departureTime}</p>
              )}
            </div>
            <div>
              <span className="text-[10px] font-bold uppercase text-[#667085]">To Arrival Airport</span>
              <p className="font-extrabold text-[#1F2933] text-sm mt-0.5">
                {step.arrivalAirport} {step.arrivalIata ? `(${step.arrivalIata})` : ''}
              </p>
              {step.arrivalTime && (
                <p className="text-[11px] text-indigo-800 font-bold mt-0.5">🕒 Arrival: {step.arrivalTime}</p>
              )}
            </div>
          </div>

          {/* Metrics */}
          <div className="flex flex-wrap items-center gap-3 text-xs text-[#667085]">
            <span>⏱ <strong>Duration:</strong> {formatDuration(step.durationMinutes)}</span>
            <span>•</span>
            <span>🛑 <strong>Stops:</strong> {step.stops}</span>
            {step.baggage && (
              <>
                <span>•</span>
                <span>🧳 <strong>Baggage:</strong> {step.baggage}</span>
              </>
            )}
          </div>

          {/* Layover Alert for Connecting Flights */}
          {step.layoverDuration && (
            <div className="bg-amber-50 border border-amber-300 rounded-lg p-2.5 text-xs text-amber-950 flex flex-wrap items-center justify-between gap-2 shadow-2xs">
              <span className="font-bold flex items-center gap-1.5">
                <span>⏱</span> Layover: {step.layoverDuration} at {step.layoverAirport || 'Connecting Hub'}
              </span>
              <span className="text-[11px] font-bold bg-white border border-amber-300 px-2 py-0.5 rounded text-amber-900">
                Baggage through-checked to destination
              </span>
            </div>
          )}
        </div>
      );
    }

    // 7. AUTO / CAB / RIDE STEP
    if (step.mode === 'auto' || step.mode === 'cab' || step.mode === 'uber' || step.mode === 'rapido') {
      const modeIcon = step.mode === 'auto' ? '🛺' : step.mode === 'rapido' ? '🛵' : '🚕';
      return (
        <div className="bg-yellow-50/30 border border-yellow-200 rounded-xl p-4 sm:p-5 shadow-2xs space-y-2">
          <div className="flex items-center justify-between">
            <span className="text-[11px] font-black uppercase tracking-wider text-yellow-900 flex items-center gap-1.5">
              <span>{modeIcon}</span> STEP {step.stepNumber} — {step.mode.toUpperCase()} / LOCAL TRANSPORT
            </span>
            {step.fare !== null && step.fare !== undefined && (
              <span className="text-sm font-black text-[#146B5B]">
                {(step.mode === 'uber' || step.mode === 'rapido') ? `≈ ${formatPrice(step.fare, step.currency)} (estimated)` : formatPrice(step.fare, step.currency)}
              </span>
            )}
          </div>
          <p className="text-sm font-bold text-[#1F2933]">
            {step.title} · {step.from} ➔ {step.to}
          </p>
          {(step.mode === 'uber' || step.mode === 'rapido') && (
            <p className="text-xs font-semibold text-amber-800">
              Estimated fare and duration · availability not verified. {RIDE_HAILING_NOTE}
            </p>
          )}
          <div className="flex flex-wrap items-center gap-3 text-xs text-[#667085]">
            <span>⏱ <strong>Duration:</strong> {formatDuration(step.durationMinutes)}</span>
            <span>•</span>
            <span>📍 <strong>Distance:</strong> {step.distanceKm} km</span>
          </div>
        </div>
      );
    }

    // 8. WALKING STEP
    return (
      <div className="bg-gray-50 border border-gray-200 rounded-xl p-4 sm:p-5 shadow-2xs space-y-2">
        <span className="text-[11px] font-black uppercase tracking-wider text-gray-700 flex items-center gap-1.5">
          <span>🚶</span> STEP {step.stepNumber} — WALKING
        </span>
        <p className="text-sm font-bold text-[#1F2933]">
          Walk from {step.from} to {step.to}
        </p>
        <div className="flex flex-wrap items-center gap-3 text-xs text-[#667085]">
          <span>⏱ <strong>Duration:</strong> {formatDuration(step.durationMinutes)}</span>
          <span>•</span>
          <span>📍 <strong>Distance:</strong> {step.distanceKm.toFixed(1)} km</span>
        </div>
      </div>
    );
  };

  return (
    <article
      id={`route-${route.id}`}
      className={`bg-white border rounded-2xl p-5 md:p-6 shadow-xs transition-all duration-200 ${
        isFastest && isBudget
          ? 'border-emerald-400 ring-1 ring-emerald-300/50 hover:border-emerald-500'
          : isFastest
            ? 'border-amber-300/90 ring-1 ring-amber-200/50 hover:border-amber-400'
            : isBudget
              ? 'border-emerald-300/90 ring-1 ring-emerald-200/50 hover:border-emerald-400'
              : 'border-[#D4DEDA] hover:border-[#146B5B]/50'
      }`}
    >
      {/* 1. Main Search Result Card — Quick Summary (Compact & Clean) */}
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3 pb-3.5 border-b border-gray-100">
        <div className="flex items-center gap-2.5 flex-wrap">
          {routeIndex && (
            <span className="text-xs font-black uppercase tracking-wider bg-[#146B5B]/10 text-[#146B5B] border border-[#146B5B]/25 px-2.5 py-1 rounded-md">
              Option {routeIndex}
            </span>
          )}
          <h3 className="text-lg md:text-xl font-black text-[#1F2933] flex items-center gap-2">
            {modeTitle}
          </h3>
        </div>

        {/* Small Labels / Badges: Fastest, Budget Route, Recommended */}
        <div className="flex items-center gap-2 flex-wrap">
          {isFastest && (
            <span className="inline-flex items-center gap-1 bg-amber-100 border border-amber-300 text-amber-900 px-2.5 py-1 rounded-full text-xs font-black shadow-2xs">
              ⚡ Fastest
            </span>
          )}
          {isBudget && (
            <span className="inline-flex items-center gap-1 bg-emerald-100 border border-emerald-300 text-emerald-900 px-2.5 py-1 rounded-full text-xs font-black shadow-2xs">
              💰 Budget Route
            </span>
          )}
          {isRecommended && (
            <span className="inline-flex items-center gap-1 bg-purple-100 border border-purple-300 text-purple-900 px-2.5 py-1 rounded-full text-xs font-black shadow-2xs">
              ⭐ Recommended
            </span>
          )}
          {isRideOption && (
            <>
              <span className="inline-flex items-center gap-1.5 rounded-full bg-amber-100 border border-amber-300 px-2.5 py-1 text-xs font-black text-amber-900 shadow-2xs">
                <span className="h-2 w-2 rounded-full bg-amber-500"></span>
                Availability not verified
              </span>
              <span className="inline-flex items-center rounded-full bg-slate-100 border border-slate-300 px-2.5 py-1 text-xs font-black text-slate-700 shadow-2xs">
                Estimated option
              </span>
            </>
          )}
          {hasEstimatedRide && !isRideOption && (
            <span className="inline-flex items-center rounded-full bg-amber-100 border border-amber-300 px-2.5 py-1 text-xs font-black text-amber-900 shadow-2xs">
              Includes estimated ride leg
            </span>
          )}
        </div>
      </div>

      {/* Quick Metrics Bar: Travel Time, Distance, Transfers, Estimated Cost */}
      <div className="py-4 grid grid-cols-2 sm:grid-cols-4 gap-4 items-center">
        <div className={`space-y-0.5 p-2 rounded-xl transition-all ${isFastest ? 'bg-amber-50/90 border border-amber-300 shadow-2xs' : ''}`}>
          <div className="flex items-center justify-between">
            <span className="text-[11px] font-bold uppercase tracking-wider text-[#667085]">{isRideOption ? 'Estimated Duration' : 'Travel Time'}</span>
            {isFastest && (
              <span className="text-[10px] font-black text-amber-900 bg-amber-200/90 px-1.5 py-0.5 rounded leading-none">
                ⚡ Fastest
              </span>
            )}
          </div>
          <p className={`text-base md:text-lg font-black ${isFastest ? 'text-amber-950' : 'text-[#1F2933]'}`}>
            {formatDuration(route.totalDurationMinutes)}
          </p>
        </div>

        <div className="space-y-0.5 p-2">
          <span className="text-[11px] font-bold uppercase tracking-wider text-[#667085]">Distance</span>
          <p className="text-base md:text-lg font-black text-[#1F2933]">
            {totalDist.toFixed(0)} km
          </p>
        </div>

        <div className="space-y-0.5 p-2">
          <span className="text-[11px] font-bold uppercase tracking-wider text-[#667085]">Transfers</span>
          <p className="text-base md:text-lg font-black text-[#1F2933]">
            {route.totalTransfers === 0 ? 'Direct (0)' : `${route.totalTransfers} transfer${route.totalTransfers === 1 ? '' : 's'}`}
          </p>
        </div>

        <div className={`space-y-0.5 p-2 rounded-xl transition-all ${isBudget ? 'bg-emerald-50/90 border border-emerald-300 shadow-2xs' : ''}`}>
          <div className="flex items-center justify-between">
            <span className="text-[11px] font-bold uppercase tracking-wider text-[#667085]">{isRideOption ? 'Estimated Fare' : 'Estimated Cost'}</span>
            {isBudget && (
              <span className="text-[10px] font-black text-emerald-900 bg-emerald-200/90 px-1.5 py-0.5 rounded leading-none">
                💰 Budget Route
              </span>
            )}
          </div>
          <p className={`text-base md:text-lg font-black ${isBudget ? 'text-emerald-900' : 'text-[#146B5B]'}`}>
            {formatPrice(route.totalPrice, route.currency)}
          </p>
        </div>
      </div>

      {hasEstimatedRide && (
        <p className="mb-3 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-xs font-semibold text-amber-900">
          {isRideOption ? 'Estimated ride option.' : 'This route includes an estimated ride leg.'}{' '}
          Fare and duration are estimates, not live provider data. {RIDE_HAILING_NOTE}
        </p>
      )}

      {/* Card Action Row: Overview & Show Details Toggle */}
      <div className="pt-3 flex items-center justify-between border-t border-gray-100 flex-wrap gap-2">
        <div className="text-xs text-[#667085] font-medium flex items-center gap-1.5 truncate">
          <span className="font-bold text-gray-800">{route.from}</span>
          <span className="text-gray-400">➔</span>
          <span className="font-bold text-gray-800">{route.to}</span>
          {route.via && (
            <span className="text-gray-500 text-[11px] ml-1">· via {route.via}</span>
          )}
        </div>

        <button
          onClick={() => setShowDetails(!showDetails)}
          className="inline-flex items-center gap-1.5 rounded-xl bg-[#F0F4F2] px-4 py-2 text-xs font-bold text-[#146B5B] hover:bg-[#E2EBE6] transition-colors cursor-pointer"
          aria-expanded={showDetails}
        >
          <span>{showDetails ? 'Hide Details' : 'Show Details'}</span>
          {showDetails ? <ChevronUp className="h-4 w-4" /> : <ChevronDown className="h-4 w-4" />}
        </button>
      </div>

      {/* 2. Show Details — Complete Step-by-Step Journey UI */}
      {showDetails && (
        <div className="mt-6 pt-6 border-t border-gray-200 space-y-6 animate-fadeIn">
          {/* Detailed Journey Heading */}
          <div className="flex items-center justify-between flex-wrap gap-2 pb-2 border-b border-gray-200">
            <div>
              <div className="flex items-center gap-2 flex-wrap">
                <h4 className="text-xs font-black uppercase tracking-wider text-[#667085] flex items-center gap-2">
                  <span>🗺</span> Detailed Journey — Step-by-Step
                </h4>
                {isFastest && (
                  <span className="text-[11px] font-black text-amber-900 bg-amber-100 border border-amber-300 px-2 py-0.5 rounded-full flex items-center gap-1 shadow-2xs">
                    ⚡ Fastest ({formatDuration(route.totalDurationMinutes)})
                  </span>
                )}
                {isBudget && (
                  <span className="text-[11px] font-black text-emerald-900 bg-emerald-100 border border-emerald-300 px-2 py-0.5 rounded-full flex items-center gap-1 shadow-2xs">
                    💰 Budget Route ({formatPrice(route.totalPrice, route.currency)})
                  </span>
                )}
              </div>
              <p className="text-xs text-[#667085] mt-0.5">
                Clear step-by-step navigation including boarding, alight points, and transfer guidance.
              </p>
            </div>
            <span className="text-xs font-bold text-[#146B5B] bg-[#146B5B]/10 px-3 py-1 rounded-full">
              {journeySteps.length} Steps · {route.totalTransfers} Transfer{route.totalTransfers === 1 ? '' : 's'}
            </span>
          </div>

          {/* Vertical Step-by-Step Timeline */}
          <div className="relative pl-6 sm:pl-10 space-y-6">
            {/* Continuous Vertical Timeline Line */}
            <div
              className="absolute left-[15px] sm:left-[23px] top-6 bottom-6 w-0.5 bg-gray-200"
              aria-hidden="true"
            />

            {journeySteps.map((step, idx) => (
              <div key={idx} className="relative">
                {/* Node Icon on Timeline */}
                <div className="absolute -left-[23px] sm:-left-[35px] top-3.5 z-10">
                  {renderStepNode(step)}
                </div>

                {/* Step Card Content */}
                {renderStepCard(step)}

                {/* Downward Connector Arrow between steps */}
                {idx < journeySteps.length - 1 && (
                  <div className="flex items-center justify-center pt-3 pb-1 -ml-6 sm:-ml-10 text-gray-400">
                    <span className="text-xs font-black bg-white px-2 py-0.5 rounded-full border border-gray-200 text-gray-400 shadow-2xs">
                      ↓
                    </span>
                  </div>
                )}
              </div>
            ))}
          </div>

          {/* Facility & Modal Breakdown Directory (Collapsible) */}
          <details className="group border border-[#D9DED9] rounded-xl bg-gray-50/70 p-4 transition-all">
            <summary className="text-xs font-black uppercase tracking-wider text-[#667085] cursor-pointer flex items-center justify-between list-none">
              <span className="flex items-center gap-1.5">
                <span>📊</span> View Route Composition & Facility Directory
              </span>
              <ChevronDown className="h-4 w-4 text-gray-500 group-open:rotate-180 transition-transform" />
            </summary>
            <div className="mt-4 pt-3 border-t border-[#D9DED9] space-y-3.5">
              {/* Modal Distances */}
              <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-5 gap-2.5">
                <div className="bg-white border border-[#D9DED9] rounded-lg p-2.5">
                  <span className="text-[10px] font-extrabold uppercase text-[#667085]">🚶 Walking</span>
                  <p className="text-sm font-black text-[#1F2933] mt-0.5">
                    {(route.walkingDistanceKm ?? route.segments.filter(s => s.mode === 'walking').reduce((acc, s) => acc + s.distanceKm, 0)).toFixed(1)} km
                  </p>
                </div>
                <div className="bg-white border border-[#D9DED9] rounded-lg p-2.5">
                  <span className="text-[10px] font-extrabold uppercase text-[#667085]">🚌 Bus Transit</span>
                  <p className="text-sm font-black text-[#1F2933] mt-0.5">
                    {(route.busDistanceKm ?? route.segments.filter(s => s.mode === 'bus').reduce((acc, s) => acc + s.distanceKm, 0)).toFixed(1)} km
                  </p>
                </div>
                <div className="bg-white border border-[#D9DED9] rounded-lg p-2.5">
                  <span className="text-[10px] font-extrabold uppercase text-[#667085]">🚆 Train Rail</span>
                  <p className="text-sm font-black text-[#1F2933] mt-0.5">
                    {(route.trainDistanceKm ?? route.segments.filter(s => s.mode === 'train').reduce((acc, s) => acc + s.distanceKm, 0)).toFixed(1)} km
                  </p>
                </div>
                <div className="bg-white border border-[#D9DED9] rounded-lg p-2.5">
                  <span className="text-[10px] font-extrabold uppercase text-[#667085]">🛺 Cab / Auto</span>
                  <p className="text-sm font-black text-[#1F2933] mt-0.5">
                    {(route.cabAutoDistanceKm ?? route.segments.filter(s => s.mode === 'auto' || s.mode === 'cab' || s.mode === 'uber' || s.mode === 'rapido').reduce((acc, s) => acc + s.distanceKm, 0)).toFixed(1)} km
                  </p>
                </div>
                {((route.flightDistanceKm ?? 0) > 0 || route.segments.some(s => s.mode === 'flight')) && (
                  <div className="bg-white border border-indigo-200 rounded-lg p-2.5">
                    <span className="text-[10px] font-extrabold uppercase text-indigo-700">✈️ Air Flight</span>
                    <p className="text-sm font-black text-indigo-950 mt-0.5">
                      {(route.flightDistanceKm ?? route.segments.filter(s => s.mode === 'flight').reduce((acc, s) => acc + s.distanceKm, 0)).toFixed(0)} km
                    </p>
                  </div>
                )}
              </div>

              {/* Facilities Directory */}
              <div className="space-y-2 pt-1 border-t border-[#D9DED9]">
                {route.airports && route.airports.length > 0 && (
                  <div className="flex flex-wrap items-center gap-1.5 text-xs">
                    <span className="font-extrabold text-[#667085] uppercase text-[10px] min-w-[110px]">✈️ Airports:</span>
                    {route.airports.map((airport, i) => (
                      <span key={i} className="bg-white border border-indigo-300 text-indigo-950 px-2 py-0.5 rounded font-semibold text-[11px]">
                        {airport}
                      </span>
                    ))}
                  </div>
                )}
                {route.busStops && route.busStops.length > 0 && (
                  <div className="flex flex-wrap items-center gap-1.5 text-xs">
                    <span className="font-extrabold text-[#667085] uppercase text-[10px] min-w-[110px]">🚏 Bus Stops:</span>
                    {route.busStops.map((stop, i) => (
                      <span key={i} className="bg-white border border-emerald-300 text-emerald-950 px-2 py-0.5 rounded font-semibold text-[11px]">
                        {stop}
                      </span>
                    ))}
                  </div>
                )}
                {route.busStands && route.busStands.length > 0 && (
                  <div className="flex flex-wrap items-center gap-1.5 text-xs">
                    <span className="font-extrabold text-[#667085] uppercase text-[10px] min-w-[110px]">🏢 Bus Stands:</span>
                    {route.busStands.map((stand, i) => (
                      <span key={i} className="bg-white border border-teal-300 text-teal-950 px-2 py-0.5 rounded font-semibold text-[11px]">
                        {stand}
                      </span>
                    ))}
                  </div>
                )}
                {route.railwayStations && route.railwayStations.length > 0 && (
                  <div className="flex flex-wrap items-center gap-1.5 text-xs">
                    <span className="font-extrabold text-[#667085] uppercase text-[10px] min-w-[110px]">🚉 Railway Stations:</span>
                    {route.railwayStations.map((station, i) => (
                      <span key={i} className="bg-white border border-amber-300 text-amber-950 px-2 py-0.5 rounded font-semibold text-[11px]">
                        {station}
                      </span>
                    ))}
                  </div>
                )}
              </div>
            </div>
          </details>

          {/* Action Buttons: View Route on Map & Save */}
          <div className="pt-2 flex flex-col sm:flex-row gap-3">
            <button
              onClick={() => setShowMap(true)}
              className="flex-1 py-2.5 px-4 rounded-xl bg-[#146B5B] hover:bg-[#0f5447] text-white font-extrabold text-xs transition flex items-center justify-center gap-2 shadow-xs cursor-pointer"
            >
              <Map className="h-4 w-4" /> View Route on Map
            </button>
            <button
              onClick={handleSaveRoute}
              className="flex-1 py-2.5 px-4 rounded-xl border border-[#D9DED9] hover:bg-gray-50 text-[#1F2933] font-bold text-xs transition flex items-center justify-center gap-2 cursor-pointer"
            >
              {saved ? (
                <>
                  <Check className="h-4 w-4 text-[#146B5B]" />
                  <span className="text-[#146B5B]">Saved to Journeys</span>
                </>
              ) : (
                <>
                  <Bookmark className="h-4 w-4 text-[#667085]" />
                  <span>Save Route Itinerary</span>
                </>
              )}
            </button>
          </div>
        </div>
      )}

      <RouteMap route={route} isOpen={showMap} onClose={() => setShowMap(false)} />
    </article>
  );
}

import { useMemo } from 'react';
import { Bus, TrainFront, Plane, CarTaxiFront } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import type { Journey, TransitLeg, LocalRideLeg, WalkLeg } from '../services/planService';
import { isTransitLeg, isLocalRideLeg, isWalkLeg } from '../services/planService';
import { clockOf, dayDifference, formatDuration } from '../utils/dateTime';
import { vehicleFamilyOf } from '../utils/busIdentity';

export interface JourneyTimelineProps {
  journey: Journey;
  from?: string;
  to?: string;
  corridor?: { from: string; to: string };
  className?: string;
}

interface TransferPoint {
  id: string;
  name: string;
  positionPercent: number;
  fromMode: string;
  toMode: string;
  waitTimeFormatted: string | null;
  arrivalTime: string;
  departureTime: string;
}

interface TimelineSegment {
  id: string;
  mode: string;
  label: string;
  Icon: LucideIcon;
  centerPercent: number;
}

const MODE_ICON_MAP: Record<string, LucideIcon> = {
  bus: Bus,
  train: TrainFront,
  flight: Plane,
  local_ride: CarTaxiFront,
  walk: CarTaxiFront,
};

export default function JourneyTimeline({
  journey,
  from,
  to,
  corridor,
  className = '',
}: JourneyTimelineProps) {
  const isCurrentLocation = useMemo(() => {
    const firstLeg = journey.legs?.[0];
    const firstLegName = firstLeg && isTransitLeg(firstLeg) ? firstLeg.fromStop?.name : (firstLeg as { from?: { name?: string } })?.from?.name;
    return Boolean(
      /current\s*location/i.test(from || '') ||
      /current\s*location/i.test(corridor?.from || '') ||
      /current\s*location/i.test(firstLegName || '')
    );
  }, [from, corridor?.from, journey.legs]);

  const transitLegs = useMemo(() => {
    return (journey.legs || []).filter(isTransitLeg);
  }, [journey.legs]);

  const accessLeg = useMemo(() => {
    return (journey.legs || []).find((l): l is LocalRideLeg | WalkLeg => (isLocalRideLeg(l) || isWalkLeg(l)) && l.kind === 'access') || null;
  }, [journey.legs]);

  // When starting from current location, show the local ride to the bus stand or station along the main timeline
  const timelineLegs = useMemo<(TransitLeg | LocalRideLeg)[]>(() => {
    if (isCurrentLocation && accessLeg && transitLegs.length > 0) {
      const accessRide: LocalRideLeg = isLocalRideLeg(accessLeg) ? accessLeg : {
        mode: 'local_ride',
        kind: accessLeg.kind,
        label: 'Local ride',
        from: accessLeg.from,
        to: accessLeg.to,
        distanceMeters: accessLeg.distanceMeters || 500,
        durationSeconds: accessLeg.durationSeconds,
        rideSeconds: accessLeg.durationSeconds,
        pickupWaitSeconds: 0,
        departureTime: accessLeg.departureTime,
        arrivalTime: accessLeg.arrivalTime,
        dataConfidence: 'estimated',
        durationConfidence: 'estimated',
        providerIntegration: false,
        availabilityStatus: 'unknown',
        isRealtime: false,
        fare: null
      };
      return [accessRide, ...transitLegs];
    }
    return transitLegs;
  }, [isCurrentLocation, accessLeg, transitLegs]);

  const originName = useMemo(() => {
    if (isCurrentLocation) return from?.trim() || '📍 Current Location';
    if (from && from.trim() && !/^origin$/i.test(from.trim())) return from.trim();
    if (corridor?.from && !/^origin$/i.test(corridor.from.trim())) return corridor.from;
    const firstLeg = journey.legs?.[0];
    const raw = firstLeg && isTransitLeg(firstLeg) ? firstLeg.fromStop?.name : firstLeg?.from?.name;
    if (raw && !/^origin$/i.test(raw.trim())) return raw;
    return from || 'From';
  }, [isCurrentLocation, corridor?.from, journey.legs, from]);

  const destinationName = useMemo(() => {
    if (to && to.trim() && !/^destination$/i.test(to.trim())) return to.trim();
    if (corridor?.to && !/^destination$/i.test(corridor.to.trim())) return corridor.to;
    const lastLeg = journey.legs?.at(-1);
    const raw = lastLeg && isTransitLeg(lastLeg) ? lastLeg.toStop?.name : lastLeg?.to?.name;
    if (raw && !/^destination$/i.test(raw.trim())) return raw;
    return to || 'To';
  }, [corridor?.to, journey.legs, to]);

  const depTime = clockOf(journey.departureTime);
  const arrTime = clockOf(journey.arrivalTime);
  const extraDays = dayDifference(journey.departureTime, journey.arrivalTime);

  const getLegFromPlace = (leg: TransitLeg | LocalRideLeg) => isTransitLeg(leg) ? leg.fromStop?.name : (leg as LocalRideLeg).from?.name;
  const getLegToPlace = (leg: TransitLeg | LocalRideLeg) => isTransitLeg(leg) ? leg.toStop?.name : (leg as LocalRideLeg).to?.name;
  const getLegFamily = (leg: TransitLeg | LocalRideLeg) => isTransitLeg(leg) ? vehicleFamilyOf(leg) : 'local_ride';

  // Identify intermediate transfer points for journeys with vehicle transfers
  const transferPoints = useMemo<TransferPoint[]>(() => {
    if (timelineLegs.length <= 1) return [];

    const points: TransferPoint[] = [];
    const count = timelineLegs.length - 1;

    for (let i = 0; i < count; i++) {
      const current = timelineLegs[i];
      const next = timelineLegs[i + 1];

      const rawName = getLegToPlace(current) || getLegFromPlace(next) || 'Transfer';
      const waitSeconds = Math.max(
        0,
        Math.round((new Date(next.departureTime).getTime() - new Date(current.arrivalTime).getTime()) / 1000)
      );
      const waitTimeFormatted = waitSeconds >= 60 ? formatDuration(waitSeconds) : null;
      const positionPercent = Math.round(((i + 1) / (count + 1)) * 100);

      points.push({
        id: `transfer-${i}-${rawName}`,
        name: rawName,
        positionPercent,
        fromMode: getLegFamily(current),
        toMode: getLegFamily(next),
        waitTimeFormatted,
        arrivalTime: clockOf(current.arrivalTime),
        departureTime: clockOf(next.departureTime),
      });
    }

    return points;
  }, [timelineLegs]);

  // Intermediate segments for displaying travel mode icons along the line
  const segments = useMemo<TimelineSegment[]>(() => {
    if (timelineLegs.length === 0) {
      return [{
        id: 'seg-single',
        mode: 'local_ride',
        label: 'Local ride',
        Icon: CarTaxiFront,
        centerPercent: 50,
      }];
    }

    if (timelineLegs.length === 1) {
      const mode = getLegFamily(timelineLegs[0]);
      return [{
        id: 'seg-single',
        mode,
        label: mode === 'local_ride' ? 'Local ride' : mode === 'bus' ? 'Bus' : mode === 'train' ? 'Train' : 'Flight',
        Icon: MODE_ICON_MAP[mode] || (mode === 'local_ride' ? CarTaxiFront : Bus),
        centerPercent: 50,
      }];
    }

    const count = timelineLegs.length;
    return timelineLegs.map((leg, i) => {
      const mode = getLegFamily(leg);
      const startPct = (i / count) * 100;
      const endPct = ((i + 1) / count) * 100;
      const centerPercent = Math.round((startPct + endPct) / 2);
      const label = mode === 'local_ride' ? 'Local ride' : mode === 'bus' ? 'Bus' : mode === 'train' ? 'Train' : 'Flight';
      return {
        id: `seg-${i}-${mode}`,
        mode,
        label,
        Icon: MODE_ICON_MAP[mode] || (mode === 'local_ride' ? CarTaxiFront : Bus),
        centerPercent,
      };
    });
  }, [timelineLegs]);

  return (
    <div
      className={`relative w-full pt-7 pb-8 px-2 sm:px-3 my-1 select-none ${className}`}
      aria-label={`Journey timeline: depart ${originName} at ${depTime}, arrive ${destinationName} at ${arrTime}${
        transferPoints.length > 0 ? ` with transfers at ${transferPoints.map(p => p.name).join(', ')}` : ' direct'
      }`}
    >
      {/* Horizontal Line Track */}
      <div className="relative h-1 w-full bg-[#E2E8F0] rounded-full">
        {/* Active colored path line */}
        <div
          className="absolute inset-0 rounded-full bg-gradient-to-r from-[#146B5B] via-[#0D9488] to-[#146B5B]"
          aria-hidden="true"
        />

        {/* Animated Moving Dot */}
        <div
          aria-hidden="true"
          className="rc-timeline-moving-dot absolute top-1/2 -translate-y-1/2 w-2.5 h-2.5 sm:w-3 sm:h-3 rounded-full bg-[#146B5B] shadow-[0_0_8px_rgba(20,107,91,0.7)] border-2 border-white z-20 pointer-events-none"
        />

        {/* Mode Icons along segments */}
        {segments.map(seg => {
          const Icon = seg.Icon;
          return (
            <div
              key={seg.id}
              className="absolute top-1/2 -translate-y-1/2 -translate-x-1/2 z-15 pointer-events-none"
              style={{ left: `${seg.centerPercent}%` }}
              aria-hidden="true"
            >
              <span className="inline-flex items-center gap-1 rounded-full bg-white/90 backdrop-blur-xs border border-[#CBDDF0]/80 px-1.5 py-0.5 text-[10px] font-bold text-[#2F5D8C] shadow-2xs">
                <Icon className="h-2.5 w-2.5 shrink-0" />
                <span className="hidden sm:inline">{seg.label}</span>
              </span>
            </div>
          );
        })}

        {/* Origin Point (Left 0%) */}
        <div
          className="absolute top-1/2 left-0 -translate-y-1/2 -translate-x-1/2 z-20 flex flex-col items-start"
          style={{ left: '0%' }}
        >
          {/* Departure Time (Above Origin) */}
          <div className="absolute bottom-3 sm:bottom-3.5 left-0 text-left whitespace-nowrap">
            <span className="text-xs sm:text-sm font-black tabular-nums text-[#1F2933]">
              {depTime}
            </span>
          </div>

          {/* Origin Marker */}
          <div
            className="w-3.5 h-3.5 sm:w-4 sm:h-4 rounded-full bg-white border-2 border-[#146B5B] shadow-sm flex items-center justify-center ring-4 ring-[#146B5B]/15"
            title={`From: ${originName} (Departs ${depTime})`}
          >
            <div className="w-1.5 h-1.5 rounded-full bg-[#146B5B]" />
          </div>

          {/* Origin Place Name (Below Origin) */}
          <div className="absolute top-4 sm:top-4.5 left-0 text-left">
            <span
              title={originName}
              className="block max-w-[90px] sm:max-w-[130px] truncate text-[11px] sm:text-xs font-bold text-[#475467]"
            >
              {originName}
            </span>
          </div>
        </div>

        {/* Transfer Points (Intermediate transit stops) */}
        {transferPoints.map(point => (
          <div
            key={point.id}
            className="absolute top-1/2 -translate-y-1/2 -translate-x-1/2 z-20 flex flex-col items-center"
            style={{ left: `${point.positionPercent}%` }}
          >
            {/* Transfer Badge / Wait Time (Above Transfer Stop) */}
            <div className="absolute bottom-3 sm:bottom-3.5 left-1/2 -translate-x-1/2 text-center whitespace-nowrap">
              {point.waitTimeFormatted ? (
                <span
                  title={`Transfer at ${point.name}: ${point.waitTimeFormatted} wait`}
                  className="inline-flex items-center rounded-full bg-[#FFF7E8] border border-[#F1D29A] px-1.5 py-0.2 text-[10px] font-bold text-[#8A5D0C] shadow-2xs"
                >
                  {point.waitTimeFormatted} wait
                </span>
              ) : (
                <span
                  title={`Transfer at ${point.name}`}
                  className="inline-flex items-center rounded-full bg-[#EFF5FB] border border-[#CBDDF0] px-1.5 py-0.2 text-[10px] font-bold text-[#2F5D8C] shadow-2xs"
                >
                  Transfer
                </span>
              )}
            </div>

            {/* Transfer Node Marker */}
            <div
              className="w-3 h-3 sm:w-3.5 sm:h-3.5 rounded-full bg-white border-2 border-[#E5A93D] shadow-sm flex items-center justify-center ring-4 ring-[#E5A93D]/20"
              title={`Transfer stop: ${point.name}${point.waitTimeFormatted ? ` (${point.waitTimeFormatted} wait)` : ''}`}
            >
              <div className="w-1 h-1 rounded-full bg-[#E5A93D]" />
            </div>

            {/* Transfer Stop Label (Below Transfer Stop) */}
            <div className="absolute top-4 sm:top-4.5 left-1/2 -translate-x-1/2 text-center">
              <span
                title={point.name}
                className="block max-w-[105px] sm:max-w-[150px] truncate text-[11px] sm:text-xs font-extrabold text-[#1F2933] uppercase tracking-tight"
              >
                {point.name}
              </span>
            </div>
          </div>
        ))}

        {/* Destination Point (Right 100%) */}
        <div
          className="absolute top-1/2 right-0 -translate-y-1/2 translate-x-1/2 z-20 flex flex-col items-end"
          style={{ left: '100%' }}
        >
          {/* Arrival Time (Above Destination) */}
          <div className="absolute bottom-3 sm:bottom-3.5 right-0 text-right whitespace-nowrap flex items-center gap-1">
            <span className="text-xs sm:text-sm font-black tabular-nums text-[#1F2933]">
              {arrTime}
            </span>
            {extraDays > 0 && (
              <span className="text-[10px] font-bold text-amber-700 bg-amber-50 px-1 rounded border border-amber-200">
                +{extraDays}d
              </span>
            )}
          </div>

          {/* Destination Marker */}
          <div
            className="w-3.5 h-3.5 sm:w-4 sm:h-4 rounded-full bg-[#146B5B] border-2 border-white shadow-sm flex items-center justify-center ring-4 ring-[#146B5B]/25"
            title={`To: ${destinationName} (Arrives ${arrTime}${extraDays > 0 ? ` +${extraDays}d` : ''})`}
          >
            <div className="w-1.5 h-1.5 rounded-full bg-white" />
          </div>

          {/* Destination Place Name (Below Destination) */}
          <div className="absolute top-4 sm:top-4.5 right-0 text-right">
            <span
              title={destinationName}
              className="block max-w-[90px] sm:max-w-[130px] truncate text-[11px] sm:text-xs font-bold text-[#475467]"
            >
              {destinationName}
            </span>
          </div>
        </div>
      </div>
    </div>
  );
}

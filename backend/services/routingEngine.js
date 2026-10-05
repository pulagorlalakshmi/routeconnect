// Master Multi-Modal Route Calculation Engine
// Assembles comprehensive journey options connecting villages, small towns, cities,
// bus stops, bus stands, and railway stations.
// Recognizes multi-modal combinations (Bus + Train, Bus + Bus, Train + Bus, Bus + Train + Bus, Walking + Bus + Train) as complete seamless journeys.

import { db, getStoredMultiModalRoutes } from '../db/database.js';
import { getDistance, normalizePlaceKey, resolveLocation } from './geoService.js';
import { getNearbyRailwayStations, getNearbyBusStopsAndStations, getPhysicalHubTransfer } from './transitPlacesService.js';
import { findDirectTrains, findConnectingTrains } from './railwayService.js';
import { findDirectBusRoutes, findRuralFeederBus, findMultiStageBusRoutes } from './busService.js';
import { fetchNearbyOsmStops } from './osmTransitService.js';
import { validateRouteIntegrity } from './dataPipelineService.js';
import { buildCompleteAirJourneys } from './flightService.js';
import { isLegacyRideHailingEnabled, isRideHailingRoute, stampRideHailingRoute } from './rideHailing.js';

export function calculateSegmentPrice(mode, basePrice, passengers = 1) {
  if (mode === 'train' || mode === 'bus') {
    return basePrice * passengers;
  }
  return basePrice;
}

// Practical Route Corridors Registry (Preserves authoritative factual road village progression)
export const PRACTICAL_ROUTE_CORRIDORS = [
  {
    corridorId: 'narasaraopet-ongole',
    origin: 'Narasaraopet',
    destination: 'Ongole',
    originAliases: ['narasaraopet', 'narasaraopeta', 'nrt'],
    destinationAliases: ['ongole', 'ong', 'ongole railway station'],
    bidirectional: true,
    routes: [
      {
        id: 'nrt-ong-via-addanki',
        routeName: 'Route 2 – Bus Only: Via Addanki',
        via: 'Addanki',
        distanceKm: 88.0,
        durationMinutes: 105,
        basePrice: 110,
        highway: 'NAM Expressway (SH 45) & NH 16',
        villages: [
          'Narasaraopet',
          'Mulakalur',
          'Rompicherla',
          'Santhamaguluru',
          'Kotikalapudi',
          'Addanki',
          'Medarmetla',
          'Korisapadu',
          'Maddipadu',
          'Ongole'
        ],
        segments: [
          {
            mode: 'bus',
            provider: 'APSRTC Express',
            from: 'Narasaraopet Bus Station',
            to: 'Chilakaluripeta Bus Stand',
            durationMinutes: 50,
            distanceKm: 42.0,
            price: 45,
            departure: '07:30',
            arrival: '08:20',
            serviceName: 'Express',
            busType: 'Express',
            stops: 'Mulakalur, Rompicherla, Santhamaguluru, Kotikalapudi'
          },
          {
            mode: 'bus',
            provider: 'APSRTC Palle Velugu',
            from: 'Chilakaluripeta Bus Stand',
            to: 'Ongole Bus Stand',
            durationMinutes: 55,
            distanceKm: 46.0,
            price: 65,
            departure: '08:35',
            arrival: '09:30',
            serviceName: 'Palle Velugu (Via Addanki)',
            busType: 'Palle Velugu',
            stops: 'Addanki, Medarmetla, Korisapadu, Maddipadu'
          }
        ]
      },
      {
        id: 'nrt-ong-via-chilakaluripeta',
        routeName: 'Route 3 – Bus Only: Via Chilakaluripeta',
        via: 'Chilakaluripeta',
        distanceKm: 96.0,
        durationMinutes: 115,
        basePrice: 125,
        highway: 'SH 45 & NH 16 Grand Trunk Corridor',
        villages: [
          'Narasaraopet',
          'Mulakalur',
          'Kakani',
          'Nadendla',
          'Chilakaluripeta',
          'Purushothapatnam',
          'Martur',
          'Medarmetla',
          'Maddipadu',
          'Ongole'
        ],
        segments: [
          {
            mode: 'bus',
            provider: 'APSRTC Ultra Deluxe',
            from: 'Narasaraopet Bus Station',
            to: 'Chilakaluripeta Bus Stand',
            durationMinutes: 55,
            distanceKm: 45.0,
            price: 55,
            departure: '08:00',
            arrival: '08:55',
            serviceName: 'Express',
            busType: 'Express',
            stops: 'Mulakalur, Kakani, Nadendla'
          },
          {
            mode: 'bus',
            provider: 'APSRTC Super Luxury',
            from: 'Chilakaluripeta Bus Stand',
            to: 'Ongole Bus Stand',
            durationMinutes: 60,
            distanceKm: 51.0,
            price: 70,
            departure: '09:10',
            arrival: '10:10',
            serviceName: 'Super Luxury',
            busType: 'Super Luxury',
            stops: 'Purushothapatnam, Martur, Medarmetla, Maddipadu'
          }
        ]
      }
    ]
  }
];

function matchCorridor(fromCity, toCity) {
  const normFrom = normalizePlaceKey(fromCity);
  const normTo = normalizePlaceKey(toCity);

  for (const corridor of PRACTICAL_ROUTE_CORRIDORS) {
    const originMatches = (
      corridor.origin.toLowerCase() === normFrom ||
      (corridor.originAliases && corridor.originAliases.some(a => a.toLowerCase() === normFrom))
    );
    const destMatches = (
      corridor.destination.toLowerCase() === normTo ||
      (corridor.destinationAliases && corridor.destinationAliases.some(a => a.toLowerCase() === normTo))
    );

    if (originMatches && destMatches) {
      return { corridor, isReverse: false };
    }

    if (corridor.bidirectional) {
      const revOriginMatches = (
        corridor.destination.toLowerCase() === normFrom ||
        (corridor.destinationAliases && corridor.destinationAliases.some(a => a.toLowerCase() === normFrom))
      );
      const revDestMatches = (
        corridor.origin.toLowerCase() === normTo ||
        (corridor.originAliases && corridor.originAliases.some(a => a.toLowerCase() === normTo))
      );

      if (revOriginMatches && revDestMatches) {
        return { corridor, isReverse: true };
      }
    }
  }
  return null;
}

export function createGpsRideOptions(fromName, toName, directDist) {
  const dist = Math.round(directDist * 10) / 10;
  const uberPrice = Math.max(60, Math.round(directDist * 14 + 40));
  const uberDur = Math.max(8, Math.round(directDist * 2.0));
  const rapidoPrice = Math.max(35, Math.round(directDist * 8 + 20));
  const rapidoDur = Math.max(6, Math.round(directDist * 1.8));

  // Estimated options only: no Uber/Rapido integration exists. stampRideHailingRoute() adds the honest
  // metadata (availability unknown, estimated fare/duration, not real-time) and removes trusted ranking tags.
  return [
    {
      id: `direct-uber-${Date.now()}-${Math.random().toString(36).substring(7)}`,
      from: fromName,
      to: toName,
      routeName: 'Uber – Estimated option',
      totalPrice: uberPrice,
      totalDurationMinutes: uberDur,
      totalTransfers: 0,
      distanceKm: dist,
      tag: null,
      segments: [{
        mode: 'uber',
        provider: 'Uber',
        serviceName: directDist > 15 ? 'Uber Intercity' : 'Uber Auto / Cab',
        from: fromName,
        to: toName,
        durationMinutes: uberDur,
        distanceKm: dist,
        price: uberPrice,
        departure: null,
        arrival: null
      }]
    },
    {
      id: `direct-rapido-${Date.now()}-${Math.random().toString(36).substring(7)}`,
      from: fromName,
      to: toName,
      routeName: 'Rapido – Estimated option',
      totalPrice: rapidoPrice,
      totalDurationMinutes: rapidoDur,
      totalTransfers: 0,
      distanceKm: dist,
      tag: null,
      segments: [{
        mode: 'rapido',
        provider: 'Rapido',
        serviceName: directDist > 15 ? 'Rapido Outstation' : 'Rapido Bike / Auto',
        from: fromName,
        to: toName,
        durationMinutes: rapidoDur,
        distanceKm: dist,
        price: rapidoPrice,
        departure: null,
        arrival: null
      }]
    }
  ].map(stampRideHailingRoute);
}

function formatModeTitle(mode) {
  switch (mode) {
    case 'bus': return 'Bus';
    case 'train': return 'Train';
    case 'auto': return 'Auto';
    case 'cab': return 'Cab';
    case 'walking': return 'Walking';
    case 'flight': return 'Flight';
    case 'uber': return 'Uber';
    case 'rapido': return 'Rapido';
    default: return mode ? mode.charAt(0).toUpperCase() + mode.slice(1) : 'Transit';
  }
}

function enrichRouteDetails(route, locFrom, locTo, villageAssistance) {
  const segments = route.segments || [];

  let walkingDistanceKm = 0;
  let busDistanceKm = 0;
  let trainDistanceKm = 0;
  let cabAutoDistanceKm = 0;
  let flightDistanceKm = 0;
  const modesSet = new Set();
  const busStopsSet = new Set();
  const busStandsSet = new Set();
  const railwayStationsSet = new Set();
  const airportsSet = new Set();
  const intermediateLocationsSet = new Set();

  for (const s of segments) {
    modesSet.add(s.mode);
    if (s.mode === 'walking') walkingDistanceKm += s.distanceKm || 0;
    else if (s.mode === 'bus') busDistanceKm += s.distanceKm || 0;
    else if (s.mode === 'train') trainDistanceKm += s.distanceKm || 0;
    else if (s.mode === 'auto' || s.mode === 'cab' || s.mode === 'uber' || s.mode === 'rapido') cabAutoDistanceKm += s.distanceKm || 0;
    else if (s.mode === 'flight') {
      flightDistanceKm += s.distanceKm || 0;
      if (s.departureAirport) airportsSet.add(s.departureAirport);
      if (s.arrivalAirport) airportsSet.add(s.arrivalAirport);
      if (s.layoverAirport) airportsSet.add(s.layoverAirport);
    }

    const fromLower = s.from.toLowerCase();
    const toLower = s.to.toLowerCase();
    if (fromLower.includes('bus stop')) busStopsSet.add(s.from);
    else if (fromLower.includes('bus stand') || fromLower.includes('bus station') || fromLower.includes('bus complex')) busStandsSet.add(s.from);
    else if (fromLower.includes('station') || fromLower.includes('junction')) railwayStationsSet.add(s.from);
    else if (fromLower.includes('airport')) airportsSet.add(s.from);
    else intermediateLocationsSet.add(s.from);

    if (toLower.includes('bus stop')) busStopsSet.add(s.to);
    else if (toLower.includes('bus stand') || toLower.includes('bus station') || toLower.includes('bus complex')) busStandsSet.add(s.to);
    else if (toLower.includes('station') || toLower.includes('junction')) railwayStationsSet.add(s.to);
    else if (toLower.includes('airport')) airportsSet.add(s.to);
    else intermediateLocationsSet.add(s.to);

    if (s.stops) {
      s.stops.split(',').forEach(st => {
        const item = st.trim();
        if (item) intermediateLocationsSet.add(item);
      });
    }
  }

  // Refine or generate transfers list
  let transfers = route.transfers || [];
  if (!transfers.length && segments.length > 1) {
    transfers = [];
    for (let i = 0; i < segments.length - 1; i++) {
      const prev = segments[i];
      const next = segments[i + 1];
      const isAutoTransfer = next.mode === 'auto' || next.mode === 'cab';

      let location = prev.to;
      let nextBoarding = next.from;
      let transferMode = 'walkway';
      let transferDistance = 0;
      let transferDuration = 15;
      let transferPrice = 0;
      let instruction = '';

      if (isAutoTransfer) {
        const afterNext = segments[i + 2];
        location = prev.to;
        nextBoarding = next.to;
        transferMode = next.mode;
        transferDistance = next.distanceKm;
        transferDuration = next.durationMinutes;
        transferPrice = next.price;
        instruction = `Get down from ${formatModeTitle(prev.mode)} at ${prev.to}. Travel ${next.distanceKm} km by ${formatModeTitle(next.mode)} to ${next.to}${afterNext ? ` to board ${formatModeTitle(afterNext.mode)}` : ''}.`;
      } else {
        instruction = `Get down from ${formatModeTitle(prev.mode)} at ${prev.to}. ${prev.to.toLowerCase() !== next.from.toLowerCase() ? `Transfer to ${next.from}. ` : ''}Board ${formatModeTitle(next.mode)} to ${next.to}.`;
      }

      transfers.push({
        transferNumber: transfers.length + 1,
        location,
        fromMode: prev.mode,
        toMode: next.mode,
        nextBoardingPoint: nextBoarding,
        transferMode,
        transferDistanceKm: transferDistance,
        transferDurationMinutes: transferDuration,
        transferPrice,
        instruction
      });
    }
  }

  // Format Route Title / Name if default or missing
  const modesList = Array.from(modesSet);
  let routeName = route.routeName;
  const hasFlight = modesSet.has('flight');
  const hasBus = modesSet.has('bus');
  const hasTrain = modesSet.has('train');
  const hasWalk = modesSet.has('walking');
  const hasAuto = modesSet.has('auto') || modesSet.has('cab');

  if ((!hasTrain && routeName && routeName.includes('Train')) || (!hasFlight && routeName && routeName.includes('Flight'))) {
    routeName = null;
  }

  if (!routeName || routeName.startsWith('Via ') || !routeName.includes('–')) {

    let modeTitle = 'Combined Transit';
    if (hasFlight && hasBus && hasTrain) {
      modeTitle = 'Bus + Flight + Train';
    } else if (hasFlight && hasBus && segments.some(s => s.stopCount > 0 || s.layoverMinutes)) {
      modeTitle = 'Bus + Connecting Flight + Bus';
    } else if (hasFlight && hasBus) {
      modeTitle = 'Bus + Flight + Bus';
    } else if (hasFlight && hasAuto) {
      modeTitle = 'Cab + Flight + Cab';
    } else if (hasFlight) {
      modeTitle = 'Flight Option';
    } else if (hasBus && hasTrain && segments.length >= 3 && segments[segments.length - 1].mode === 'bus') {
      modeTitle = 'Bus + Train + Bus';
    } else if (hasWalk && hasBus && hasTrain) {
      modeTitle = 'Walking + Bus + Train';
    } else if (hasBus && hasTrain) {
      modeTitle = 'Bus + Train';
    } else if (hasTrain && hasBus) {
      modeTitle = 'Train + Bus';
    } else if (hasBus && !hasTrain) {
      modeTitle = 'Bus Only';
    } else if (hasTrain && !hasBus) {
      modeTitle = 'Train Only';
    } else if (hasBus && hasAuto) {
      modeTitle = 'Bus + Auto/Cab';
    }

    const viaText = route.via ? `: Via ${route.via}` : '';
    routeName = `${modeTitle}${viaText}`;
  }

  const enriched = {
    ...route,
    routeName,
    modes: modesList,
    walkingDistanceKm: Math.round(walkingDistanceKm * 10) / 10,
    busDistanceKm: Math.round(busDistanceKm * 10) / 10,
    trainDistanceKm: Math.round(trainDistanceKm * 10) / 10,
    cabAutoDistanceKm: Math.round(cabAutoDistanceKm * 10) / 10,
    flightDistanceKm: Math.round(flightDistanceKm * 10) / 10,
    busStops: Array.from(busStopsSet),
    busStands: Array.from(busStandsSet),
    railwayStations: Array.from(railwayStationsSet),
    airports: Array.from(airportsSet),
    intermediateLocations: Array.from(intermediateLocationsSet),
    transfers,
    villageAssistance: villageAssistance || route.villageAssistance || null
  };

  // Every route containing an Uber/Rapido leg is honestly labelled as estimated (no live availability).
  return isRideHailingRoute(enriched) ? stampRideHailingRoute(enriched) : enriched;
}

export async function findMultiModalRoutes(fromCity, toCity, date, timeStr, passengersCount, originCoordinates = null) {
  const normalizedFrom = fromCity.trim().toLowerCase();
  const normalizedTo = toCity.trim().toLowerCase();
  const passengers = parseInt(passengersCount) || 1;

  if (normalizedFrom === normalizedTo) {
    return [];
  }

  let candidateRoutes = [];

  // 1. Fetch pre-stored permitted routes from SQLite database (Requirement 8)
  try {
    const storedRoutes = getStoredMultiModalRoutes(fromCity, toCity, passengers);
    if (storedRoutes && storedRoutes.length > 0) {
      candidateRoutes.push(...storedRoutes);
    }
  } catch (err) {
    console.warn('Error reading stored multi-modal routes:', err.message);
  }

  // 2. Resolve locations
  const [locFrom, locTo] = await Promise.all([
    resolveLocation(fromCity, originCoordinates),
    resolveLocation(toCity)
  ]);

  if (!locFrom || !locTo) {
    return candidateRoutes;
  }

  // Strict Location-Based Rule (Requirement 4):
  // IF fromLocation.type == "CURRENT_GPS_LOCATION" THEN Allow Uber/Rapido ELSE Hide Uber/Rapido
  const isCurrentGpsOrigin = Boolean(locFrom && locFrom.type === 'CURRENT_GPS_LOCATION');
  // Ride-hailing is a product-level "off" (no provider integration): nothing below is generated or priced
  // unless the development-only switch is set. See rideHailing.js.
  const rideHailingEnabled = isLegacyRideHailingEnabled();

  // OpenStreetMap Transit Infrastructure Discovery (Permitted Open Data ODbL)
  if (locFrom && Number.isFinite(locFrom.latitude)) {
    fetchNearbyOsmStops(locFrom.latitude, locFrom.longitude, 4000).catch(() => []);
  }
  if (locTo && Number.isFinite(locTo.latitude)) {
    fetchNearbyOsmStops(locTo.latitude, locTo.longitude, 4000).catch(() => []);
  }

  // Village Assistance Analysis (Requirement 7)
  const isVillage = locFrom.type === 'village' || locFrom.name.toLowerCase().includes('village');
  const nearbyBusList = getNearbyBusStopsAndStations(locFrom);
  const nearbyStationList = getNearbyRailwayStations(locFrom);
  const nearestBusFacility = nearbyBusList[0] || null;
  const nearestRailwayFacility = nearbyStationList[0] || null;

  const villageAssistance = isVillage ? {
    originIsVillage: true,
    villageName: locFrom.name,
    nearestBusFacility: nearestBusFacility ? {
      name: nearestBusFacility.name,
      distanceKm: nearestBusFacility.distanceKm,
      type: nearestBusFacility.type
    } : null,
    nearestRailwayStation: nearestRailwayFacility ? {
      name: nearestRailwayFacility.name,
      distanceKm: nearestRailwayFacility.distanceKm,
      type: nearestRailwayFacility.type
    } : null,
    explanation: `${locFrom.name} does not have a direct railway station. Route Connect has identified the nearest bus facility (${nearestBusFacility?.name || 'Local Bus Stop'}, ${nearestBusFacility?.distanceKm || 1.2} km) and nearby rail hub (${nearestRailwayFacility?.name || 'Nearest Station'}, ${nearestRailwayFacility?.distanceKm || 12} km) to generate multi-modal travel options.`
  } : null;

  const directDist = getDistance(locFrom.latitude, locFrom.longitude, locTo.latitude, locTo.longitude);

  // 3. Add Corridor registry routes if matched (Do not return early, combine with network options!)
  const corridorMatch = isCurrentGpsOrigin ? null : matchCorridor(fromCity, toCity);
  if (corridorMatch) {
    const { corridor, isReverse } = corridorMatch;
    const mappedCorridor = corridor.routes.map(r => {
      const routePrice = calculateSegmentPrice('bus', r.basePrice, passengers);
      const startPoint = isReverse ? corridor.destination : corridor.origin;
      const endPoint = isReverse ? corridor.origin : corridor.destination;
      const villagesList = isReverse ? [...r.villages].reverse() : [...r.villages];

      const segsToMap = isReverse ? [...r.segments].reverse() : r.segments;
      const mappedSegments = segsToMap.map(s => {
        const segPrice = calculateSegmentPrice(s.mode, s.price, passengers);
        if (!isReverse) return { ...s, price: segPrice };
        const reversedStops = s.stops
          ? s.stops.split(',').map(item => item.trim()).reverse().join(', ')
          : null;
        return {
          ...s,
          from: s.to,
          to: s.from,
          price: segPrice,
          departure: s.departure ? (s.departure === '07:30' ? '07:15' : '07:45') : null,
          arrival: s.arrival ? (s.arrival === '09:15' ? '09:00' : '09:40') : null,
          stops: reversedStops
        };
      });

      return {
        id: `${r.id}-${isReverse ? 'rev' : 'fwd'}-${Date.now()}-${Math.random().toString(36).substring(7)}`,
        from: startPoint,
        to: endPoint,
        routeName: r.routeName,
        via: r.via,
        highway: r.highway,
        villages: villagesList,
        distanceKm: r.distanceKm,
        totalPrice: routePrice,
        totalDurationMinutes: r.durationMinutes,
        totalTransfers: Math.max(0, mappedSegments.length - 1),
        tag: null,
        segments: mappedSegments
      };
    });
    candidateRoutes.push(...mappedCorridor);
  }

  // 4. Intra-Town Local Travel (when origin and destination are within 5 km of each other)
  if (directDist <= 5.0) {
    if (directDist <= 2.0) {
      const walkDist = Math.round(directDist * 10) / 10;
      candidateRoutes.push({
        id: `direct-walking-${Date.now()}-${Math.random()}`,
        from: locFrom.name,
        to: locTo.name,
        routeName: 'Walking',
        totalPrice: 0,
        totalDurationMinutes: Math.max(1, Math.round(directDist * 12)),
        totalTransfers: 0,
        distanceKm: walkDist,
        tag: 'cheapest',
        segments: [{
          mode: 'walking',
          provider: 'Walking',
          from: locFrom.name,
          to: locTo.name,
          durationMinutes: Math.max(1, Math.round(directDist * 12)),
          distanceKm: walkDist,
          price: 0,
          departure: null,
          arrival: null
        }]
      });
    }

    const hubTransfer = getPhysicalHubTransfer(locFrom.name, locTo.name);
    const busDist = Math.round(directDist * 10) / 10;
    const busDur = hubTransfer ? hubTransfer.duration_minutes : Math.max(5, Math.round(directDist * 3));
    const busPrice = (hubTransfer ? Math.max(15, hubTransfer.price) : Math.max(15, Math.round(directDist * 8))) * passengers;

    candidateRoutes.push({
      id: `local-transit-${Date.now()}-${Math.random()}`,
      from: locFrom.name,
      to: locTo.name,
      routeName: 'Local Public Bus / Shuttle',
      totalPrice: busPrice,
      totalDurationMinutes: busDur,
      totalTransfers: 0,
      distanceKm: busDist,
      tag: directDist <= 1.0 ? 'fastest' : 'best',
      segments: [{
        mode: 'bus',
        provider: 'Local public bus / town feeder',
        from: locFrom.name,
        to: locTo.name,
        durationMinutes: busDur,
        distanceKm: busDist,
        price: busPrice,
        departure: null,
        arrival: null
      }]
    });

    if (isCurrentGpsOrigin && rideHailingEnabled) {
      candidateRoutes.push(...createGpsRideOptions(locFrom.name, locTo.name, directDist));
    }

    let localRoutes = candidateRoutes.map(r => enrichRouteDetails(r, locFrom, locTo, villageAssistance));
    if (!isCurrentGpsOrigin) {
      localRoutes = localRoutes.filter(r => !r.segments.some(s => s.mode === 'uber' || s.mode === 'rapido'));
    }
    return localRoutes;
  }

  // 5. Discover nearby transport facilities for multi-modal connections
  const startStations = getNearbyRailwayStations(locFrom, 50, 4);
  const destStations = getNearbyRailwayStations(locTo, 50, 4);
  const startBusHubs = getNearbyBusStopsAndStations(locFrom, 40, 5);
  const destBusHubs = getNearbyBusStopsAndStations(locTo, 40, 5);

  function buildOriginLeg(fromLoc, hubLoc) {
    const d = getDistance(fromLoc.latitude, fromLoc.longitude, hubLoc.latitude, hubLoc.longitude);
    if (d <= 0.05) return null;

    if (d <= 2.5) {
      return {
        mode: 'walking',
        provider: 'Walking',
        from: fromLoc.name,
        to: hubLoc.name,
        durationMinutes: Math.max(2, Math.round(d * 12)),
        distanceKm: Math.round(d * 10) / 10,
        price: 0
      };
    }

    return findRuralFeederBus(fromLoc, hubLoc, passengers);
  }

  function buildDestLeg(hubLoc, toLoc) {
    const d = getDistance(hubLoc.latitude, hubLoc.longitude, toLoc.latitude, toLoc.longitude);
    if (d <= 0.05) return null;

    if (d <= 2.5) {
      return {
        mode: 'walking',
        provider: 'Walking',
        from: hubLoc.name,
        to: toLoc.name,
        durationMinutes: Math.max(2, Math.round(d * 12)),
        distanceKm: Math.round(d * 10) / 10,
        price: 0
      };
    }

    if (d <= 6.0) {
      return {
        mode: 'auto',
        provider: 'Local Auto / Cab',
        from: hubLoc.name,
        to: toLoc.name,
        serviceName: 'Local Auto',
        durationMinutes: Math.max(8, Math.round(d * 2.5)),
        distanceKm: Math.round(d * 10) / 10,
        price: Math.max(30, Math.round(20 + d * 8)),
        estimated: true
      };
    }

    const dur = Math.max(10, Math.round(d * 2.2));
    const price = Math.max(15, Math.round(10 + d * 1.25)) * passengers;
    return {
      mode: 'bus',
      provider: 'APSRTC City Feeder / Local Bus',
      from: hubLoc.name,
      to: toLoc.name,
      routeNumber: 'CITY-FEEDER',
      serviceName: 'City Ordinary',
      busType: 'Ordinary',
      durationMinutes: dur,
      distanceKm: Math.round(d * 10) / 10,
      price,
      estimated: true,
      estimatedNote: 'Local city bus or transfer to final destination.'
    };
  }

  // OPTION 1: Multi-Modal (Bus + Train Network)
  // Village A -> Bus -> Town X Bus Stand -> Auto/Walk -> Town X Railway Station -> Train -> City B Railway Station -> Bus/Auto -> Final Destination
  for (const sBus of startBusHubs) {
    for (const sStation of startStations) {
      const hubDist = getDistance(sBus.latitude, sBus.longitude, sStation.latitude, sStation.longitude);
      if (hubDist > 8.0) continue;

      for (const dStation of destStations) {
        if (sStation.name === dStation.name) continue;

        const directTrains = findDirectTrains(sStation.name, dStation.name, passengers);
        for (const trainSeg of directTrains) {
          const originDist = getDistance(locFrom.latitude, locFrom.longitude, sBus.latitude, sBus.longitude);
          const originLeg = buildOriginLeg(locFrom, sBus);
          if (originDist > 2.5 && !originLeg) continue;

          const destDist = getDistance(dStation.latitude, dStation.longitude, locTo.latitude, locTo.longitude);
          const destLeg = buildDestLeg(dStation, locTo);
          if (destDist > 2.5 && !destLeg) continue;

          const hubTransfer = getPhysicalHubTransfer(sBus.name, sStation.name);
          let transferLeg = null;
          if (hubDist > 0.05) {
            if (hubTransfer) {
              transferLeg = {
                mode: hubTransfer.mode,
                provider: hubTransfer.mode === 'auto' ? 'Local Auto / Cab' : (hubTransfer.transfer_type === 'walk' ? 'Station Walkway' : 'Town Feeder Shuttle'),
                from: sBus.name,
                to: sStation.name,
                durationMinutes: hubTransfer.duration_minutes,
                distanceKm: hubTransfer.distance_km,
                price: hubTransfer.price * (hubTransfer.mode === 'auto' ? 1 : passengers)
              };
            } else if (hubDist <= 2.5) {
              transferLeg = {
                mode: 'walking',
                provider: 'Station Walkway',
                from: sBus.name,
                to: sStation.name,
                durationMinutes: Math.max(2, Math.round(hubDist * 12)),
                distanceKm: Math.round(hubDist * 10) / 10,
                price: 0
              };
            } else {
              transferLeg = {
                mode: 'auto',
                provider: 'Local Auto / Shuttle',
                from: sBus.name,
                to: sStation.name,
                durationMinutes: Math.max(8, Math.round(hubDist * 2.5)),
                distanceKm: Math.round(hubDist * 10) / 10,
                price: Math.max(30, Math.round(20 + hubDist * 8))
              };
            }
          }

          const segments = [originLeg, transferLeg, trainSeg, destLeg].filter(Boolean);
          const totalDur = segments.reduce((sum, s) => sum + s.durationMinutes, 0) + 20;
          const totalPrice = segments.reduce((sum, s) => sum + s.price, 0);
          const totalDist = Math.round(segments.reduce((sum, s) => sum + s.distanceKm, 0) * 10) / 10;

          candidateRoutes.push({
            id: `multimodal-train-${Date.now()}-${Math.random().toString(36).substring(7)}`,
            from: locFrom.name,
            to: locTo.name,
            routeName: 'Bus + Train',
            totalPrice,
            totalDurationMinutes: totalDur,
            totalTransfers: Math.max(0, segments.length - 1),
            distanceKm: totalDist,
            priceIsPartial: segments.some(s => s.fareAvailable === false),
            tag: null,
            segments
          });
        }
      }
    }
  }

  // OPTION 2: All-Bus Network (Rural Feeder Bus + Intercity Bus Network)
  // Village A -> Feeder Bus -> Town Y Bus Stand -> Intercity Bus -> Destination
  for (const sBus of startBusHubs) {
    for (const dBus of destBusHubs) {
      if (sBus.name === dBus.name) continue;

      const directBuses = findDirectBusRoutes(sBus.name, dBus.name, passengers);
      for (const busSeg of directBuses) {
        const originDist = getDistance(locFrom.latitude, locFrom.longitude, sBus.latitude, sBus.longitude);
        const originLeg = buildOriginLeg(locFrom, sBus);
        if (originDist > 2.5 && !originLeg) continue;

        const destDist = getDistance(dBus.latitude, dBus.longitude, locTo.latitude, locTo.longitude);
        const destLeg = buildDestLeg(dBus, locTo);
        if (destDist > 2.5 && !destLeg) continue;

        const segments = [originLeg, busSeg, destLeg].filter(Boolean);
        const totalDur = segments.reduce((sum, s) => sum + s.durationMinutes, 0) + 15;
        const totalPrice = segments.reduce((sum, s) => sum + s.price, 0);
        const totalDist = Math.round(segments.reduce((sum, s) => sum + s.distanceKm, 0) * 10) / 10;

        candidateRoutes.push({
          id: `bus-network-${Date.now()}-${Math.random().toString(36).substring(7)}`,
          from: locFrom.name,
          to: locTo.name,
          routeName: 'Bus Only',
          totalPrice,
          totalDurationMinutes: totalDur,
          totalTransfers: Math.max(0, segments.length - 1),
          distanceKm: totalDist,
          priceIsPartial: segments.some(s => s.fareAvailable === false),
          tag: null,
          segments
        });
      }
    }
  }

  // OPTION 3: Train + Bus (Train from nearby rail station -> Junction -> Connecting bus to destination)
  for (const sStation of startStations) {
    for (const dBus of destBusHubs) {
      const junctionHubs = [
        { name: 'Vijayawada Railway Station', bus: 'Vijayawada Bus Station' },
        { name: 'Tenali Railway Station', bus: 'Tenali Bus Stand' },
        { name: 'Guntur Railway Station', bus: 'Guntur Bus Station' },
        { name: 'Rajahmundry Railway Station', bus: 'Rajahmundry Bus Station' }
      ];

      for (const junc of junctionHubs) {
        if (normalizePlaceKey(sStation.name) === normalizePlaceKey(junc.name)) continue;
        const leg1Trains = findDirectTrains(sStation.name, junc.name, passengers);
        const leg2Buses = findDirectBusRoutes(junc.bus, dBus.name, passengers);

        if (leg1Trains.length > 0 && leg2Buses.length > 0) {
          const originDist = getDistance(locFrom.latitude, locFrom.longitude, sStation.latitude, sStation.longitude);
          const originLeg = buildOriginLeg(locFrom, sStation);
          if (originDist > 2.5 && !originLeg) continue;

          const destDist = getDistance(dBus.latitude, dBus.longitude, locTo.latitude, locTo.longitude);
          const destLeg = buildDestLeg(dBus, locTo);
          if (destDist > 2.5 && !destLeg) continue;

          const trainSeg = leg1Trains[0];
          const hubTransfer = getPhysicalHubTransfer(junc.name, junc.bus);
          const transferLeg = {
            mode: hubTransfer?.mode || 'bus',
            provider: 'Junction Shuttle',
            from: junc.name,
            to: junc.bus,
            durationMinutes: hubTransfer?.duration_minutes || 10,
            distanceKm: hubTransfer?.distance_km || 1.5,
            price: (hubTransfer?.price || 15) * passengers
          };
          const busSeg = leg2Buses[0];

          const segments = [originLeg, trainSeg, transferLeg, busSeg, destLeg].filter(Boolean);
          const totalDist = Math.round(segments.reduce((sum, s) => sum + s.distanceKm, 0) * 10) / 10;
          if (directDist > 15 && totalDist > Math.max(directDist * 2.0, directDist + 50)) continue;

          const totalDur = segments.reduce((sum, s) => sum + s.durationMinutes, 0) + 25;
          const totalPrice = segments.reduce((sum, s) => sum + s.price, 0);

          candidateRoutes.push({
            id: `train-bus-${Date.now()}-${Math.random().toString(36).substring(7)}`,
            from: locFrom.name,
            to: locTo.name,
            routeName: 'Train + Bus',
            totalPrice,
            totalDurationMinutes: totalDur,
            totalTransfers: Math.max(0, segments.length - 1),
            distanceKm: totalDist,
            tag: null,
            segments
          });
        }
      }
    }
  }

  // OPTION 4: Direct Trains / Direct Buses
  const directTrains = findDirectTrains(locFrom.name, locTo.name, passengers);
  for (const t of directTrains) {
    candidateRoutes.push({
      id: `direct-train-${t.trainNumber}-${Date.now()}`,
      from: locFrom.name,
      to: locTo.name,
      routeName: 'Train Only',
      totalPrice: t.price,
      totalDurationMinutes: t.durationMinutes,
      totalTransfers: 0,
      distanceKm: t.distanceKm,
      tag: null,
      segments: [t]
    });
  }

  const directBuses = findDirectBusRoutes(locFrom.name, locTo.name, passengers);
  for (const b of directBuses) {
    candidateRoutes.push({
      id: `direct-bus-${b.routeNumber || 'exp'}-${Date.now()}`,
      from: locFrom.name,
      to: locTo.name,
      routeName: 'Bus Only',
      totalPrice: b.price,
      totalDurationMinutes: b.durationMinutes,
      totalTransfers: 0,
      distanceKm: b.distanceKm,
      tag: null,
      segments: [b]
    });
  }

  // OPTION 4B: Multi-Stage Connecting Bus Routes (Requirement 2: Village A -> Bus -> Village B -> Bus -> Town C -> Bus -> City D)
  const multiStageBuses = findMultiStageBusRoutes(locFrom.name, locTo.name, passengers);
  for (const msb of multiStageBuses) {
    candidateRoutes.push({
      id: `multi-stage-bus-${Date.now()}-${Math.random().toString(36).substring(7)}`,
      from: locFrom.name,
      to: locTo.name,
      routeName: msb.routeName,
      totalPrice: msb.totalPrice,
      totalDurationMinutes: msb.totalDurationMinutes,
      totalTransfers: msb.totalTransfers,
      distanceKm: msb.distanceKm,
      tag: null,
      segments: msb.segments,
      transfers: msb.transfers
    });
  }

  // OPTION 5: Connecting Trains (Train + Train via Junction)
  for (const sStation of startStations) {
    for (const dStation of destStations) {
      const connecting = findConnectingTrains(sStation.name, dStation.name, passengers, date);
      for (const conn of connecting) {
        const originDist = getDistance(locFrom.latitude, locFrom.longitude, sStation.latitude, sStation.longitude);
        const originLeg = buildOriginLeg(locFrom, sStation);
        if (originDist > 2.5 && !originLeg) continue;

        const destDist = getDistance(dStation.latitude, dStation.longitude, locTo.latitude, locTo.longitude);
        const destLeg = buildDestLeg(dStation, locTo);
        if (destDist > 2.5 && !destLeg) continue;

        const leg1 = conn.segments ? conn.segments[0] : conn.leg1;
        const leg2 = conn.segments ? conn.segments[1] : conn.leg2;
        if (!leg1 || !leg2) continue;

        const segments = [originLeg, leg1, leg2, destLeg].filter(Boolean);
        const totalDist = Math.round(segments.reduce((sum, s) => sum + s.distanceKm, 0) * 10) / 10;
        if (directDist > 15 && totalDist > Math.max(directDist * 2.2, directDist + 60)) continue;

        const totalDur = segments.reduce((sum, s) => sum + s.durationMinutes, 0) + (conn.layoverMinutes || 25);
        const totalPrice = segments.reduce((sum, s) => sum + s.price, 0);

        candidateRoutes.push({
          id: `train-transfer-${Date.now()}-${Math.random().toString(36).substring(7)}`,
          from: locFrom.name,
          to: locTo.name,
          routeName: 'Train + Train',
          totalPrice,
          totalDurationMinutes: totalDur,
          totalTransfers: Math.max(0, segments.length - 1),
          distanceKm: totalDist,
          tag: null,
          segments
        });
      }
    }
  }

  // OPTION 6: Bus + Auto/Cab (Bus to major hub -> Auto/Cab directly to destination)
  if (directDist > 10.0 && directDist <= 60.0) {
    for (const sBus of startBusHubs) {
      for (const dBus of destBusHubs) {
        const directBuses = findDirectBusRoutes(sBus.name, dBus.name, passengers);
        if (directBuses.length > 0) {
          const autoDist = Math.round(getDistance(dBus.latitude, dBus.longitude, locTo.latitude, locTo.longitude) * 10) / 10;
          if (autoDist >= 1.5 && autoDist <= 15.0) {
            const originLeg = buildOriginLeg(locFrom, sBus);
            const busSeg = directBuses[0];
            const autoLeg = {
              mode: 'auto',
              provider: 'Local Auto / Cab',
              from: dBus.name,
              to: locTo.name,
              serviceName: 'Auto / Cab',
              durationMinutes: Math.max(10, Math.round(autoDist * 2.5)),
              distanceKm: autoDist,
              price: Math.max(40, Math.round(25 + autoDist * 10))
            };

            const segments = [originLeg, busSeg, autoLeg].filter(Boolean);
            const totalDur = segments.reduce((sum, s) => sum + s.durationMinutes, 0) + 15;
            const totalPrice = segments.reduce((sum, s) => sum + s.price, 0);
            const totalDist = Math.round(segments.reduce((sum, s) => sum + s.distanceKm, 0) * 10) / 10;

            candidateRoutes.push({
              id: `bus-auto-${Date.now()}-${Math.random().toString(36).substring(7)}`,
              from: locFrom.name,
              to: locTo.name,
              routeName: 'Bus + Auto/Cab',
              totalPrice,
              totalDurationMinutes: totalDur,
              totalTransfers: Math.max(0, segments.length - 1),
              distanceKm: totalDist,
              tag: null,
              segments
            });
          }
        }
      }
    }
  }

  // GPS Direct ride options (Uber & Rapido) ONLY when From is explicitly Current GPS Location
  if (isCurrentGpsOrigin && rideHailingEnabled && directDist <= 85.0) {
    candidateRoutes.push(...createGpsRideOptions(locFrom.name, locTo.name, directDist));
  }

  // Feeder connections with Uber / Rapido from Current GPS Location (development-only; off by default)
  if (isCurrentGpsOrigin && rideHailingEnabled) {
    const primaryStation = startStations[0];
    if (primaryStation) {
      const distToStation = getDistance(locFrom.latitude, locFrom.longitude, primaryStation.latitude, primaryStation.longitude);
      if (distToStation >= 0.8 && distToStation <= 25.0) {
        for (const dStation of destStations) {
          const directTrains = findDirectTrains(primaryStation.name, dStation.name, passengers, date);
          if (directTrains && directTrains.length > 0) {
            const trainLeg = directTrains[0];
            const destLeg = buildDestLeg(dStation, locTo);
            const uberPrice = Math.max(60, Math.round(distToStation * 14 + 40));
            const uberDur = Math.max(8, Math.round(distToStation * 2.0));
            const uberLeg = {
              mode: 'uber',
              provider: 'Uber',
              serviceName: distToStation > 15 ? 'Uber Intercity' : 'Uber Auto / Cab',
              from: locFrom.name,
              to: primaryStation.name,
              durationMinutes: uberDur,
              distanceKm: Math.round(distToStation * 10) / 10,
              price: uberPrice
            };
            const segs = [uberLeg, trainLeg, destLeg].filter(Boolean);
            candidateRoutes.push({
              id: `gps-uber-train-${Date.now()}-${Math.random().toString(36).substring(7)}`,
              from: locFrom.name,
              to: locTo.name,
              routeName: 'Uber + Train',
              totalPrice: segs.reduce((sum, s) => sum + s.price, 0),
              totalDurationMinutes: segs.reduce((sum, s) => sum + s.durationMinutes, 0) + 15,
              totalTransfers: Math.max(0, segs.length - 1),
              distanceKm: Math.round(segs.reduce((sum, s) => sum + s.distanceKm, 0) * 10) / 10,
              tag: null,
              segments: segs
            });
            break;
          }
        }
      }
    }

    const primaryBusHub = startBusHubs[0];
    if (primaryBusHub) {
      const distToBus = getDistance(locFrom.latitude, locFrom.longitude, primaryBusHub.latitude, primaryBusHub.longitude);
      if (distToBus >= 0.8 && distToBus <= 20.0) {
        for (const dBus of destBusHubs) {
          const directBuses = findDirectBusRoutes(primaryBusHub.name, dBus.name, passengers);
          if (directBuses && directBuses.length > 0) {
            const busLeg = directBuses[0];
            const destLeg = buildDestLeg(dBus, locTo);
            const rapidoPrice = Math.max(35, Math.round(distToBus * 8 + 20));
            const rapidoDur = Math.max(6, Math.round(distToBus * 1.8));
            const rapidoLeg = {
              mode: 'rapido',
              provider: 'Rapido',
              serviceName: distToBus > 15 ? 'Rapido Outstation' : 'Rapido Bike / Auto',
              from: locFrom.name,
              to: primaryBusHub.name,
              durationMinutes: rapidoDur,
              distanceKm: Math.round(distToBus * 10) / 10,
              price: rapidoPrice
            };
            const segs = [rapidoLeg, busLeg, destLeg].filter(Boolean);
            candidateRoutes.push({
              id: `gps-rapido-bus-${Date.now()}-${Math.random().toString(36).substring(7)}`,
              from: locFrom.name,
              to: locTo.name,
              routeName: 'Rapido + Bus',
              totalPrice: segs.reduce((sum, s) => sum + s.price, 0),
              totalDurationMinutes: segs.reduce((sum, s) => sum + s.durationMinutes, 0) + 10,
              totalTransfers: Math.max(0, segs.length - 1),
              distanceKm: Math.round(segs.reduce((sum, s) => sum + s.distanceKm, 0) * 10) / 10,
              tag: null,
              segments: segs
            });
            break;
          }
        }
      }
    }
  }

  // Multi-Modal Air Travel Options (Only for long-distance journeys >= 350 km)
  if (directDist >= 350) {
    try {
      const airJourneys = await buildCompleteAirJourneys(fromCity, toCity, date, isCurrentGpsOrigin ? originCoordinates : null, passengers);
      if (airJourneys && airJourneys.length > 0) {
        candidateRoutes.push(...airJourneys);
      }
    } catch (err) {
      console.warn('Air journeys calculation warning:', err.message);
    }
  }

  // 6. Enrich all routes with comprehensive details, transfer steps, and facility metadata
  candidateRoutes = candidateRoutes.map(r => enrichRouteDetails(r, locFrom, locTo, villageAssistance));

  // 7. Strict Rule Filters:
  // Walking filter: Single-segment walking journey allowed only if distance <= 2.0 km
  // Access / transfer walking legs allowed up to 2.5 km (so "Walk 1.2 km" is fully supported)
  // Discard routes with walking legs > 2.5 km
  candidateRoutes = candidateRoutes.filter(r => {
    const isSingleWalk = r.segments.length === 1 && r.segments[0].mode === 'walking';
    if (isSingleWalk && r.segments[0].distanceKm > 2.0) return false;
    if (r.segments.some(s => s.mode === 'walking' && s.distanceKm > 2.5)) return false;
    return true;
  });

  // Strict Location-Based Filter (Requirement 4):
  // IF fromLocation.type == "CURRENT_GPS_LOCATION" THEN Allow Uber/Rapido ELSE Hide Uber/Rapido
  if (!isCurrentGpsOrigin) {
    candidateRoutes = candidateRoutes.filter(
      r => !r.segments.some(s => s.mode === 'uber' || s.mode === 'rapido')
    );
  }

  // Data Pipeline Integrity Validation (Requirement 8)
  candidateRoutes = candidateRoutes.filter(r => validateRouteIntegrity(r, locFrom, locTo));

  // 8. Deduplication by Transit Backbone (eliminates identical intercity services wrapped in redundant local walking loops)
  const backboneMap = new Map();
  for (const r of candidateRoutes) {
    const mainTransit = r.segments.filter(s => s.mode !== 'walking');
    const backboneSig = mainTransit.map(s => {
      const modeKey = s.mode;
      const idKey = s.trainNumber || s.routeNumber || s.serviceName || s.provider || '';
      const fromKey = normalizePlaceKey(s.from).replace(/\s*(bus\s*(station|stand|stop)|railway\s*station|station|junction)/gi, '').trim();
      const toKey = normalizePlaceKey(s.to).replace(/\s*(bus\s*(station|stand|stop)|railway\s*station|station|junction)/gi, '').trim();
      return `${modeKey}:${idKey}:${fromKey}->${toKey}`;
    }).join('|');

    if (!backboneMap.has(backboneSig)) {
      backboneMap.set(backboneSig, r);
    } else {
      const existing = backboneMap.get(backboneSig);
      // Keep the cleaner, faster, or direct route
      if (r.totalTransfers < existing.totalTransfers ||
          (r.totalTransfers === existing.totalTransfers && r.totalDurationMinutes < existing.totalDurationMinutes) ||
          (r.totalTransfers === existing.totalTransfers && r.totalDurationMinutes === existing.totalDurationMinutes && (r.walkingDistanceKm || 0) < (existing.walkingDistanceKm || 0))) {
        backboneMap.set(backboneSig, r);
      }
    }
  }

  let uniqueRoutes = Array.from(backboneMap.values());

  // Estimated ride-hailing options (Uber/Rapido) are formula-based, not provider-backed. They never take part
  // in trusted comparisons (outlier pruning, fastest / budget / best tagging) and are listed after the
  // timetable-backed routes. Without ride-hailing options this is identical to ranking every route.
  const trustedRoutes = () => uniqueRoutes.filter(r => !isRideHailingRoute(r));

  // 9. Prune inferior detour outliers when direct options exist
  if (trustedRoutes().length > 0) {
    const minDur = Math.min(...trustedRoutes().map(r => r.totalDurationMinutes));
    const minPrice = Math.min(...trustedRoutes().map(r => r.totalPrice));

    uniqueRoutes = uniqueRoutes.filter(r => {
      if (isRideHailingRoute(r)) return true;
      if (r.totalDurationMinutes > minDur * 2.2 && r.totalPrice > minPrice * 2.0) {
        return false;
      }
      return true;
    });
  }

  // 10. Scoring & Tagging (trusted routes only)
  const rankable = trustedRoutes();
  if (rankable.length > 0) {
    let minPrice = Math.min(...rankable.map(r => r.totalPrice));
    let minDur = Math.min(...rankable.map(r => r.totalDurationMinutes));
    let maxPrice = Math.max(...rankable.map(r => r.totalPrice));
    let maxDur = Math.max(...rankable.map(r => r.totalDurationMinutes));

    for (const r of rankable) {
      r.isFastest = (r.totalDurationMinutes === minDur);
      r.isBudget = (r.totalPrice === minPrice);

      if (r.isFastest && r.isBudget) r.tag = 'budget';
      else if (r.isFastest) r.tag = 'fastest';
      else if (r.isBudget) r.tag = 'budget';
      else {
        const normPrice = maxPrice === minPrice ? 0 : (r.totalPrice - minPrice) / (maxPrice - minPrice);
        const normDur = maxDur === minDur ? 0 : (r.totalDurationMinutes - minDur) / (maxDur - minDur);
        r.score = normPrice * 0.45 + normDur * 0.45 + (r.totalTransfers * 0.1);
      }
    }

    const nonTagged = rankable.filter(r => !r.tag).sort((a, b) => (a.score || 0) - (b.score || 0));
    if (nonTagged[0]) {
      nonTagged[0].tag = 'best';
    }
  }

  // Estimated ride-hailing routes never carry trusted ranking tags, even when no timetable route exists.
  for (const r of uniqueRoutes) {
    if (isRideHailingRoute(r)) {
      r.tag = null;
      r.isFastest = false;
      r.isBudget = false;
    }
  }

  // 11. Prioritize distinct optimum routes: fastest first, budget second, best third, followed by diverse modes
  //     (estimated ride-hailing always after timetable-backed routes)
  uniqueRoutes.sort((a, b) => {
    const aRide = isRideHailingRoute(a);
    const bRide = isRideHailingRoute(b);
    if (aRide !== bRide) return aRide ? 1 : -1;
    const order = { fastest: 1, budget: 2, best: 3 };
    const aOrder = order[a.tag] || 4;
    const bOrder = order[b.tag] || 4;
    if (aOrder !== bOrder) return aOrder - bOrder;
    return a.totalDurationMinutes - b.totalDurationMinutes;
  });

  // Limit to at most 6-8 distinct, optimum routes. For GPS origins the standalone ride-hailing estimates are
  // always kept (they are the only door-to-door option) but placed AFTER the timetable-backed routes, never
  // promoted above them.
  const isStandaloneRide = r => r.segments.length === 1 && isRideHailingRoute(r);
  const selectedRoutes = isCurrentGpsOrigin
    ? [
        ...uniqueRoutes.filter(r => !isStandaloneRide(r)).slice(0, 7),
        ...uniqueRoutes.filter(isStandaloneRide)
      ]
    : uniqueRoutes.slice(0, 8);

  // 12. Final Clean Route Numbering (Route 1 – ..., Route 2 – ..., Route 3 – ...), in display order
  const finalRoutes = selectedRoutes.map((r, rIdx) => {
    let title = (r.routeName || 'Multi-Modal Route').replace(/^Route\s+\d+\s*–\s*/i, '');
    title = `Route ${rIdx + 1} – ${title}`;
    return {
      ...r,
      routeName: title
    };
  });

  return finalRoutes;
}

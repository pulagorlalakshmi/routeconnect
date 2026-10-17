// Legacy train lookups over hand-written sample data (STATIC_TRAIN_SERVICES and seeded `segments` rows).
// That data is NOT a verified timetable, so both lookups are disabled (see trainDataPolicy.js) and return no trains.

import { STATIC_TRAIN_SERVICES } from '../db/staticTransitData.js';
import { db } from '../db/database.js';
import { normalizePlaceKey, getDistance } from './geoService.js';
import { LEGACY_TRAIN_DATA_ENABLED } from './trainDataPolicy.js';

function matchStation(stationName, candidateStr) {
  if (!stationName || !candidateStr) return false;
  const s1 = normalizePlaceKey(stationName);
  const s2 = normalizePlaceKey(candidateStr);
  if (s1 === s2) return true;
  if (s1.length >= 4 && s2.length >= 4) {
    return s1.includes(s2) || s2.includes(s1);
  }
  return false;
}

export function findDirectTrains(fromStationName, toStationName, passengers = 1) {
  if (!LEGACY_TRAIN_DATA_ENABLED) return [];
  const directOptions = [];
  const normFrom = normalizePlaceKey(fromStationName);
  const normTo = normalizePlaceKey(toStationName);

  // 1. Search authoritative train timetable halts
  for (const train of STATIC_TRAIN_SERVICES) {
    let fromIdx = -1;
    let toIdx = -1;

    for (let i = 0; i < train.halts.length; i++) {
      const halt = train.halts[i];
      if (fromIdx === -1 && (matchStation(halt.station, normFrom) || (halt.code && halt.code.toLowerCase() === normFrom))) {
        fromIdx = i;
      }
      if (fromIdx !== -1 && i > fromIdx && (matchStation(halt.station, normTo) || (halt.code && halt.code.toLowerCase() === normTo))) {
        toIdx = i;
        break;
      }
    }

    if (fromIdx !== -1 && toIdx !== -1) {
      const startHalt = train.halts[fromIdx];
      const endHalt = train.halts[toIdx];
      const intermediateHalts = train.halts.slice(fromIdx + 1, toIdx).map(h => h.station);

      const distanceKm = Math.max(10, Math.round((endHalt.distanceKm - startHalt.distanceKm) * 10) / 10);
      const depTime = startHalt.dep || startHalt.arr || '08:00';
      const arrTime = endHalt.arr || endHalt.dep || '12:00';

      const durMinutes = calculateDuration(depTime, arrTime);
      const baseFare = train.baseFares?.['2S'] || Math.max(40, Math.round(distanceKm * 0.95));

      directOptions.push({
        mode: 'train',
        provider: 'Indian Railways',
        from: startHalt.station,
        to: endHalt.station,
        trainNumber: train.trainNumber,
        trainName: train.trainName,
        runningDays: train.runningDays,
        classes: train.classes || ['2S', 'SL', '3A'],
        departure: depTime,
        arrival: arrTime,
        durationMinutes: durMinutes,
        distanceKm,
        price: baseFare * passengers,
        stops: intermediateHalts.join(', ') || 'Direct non-stop halt',
        estimated: false,
        fareAvailable: true
      });
    }
  }

  // 2. Also check segments table for seeded intercity train links
  const segs = db.prepare(`
    SELECT * FROM segments
    WHERE mode = 'train' AND (LOWER(from_location) LIKE ? OR LOWER(from_location) LIKE ?)
      AND (LOWER(to_location) LIKE ? OR LOWER(to_location) LIKE ?)
  `).all(`%${normFrom}%`, normFrom, `%${normTo}%`, normTo);

  for (const s of segs) {
    if (!directOptions.some(d => d.trainNumber === s.train_number)) {
      directOptions.push({
        mode: 'train',
        provider: s.operator || 'Indian Railways',
        from: s.from_location,
        to: s.to_location,
        trainNumber: s.train_number || '12727',
        trainName: s.train_name || 'Godavari Express',
        runningDays: 'Daily',
        classes: ['2S', 'SL'],
        departure: s.departure_time || '16:10',
        arrival: s.arrival_time || '18:35',
        durationMinutes: s.duration_minutes,
        distanceKm: s.distance_km,
        price: s.price * passengers,
        stops: s.stops || null,
        estimated: false,
        fareAvailable: true
      });
    }
  }

  return directOptions;
}

export function isTrainRunningOnDate(train, dateStr) {
  if (!train.runningDays || train.runningDays === 'Daily') return true;
  if (!dateStr) return true;
  const date = new Date(dateStr);
  if (isNaN(date.getTime())) return true;
  const dayNames = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  const dayName = dayNames[date.getDay()];
  const runningDaysList = train.runningDays.split(',').map(d => d.trim().toLowerCase());
  return runningDaysList.includes(dayName.toLowerCase());
}

export function findConnectingTrains(fromStationName, toStationName, passengers = 1, travelDate = null) {
  if (!LEGACY_TRAIN_DATA_ENABLED) return [];
  // Major junction transfer hubs & candidate rail junction points
  const candidateJunctions = [
    { name: 'Vijayawada Railway Station', code: 'BZA' },
    { name: 'Visakhapatnam Railway Station', code: 'VSKP' },
    { name: 'Tenali Railway Station', code: 'TEL' },
    { name: 'Guntur Railway Station', code: 'GNT' },
    { name: 'Rajahmundry Railway Station', code: 'RJY' },
    { name: 'Samalkot', code: 'SLO' },
    { name: 'Gudivada Railway Station', code: 'GDV' },
    { name: 'Bhimavaram Junction', code: 'BVRM' },
    { name: 'Nidadavolu', code: 'NDD' },
    { name: 'Railway Station D', code: 'RSD' },
    { name: 'Town C Railway Station', code: 'TWNC' },
    { name: 'Town X Railway Station', code: 'TWNX' }
  ];

  const normFrom = normalizePlaceKey(fromStationName);
  const normTo = normalizePlaceKey(toStationName);
  const connections = [];
  const seenJunctions = new Set();

  for (const junction of candidateJunctions) {
    if (matchStation(junction.name, normFrom) || matchStation(junction.name, normTo)) {
      continue;
    }

    const jKey = junction.name.toLowerCase();
    if (seenJunctions.has(jKey)) continue;

    const leg1Trains = findDirectTrains(fromStationName, junction.name, passengers);
    const leg2Trains = findDirectTrains(junction.name, toStationName, passengers);

    if (leg1Trains.length > 0 && leg2Trains.length > 0) {
      seenJunctions.add(jKey);
      const leg1 = leg1Trains[0];
      const leg2 = leg2Trains[0];

      // Verify date operating schedules if travelDate provided
      if (travelDate && (!isTrainRunningOnDate(leg1, travelDate) || !isTrainRunningOnDate(leg2, travelDate))) {
        continue;
      }

      // Compute layover buffer
      const layoverMinutes = 25;
      const totalDur = leg1.durationMinutes + layoverMinutes + leg2.durationMinutes;
      const totalDist = Math.round((leg1.distanceKm + leg2.distanceKm) * 10) / 10;
      const totalPrice = leg1.price + leg2.price;

      connections.push({
        routeType: 'connecting_trains',
        routeName: `Route – Connecting Trains via ${junction.name}`,
        from: fromStationName,
        to: toStationName,
        transferStation: junction.name,
        layoverMinutes,
        totalDurationMinutes: totalDur,
        totalPrice,
        distanceKm: totalDist,
        totalTransfers: 1,
        segments: [
          { ...leg1, layoverMinutes: null },
          { ...leg2, layoverMinutes }
        ],
        transfers: [
          {
            transferNumber: 1,
            location: junction.name,
            fromMode: 'train',
            toMode: 'train',
            nextBoardingPoint: junction.name,
            transferMode: 'platform_transfer',
            transferDistanceKm: 0.2,
            transferDurationMinutes: 10,
            transferPrice: 0,
            instruction: `Get down at ${junction.name} from Train #${leg1.trainNumber} (${leg1.trainName}). Change platforms and board connecting Train #${leg2.trainNumber} (${leg2.trainName}) towards ${toStationName}.`,
            layoverMinutes
          }
        ]
      });
    }
  }

  return connections;
}

function calculateDuration(depTime, arrTime) {
  const [depH, depM] = (depTime || '00:00').split(':').map(Number);
  const [arrH, arrM] = (arrTime || '00:00').split(':').map(Number);
  let depTotal = depH * 60 + depM;
  let arrTotal = arrH * 60 + arrM;
  if (arrTotal < depTotal) arrTotal += 24 * 60; // Next day arrival
  return Math.max(15, arrTotal - depTotal);
}

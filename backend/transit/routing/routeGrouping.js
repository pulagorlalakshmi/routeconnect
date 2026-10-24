// Route grouping logic for backend journey planning and API responses.
// Groups journeys following the same actual route (same ordered stops, boarding and
// dropping points, and travel modes) and collects all valid departure times.

function normalize(text) {
  if (!text) return '';
  return String(text).trim().toLowerCase().replace(/\s+/g, ' ');
}

function normalizePlace(place) {
  if (!place) return '';
  if (place.stopId) return normalize(place.stopId);
  if (place.code) return normalize(place.code);
  if (place.name) return normalize(place.name);
  if (place.type) return normalize(place.type);
  return '';
}

function normalizeRouteId(leg) {
  const raw = leg.routeId || leg.routeCode || leg.serviceNumber || leg.trainNumber || leg.flightNumber || '';
  const cleaned = normalize(raw);
  const withoutZeros = cleaned.replace(/^0+/, '');
  return withoutZeros || cleaned;
}

function normalizeMode(mode) {
  const m = normalize(mode);
  if (/rail|train|subway|metro|tram/.test(m)) return 'train';
  if (/air|flight/.test(m)) return 'flight';
  if (/bus/.test(m)) return 'bus';
  return m;
}

export function computeRouteSignature(journey) {
  if (!journey || !Array.isArray(journey.legs) || journey.legs.length === 0) {
    return journey?.id || 'empty_journey';
  }

  const parts = journey.legs.map(leg => {
    if (leg.mode === 'walk') {
      const from = normalizePlace(leg.from);
      const to = normalizePlace(leg.to);
      return `walk:${leg.kind}:${from}->${to}`;
    }

    if (leg.mode === 'local_ride') {
      const from = normalizePlace(leg.from);
      const to = normalizePlace(leg.to);
      return `ride:${leg.kind}:${from}->${to}`;
    }

    // Transit leg (bus, train, flight)
    const mode = normalizeMode(leg.mode);
    const routeId = normalizeRouteId(leg);
    const fromStop = normalizePlace(leg.fromStop);
    const toStop = normalizePlace(leg.toStop);
    const op = normalize(leg.operatorInfo?.name || leg.operator || '');

    let stopsPart = '';
    if (Array.isArray(leg.intermediateStops) && leg.intermediateStops.length > 0) {
      stopsPart = leg.intermediateStops.map(s => normalize(s)).join('>');
    } else {
      stopsPart = `count:${leg.intermediateStopCount ?? 0}`;
    }

    return `${mode}:${routeId}:${fromStop}->${toStop}:stops[${stopsPart}]:op[${op}]`;
  });

  return parts.join('||');
}

export function isSameRoute(a, b) {
  return computeRouteSignature(a) === computeRouteSignature(b);
}

/**
 * Attaches matching candidate trips to shortlisted journeys as `journey.departureOptions`.
 */
export function attachCandidateDepartures(shortlistedJourneys, allCandidates = []) {
  if (!Array.isArray(shortlistedJourneys) || shortlistedJourneys.length === 0) return shortlistedJourneys;

  // Build candidate options by signature
  const candidatesBySig = new Map();
  for (const candidate of allCandidates) {
    const sig = computeRouteSignature(candidate);
    if (!candidatesBySig.has(sig)) candidatesBySig.set(sig, []);
    candidatesBySig.get(sig).push(candidate);
  }

  for (const journey of shortlistedJourneys) {
    const sig = computeRouteSignature(journey);
    const matching = candidatesBySig.get(sig) || [];

    const options = [];
    const seenTimes = new Set();

    const addOption = (j) => {
      const mainTrip = j.legs?.find(l => l.mode !== 'walk' && l.mode !== 'local_ride')?.tripId || j.id;
      const key = `${j.departureTime}@${mainTrip}`;
      if (!seenTimes.has(key)) {
        seenTimes.add(key);
        options.push({
          tripId: mainTrip,
          departureTime: j.departureTime,
          arrivalTime: j.arrivalTime,
          durationSeconds: j.totalDurationSeconds
        });
      }
    };

    // Always include the journey itself
    addOption(journey);

    // Also include any other matching candidate departures
    for (const match of matching) {
      addOption(match);
    }

    // Sort chronologically
    options.sort((a, b) => {
      const timeDiff = new Date(a.departureTime).getTime() - new Date(b.departureTime).getTime();
      if (timeDiff !== 0) return timeDiff;
      return a.departureTime.localeCompare(b.departureTime);
    });

    journey.departureOptions = options;
  }

  return shortlistedJourneys;
}

export function groupJourneysByRoute(journeys) {
  if (!Array.isArray(journeys) || journeys.length === 0) return [];

  const groups = new Map();

  for (const journey of journeys) {
    const sig = computeRouteSignature(journey);

    const options = [];
    if (Array.isArray(journey.departureOptions) && journey.departureOptions.length > 0) {
      options.push(...journey.departureOptions);
    }
    const mainTrip = journey.legs?.find(l => l.mode !== 'walk' && l.mode !== 'local_ride')?.tripId || journey.id;
    options.push({
      tripId: mainTrip,
      departureTime: journey.departureTime,
      arrivalTime: journey.arrivalTime,
      durationSeconds: journey.totalDurationSeconds,
      journey
    });

    if (!groups.has(sig)) {
      groups.set(sig, {
        id: `route_${journey.id}`,
        signature: sig,
        representativeJourney: journey,
        departures: [...options]
      });
    } else {
      const existing = groups.get(sig);
      existing.departures.push(...options);
      for (const label of journey.labels || []) {
        if (!existing.representativeJourney.labels.includes(label)) {
          existing.representativeJourney.labels.push(label);
        }
      }
      const curScore = existing.representativeJourney.rating?.raw ?? existing.representativeJourney.rating?.score ?? -1;
      const candScore = journey.rating?.raw ?? journey.rating?.score ?? -1;
      if (candScore > curScore) {
        existing.representativeJourney = journey;
      }
    }
  }

  const result = Array.from(groups.values());
  for (const group of result) {
    const seen = new Set();
    const unique = [];
    for (const dep of group.departures) {
      const key = `${dep.departureTime}@${dep.tripId}`;
      if (!seen.has(key)) {
        seen.add(key);
        unique.push(dep);
      }
    }
    unique.sort((a, b) => {
      const diff = new Date(a.departureTime).getTime() - new Date(b.departureTime).getTime();
      return diff !== 0 ? diff : a.departureTime.localeCompare(b.departureTime);
    });
    group.departures = unique;
    group.representativeJourney.departureOptions = unique;
  }

  return result;
}

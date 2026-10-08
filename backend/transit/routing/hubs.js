// Hub quality, derived from the timetable network itself (nothing about any town is hardcoded), plus static connectivity.
//
//   getHubMetrics(network)   -> per-stop { routes, trips, onward, neighbours } and strength in 0..1 (cached per network)
//   hubScore(strength, n)    -> reusable score: usable services in the search window, weighted by the stop's network strength
//   getConnectivity(network) -> connected-component id per stop (ignoring time, direction and calendar), cached per network
//
// "strength" is the mean percentile rank of four signals over all stops that have service:
//   routes      distinct routes calling at the stop
//   trips       scheduled trips calling at the stop (all service days; a size signal, not a per-day count)
//   onward      distinct stops reachable on a direct trip from this stop (onward connectivity)
//   neighbours  walkable transfer partners (transfer connectivity)
// Percentile ranks make the score scale-free: it works on a state-wide network and on a single-town feed alike.
const metricsCache = new WeakMap();
const connectivityCache = new WeakMap();

function percentileRanks(values, served) {
  // mid-rank percentile among served stops, so ties do not unfairly favour either side
  const sorted = served.map(s => values[s]).sort((a, b) => a - b);
  const lowerBound = target => { let lo = 0, hi = sorted.length; while (lo < hi) { const mid = (lo + hi) >> 1; if (sorted[mid] < target) lo = mid + 1; else hi = mid; } return lo; };
  const upperBound = target => { let lo = 0, hi = sorted.length; while (lo < hi) { const mid = (lo + hi) >> 1; if (sorted[mid] <= target) lo = mid + 1; else hi = mid; } return lo; };
  const ranks = new Float64Array(values.length);
  for (const s of served) ranks[s] = sorted.length > 1 ? ((lowerBound(values[s]) + upperBound(values[s])) / 2) / sorted.length : 1;
  return ranks;
}

export function getHubMetrics(network) {
  const cached = metricsCache.get(network);
  if (cached) return cached;

  const n = network.stopCount;
  const routes = new Int32Array(n), trips = new Float64Array(n), onward = new Int32Array(n), neighbours = new Int32Array(n);
  const routeSets = new Array(n), onwardSets = new Array(n);
  const served = [];

  network.patterns.forEach(pattern => {
    for (let i = 0; i < pattern.n; i++) {
      const stop = pattern.stops[i];
      (routeSets[stop] ??= new Set()).add(pattern.routeIdx);
      trips[stop] += pattern.tripCount;
      if (pattern.pickup.some(flag => flag === 1) && pattern.pickup[i] === 1) {
        const set = (onwardSets[stop] ??= new Set());
        for (let j = i + 1; j < pattern.n; j++) if (pattern.dropOff[j] === 1) set.add(pattern.stops[j]);
      }
    }
  });
  for (let s = 0; s < n; s++) {
    if (!routeSets[s]) continue;
    served.push(s);
    routes[s] = routeSets[s].size;
    onward[s] = onwardSets[s]?.size ?? 0;
    neighbours[s] = network.footOffsets[s + 1] - network.footOffsets[s];
  }

  const rRoutes = percentileRanks(routes, served), rTrips = percentileRanks(trips, served);
  const rOnward = percentileRanks(onward, served), rNeighbours = percentileRanks(neighbours, served);
  const strength = new Float64Array(n);
  for (const s of served) strength[s] = (rRoutes[s] + rTrips[s] + rOnward[s] + rNeighbours[s]) / 4;

  const metrics = { routes, trips, onward, neighbours, strength, served: Int32Array.from(served), isServed: stop => routeSets[stop] !== undefined };
  metricsCache.set(network, metrics);
  return metrics;
}

// The reusable score: how many usable services the stop has in the window, scaled by how well-connected the stop is.
export const hubScore = (strength, servicesInWindow) => servicesInWindow * (0.5 + strength);

export function getConnectivity(network) {
  const cached = connectivityCache.get(network);
  if (cached) return cached;

  const parent = new Int32Array(network.stopCount).map((_, i) => i);
  const find = x => { while (parent[x] !== x) { parent[x] = parent[parent[x]]; x = parent[x]; } return x; };
  const union = (a, b) => { const ra = find(a), rb = find(b); if (ra !== rb) parent[Math.max(ra, rb)] = Math.min(ra, rb); };
  for (const pattern of network.patterns) for (let i = 1; i < pattern.n; i++) union(pattern.stops[i - 1], pattern.stops[i]);
  for (let s = 0; s < network.stopCount; s++) for (let e = network.footOffsets[s]; e < network.footOffsets[s + 1]; e++) union(s, network.footTo[e]);

  const component = new Int32Array(network.stopCount);
  for (let s = 0; s < network.stopCount; s++) component[s] = find(s);
  const connectivity = { component };
  connectivityCache.set(network, connectivity);
  return connectivity;
}

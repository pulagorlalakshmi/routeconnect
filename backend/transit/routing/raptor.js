// RAPTOR (Round-bAsed Public Transit Optimized Router), Delling/Pajor/Werneck.
//
// Round k computes, for every stop, the earliest arrival using at most k transit trips. Rounds therefore map
// directly to transfers (k trips = k-1 transfers). Each round:
//   1. collects the patterns ("routes") that serve a stop improved in the previous round, remembering the
//      earliest improved position along each pattern;
//   2. scans each such pattern once, tracking the current best trip: it alights (improving arrival labels) and
//      re-boards an earlier trip whenever the previous round allows it;
//   3. relaxes walking transfers from the stops improved by transit.
//
// This function is pure with respect to the network: it reads typed arrays only (no SQL, no I/O) and writes
// into a reusable workspace. Times are integer seconds from 00:00 local time of the query's anchor day and may
// be negative or exceed 86400 (service days D-1 / D+1 and GTFS times past 24:00:00).
import { INF, PARENT } from './types.js';

export function createWorkspace(network, rounds) {
  const S = network.stopCount;
  const perRound = (Type, fill) => Array.from({ length: rounds }, () => {
    const array = new Type(S);
    if (fill !== undefined) array.fill(fill);
    return array;
  });
  return {
    rounds,
    tau: perRound(Int32Array, INF),        // earliest arrival at the stop using <= k trips
    buffer: perRound(Int32Array, 0),       // extra seconds needed before boarding from this label
    pType: perRound(Uint8Array, 0),        // PARENT.* : how this label was produced
    pRound: perRound(Uint8Array, 0),       // the round in which the label was set (labels are copied forward)
    pPattern: perRound(Int32Array, -1),
    pTrip: perRound(Int32Array, -1),
    pOffIdx: perRound(Uint8Array, 0),      // index into request.serviceDays of the trip's service day
    pBoard: perRound(Int32Array, -1),      // boarding position within the pattern
    pAlight: perRound(Int32Array, -1),     // alighting position within the pattern
    pFrom: perRound(Int32Array, -1),       // origin stop of a walking transfer
    tauStar: new Int32Array(S),            // best arrival over all rounds (local pruning)
    inImproved: new Uint8Array(S),
    queuePos: new Int32Array(network.patternCount).fill(-1)
  };
}

const found = { trip: -1, offIdx: -1, dep: INF };

// Earliest trip of `pattern` that departs position `pos` at or after `ready`, over all candidate service days.
function findEarliestTrip(pattern, pos, ready, serviceDays, out) {
  out.trip = -1;
  out.offIdx = -1;
  out.dep = INF;
  const { n, dep, tripCount, service } = pattern;
  for (let d = 0; d < serviceDays.length; d++) {
    const day = serviceDays[d];
    const target = ready - day.offsetSeconds;
    // Trips are ordered and never overtake, so departures at a position are non-decreasing: binary search.
    let lo = 0;
    let hi = tripCount;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (dep[mid * n + pos] >= target) hi = mid;
      else lo = mid + 1;
    }
    for (let j = lo; j < tripCount; j++) {
      if (day.active[service[j]] === 1) {
        const absolute = dep[j * n + pos] + day.offsetSeconds;
        if (absolute < out.dep) {
          out.dep = absolute;
          out.trip = j;
          out.offIdx = d;
        }
        break;
      }
    }
  }
}

/**
 * @param {import('./types.js').Network} network
 * @param {Object} request
 * @param {{stopIdx:number, durationSeconds:number}[]} request.accessLegs   origin -> stop walks
 * @param {number} request.departureTime        seconds from anchor-day midnight when the traveller leaves the origin
 * @param {number} request.maxTransfers         rounds executed = maxTransfers + 1 (trips)
 * @param {{offsetSeconds:number, active:Uint8Array}[]} request.serviceDays
 * @param {Int32Array|null} request.egressSeconds   per stop: walking seconds to the destination, -1 if not a target
 * @param {number} request.horizonTime          ignore arrivals after this time
 * @param {number} [request.boardingBufferSeconds]
 * @param {Object} [workspace]
 */
export function runRaptor(network, request, workspace) {
  const { accessLegs, departureTime, maxTransfers, serviceDays, egressSeconds, horizonTime, boardingBufferSeconds = 0 } = request;
  const maxRounds = maxTransfers + 2; // round 0 = walking access, rounds 1..maxTransfers+1 = trips
  const ws = workspace ?? createWorkspace(network, maxRounds);
  if (ws.rounds < maxRounds) throw new Error('RAPTOR workspace has too few rounds for this request.');

  const { stopPatternOffsets, stopPatternPattern, stopPatternPos, footOffsets, footTo, footSeconds, patterns, minTransfer } = network;
  const { tau, buffer, pType, pRound, pPattern, pTrip, pOffIdx, pBoard, pAlight, pFrom, tauStar, inImproved, queuePos } = ws;
  const stats = { roundsExecuted: 0, patternsScanned: 0, stopsImproved: 0 };

  // ---- Round 0: walk from the origin to nearby stops ----
  tau[0].fill(INF);
  buffer[0].fill(0);
  pType[0].fill(PARENT.NONE);
  pRound[0].fill(0);
  tauStar.fill(INF);

  let marked = [];
  for (const leg of accessLegs) {
    const s = leg.stopIdx;
    const arrival = departureTime + leg.durationSeconds;
    if (arrival < tau[0][s] && arrival <= horizonTime) {
      tau[0][s] = arrival;
      tauStar[s] = arrival;
      buffer[0][s] = boardingBufferSeconds;
      pType[0][s] = PARENT.ACCESS;
      marked.push(s);
    }
  }

  let bestTarget = INF; // best known arrival at the destination (after egress): prunes hopeless labels
  let lastRound = 0;

  for (let k = 1; k < maxRounds && marked.length > 0; k++) {
    // Labels are copied forward so "at most k trips" semantics (and reconstruction) stay valid.
    tau[k].set(tau[k - 1]);
    buffer[k].set(buffer[k - 1]);
    pType[k].set(pType[k - 1]);
    pRound[k].set(pRound[k - 1]);
    pPattern[k].set(pPattern[k - 1]);
    pTrip[k].set(pTrip[k - 1]);
    pOffIdx[k].set(pOffIdx[k - 1]);
    pBoard[k].set(pBoard[k - 1]);
    pAlight[k].set(pAlight[k - 1]);
    pFrom[k].set(pFrom[k - 1]);

    const tauPrev = tau[k - 1];
    const bufferPrev = buffer[k - 1];
    const tauNow = tau[k];

    // 1. Queue the patterns serving stops improved last round, at their earliest improved position.
    const queued = [];
    for (const s of marked) {
      for (let e = stopPatternOffsets[s]; e < stopPatternOffsets[s + 1]; e++) {
        const p = stopPatternPattern[e];
        const pos = stopPatternPos[e];
        if (queuePos[p] === -1) {
          queuePos[p] = pos;
          queued.push(p);
        } else if (pos < queuePos[p]) {
          queuePos[p] = pos;
        }
      }
    }

    const improved = [];
    const markImproved = s => {
      if (inImproved[s] === 0) {
        inImproved[s] = 1;
        improved.push(s);
      }
    };

    // 2. Scan each queued pattern once.
    for (const p of queued) {
      const pattern = patterns[p];
      const { n, stops, dep, arr, pickup, dropOff } = pattern;
      const startPos = queuePos[p];
      queuePos[p] = -1;
      stats.patternsScanned++;

      let trip = -1;
      let offIdx = 0;
      let offset = 0;
      let boardPos = -1;

      for (let i = startPos; i < n; i++) {
        const s = stops[i];

        // Alight: can riding the current trip improve this stop's arrival?
        if (trip >= 0 && dropOff[i] === 1) {
          const arrival = arr[trip * n + i] + offset;
          if (arrival < tauStar[s] && arrival < bestTarget && arrival <= horizonTime) {
            tauNow[s] = arrival;
            tauStar[s] = arrival;
            buffer[k][s] = minTransfer[s];
            pType[k][s] = PARENT.TRANSIT;
            pRound[k][s] = k;
            pPattern[k][s] = p;
            pTrip[k][s] = trip;
            pOffIdx[k][s] = offIdx;
            pBoard[k][s] = boardPos;
            pAlight[k][s] = i;
            markImproved(s);
            if (egressSeconds && egressSeconds[s] >= 0) {
              const total = arrival + egressSeconds[s];
              if (total < bestTarget) bestTarget = total;
            }
          }
        }

        // Board: can a (better) trip be caught here using the previous round's label?
        if (i < n - 1 && pickup[i] === 1 && tauPrev[s] < INF) {
          const ready = tauPrev[s] + bufferPrev[s]; // arrival + minimum transfer time
          const currentDeparture = trip >= 0 ? dep[trip * n + i] + offset : INF;
          if (ready < currentDeparture) {
            findEarliestTrip(pattern, i, ready, serviceDays, found);
            if (found.trip >= 0 && found.dep < currentDeparture && found.dep <= horizonTime) {
              trip = found.trip;
              offIdx = found.offIdx;
              offset = serviceDays[offIdx].offsetSeconds;
              boardPos = i;
            }
          }
        }
      }
    }

    // 3. Walking transfers from stops improved by transit in this round.
    const viaTransit = improved.slice();
    for (const p of viaTransit) {
      for (let e = footOffsets[p]; e < footOffsets[p + 1]; e++) {
        const q = footTo[e];
        const walk = footSeconds[e];
        const arrival = tauNow[p] + walk;
        if (arrival < tauStar[q] && arrival < bestTarget && arrival <= horizonTime) {
          tauNow[q] = arrival;
          tauStar[q] = arrival;
          // Changing vehicle needs at least minTransfer in total: walk time counts towards it.
          buffer[k][q] = Math.max(0, minTransfer[q] - walk);
          pType[k][q] = PARENT.FOOT;
          pRound[k][q] = k;
          pFrom[k][q] = p;
          markImproved(q);
          if (egressSeconds && egressSeconds[q] >= 0) {
            const total = arrival + egressSeconds[q];
            if (total < bestTarget) bestTarget = total;
          }
        }
      }
    }

    for (const s of improved) inImproved[s] = 0;
    stats.stopsImproved += improved.length;
    stats.roundsExecuted++;
    lastRound = k;
    marked = improved;
  }

  return { ws, lastRound, stats };
}

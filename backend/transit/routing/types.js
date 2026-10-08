// Shared constants and type documentation for the routing engine.

// "Infinity" for 32-bit second counters (all internal times are integer seconds).
export const INF = 2147483647;

// How a stop's best label in a RAPTOR round was produced (used for journey reconstruction).
export const PARENT = Object.freeze({ NONE: 0, ACCESS: 1, TRANSIT: 2, FOOT: 3 });

// Worst-first ordering of stop_time quality, stored as small integers in the in-memory network.
export const TIME_QUALITY_NAMES = Object.freeze(['exact', 'approximate', 'interpolated', 'unknown']);
export const TIME_QUALITY_CODE = Object.freeze({ exact: 0, approximate: 1, interpolated: 2, unknown: 3 });

export const JOURNEY_LABELS = Object.freeze({
  // Highest Best Path Rating of the search (rating/pathRating.js). One journey, unless scores tie exactly.
  BEST_PATH: 'BEST_PATH',
  FASTEST: 'FASTEST',
  LEAST_TRANSFERS: 'LEAST_TRANSFERS',
  BEST_BALANCED: 'BEST_BALANCED',
  // Only when estimated fare RANGES are clearly separated (see ranking.js). CHEAPEST / BUDGET are intentionally
  // absent: fares are estimated ranges, so a "cheapest" claim would be false precision.
  LOWER_ESTIMATED_COST: 'LOWER_ESTIMATED_COST'
});

export const SECONDS_PER_DAY = 86400;

/**
 * In-memory transit network (built once, read-only during routing). All arrays are indexed by internal
 * integers, never by database ids.
 *
 * @typedef {Object} Pattern  A RAPTOR "route": trips that share the same ordered stops and never overtake.
 * @property {number} routeIdx
 * @property {number} n                 number of stops in the pattern
 * @property {Int32Array} stops         stop indices in travel order
 * @property {number} tripCount
 * @property {Int32Array} dep           departure seconds from service-day start, [trip * n + position]
 * @property {Int32Array} arr           arrival seconds from service-day start, [trip * n + position]
 * @property {Uint8Array} quality       time quality code per stop time, [trip * n + position]
 * @property {Int32Array} service       service index per trip
 * @property {string[]} tripSourceIds
 * @property {(string|null)[]} headsigns
 * @property {Uint8Array} pickup        1 = boarding allowed at this position
 * @property {Uint8Array} dropOff       1 = alighting allowed at this position
 *
 * @typedef {Object} Network
 * @property {number} stopCount
 * @property {string[]} stopNames
 * @property {string[]} stopSourceIds
 * @property {Float64Array} stopLat
 * @property {Float64Array} stopLon
 * @property {Pattern[]} patterns
 * @property {number} patternCount
 * @property {Int32Array} stopPatternOffsets   CSR: patterns serving each stop
 * @property {Int32Array} stopPatternPattern
 * @property {Int32Array} stopPatternPos
 * @property {Int32Array} footOffsets          CSR: walking transfers between stops
 * @property {Int32Array} footTo
 * @property {Int32Array} footSeconds
 * @property {Int32Array} footMeters
 * @property {Int32Array} minTransfer          minimum transfer seconds per stop
 */

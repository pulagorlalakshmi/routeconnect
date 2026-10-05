// Uniform-grid spatial index over stops (no dependencies). Good for "stops within R metres of a point".
import { haversineMeters, METERS_PER_DEGREE_LAT } from './geo.js';

const LAT_BUCKET_OFFSET = 5000;
const LON_BUCKET_OFFSET = 10000;
const LON_BUCKET_SPAN = 20000;

export class StopIndex {
  // lats / lons: parallel arrays; index i is the stop index used everywhere else.
  constructor(lats, lons, { cellDegrees = 0.02 } = {}) {
    this.lats = lats;
    this.lons = lons;
    this.cell = cellDegrees;
    this.cells = new Map();
    for (let i = 0; i < lats.length; i++) {
      const key = this.#key(Math.floor(lats[i] / this.cell), Math.floor(lons[i] / this.cell));
      const bucket = this.cells.get(key);
      if (bucket) bucket.push(i);
      else this.cells.set(key, [i]);
    }
  }

  #key(iy, ix) {
    return (iy + LAT_BUCKET_OFFSET) * LON_BUCKET_SPAN + (ix + LON_BUCKET_OFFSET);
  }

  // Stops within radiusMeters (straight line), nearest first; ties broken by stop index (deterministic).
  nearby(lat, lon, radiusMeters, { limit = Infinity } = {}) {
    const cosLat = Math.max(0.01, Math.cos((lat * Math.PI) / 180));
    const dLat = radiusMeters / METERS_PER_DEGREE_LAT;
    const dLon = radiusMeters / (METERS_PER_DEGREE_LAT * cosLat);
    const minY = Math.floor((lat - dLat) / this.cell);
    const maxY = Math.floor((lat + dLat) / this.cell);
    const minX = Math.floor((lon - dLon) / this.cell);
    const maxX = Math.floor((lon + dLon) / this.cell);

    const found = [];
    for (let iy = minY; iy <= maxY; iy++) {
      for (let ix = minX; ix <= maxX; ix++) {
        const bucket = this.cells.get(this.#key(iy, ix));
        if (!bucket) continue;
        for (const stop of bucket) {
          const distanceMeters = haversineMeters(lat, lon, this.lats[stop], this.lons[stop]);
          if (distanceMeters <= radiusMeters) found.push({ stop, distanceMeters });
        }
      }
    }
    found.sort((a, b) => a.distanceMeters - b.distanceMeters || a.stop - b.stop);
    return Number.isFinite(limit) ? found.slice(0, limit) : found;
  }
}

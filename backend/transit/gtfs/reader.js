// Safe, source-agnostic GTFS ZIP reader.
// - Reads the archive entirely in memory (nothing is written to disk).
// - Only *.txt entries are decompressed; entry names are used purely as map keys, never as paths.
// - Refuses archives whose declared uncompressed size is unreasonable (zip-bomb guard).
import fs from 'fs';
import crypto from 'crypto';
import { unzipSync } from 'fflate';
import { parseCsv } from './csv.js';

export const KNOWN_GTFS_FILES = Object.freeze([
  'agency', 'stops', 'routes', 'trips', 'stop_times', 'calendar', 'calendar_dates',
  'fare_attributes', 'fare_rules', 'fare_media', 'fare_products', 'fare_leg_rules', 'fare_transfer_rules',
  'timeframes', 'areas', 'stop_areas', 'networks', 'route_networks',
  'shapes', 'frequencies', 'transfers', 'pathways', 'levels',
  'location_groups', 'location_group_stops', 'booking_rules',
  'translations', 'feed_info', 'attributions'
]);

const DEFAULT_MAX_ENTRY_BYTES = 512 * 1024 * 1024;
const DEFAULT_MAX_TOTAL_BYTES = 1024 * 1024 * 1024;

function isZip(buffer) {
  return buffer.length > 4 && buffer[0] === 0x50 && buffer[1] === 0x4b;
}

// Reads a GTFS archive and returns parsed tables keyed by file name without ".txt".
export function readGtfsArchive(zipPath, options = {}) {
  const maxEntryBytes = options.maxEntryBytes ?? DEFAULT_MAX_ENTRY_BYTES;
  const maxTotalBytes = options.maxTotalBytes ?? DEFAULT_MAX_TOTAL_BYTES;

  const buffer = fs.readFileSync(zipPath);
  if (!isZip(buffer)) {
    throw new Error('Not a valid ZIP archive (missing PK signature).');
  }

  const checksum = crypto.createHash('sha256').update(buffer).digest('hex');
  const bytes = new Uint8Array(buffer.buffer, buffer.byteOffset, buffer.byteLength);

  // Pass 1: list entries without decompressing anything.
  const entries = [];
  try {
    unzipSync(bytes, {
      filter(file) {
        entries.push({ name: file.name, size: file.originalSize });
        return false;
      }
    });
  } catch (error) {
    throw new Error(`Unreadable ZIP archive: ${error.message}`);
  }

  // Choose one .txt entry per GTFS table, preferring the shallowest path.
  const chosen = new Map();
  for (const entry of entries) {
    if (entry.name.endsWith('/') || entry.name.startsWith('__MACOSX/')) continue;
    const parts = entry.name.split('/');
    const base = parts[parts.length - 1];
    if (!base.toLowerCase().endsWith('.txt') || base.startsWith('.')) continue;
    const table = base.slice(0, -4).toLowerCase();
    const depth = parts.length - 1;
    const existing = chosen.get(table);
    if (!existing || depth < existing.depth) chosen.set(table, { ...entry, depth });
  }

  let total = 0;
  for (const entry of chosen.values()) {
    if (entry.size > maxEntryBytes) {
      throw new Error(`Archive entry ${entry.name} is too large (${entry.size} bytes).`);
    }
    total += entry.size;
  }
  if (total > maxTotalBytes) {
    throw new Error(`Archive expands to ${total} bytes, above the ${maxTotalBytes} byte limit.`);
  }

  // Pass 2: decompress only the chosen entries.
  const wanted = new Set([...chosen.values()].map(entry => entry.name));
  const files = unzipSync(bytes, { filter: file => wanted.has(file.name) });

  const decoder = new TextDecoder('utf-8');
  const tables = {};
  const unknownFiles = [];
  for (const [table, entry] of chosen) {
    const parsed = parseCsv(decoder.decode(files[entry.name]));
    tables[table] = parsed;
    if (!KNOWN_GTFS_FILES.includes(table)) unknownFiles.push(`${table}.txt`);
  }

  return {
    checksum,
    sizeBytes: buffer.length,
    fileNames: [...chosen.keys()].map(name => `${name}.txt`).sort(),
    unknownFiles: unknownFiles.sort(),
    tables
  };
}

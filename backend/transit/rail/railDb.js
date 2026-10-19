// Opens the railway timetable database (separate from transit.db and from the user database).
import fs from 'fs';
import path from 'path';
import { DatabaseSync } from 'node:sqlite';
import { RAIL_SCHEMA_SQL, RAIL_SCHEMA_VERSION } from './railSchema.js';

export function openRailDb(dbPath, { readOnly = false } = {}) {
  if (readOnly) {
    if (dbPath !== ':memory:' && !fs.existsSync(dbPath)) throw new Error('Rail database does not exist.');
    return new DatabaseSync(dbPath, { readOnly: true });
  }
  if (dbPath !== ':memory:') fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  const db = new DatabaseSync(dbPath);
  db.exec('PRAGMA foreign_keys = ON;');
  const meta = db.prepare("SELECT 1 AS ok FROM sqlite_master WHERE type = 'table' AND name = 'rail_schema_meta'").get()
    ? db.prepare("SELECT value FROM rail_schema_meta WHERE key = 'schema_version'").get()
    : null;
  if (meta && Number(meta.value) !== RAIL_SCHEMA_VERSION) {
    db.close();
    throw new Error(`Rail database schema version ${meta.value} does not match expected ${RAIL_SCHEMA_VERSION}. Delete it and run "npm run rail:import" again.`);
  }
  db.exec(RAIL_SCHEMA_SQL);
  db.prepare("INSERT OR REPLACE INTO rail_schema_meta (key, value) VALUES ('schema_version', ?)").run(String(RAIL_SCHEMA_VERSION));
  return db;
}

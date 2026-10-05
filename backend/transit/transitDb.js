// Opens the transit database (separate from the user/auth database).
import fs from 'fs';
import path from 'path';
import { DatabaseSync } from 'node:sqlite';
import { SCHEMA_SQL, SCHEMA_VERSION } from './schema.js';

// Opens (and for write mode, creates/initialises) a transit database.
// readOnly: never creates the file or directories; throws if the database does not exist.
export function openTransitDb(dbPath, { readOnly = false } = {}) {
  if (readOnly) {
    if (dbPath !== ':memory:' && !fs.existsSync(dbPath)) {
      throw new Error('Transit database does not exist.');
    }
    return new DatabaseSync(dbPath, { readOnly: true });
  }

  if (dbPath !== ':memory:') fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  const db = new DatabaseSync(dbPath);
  db.exec('PRAGMA foreign_keys = ON;');
  applySchema(db);
  return db;
}

export function applySchema(db) {
  const existing = tableExists(db, 'schema_meta')
    ? db.prepare("SELECT value FROM schema_meta WHERE key = 'schema_version'").get()
    : null;

  if (existing && Number(existing.value) !== SCHEMA_VERSION) {
    throw new Error(
      `Transit database schema version ${existing.value} does not match expected ${SCHEMA_VERSION}. ` +
      'The transit database is a rebuildable artefact: delete it and run "npm run transit:import" again.'
    );
  }

  db.exec(SCHEMA_SQL);
  db.prepare("INSERT OR REPLACE INTO schema_meta (key, value) VALUES ('schema_version', ?)").run(String(SCHEMA_VERSION));
}

function tableExists(db, name) {
  return Boolean(db.prepare("SELECT 1 AS ok FROM sqlite_master WHERE type = 'table' AND name = ?").get(name));
}

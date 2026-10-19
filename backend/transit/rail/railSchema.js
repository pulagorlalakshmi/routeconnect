// Dedicated railway timetable schema. Kept in its OWN database file (rail.db), separate from the APSRTC bus transit
// database, so rail train numbers / station codes can never collide with bus route or stop identifiers, and either side
// can be rebuilt or replaced independently. Like transit.db this is a REBUILDABLE ARTEFACT: never hand-edit, never commit.
//
// Provider-independent: every provider (GTFS today, an official API later) is normalised into these tables by
// railImporter.js. Field provenance is documented in backend/transit/rail/README.md.
export const RAIL_SCHEMA_VERSION = 1;

export const RAIL_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS rail_schema_meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

-- One row per imported snapshot. Provenance and licence status travel with every record below.
CREATE TABLE IF NOT EXISTS rail_datasets (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  provider_id       TEXT    NOT NULL,                 -- e.g. gtfs
  source_key        TEXT    NOT NULL,                 -- re-importing the same source replaces its rows
  name              TEXT    NOT NULL,
  source_type       TEXT    NOT NULL CHECK (source_type IN ('official','open_data','community')),
  source_url        TEXT,
  license           TEXT    NOT NULL DEFAULT 'unknown',
  license_status    TEXT    NOT NULL CHECK (license_status IN ('cleared','unconfirmed','restricted')),
  provenance_note   TEXT,
  operator          TEXT,
  snapshot_date     TEXT,                             -- ISO date the source captured the timetable (feed_version / retrieval)
  retrieved_at      TEXT    NOT NULL,                 -- when RouteConnect downloaded the archive
  imported_at       TEXT    NOT NULL,
  feed_start_date   TEXT,                             -- as declared by the publisher (feed_info.txt)
  feed_end_date     TEXT,
  valid_from        TEXT,                             -- derived from the usable service calendars
  valid_to          TEXT,
  checksum_sha256   TEXT    NOT NULL,
  stats_json        TEXT,
  -- Nothing from a community source is ever "verified".
  verified          INTEGER NOT NULL DEFAULT 0 CHECK (verified IN (0,1)),
  CHECK (verified = 0 OR source_type = 'official')
);
CREATE INDEX IF NOT EXISTS idx_rail_datasets_source_key ON rail_datasets(source_key);

CREATE TABLE IF NOT EXISTS rail_stations (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  dataset_id INTEGER NOT NULL REFERENCES rail_datasets(id) ON DELETE CASCADE,
  code       TEXT    NOT NULL,                        -- Indian Railways station code (BZA, GNT, ...)
  name       TEXT    NOT NULL,
  lat        REAL,                                    -- NULL when the source has no usable coordinate
  lon        REAL,
  UNIQUE (dataset_id, code)
);
CREATE INDEX IF NOT EXISTS idx_rail_stations_lat_lon ON rail_stations(lat, lon);

CREATE TABLE IF NOT EXISTS rail_services (
  dataset_id INTEGER NOT NULL REFERENCES rail_datasets(id) ON DELETE CASCADE,
  service_id TEXT    NOT NULL,
  monday INTEGER NOT NULL, tuesday INTEGER NOT NULL, wednesday INTEGER NOT NULL, thursday INTEGER NOT NULL,
  friday INTEGER NOT NULL, saturday INTEGER NOT NULL, sunday INTEGER NOT NULL,
  start_date TEXT NOT NULL,                           -- ISO dates; the run's FIRST-STATION departure date
  end_date   TEXT NOT NULL,
  PRIMARY KEY (dataset_id, service_id)
) WITHOUT ROWID;

CREATE TABLE IF NOT EXISTS rail_service_dates (
  dataset_id     INTEGER NOT NULL REFERENCES rail_datasets(id) ON DELETE CASCADE,
  service_id     TEXT    NOT NULL,
  date           TEXT    NOT NULL,
  exception_type INTEGER NOT NULL CHECK (exception_type IN (1,2)),
  PRIMARY KEY (dataset_id, service_id, date)
) WITHOUT ROWID;

CREATE TABLE IF NOT EXISTS rail_trains (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  dataset_id     INTEGER NOT NULL REFERENCES rail_datasets(id) ON DELETE CASCADE,
  source_trip_id TEXT    NOT NULL,
  number         TEXT    NOT NULL,                    -- train number exactly as published by the source
  name           TEXT,                                -- train name exactly as published by the source
  headsign       TEXT,
  service_id     TEXT    NOT NULL,
  UNIQUE (dataset_id, source_trip_id)
);
CREATE INDEX IF NOT EXISTS idx_rail_trains_number ON rail_trains(dataset_id, number);

-- Times are seconds from 00:00 of the run's first-station departure date (>= 86400 on later journey days).
CREATE TABLE IF NOT EXISTS rail_train_stops (
  train_id          INTEGER NOT NULL REFERENCES rail_trains(id) ON DELETE CASCADE,
  seq               INTEGER NOT NULL,                 -- position along the run, 0-based, in source stop_sequence order
  station_id        INTEGER NOT NULL REFERENCES rail_stations(id) ON DELETE CASCADE,
  arrival_seconds   INTEGER,                          -- NULL at the origin
  departure_seconds INTEGER,                          -- NULL at the terminus
  distance_km       REAL,
  PRIMARY KEY (train_id, seq)
) WITHOUT ROWID;
CREATE INDEX IF NOT EXISTS idx_rail_train_stops_station ON rail_train_stops(station_id, departure_seconds);

-- Everything the importer refused or flagged, so coverage gaps are visible rather than silent.
CREATE TABLE IF NOT EXISTS rail_import_issues (
  dataset_id INTEGER NOT NULL REFERENCES rail_datasets(id) ON DELETE CASCADE,
  severity   TEXT    NOT NULL CHECK (severity IN ('error','warning')),
  code       TEXT    NOT NULL,
  entity     TEXT,
  detail     TEXT
);
CREATE INDEX IF NOT EXISTS idx_rail_import_issues_dataset ON rail_import_issues(dataset_id, code);
`;

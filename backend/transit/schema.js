// Normalised transit schema (GTFS-shaped). This database is a REBUILDABLE ARTEFACT produced by importers:
// never hand-edit it, never store user data in it, never commit it.
//
// Identity model: every table has its own integer surrogate key (`id`) plus the feed's original ID
// (`source_*_id`). Services and shapes are keyed by (dataset_id, source id) because GTFS defines them
// implicitly through calendar.txt / shapes.txt rather than as standalone entities.
export const SCHEMA_VERSION = 1;

export const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS schema_meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

-- One row per imported feed; carries the provenance and the honest confidence of everything below it.
CREATE TABLE IF NOT EXISTS datasets (
  id                 INTEGER PRIMARY KEY AUTOINCREMENT,
  source_key         TEXT    NOT NULL,                 -- "<source_type>|<name>"; re-importing replaces rows with the same key
  name               TEXT    NOT NULL,
  source_type        TEXT    NOT NULL,                 -- e.g. community_gtfs
  source_url         TEXT,
  license            TEXT    NOT NULL DEFAULT 'unknown',
  confidence_default TEXT    NOT NULL
    CHECK (confidence_default IN ('live','verified','published','inferred','estimated','unknown')),
  verified           INTEGER NOT NULL DEFAULT 0 CHECK (verified IN (0,1)),
  retrieved_at       TEXT    NOT NULL,                 -- when the archive was actually downloaded
  imported_at        TEXT    NOT NULL,
  valid_from         TEXT,                             -- ISO date, derived from calendar(_dates)
  valid_to           TEXT,
  feed_start_date    TEXT,                             -- feed_info.txt, if present
  feed_end_date      TEXT,
  feed_publisher     TEXT,
  feed_version       TEXT,
  checksum_sha256    TEXT    NOT NULL,
  stats_json         TEXT,
  validation_json    TEXT,
  -- Database-level honesty guard: "verified"/"live" can never be stored for unverified data.
  CHECK (verified = 1 OR confidence_default NOT IN ('verified','live'))
);
CREATE INDEX IF NOT EXISTS idx_datasets_source_key ON datasets(source_key);

CREATE TABLE IF NOT EXISTS agencies (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  source_agency_id TEXT,
  name             TEXT NOT NULL,
  url              TEXT,
  timezone         TEXT,
  dataset_id       INTEGER NOT NULL REFERENCES datasets(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_agencies_dataset ON agencies(dataset_id);

CREATE TABLE IF NOT EXISTS stops (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  source_stop_id TEXT    NOT NULL,
  name           TEXT    NOT NULL,
  lat            REAL,                                  -- NULL when the feed has missing/invalid coordinates
  lon            REAL,
  location_type  INTEGER NOT NULL DEFAULT 0,
  kind           TEXT,                                  -- station | bus | rail | ... | mixed | unserved (derived from serving routes)
  parent_station INTEGER REFERENCES stops(id) ON DELETE SET NULL,
  dataset_id     INTEGER NOT NULL REFERENCES datasets(id) ON DELETE CASCADE,
  UNIQUE (dataset_id, source_stop_id)
);
CREATE INDEX IF NOT EXISTS idx_stops_name ON stops(name);
CREATE INDEX IF NOT EXISTS idx_stops_lat_lon ON stops(lat, lon);

CREATE TABLE IF NOT EXISTS routes (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  source_route_id TEXT    NOT NULL,
  agency_id       INTEGER REFERENCES agencies(id) ON DELETE SET NULL,
  short_name      TEXT,
  long_name       TEXT,
  route_type      INTEGER NOT NULL,
  mode            TEXT    NOT NULL,                     -- bus | rail | tram | ... (mapped from route_type)
  dataset_id      INTEGER NOT NULL REFERENCES datasets(id) ON DELETE CASCADE,
  UNIQUE (dataset_id, source_route_id)
);
CREATE INDEX IF NOT EXISTS idx_routes_agency ON routes(agency_id);

CREATE TABLE IF NOT EXISTS trips (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  source_trip_id TEXT    NOT NULL,
  route_id       INTEGER NOT NULL REFERENCES routes(id) ON DELETE CASCADE,
  service_id     TEXT    NOT NULL,                      -- source service id (see service_calendars / calendar_dates)
  headsign       TEXT,
  direction_id   INTEGER,
  shape_id       TEXT,                                  -- source shape id (see shapes)
  dataset_id     INTEGER NOT NULL REFERENCES datasets(id) ON DELETE CASCADE,
  UNIQUE (dataset_id, source_trip_id)
);
CREATE INDEX IF NOT EXISTS idx_trips_route_service ON trips(route_id, service_id);
CREATE INDEX IF NOT EXISTS idx_trips_dataset_service ON trips(dataset_id, service_id);

-- arrival/departure are seconds from the start of the SERVICE day and may exceed 86400 (overnight trips).
-- time_quality: exact (timepoint) | approximate (timepoint=0) | interpolated (filled in by the importer) | unknown
CREATE TABLE IF NOT EXISTS stop_times (
  trip_id           INTEGER NOT NULL REFERENCES trips(id) ON DELETE CASCADE,
  stop_id           INTEGER NOT NULL REFERENCES stops(id) ON DELETE CASCADE,
  stop_sequence     INTEGER NOT NULL,
  arrival_seconds   INTEGER,
  departure_seconds INTEGER,
  pickup_type       INTEGER NOT NULL DEFAULT 0,
  drop_off_type     INTEGER NOT NULL DEFAULT 0,
  time_quality      TEXT    NOT NULL CHECK (time_quality IN ('exact','approximate','interpolated','unknown')),
  PRIMARY KEY (trip_id, stop_sequence)
) WITHOUT ROWID;
CREATE INDEX IF NOT EXISTS idx_stop_times_stop_departure ON stop_times(stop_id, departure_seconds);

CREATE TABLE IF NOT EXISTS service_calendars (
  dataset_id INTEGER NOT NULL REFERENCES datasets(id) ON DELETE CASCADE,
  service_id TEXT    NOT NULL,
  monday INTEGER NOT NULL, tuesday INTEGER NOT NULL, wednesday INTEGER NOT NULL, thursday INTEGER NOT NULL,
  friday INTEGER NOT NULL, saturday INTEGER NOT NULL, sunday INTEGER NOT NULL,
  start_date TEXT NOT NULL,                             -- ISO dates
  end_date   TEXT NOT NULL,
  PRIMARY KEY (dataset_id, service_id)
);

CREATE TABLE IF NOT EXISTS calendar_dates (
  dataset_id     INTEGER NOT NULL REFERENCES datasets(id) ON DELETE CASCADE,
  service_id     TEXT    NOT NULL,
  date           TEXT    NOT NULL,                      -- ISO date
  exception_type INTEGER NOT NULL CHECK (exception_type IN (1,2)),
  PRIMARY KEY (dataset_id, service_id, date)
);

CREATE TABLE IF NOT EXISTS shapes (
  dataset_id        INTEGER NOT NULL REFERENCES datasets(id) ON DELETE CASCADE,
  shape_id          TEXT    NOT NULL,
  sequence          INTEGER NOT NULL,
  lat               REAL    NOT NULL,
  lon               REAL    NOT NULL,
  distance_traveled REAL,
  PRIMARY KEY (dataset_id, shape_id, sequence)
) WITHOUT ROWID;

-- Prepared for later phases (populated only if the feed provides them / a future source does).
CREATE TABLE IF NOT EXISTS transfers (
  dataset_id           INTEGER NOT NULL REFERENCES datasets(id) ON DELETE CASCADE,
  from_stop_id         INTEGER NOT NULL REFERENCES stops(id) ON DELETE CASCADE,
  to_stop_id           INTEGER NOT NULL REFERENCES stops(id) ON DELETE CASCADE,
  transfer_type        INTEGER NOT NULL DEFAULT 0,
  min_transfer_seconds INTEGER,
  PRIMARY KEY (dataset_id, from_stop_id, to_stop_id)
) WITHOUT ROWID;

-- Intentionally empty today: no source of real fares exists yet, so fares stay UNKNOWN rather than invented.
CREATE TABLE IF NOT EXISTS fare_rules (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  dataset_id     INTEGER REFERENCES datasets(id) ON DELETE CASCADE,
  mode           TEXT,
  service_class  TEXT,
  min_distance_km REAL,
  max_distance_km REAL,
  price          REAL NOT NULL,
  currency       TEXT NOT NULL DEFAULT 'INR',
  source         TEXT NOT NULL,
  confidence     TEXT NOT NULL CHECK (confidence IN ('live','verified','published','inferred','estimated','unknown'))
);
`;

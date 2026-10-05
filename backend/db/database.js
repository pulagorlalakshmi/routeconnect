// SQLite Database Initialization & Repository Manager
// Separates static/allowed storage from dynamic short-lived cached data.
import { DatabaseSync } from 'node:sqlite';
import path from 'path';
import { fileURLToPath } from 'url';
import { STATIC_LOCATIONS } from './staticLocations.js';
import { STATIC_HUB_TRANSFERS } from './staticTransfers.js';
import { STATIC_TRAIN_SERVICES, STATIC_BUS_SERVICES } from './staticTransitData.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const dbPath = process.env.ROUTECONNECT_DATABASE_PATH || path.join(__dirname, '..', '..', 'routeconnect.db');
export const db = new DatabaseSync(dbPath);

// Initialize Tables
export function initializeDatabase() {
  // 1. Users Table
  db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      email TEXT NOT NULL UNIQUE,
      phone TEXT NOT NULL,
      password TEXT NOT NULL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
  `);

  // 2. Locations Table (Static / Allowed Permitted Data: villages, towns, cities, stations, bus stops)
  db.exec(`
    CREATE TABLE IF NOT EXISTS locations (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      latitude REAL NOT NULL,
      longitude REAL NOT NULL,
      mandal TEXT,
      district TEXT,
      state TEXT,
      type TEXT NOT NULL,
      code TEXT,
      source TEXT DEFAULT 'curated',
      verified INTEGER DEFAULT 1,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
  `);

  const locCols = db.prepare("PRAGMA table_info(locations)").all().map(c => c.name);
  if (!locCols.includes('code')) db.exec("ALTER TABLE locations ADD COLUMN code TEXT;");
  if (!locCols.includes('location_id')) db.exec("ALTER TABLE locations ADD COLUMN location_id TEXT;");
  if (!locCols.includes('location_type')) db.exec("ALTER TABLE locations ADD COLUMN location_type TEXT;");
  if (!locCols.includes('source')) db.exec("ALTER TABLE locations ADD COLUMN source TEXT DEFAULT 'curated';");
  if (!locCols.includes('verified')) db.exec("ALTER TABLE locations ADD COLUMN verified INTEGER DEFAULT 1;");
  if (!locCols.includes('created_at')) db.exec("ALTER TABLE locations ADD COLUMN created_at DATETIME;");

  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_locations_name ON locations(name);
    CREATE INDEX IF NOT EXISTS idx_locations_type ON locations(type);
  `);

  // 3. Transport Hub Transfers (Physical links between Bus Stands & Railway Stations)
  db.exec(`
    CREATE TABLE IF NOT EXISTS hub_transfers (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      from_hub TEXT NOT NULL,
      to_hub TEXT NOT NULL,
      distance_km REAL NOT NULL,
      mode TEXT NOT NULL,
      duration_minutes INTEGER NOT NULL,
      price REAL NOT NULL,
      transfer_type TEXT,
      notes TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_hub_transfers_from_to ON hub_transfers(from_hub, to_hub);
  `);

  // 4. Segments Table (Direct segments table for intercity links)
  db.exec(`
    CREATE TABLE IF NOT EXISTS segments (
      id TEXT PRIMARY KEY,
      from_location TEXT NOT NULL,
      to_location TEXT NOT NULL,
      mode TEXT NOT NULL,
      operator TEXT NOT NULL,
      duration_minutes INTEGER NOT NULL,
      distance_km REAL NOT NULL,
      price REAL NOT NULL,
      departure_time TEXT,
      arrival_time TEXT,
      train_name TEXT,
      train_number TEXT,
      service_name TEXT,
      stops TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_segments_from_to ON segments(from_location, to_location);
  `);

  // 5. Dynamic Data Cache with TTL (Requirement 6: Dynamic Data vs Stored Data)
  db.exec(`
    CREATE TABLE IF NOT EXISTS dynamic_cache (
      cache_key TEXT PRIMARY KEY,
      provider TEXT NOT NULL,
      payload TEXT NOT NULL,
      expires_at INTEGER NOT NULL,
      created_at INTEGER NOT NULL
    );
  `);

  // 6. Google Place References (Per Google Maps Platform Terms of Service)
  db.exec(`
    CREATE TABLE IF NOT EXISTS google_place_references (
      place_id TEXT PRIMARY KEY,
      first_seen_at TEXT NOT NULL,
      last_seen_at TEXT NOT NULL
    );
  `);

  // 7. Route Intermediate Locations (Villages, Towns, Bus Stops, Stations along routes)
  db.exec(`
    CREATE TABLE IF NOT EXISTS route_intermediate_locations (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      latitude REAL NOT NULL,
      longitude REAL NOT NULL,
      type TEXT NOT NULL,
      district TEXT,
      region TEXT,
      nearby_bus_facilities TEXT,
      nearby_transport_points TEXT,
      associated_routes TEXT,
      distance_from_route_km REAL,
      source TEXT,
      google_place_id TEXT,
      google_maps_uri TEXT,
      retrieved_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_route_inter_loc_name ON route_intermediate_locations(name);
    CREATE INDEX IF NOT EXISTS idx_route_inter_loc_type ON route_intermediate_locations(type);
  `);

  // 8. Transport Stops (Bus stops, bus stands, railway stations, auto stands)
  db.exec(`
    CREATE TABLE IF NOT EXISTS transport_stops (
      stop_id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      latitude REAL NOT NULL,
      longitude REAL NOT NULL,
      type TEXT NOT NULL,
      location_id TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_transport_stops_name ON transport_stops(name);
    CREATE INDEX IF NOT EXISTS idx_transport_stops_type ON transport_stops(type);
  `);

  // 9. Routes (Permitted and frequently requested multi-modal journeys)
  db.exec(`
    CREATE TABLE IF NOT EXISTS routes (
      route_id TEXT PRIMARY KEY,
      source TEXT NOT NULL,
      destination TEXT NOT NULL,
      transport_type TEXT NOT NULL,
      route_name TEXT,
      total_distance REAL NOT NULL,
      total_duration INTEGER NOT NULL,
      total_transfers INTEGER NOT NULL,
      total_fare REAL NOT NULL,
      via TEXT,
      highway TEXT,
      villages TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
    CREATE INDEX IF NOT EXISTS idx_routes_source_dest ON routes(source, destination);
  `);

  // 10. Route Segments (Individual travel legs in a multi-modal route)
  db.exec(`
    CREATE TABLE IF NOT EXISTS route_segments (
      segment_id TEXT PRIMARY KEY,
      route_id TEXT NOT NULL,
      from_stop TEXT NOT NULL,
      to_stop TEXT NOT NULL,
      transport_type TEXT NOT NULL,
      distance REAL NOT NULL,
      duration INTEGER NOT NULL,
      price REAL NOT NULL,
      sequence_order INTEGER NOT NULL,
      departure_time TEXT,
      arrival_time TEXT,
      provider TEXT,
      service_name TEXT,
      stops TEXT,
      FOREIGN KEY (route_id) REFERENCES routes(route_id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_route_segments_route_id ON route_segments(route_id);
  `);

  // 11. Transfers (Transfer points where passengers change vehicles/modes)
  db.exec(`
    CREATE TABLE IF NOT EXISTS transfers (
      transfer_id TEXT PRIMARY KEY,
      route_id TEXT NOT NULL,
      location TEXT NOT NULL,
      previous_transport TEXT NOT NULL,
      next_transport TEXT NOT NULL,
      distance REAL DEFAULT 0,
      duration INTEGER DEFAULT 0,
      price REAL DEFAULT 0,
      notes TEXT,
      sequence_order INTEGER DEFAULT 1,
      FOREIGN KEY (route_id) REFERENCES routes(route_id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_transfers_route_id ON transfers(route_id);
  `);

  // Seed Static Locations and Multi-Modal Topology
  seedLocations();
  seedTransportStops();
  seedHubTransfers();
  seedIntercitySegments();
  seedMultiModalRoutes();
}

function seedLocations() {
  const insertStmt = db.prepare(`
    INSERT OR REPLACE INTO locations (id, location_id, name, latitude, longitude, mandal, district, state, type, location_type, code, source, verified)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  for (const loc of STATIC_LOCATIONS) {
    insertStmt.run(
      loc.id,
      loc.id,
      loc.name,
      loc.latitude,
      loc.longitude,
      loc.mandal || null,
      loc.district || null,
      loc.state || null,
      loc.type,
      loc.type,
      loc.code || null,
      'curated',
      1
    );
  }
}

function seedTransportStops() {
  const insertStop = db.prepare(`
    INSERT OR REPLACE INTO transport_stops (stop_id, name, latitude, longitude, type, location_id)
    VALUES (?, ?, ?, ?, ?, ?)
  `);
  for (const loc of STATIC_LOCATIONS) {
    if (['bus', 'station', 'airport'].includes(loc.type) || loc.name.toLowerCase().includes('bus') || loc.name.toLowerCase().includes('station')) {
      const stopType = loc.type === 'station' ? 'railway_station' : (loc.type === 'bus' ? 'bus_station' : loc.type);
      insertStop.run(
        `stop-${loc.id}`,
        loc.name,
        loc.latitude,
        loc.longitude,
        stopType,
        loc.id
      );
    }
  }
}

function seedHubTransfers() {
  const checkStmt = db.prepare('SELECT id FROM hub_transfers WHERE LOWER(from_hub) = LOWER(?) AND LOWER(to_hub) = LOWER(?) LIMIT 1');
  const insertTransfer = db.prepare(`
    INSERT INTO hub_transfers (from_hub, to_hub, distance_km, mode, duration_minutes, price, transfer_type, notes)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `);
  for (const t of STATIC_HUB_TRANSFERS) {
    if (!checkStmt.get(t.fromHub, t.toHub)) {
      insertTransfer.run(t.fromHub, t.toHub, t.distanceKm, t.mode, t.durationMinutes, t.price, t.transferType, t.notes);
    }
    if (!checkStmt.get(t.toHub, t.fromHub)) {
      insertTransfer.run(t.toHub, t.fromHub, t.distanceKm, t.mode, t.durationMinutes, t.price, t.transferType, t.notes);
    }
  }
}

function seedIntercitySegments() {
  const count = db.prepare('SELECT count(*) as total FROM segments').get();
  if (count.total === 0) {
    const insertSegment = db.prepare(`
      INSERT INTO segments (id, from_location, to_location, mode, operator, duration_minutes, distance_km, price, departure_time, arrival_time, train_name, train_number, service_name, stops)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    // Add key intercity train & bus segments
    const initialSegments = [
      ['BHM-VJA-T1', 'Bhimavaram Railway Station', 'Vijayawada Railway Station', 'train', 'Indian Railways', 145, 110.0, 145, '16:10', '18:35', 'Godavari Express', '12727', null, 'Tanuku, Eluru'],
      ['BHM-VJA-T2', 'Bhimavaram Railway Station', 'Vijayawada Railway Station', 'train', 'Indian Railways', 145, 110.0, 145, '16:20', '18:45', 'Ratnachal Express', '12717', null, 'Tanuku, Eluru'],
      ['BHM-VJA-T3', 'Bhimavaram Railway Station', 'Vijayawada Railway Station', 'train', 'Indian Railways', 135, 110.0, 420, '07:10', '09:25', 'Vande Bharat Express', '20833', null, 'Eluru'],
      ['BHM-VJA-T4', 'Bhimavaram Junction', 'Vijayawada Junction', 'train', 'Indian Railways', 145, 110.0, 145, '16:10', '18:35', 'Godavari Express', '12727', null, 'Tanuku, Eluru'],
      ['BHM-VJA-T5', 'Bhimavaram Junction', 'Vijayawada Junction', 'train', 'Indian Railways', 145, 110.0, 145, '16:20', '18:45', 'Ratnachal Express', '12717', null, 'Tanuku, Eluru'],
      ['BHM-VJA-B1', 'Bhimavaram Bus Station', 'Vijayawada Bus Station', 'bus', 'APSRTC', 185, 115.0, 240, '15:15', '18:20', null, null, 'Ultra Deluxe', 'Tanuku, Eluru'],
      ['BHM-VJA-B2', 'Bhimavaram Bus Station', 'Vijayawada Bus Station', 'bus', 'APSRTC', 195, 115.0, 180, '14:30', '17:45', null, null, 'Express', 'Tanuku, Tadepalligudem, Eluru'],
      ['BHM-VJA-B3', 'Bhimavaram Bus Station', 'Vijayawada Bus Station', 'bus', 'APSRTC', 250, 115.0, 140, '06:00', '10:10', null, null, 'Pallevelugu', 'Undi, Pippara, Tanuku, Eluru'],
      ['BHM-VJA-B4', 'Bhimavaram Bus Station', 'Vijayawada Bus Station', 'bus', 'APSRTC', 170, 115.0, 320, '10:00', '12:50', null, null, 'Super Luxury', 'Tadepalligudem, Eluru'],
      ['VSKP-VJA-T1', 'Visakhapatnam Railway Station', 'Vijayawada Railway Station', 'train', 'Indian Railways', 360, 350.0, 220, '06:00', '12:00', 'Janmabhoomi Express', '12805', null, 'Samalkot, Rajahmundry, Eluru'],
      ['VSKP-VJA-T2', 'Visakhapatnam Railway Station', 'Vijayawada Railway Station', 'train', 'Indian Railways', 330, 350.0, 550, '14:30', '20:00', 'Vande Bharat Express', '20833', null, 'Rajahmundry'],
      ['VSKP-VJA-B1', 'Dwaraka Bus Complex', 'Vijayawada Bus Station', 'bus', 'APSRTC', 480, 355.0, 520, '08:00', '16:00', null, null, 'Super Luxury', 'Anakapalli, Tuni, Kakinada, Rajahmundry, Eluru'],
      ['VSKP-VJA-B2', 'Dwaraka Bus Complex', 'Vijayawada Bus Station', 'bus', 'APSRTC', 460, 355.0, 680, '22:00', '05:40', null, null, 'Vennela Sleeper', 'Rajahmundry, Eluru'],
      ['RJY-VJA-T1', 'Rajahmundry Railway Station', 'Vijayawada Railway Station', 'train', 'Indian Railways', 150, 150.0, 150, '14:00', '16:30', 'Simhadri Express', '17239', null, 'Nidadavolu, Tadepalligudem, Eluru'],
      ['RJY-VJA-B1', 'Rajahmundry Bus Station', 'Vijayawada Bus Station', 'bus', 'APSRTC', 180, 155.0, 220, '10:00', '13:00', null, null, 'Express', 'Kovvur, Tanuku, Tadepalligudem, Eluru']
    ];

    for (const seg of initialSegments) {
      insertSegment.run(...seg);
    }
  }
}

// -------------------------------------------------------------
// Benchmark Multi-Modal Routes Seeder & Query Methods (Requirement 8)
// -------------------------------------------------------------
function seedMultiModalRoutes() {
  const insertRoute = db.prepare(`
    INSERT OR REPLACE INTO routes (route_id, source, destination, transport_type, route_name, total_distance, total_duration, total_transfers, total_fare, via, highway, villages)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  const insertSegment = db.prepare(`
    INSERT OR REPLACE INTO route_segments (segment_id, route_id, from_stop, to_stop, transport_type, distance, duration, price, sequence_order, departure_time, arrival_time, provider, service_name, stops)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  const insertTransfer = db.prepare(`
    INSERT OR REPLACE INTO transfers (transfer_id, route_id, location, previous_transport, next_transport, distance, duration, price, notes, sequence_order)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  const BENCHMARK_ROUTES = [
    // 1. Village A -> Ongole Railway Station (Route 1: Bus + Train)
    {
      routeId: 'rt-vla-ogl-bus-train',
      source: 'Village A',
      destination: 'Ongole Railway Station',
      transportType: 'bus_train',
      routeName: 'Route 1 – Bus + Train',
      totalDistance: 98.0,
      totalDuration: 110,
      totalTransfers: 2,
      totalFare: 130.0,
      via: 'Town X',
      highway: 'SH 45 & Grand Trunk Corridor',
      villages: ['Village A', 'Village A Bus Stop', 'Town X', 'Ongole Railway Station'],
      segments: [
        {
          from: 'Village A',
          to: 'Town X Bus Stand',
          mode: 'bus',
          distance: 15.0,
          duration: 25,
          price: 25.0,
          departureTime: '07:15',
          arrivalTime: '07:40',
          provider: 'APSRTC Palle Velugu',
          serviceName: 'Palle Velugu (Route PV-VLA-TNX)',
          stops: 'Village A, Village A Bus Stop, Town X Bus Stand'
        },
        {
          from: 'Town X Bus Stand',
          to: 'Town X Railway Station',
          mode: 'auto',
          distance: 3.0,
          duration: 10,
          price: 40.0,
          departureTime: '07:45',
          arrivalTime: '07:55',
          provider: 'Local Auto',
          serviceName: 'Auto / Cab Shuttle',
          stops: 'Town X Station Road'
        },
        {
          from: 'Town X Railway Station',
          to: 'Ongole Railway Station',
          mode: 'train',
          distance: 80.0,
          duration: 75,
          price: 65.0,
          departureTime: '08:30',
          arrivalTime: '09:45',
          provider: 'Indian Railways',
          serviceName: 'Godavari Express (Train #12727)',
          stops: 'Railway Station X, Medarmetla, Maddipadu'
        }
      ],
      transfers: [
        {
          location: 'Town X Bus Stand',
          previousTransport: 'bus',
          nextTransport: 'auto',
          distance: 3.0,
          duration: 10,
          price: 40.0,
          notes: 'Get down at Town X Bus Stand. Travel 3 km by Auto to Town X Railway Station.'
        },
        {
          location: 'Town X Railway Station',
          previousTransport: 'auto',
          nextTransport: 'train',
          distance: 0,
          duration: 20,
          price: 0,
          notes: 'Board train #12727 Godavari Express from Town X Railway Station to Ongole Railway Station.'
        }
      ]
    },
    // Village A -> Ongole Railway Station (Route 2: Bus Only)
    {
      routeId: 'rt-vla-ogl-bus-only',
      source: 'Village A',
      destination: 'Ongole Railway Station',
      transportType: 'bus_only',
      routeName: 'Route 2 – Bus Only',
      totalDistance: 100.0,
      totalDuration: 135,
      totalTransfers: 1,
      totalFare: 130.0,
      via: 'Town Y',
      highway: 'SH 45 & NH 16 Corridor',
      villages: ['Village A', 'Town Y', 'Ongole', 'Ongole Railway Station'],
      segments: [
        {
          from: 'Village A',
          to: 'Town Y',
          mode: 'bus',
          distance: 40.0,
          duration: 50,
          price: 50.0,
          departureTime: '07:00',
          arrivalTime: '07:50',
          provider: 'APSRTC Express',
          serviceName: 'Express (Route PV-VLA-TNY)',
          stops: 'Village A, Korisapadu Cross, Town Y'
        },
        {
          from: 'Town Y',
          to: 'Ongole Railway Station',
          mode: 'bus',
          distance: 60.0,
          duration: 70,
          price: 80.0,
          departureTime: '08:05',
          arrivalTime: '09:15',
          provider: 'APSRTC Super Luxury',
          serviceName: 'Super Luxury (Route EXP-TNY-OGL)',
          stops: 'Town Y Bus Stand, Medarmetla, Maddipadu, Ongole Bus Stand, Ongole Railway Station'
        }
      ],
      transfers: [
        {
          location: 'Town Y Bus Stand',
          previousTransport: 'bus',
          nextTransport: 'bus',
          distance: 0,
          duration: 15,
          price: 0,
          notes: 'Get down at Town Y Bus Stand. Change to connecting Super Luxury bus to Ongole.'
        }
      ]
    },
    // Village A -> Ongole Railway Station (Route 3: Bus + Train + Bus)
    {
      routeId: 'rt-vla-ogl-bus-train-bus',
      source: 'Village A',
      destination: 'Ongole Railway Station',
      transportType: 'bus_train_bus',
      routeName: 'Route 3 – Bus + Train + Bus',
      totalDistance: 95.0,
      totalDuration: 120,
      totalTransfers: 2,
      totalFare: 95.0,
      via: 'Railway Station X',
      highway: 'Rural Feeder Road & South Central Railway',
      villages: ['Village A', 'Railway Station X', 'Ongole Railway Station', 'Final Destination'],
      segments: [
        {
          from: 'Village A',
          to: 'Railway Station X',
          mode: 'bus',
          distance: 12.0,
          duration: 20,
          price: 20.0,
          departureTime: '07:20',
          arrivalTime: '07:40',
          provider: 'APSRTC Rural Feeder',
          serviceName: 'Palle Velugu Feeder (Route PV-VLA-RSX)',
          stops: 'Village A, Station Road, Railway Station X'
        },
        {
          from: 'Railway Station X',
          to: 'Ongole Railway Station',
          mode: 'train',
          distance: 78.0,
          duration: 70,
          price: 60.0,
          departureTime: '08:00',
          arrivalTime: '09:10',
          provider: 'Indian Railways',
          serviceName: 'Express Train (Train #17281)',
          stops: 'Medarmetla Halt, Maddipadu, Ongole Railway Station'
        },
        {
          from: 'Ongole Railway Station',
          to: 'Final Destination',
          mode: 'bus',
          distance: 5.0,
          duration: 15,
          price: 15.0,
          departureTime: '09:20',
          arrivalTime: '09:35',
          provider: 'APSRTC City Feeder',
          serviceName: 'Local Bus (Route CITY-OGL-LOCAL)',
          stops: 'Ongole Railway Station, Collectorate, Final Destination'
        }
      ],
      transfers: [
        {
          location: 'Railway Station X',
          previousTransport: 'bus',
          nextTransport: 'train',
          distance: 0,
          duration: 20,
          price: 0,
          notes: 'Get down from Bus at Railway Station X. Board Train #17281 to Ongole Railway Station.'
        },
        {
          location: 'Ongole Railway Station',
          previousTransport: 'train',
          nextTransport: 'bus',
          distance: 0,
          duration: 10,
          price: 0,
          notes: 'Get down at Ongole Railway Station. Board Local Bus to Final Destination.'
        }
      ]
    },

    // 2. Village A -> Ongole (City level destination)
    {
      routeId: 'rt-vla-ong-bus-train',
      source: 'Village A',
      destination: 'Ongole',
      transportType: 'bus_train',
      routeName: 'Route 1 – Bus + Train',
      totalDistance: 98.0,
      totalDuration: 110,
      totalTransfers: 2,
      totalFare: 130.0,
      via: 'Town X',
      highway: 'SH 45 & Grand Trunk Corridor',
      villages: ['Village A', 'Village A Bus Stop', 'Town X', 'Ongole'],
      segments: [
        {
          from: 'Village A',
          to: 'Town X Bus Stand',
          mode: 'bus',
          distance: 15.0,
          duration: 25,
          price: 25.0,
          departureTime: '07:15',
          arrivalTime: '07:40',
          provider: 'APSRTC Palle Velugu',
          serviceName: 'Palle Velugu (Route PV-VLA-TNX)',
          stops: 'Village A, Village A Bus Stop, Town X Bus Stand'
        },
        {
          from: 'Town X Bus Stand',
          to: 'Town X Railway Station',
          mode: 'auto',
          distance: 3.0,
          duration: 10,
          price: 40.0,
          departureTime: '07:45',
          arrivalTime: '07:55',
          provider: 'Local Auto',
          serviceName: 'Auto / Cab Shuttle',
          stops: 'Town X Station Road'
        },
        {
          from: 'Town X Railway Station',
          to: 'Ongole Railway Station',
          mode: 'train',
          distance: 80.0,
          duration: 75,
          price: 65.0,
          departureTime: '08:30',
          arrivalTime: '09:45',
          provider: 'Indian Railways',
          serviceName: 'Godavari Express (Train #12727)',
          stops: 'Railway Station X, Medarmetla, Maddipadu'
        }
      ],
      transfers: [
        {
          location: 'Town X Bus Stand',
          previousTransport: 'bus',
          nextTransport: 'auto',
          distance: 3.0,
          duration: 10,
          price: 40.0,
          notes: 'Get down at Town X Bus Stand. Travel 3 km by Auto to Town X Railway Station.'
        },
        {
          location: 'Town X Railway Station',
          previousTransport: 'auto',
          nextTransport: 'train',
          distance: 0,
          duration: 20,
          price: 0,
          notes: 'Board train #12727 Godavari Express from Town X Railway Station to Ongole Railway Station.'
        }
      ]
    },
    {
      routeId: 'rt-vla-ong-bus-only',
      source: 'Village A',
      destination: 'Ongole',
      transportType: 'bus_only',
      routeName: 'Route 2 – Bus Only',
      totalDistance: 100.0,
      totalDuration: 135,
      totalTransfers: 1,
      totalFare: 130.0,
      via: 'Town Y',
      highway: 'SH 45 & NH 16 Corridor',
      villages: ['Village A', 'Town Y', 'Ongole'],
      segments: [
        {
          from: 'Village A',
          to: 'Town Y',
          mode: 'bus',
          distance: 40.0,
          duration: 50,
          price: 50.0,
          departureTime: '07:00',
          arrivalTime: '07:50',
          provider: 'APSRTC Express',
          serviceName: 'Express (Route PV-VLA-TNY)',
          stops: 'Village A, Korisapadu Cross, Town Y'
        },
        {
          from: 'Town Y',
          to: 'Ongole',
          mode: 'bus',
          distance: 60.0,
          duration: 70,
          price: 80.0,
          departureTime: '08:05',
          arrivalTime: '09:15',
          provider: 'APSRTC Super Luxury',
          serviceName: 'Super Luxury (Route EXP-TNY-OGL)',
          stops: 'Town Y Bus Stand, Medarmetla, Maddipadu, Ongole Bus Stand'
        }
      ],
      transfers: [
        {
          location: 'Town Y Bus Stand',
          previousTransport: 'bus',
          nextTransport: 'bus',
          distance: 0,
          duration: 15,
          price: 0,
          notes: 'Get down at Town Y Bus Stand. Change to connecting Super Luxury bus to Ongole.'
        }
      ]
    },
    {
      routeId: 'rt-vla-ong-bus-train-bus',
      source: 'Village A',
      destination: 'Ongole',
      transportType: 'bus_train_bus',
      routeName: 'Route 3 – Bus + Train + Bus',
      totalDistance: 95.0,
      totalDuration: 120,
      totalTransfers: 2,
      totalFare: 95.0,
      via: 'Railway Station X',
      highway: 'Rural Feeder Road & South Central Railway',
      villages: ['Village A', 'Railway Station X', 'Ongole Railway Station', 'Final Destination'],
      segments: [
        {
          from: 'Village A',
          to: 'Railway Station X',
          mode: 'bus',
          distance: 12.0,
          duration: 20,
          price: 20.0,
          departureTime: '07:20',
          arrivalTime: '07:40',
          provider: 'APSRTC Rural Feeder',
          serviceName: 'Palle Velugu Feeder (Route PV-VLA-RSX)',
          stops: 'Village A, Station Road, Railway Station X'
        },
        {
          from: 'Railway Station X',
          to: 'Ongole Railway Station',
          mode: 'train',
          distance: 78.0,
          duration: 70,
          price: 60.0,
          departureTime: '08:00',
          arrivalTime: '09:10',
          provider: 'Indian Railways',
          serviceName: 'Express Train (Train #17281)',
          stops: 'Medarmetla Halt, Maddipadu, Ongole Railway Station'
        },
        {
          from: 'Ongole Railway Station',
          to: 'Final Destination',
          mode: 'bus',
          distance: 5.0,
          duration: 15,
          price: 15.0,
          departureTime: '09:20',
          arrivalTime: '09:35',
          provider: 'APSRTC City Feeder',
          serviceName: 'Local Bus (Route CITY-OGL-LOCAL)',
          stops: 'Ongole Railway Station, Collectorate, Final Destination'
        }
      ],
      transfers: [
        {
          location: 'Railway Station X',
          previousTransport: 'bus',
          nextTransport: 'train',
          distance: 0,
          duration: 20,
          price: 0,
          notes: 'Get down from Bus at Railway Station X. Board Train #17281 to Ongole Railway Station.'
        },
        {
          location: 'Ongole Railway Station',
          previousTransport: 'train',
          nextTransport: 'bus',
          distance: 0,
          duration: 10,
          price: 0,
          notes: 'Get down at Ongole Railway Station. Board Local Bus to Final Destination.'
        }
      ]
    },

    // 3. Village A -> City B
    {
      routeId: 'rt-vla-ctyb-bus-train',
      source: 'Village A',
      destination: 'City B',
      transportType: 'bus_train',
      routeName: 'Route 1 – Bus + Train',
      totalDistance: 106.7,
      totalDuration: 135,
      totalTransfers: 3,
      totalFare: 170.0,
      via: 'Town X',
      highway: 'State Highway & Coastal Railway Line',
      villages: ['Village A', 'Village A Bus Stop', 'Town X Bus Stand', 'Town X Railway Station', 'City B Railway Station', 'City B'],
      segments: [
        {
          from: 'Village A',
          to: 'Village A Bus Stop',
          mode: 'walking',
          distance: 1.2,
          duration: 15,
          price: 0,
          departureTime: '07:00',
          arrivalTime: '07:15',
          provider: 'Walking',
          serviceName: 'Pedestrian Walkway',
          stops: null
        },
        {
          from: 'Village A Bus Stop',
          to: 'Town X Bus Stand',
          mode: 'bus',
          distance: 15.0,
          duration: 25,
          price: 25.0,
          departureTime: '07:20',
          arrivalTime: '07:45',
          provider: 'APSRTC Palle Velugu',
          serviceName: 'Palle Velugu (Route PV-VLA-TNX)',
          stops: 'Village A Bus Stop, Town X Bus Stand'
        },
        {
          from: 'Town X Bus Stand',
          to: 'Town X Railway Station',
          mode: 'auto',
          distance: 3.0,
          duration: 10,
          price: 40.0,
          departureTime: '07:50',
          arrivalTime: '08:00',
          provider: 'Local Auto',
          serviceName: 'Town Auto / Cab',
          stops: null
        },
        {
          from: 'Town X Railway Station',
          to: 'City B Railway Station',
          mode: 'train',
          distance: 85.0,
          duration: 75,
          price: 70.0,
          departureTime: '09:00',
          arrivalTime: '10:15',
          provider: 'Indian Railways',
          serviceName: 'Pinakini Intercity (Train #12711)',
          stops: 'Direct Intercity Halt'
        },
        {
          from: 'City B Railway Station',
          to: 'City B',
          mode: 'auto',
          distance: 2.5,
          duration: 10,
          price: 35.0,
          departureTime: '10:20',
          arrivalTime: '10:30',
          provider: 'Local Auto',
          serviceName: 'City Auto / Cab',
          stops: null
        }
      ],
      transfers: [
        {
          location: 'Village A Bus Stop',
          previousTransport: 'walking',
          nextTransport: 'bus',
          distance: 0,
          duration: 5,
          price: 0,
          notes: 'Walk 1.2 km from Village A to Village A Bus Stop. Board bus to Town X Bus Stand.'
        },
        {
          location: 'Town X Bus Stand',
          previousTransport: 'bus',
          nextTransport: 'auto',
          distance: 3.0,
          duration: 10,
          price: 40.0,
          notes: 'Get down at Town X Bus Stand. Travel 3 km by Auto to Town X Railway Station.'
        },
        {
          location: 'City B Railway Station',
          previousTransport: 'train',
          nextTransport: 'auto',
          distance: 2.5,
          duration: 10,
          price: 35.0,
          notes: 'Get down at City B Railway Station. Take Local Auto or City Bus to City B destination.'
        }
      ]
    },
    {
      routeId: 'rt-vla-ctyb-bus-only',
      source: 'Village A',
      destination: 'City B',
      transportType: 'bus_only',
      routeName: 'Route 2 – Bus Only',
      totalDistance: 105.0,
      totalDuration: 140,
      totalTransfers: 1,
      totalFare: 135.0,
      via: 'Town Y',
      highway: 'SH 45 & NH 16 Expressway',
      villages: ['Village A', 'Town Y', 'City B Bus Stand', 'City B'],
      segments: [
        {
          from: 'Village A',
          to: 'Town Y',
          mode: 'bus',
          distance: 40.0,
          duration: 50,
          price: 50.0,
          departureTime: '07:15',
          arrivalTime: '08:05',
          provider: 'APSRTC Express',
          serviceName: 'Express (Route PV-VLA-TNY)',
          stops: 'Village A, Town Y'
        },
        {
          from: 'Town Y',
          to: 'City B',
          mode: 'bus',
          distance: 65.0,
          duration: 75,
          price: 85.0,
          departureTime: '08:20',
          arrivalTime: '09:35',
          provider: 'APSRTC Express',
          serviceName: 'Super Luxury (Route EXP-TNY-CTYB)',
          stops: 'Town Y, City B Bus Stand, City B'
        }
      ],
      transfers: [
        {
          location: 'Town Y Bus Stand',
          previousTransport: 'bus',
          nextTransport: 'bus',
          distance: 0,
          duration: 15,
          price: 0,
          notes: 'Get down at Town Y Bus Stand. Change to connecting bus to City B.'
        }
      ]
    },
    {
      routeId: 'rt-vla-ctyb-station-z',
      source: 'Village A',
      destination: 'City B',
      transportType: 'bus_train',
      routeName: 'Route 3 – Bus + Train',
      totalDistance: 88.0,
      totalDuration: 105,
      totalTransfers: 1,
      totalFare: 80.0,
      via: 'Railway Station Z',
      highway: 'Rural Feeder Road & Coastal Rail Corridor',
      villages: ['Village A', 'Railway Station Z', 'City B Railway Station', 'City B'],
      segments: [
        {
          from: 'Village A',
          to: 'Railway Station Z',
          mode: 'bus',
          distance: 18.0,
          duration: 25,
          price: 25.0,
          departureTime: '09:00',
          arrivalTime: '09:25',
          provider: 'APSRTC Feeder',
          serviceName: 'Palle Velugu Feeder (Route PV-VLA-RSZ)',
          stops: 'Village A, Railway Station Z'
        },
        {
          from: 'Railway Station Z',
          to: 'City B',
          mode: 'train',
          distance: 70.0,
          duration: 65,
          price: 55.0,
          departureTime: '10:00',
          arrivalTime: '11:05',
          provider: 'Indian Railways',
          serviceName: 'Simhadri Intercity (Train #17239)',
          stops: 'Direct Express Halt to City B'
        }
      ],
      transfers: [
        {
          location: 'Railway Station Z',
          previousTransport: 'bus',
          nextTransport: 'train',
          distance: 0,
          duration: 35,
          price: 0,
          notes: 'Get down at Railway Station Z. Board train #17239 Simhadri Intercity to City B.'
        }
      ]
    },

    // 4. Narasaraopet -> Ongole
    {
      routeId: 'rt-nrt-ong-bus-train',
      source: 'Narasaraopet',
      destination: 'Ongole',
      transportType: 'bus_train',
      routeName: 'Route 1 – Bus + Train',
      totalDistance: 146.0,
      totalDuration: 145,
      totalTransfers: 1,
      totalFare: 130.0,
      via: 'Chilakaluripeta',
      highway: 'SH 45 & Grand Trunk Coastal Line',
      villages: ['Narasaraopet', 'Kakani', 'Nadendla', 'Chilakaluripeta', 'Bapatla', 'Chirala', 'Ongole'],
      segments: [
        {
          from: 'Narasaraopet Bus Station',
          to: 'Chilakaluripeta Bus Stand',
          mode: 'bus',
          distance: 45.0,
          duration: 55,
          price: 45.0,
          departureTime: '07:30',
          arrivalTime: '08:25',
          provider: 'APSRTC Express',
          serviceName: 'Express',
          stops: 'Kakani, Nadendla, Chilakaluripeta'
        },
        {
          from: 'Chilakaluripeta Bus Stand',
          to: 'Ongole Railway Station',
          mode: 'bus',
          distance: 51.0,
          duration: 60,
          price: 70.0,
          departureTime: '08:40',
          arrivalTime: '09:40',
          provider: 'APSRTC Super Luxury',
          serviceName: 'Super Luxury',
          stops: 'Purushothapatnam, Martur, Medarmetla, Maddipadu'
        }
      ],
      transfers: [
        {
          location: 'Chilakaluripeta Bus Stand',
          previousTransport: 'bus',
          nextTransport: 'bus',
          distance: 0,
          duration: 15,
          price: 0,
          notes: 'Get down at Chilakaluripeta Bus Stand. Board connecting Super Luxury bus to Ongole.'
        }
      ]
    },

    // 5. Village A -> City D (Benchmark Flow Options 1, 2, 3, 4, 5)
    {
      routeId: 'rt-vla-ctyd-opt1-bus-train',
      source: 'Village A',
      destination: 'City D',
      transportType: 'bus_train',
      routeName: 'Route 1 – Bus + Train',
      totalDistance: 48.0,
      totalDuration: 75,
      totalTransfers: 2,
      totalFare: 102.0,
      via: 'Town B',
      highway: 'Rural Feeder Road & Coastal Rail Corridor',
      villages: ['Village A', 'Village A Bus Stop', 'Town B', 'City D Railway Station', 'City D'],
      segments: [
        {
          from: 'Village A',
          to: 'Town B Bus Stand',
          mode: 'bus',
          distance: 14.0,
          duration: 25,
          price: 22.0,
          departureTime: '08:00',
          arrivalTime: '08:25',
          provider: 'APSRTC Palle Velugu',
          serviceName: 'Palle Velugu Feeder (Route PV-VLA-TNB)',
          stops: 'Village A, Village A Bus Stop, Town B Bus Stand'
        },
        {
          from: 'Town B Bus Stand',
          to: 'Town B Railway Station',
          mode: 'auto',
          distance: 2.5,
          duration: 8,
          price: 35.0,
          departureTime: '08:30',
          arrivalTime: '08:38',
          provider: 'Local Auto',
          serviceName: 'Auto / Cab Shuttle',
          stops: 'Town B Station Road'
        },
        {
          from: 'Town B Railway Station',
          to: 'City D Railway Station',
          mode: 'train',
          distance: 30.0,
          duration: 25,
          price: 45.0,
          departureTime: '09:15',
          arrivalTime: '09:40',
          provider: 'Indian Railways',
          serviceName: 'Pinakini Express (Train #12711)',
          stops: 'Direct Rail Line to City D'
        }
      ],
      transfers: [
        {
          location: 'Town B Bus Stand',
          previousTransport: 'bus',
          nextTransport: 'auto',
          distance: 2.5,
          duration: 8,
          price: 35.0,
          notes: 'Get down at Town B Bus Stand. Take 2.5 km Auto shuttle to Town B Railway Station.'
        },
        {
          location: 'Town B Railway Station',
          previousTransport: 'auto',
          nextTransport: 'train',
          distance: 0,
          duration: 20,
          price: 0,
          notes: 'Board Train #12711 Pinakini Express from Town B Railway Station to City D Railway Station.'
        }
      ]
    },
    {
      routeId: 'rt-vla-ctyd-opt2-bus-only',
      source: 'Village A',
      destination: 'City D',
      transportType: 'bus_only',
      routeName: 'Route 2 – Bus Only',
      totalDistance: 60.0,
      totalDuration: 95,
      totalTransfers: 1,
      totalFare: 85.0,
      via: 'Town C',
      highway: 'State Highway 45 & Regional Express Road',
      villages: ['Village A', 'Village A Bus Stop', 'Town C', 'Town C Bus Stand', 'City D'],
      segments: [
        {
          from: 'Village A',
          to: 'Town C Bus Stand',
          mode: 'bus',
          distance: 22.0,
          duration: 35,
          price: 30.0,
          departureTime: '07:30',
          arrivalTime: '08:05',
          provider: 'APSRTC Palle Velugu',
          serviceName: 'Palle Velugu (Route PV-VLA-TNC)',
          stops: 'Village A, Village A Bus Stop, Town C Bus Stand'
        },
        {
          from: 'Town C Bus Stand',
          to: 'City D',
          mode: 'bus',
          distance: 38.0,
          duration: 50,
          price: 55.0,
          departureTime: '08:20',
          arrivalTime: '09:10',
          provider: 'APSRTC Express',
          serviceName: 'Express (Route EXP-TNC-CTYD)',
          stops: 'Town C Bus Stand, City D Bus Stand, City D'
        }
      ],
      transfers: [
        {
          location: 'Town C Bus Stand',
          previousTransport: 'bus',
          nextTransport: 'bus',
          distance: 0,
          duration: 15,
          price: 0,
          notes: 'Get down at Town C Bus Stand. Board connecting Express bus directly to City D.'
        }
      ]
    },
    {
      routeId: 'rt-vla-ctyd-opt3-bus-train-bus',
      source: 'Village A',
      destination: 'City D',
      transportType: 'bus_train_bus',
      routeName: 'Route 3 – Bus + Train + Bus',
      totalDistance: 57.0,
      totalDuration: 90,
      totalTransfers: 2,
      totalFare: 90.0,
      via: 'Railway Station X & Y',
      highway: 'Rural Transit Link & South Central Rail Line',
      villages: ['Village A', 'Railway Station X', 'Railway Station Y', 'City D'],
      segments: [
        {
          from: 'Village A',
          to: 'Railway Station X',
          mode: 'bus',
          distance: 12.0,
          duration: 20,
          price: 20.0,
          departureTime: '08:00',
          arrivalTime: '08:20',
          provider: 'APSRTC Rural Feeder',
          serviceName: 'Palle Velugu Feeder (Route PV-VLA-RSX)',
          stops: 'Village A, Railway Station X'
        },
        {
          from: 'Railway Station X',
          to: 'Railway Station Y',
          mode: 'train',
          distance: 42.0,
          duration: 38,
          price: 55.0,
          departureTime: '08:50',
          arrivalTime: '09:28',
          provider: 'Indian Railways',
          serviceName: 'Simhadri Express (Train #17239)',
          stops: 'Direct Rail Corridor'
        },
        {
          from: 'Railway Station Y',
          to: 'City D',
          mode: 'bus',
          distance: 3.0,
          duration: 10,
          price: 15.0,
          departureTime: '09:40',
          arrivalTime: '09:50',
          provider: 'APSRTC City Feeder',
          serviceName: 'Local City Bus (Route CITY-RSY-CTYD)',
          stops: 'Railway Station Y, City D Center'
        }
      ],
      transfers: [
        {
          location: 'Railway Station X',
          previousTransport: 'bus',
          nextTransport: 'train',
          distance: 0,
          duration: 25,
          price: 0,
          notes: 'Get down from Bus at Railway Station X. Board Train #17239 Simhadri Express to Railway Station Y.'
        },
        {
          location: 'Railway Station Y',
          previousTransport: 'train',
          nextTransport: 'bus',
          distance: 0,
          duration: 12,
          price: 0,
          notes: 'Get down at Railway Station Y. Board Local City Bus to City D destination.'
        }
      ]
    },
    {
      routeId: 'rt-vla-ctyd-opt4-multi-stage-bus',
      source: 'Village A',
      destination: 'City D',
      transportType: 'bus_only',
      routeName: 'Route 4 – Multi-Stage Bus',
      totalDistance: 61.0,
      totalDuration: 110,
      totalTransfers: 2,
      totalFare: 95.0,
      via: 'Village B & Town C',
      highway: 'Rural Panchayati Link & State Highway 45',
      villages: ['Village A', 'Village B', 'Town C', 'City D'],
      segments: [
        {
          from: 'Village A',
          to: 'Village B',
          mode: 'bus',
          distance: 7.0,
          duration: 15,
          price: 15.0,
          departureTime: '07:15',
          arrivalTime: '07:30',
          provider: 'APSRTC Palle Velugu',
          serviceName: 'Palle Velugu Feeder (Route PV-VLA-VLB)',
          stops: 'Village A, Village A Bus Stop, Village B'
        },
        {
          from: 'Village B',
          to: 'Town C Bus Stand',
          mode: 'bus',
          distance: 16.0,
          duration: 25,
          price: 25.0,
          departureTime: '07:45',
          arrivalTime: '08:10',
          provider: 'APSRTC Palle Velugu',
          serviceName: 'Palle Velugu Feeder (Route PV-VLB-TNC)',
          stops: 'Village B, Town C Bus Stand'
        },
        {
          from: 'Town C Bus Stand',
          to: 'City D',
          mode: 'bus',
          distance: 38.0,
          duration: 50,
          price: 55.0,
          departureTime: '08:25',
          arrivalTime: '09:15',
          provider: 'APSRTC Express',
          serviceName: 'Express (Route EXP-TNC-CTYD)',
          stops: 'Town C Bus Stand, City D'
        }
      ],
      transfers: [
        {
          location: 'Village B',
          previousTransport: 'bus',
          nextTransport: 'bus',
          distance: 0,
          duration: 15,
          price: 0,
          notes: 'Get down at Village B. Transfer to connecting rural feeder bus to Town C Bus Stand.'
        },
        {
          location: 'Town C Bus Stand',
          previousTransport: 'bus',
          nextTransport: 'bus',
          distance: 0,
          duration: 15,
          price: 0,
          notes: 'Get down at Town C Bus Stand. Board Express bus directly to City D.'
        }
      ]
    },
    {
      routeId: 'rt-vla-ctyd-opt5-connecting-trains',
      source: 'Village A',
      destination: 'City D',
      transportType: 'bus_train',
      routeName: 'Route 5 – Connecting Trains',
      totalDistance: 72.8,
      totalDuration: 125,
      totalTransfers: 3,
      totalFare: 150.0,
      via: 'Town C & Railway Station D',
      highway: 'SH 45 & SCR Railway Intercity Line',
      villages: ['Village A', 'Town C', 'Railway Station D', 'City D'],
      segments: [
        {
          from: 'Village A',
          to: 'Town C',
          mode: 'bus',
          distance: 22.0,
          duration: 35,
          price: 30.0,
          departureTime: '07:15',
          arrivalTime: '07:50',
          provider: 'APSRTC Palle Velugu',
          serviceName: 'Palle Velugu (Route PV-VLA-TNC)',
          stops: 'Village A, Town C'
        },
        {
          from: 'Town C',
          to: 'Town C Railway Station',
          mode: 'auto',
          distance: 2.8,
          duration: 10,
          price: 40.0,
          departureTime: '07:55',
          arrivalTime: '08:05',
          provider: 'Local Auto',
          serviceName: 'Town Auto Shuttle',
          stops: 'Town C Main Road'
        },
        {
          from: 'Town C Railway Station',
          to: 'Railway Station D',
          mode: 'train',
          distance: 36.0,
          duration: 30,
          price: 50.0,
          departureTime: '08:30',
          arrivalTime: '09:00',
          provider: 'Indian Railways',
          serviceName: 'Express Service (Train #17281)',
          stops: 'Direct Rail Line to Railway Station D'
        },
        {
          from: 'Railway Station D',
          to: 'City D Railway Station',
          mode: 'train',
          distance: 12.0,
          duration: 15,
          price: 30.0,
          departureTime: '09:25',
          arrivalTime: '09:40',
          provider: 'Indian Railways',
          serviceName: 'Godavari Connecting Express (Train #12727)',
          stops: 'City D Railway Station'
        }
      ],
      transfers: [
        {
          location: 'Town C',
          previousTransport: 'bus',
          nextTransport: 'auto',
          distance: 2.8,
          duration: 10,
          price: 40.0,
          notes: 'Get down from Bus at Town C. Take 2.8 km Auto shuttle to Town C Railway Station.'
        },
        {
          location: 'Town C Railway Station',
          previousTransport: 'auto',
          nextTransport: 'train',
          distance: 0,
          duration: 25,
          price: 0,
          notes: 'Board Train #17281 from Town C Railway Station to Railway Station D.'
        },
        {
          location: 'Railway Station D',
          previousTransport: 'train',
          nextTransport: 'train',
          distance: 0,
          duration: 25,
          price: 0,
          notes: 'Get down at Railway Station D. Change platforms and board connecting Train #12727 to City D Railway Station.'
        }
      ]
    },

    // 6. Village A -> City C (Bus + Train + Bus Journey)
    {
      routeId: 'rt-vla-ctyc-bus-train-bus',
      source: 'Village A',
      destination: 'City C',
      transportType: 'bus_train_bus',
      routeName: 'Route 1 – Bus + Train + Bus',
      totalDistance: 56.7,
      totalDuration: 95,
      totalTransfers: 4,
      totalFare: 122.0,
      via: 'Town B & City C Railway Station',
      highway: 'Rural Panchayati Link & SCR South Trunk Line',
      villages: ['Village A', 'Village A Bus Stop', 'Town B', 'City C Railway Station', 'Final Destination'],
      segments: [
        {
          from: 'Village A',
          to: 'Village A Bus Stop',
          mode: 'walking',
          distance: 1.2,
          duration: 14,
          price: 0,
          departureTime: null,
          arrivalTime: null,
          provider: 'Walking',
          serviceName: 'Pedestrian Access Walk',
          stops: null
        },
        {
          from: 'Village A Bus Stop',
          to: 'Town B Bus Stand',
          mode: 'bus',
          distance: 14.0,
          duration: 25,
          price: 22.0,
          departureTime: '08:00',
          arrivalTime: '08:25',
          provider: 'APSRTC Palle Velugu',
          serviceName: 'Palle Velugu Feeder (Route PV-VLA-TNB)',
          stops: 'Village A Bus Stop, Town B Bus Stand'
        },
        {
          from: 'Town B Bus Stand',
          to: 'Town B Railway Station',
          mode: 'auto',
          distance: 2.5,
          duration: 8,
          price: 35.0,
          departureTime: '08:30',
          arrivalTime: '08:38',
          provider: 'Local Auto',
          serviceName: 'Auto / Cab Shuttle',
          stops: 'Town B Station Road'
        },
        {
          from: 'Town B Railway Station',
          to: 'City C Railway Station',
          mode: 'train',
          distance: 35.0,
          duration: 30,
          price: 50.0,
          departureTime: '09:10',
          arrivalTime: '09:40',
          provider: 'Indian Railways',
          serviceName: 'Janmabhoomi Express (Train #12805)',
          stops: 'Direct Rail Line to City C'
        },
        {
          from: 'City C Railway Station',
          to: 'Final Destination',
          mode: 'bus',
          distance: 4.0,
          duration: 12,
          price: 15.0,
          departureTime: '09:50',
          arrivalTime: '10:02',
          provider: 'APSRTC City Feeder',
          serviceName: 'Local City Bus (Route CITY-CTC-DEST)',
          stops: 'City C Railway Station, IT Hub, Final Destination'
        }
      ],
      transfers: [
        {
          location: 'Village A Bus Stop',
          previousTransport: 'walking',
          nextTransport: 'bus',
          distance: 0,
          duration: 5,
          price: 0,
          notes: 'Walk 1.2 km from Village A to Village A Bus Stop. Board Palle Velugu bus to Town B Bus Stand.'
        },
        {
          location: 'Town B Bus Stand',
          previousTransport: 'bus',
          nextTransport: 'auto',
          distance: 2.5,
          duration: 8,
          price: 35.0,
          notes: 'Get down at Town B Bus Stand. Take 2.5 km Auto shuttle to Town B Railway Station.'
        },
        {
          location: 'Town B Railway Station',
          previousTransport: 'auto',
          nextTransport: 'train',
          distance: 0,
          duration: 20,
          price: 0,
          notes: 'Board Train #12805 Janmabhoomi Express from Town B Railway Station to City C Railway Station.'
        },
        {
          location: 'City C Railway Station',
          previousTransport: 'train',
          nextTransport: 'bus',
          distance: 0,
          duration: 10,
          price: 0,
          notes: 'Get down at City C Railway Station. Board Local City Bus to Final Destination.'
        }
      ]
    }
  ];

  for (const r of BENCHMARK_ROUTES) {
    insertRoute.run(
      r.routeId,
      r.source,
      r.destination,
      r.transportType,
      r.routeName,
      r.totalDistance,
      r.totalDuration,
      r.totalTransfers,
      r.totalFare,
      r.via,
      r.highway || null,
      JSON.stringify(r.villages)
    );

    r.segments.forEach((seg, sIdx) => {
      insertSegment.run(
        `${r.routeId}-seg-${sIdx + 1}`,
        r.routeId,
        seg.from,
        seg.to,
        seg.mode,
        seg.distance,
        seg.duration,
        seg.price,
        sIdx + 1,
        seg.departureTime || null,
        seg.arrivalTime || null,
        seg.provider,
        seg.serviceName,
        seg.stops || null
      );
    });

    r.transfers.forEach((tr, tIdx) => {
      insertTransfer.run(
        `${r.routeId}-tr-${tIdx + 1}`,
        r.routeId,
        tr.location,
        tr.previousTransport,
        tr.nextTransport,
        tr.distance || 0,
        tr.duration || 10,
        tr.price || 0,
        tr.notes,
        tIdx + 1
      );
    });
  }
}

export function getStoredMultiModalRoutes(from, to, passengers = 1) {
  const normFrom = from.trim().toLowerCase();
  const normTo = to.trim().toLowerCase();

  const routes = db.prepare(`
    SELECT * FROM routes
    WHERE (LOWER(source) = ? OR LOWER(source) LIKE ? OR ? LIKE '%' || LOWER(source) || '%')
      AND (LOWER(destination) = ? OR LOWER(destination) LIKE ? OR ? LIKE '%' || LOWER(destination) || '%')
    ORDER BY total_duration ASC
  `).all(normFrom, `%${normFrom}%`, normFrom, normTo, `%${normTo}%`, normTo);

  const results = [];
  const seenRouteNames = new Set();
  for (const r of routes) {
    if (seenRouteNames.has(r.route_name)) continue;
    seenRouteNames.add(r.route_name);

    const rawSegments = db.prepare(`
      SELECT * FROM route_segments
      WHERE route_id = ?
      ORDER BY sequence_order ASC
    `).all(r.route_id);

    const rawTransfers = db.prepare(`
      SELECT * FROM transfers
      WHERE route_id = ?
      ORDER BY sequence_order ASC
    `).all(r.route_id);

    const segments = rawSegments.map((s) => {
      const segPrice = (s.transport_type === 'train' || s.transport_type === 'bus') ? s.price * passengers : s.price;
      return {
        mode: s.transport_type,
        provider: s.provider || (s.transport_type === 'train' ? 'Indian Railways' : 'APSRTC'),
        from: s.from_stop,
        to: s.to_stop,
        durationMinutes: s.duration,
        distanceKm: s.distance,
        price: segPrice,
        departure: s.departure_time || null,
        arrival: s.arrival_time || null,
        serviceName: s.service_name || null,
        busType: s.transport_type === 'bus' ? (s.service_name?.includes('Palle') ? 'Palle Velugu' : (s.service_name?.includes('Super Luxury') ? 'Super Luxury' : 'Express')) : null,
        trainName: s.transport_type === 'train' ? s.service_name : null,
        trainNumber: s.transport_type === 'train' ? (s.service_name?.match(/#(\d+)/)?.[1] || '12727') : null,
        stops: s.stops || null,
        fareAvailable: true,
        estimated: false
      };
    });

    const transfersList = rawTransfers.map((t, idx) => ({
      transferNumber: idx + 1,
      location: t.location,
      fromMode: t.previous_transport,
      toMode: t.next_transport,
      nextBoardingPoint: segments[idx + 1]?.from || t.location,
      transferMode: t.distance > 0 ? (t.distance <= 1.5 ? 'walking' : 'auto') : 'station_platform',
      transferDistanceKm: t.distance || 0,
      transferDurationMinutes: t.duration || 10,
      transferPrice: t.price || 0,
      instruction: t.notes || `Transfer from ${t.previous_transport} to ${t.next_transport} at ${t.location}.`
    }));

    const totalPrice = segments.reduce((sum, s) => sum + s.price, 0);
    const totalDist = Math.round(segments.reduce((sum, s) => sum + s.distanceKm, 0) * 10) / 10;
    let villages = [r.source, r.destination];
    try {
      if (r.villages) villages = JSON.parse(r.villages);
    } catch (_) {}

    results.push({
      id: `${r.route_id}-${Date.now()}-${Math.random().toString(36).substring(7)}`,
      from: r.source,
      to: r.destination,
      routeName: r.route_name || `Via ${r.via || 'Direct'}`,
      via: r.via || null,
      highway: r.highway || null,
      villages,
      distanceKm: totalDist,
      totalPrice,
      totalDurationMinutes: r.total_duration,
      totalTransfers: r.total_transfers,
      tag: null,
      source: 'stored_database',
      segments,
      transfers: transfersList
    });
  }

  return results;
}

export function saveStoredMultiModalRoute(data) {
  if (!data || !data.source || !data.destination || !data.segments?.length) return null;
  const cleanId = data.routeId || `rt-${data.source.toLowerCase().replace(/[^a-z0-9]/g, '-')}-${data.destination.toLowerCase().replace(/[^a-z0-9]/g, '-')}-${Date.now()}`;
  
  db.prepare(`
    INSERT OR REPLACE INTO routes (route_id, source, destination, transport_type, route_name, total_distance, total_duration, total_transfers, total_fare, via, highway, villages)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    cleanId,
    data.source,
    data.destination,
    data.transportType || 'multimodal',
    data.routeName || `Via ${data.via || 'Direct'}`,
    data.totalDistance || 0,
    data.totalDuration || 60,
    data.totalTransfers || Math.max(0, data.segments.length - 1),
    data.totalFare || 0,
    data.via || null,
    data.highway || null,
    JSON.stringify(data.villages || [data.source, data.destination])
  );

  data.segments.forEach((seg, sIdx) => {
    db.prepare(`
      INSERT OR REPLACE INTO route_segments (segment_id, route_id, from_stop, to_stop, transport_type, distance, duration, price, sequence_order, departure_time, arrival_time, provider, service_name, stops)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      `${cleanId}-seg-${sIdx + 1}`,
      cleanId,
      seg.from,
      seg.to,
      seg.mode,
      seg.distanceKm || 0,
      seg.durationMinutes || 0,
      seg.price || 0,
      sIdx + 1,
      seg.departure || null,
      seg.arrival || null,
      seg.provider || null,
      seg.serviceName || seg.busType || seg.trainName || null,
      seg.stops || null
    );
  });

  return cleanId;
}

export function getTransportStops(query = '', type = '') {
  let sql = 'SELECT * FROM transport_stops WHERE 1=1';
  const params = [];
  if (query) {
    sql += ' AND (LOWER(name) LIKE ? OR stop_id LIKE ?)';
    params.push(`%${query.toLowerCase()}%`, `%${query.toLowerCase()}%`);
  }
  if (type) {
    sql += ' AND LOWER(type) = ?';
    params.push(type.toLowerCase());
  }
  sql += ' ORDER BY name LIMIT 50';
  return db.prepare(sql).all(...params);
}

export function getDistance(lat1, lon1, lat2, lon2) {
  const R = 6371; // km
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLon = (lon2 - lon1) * Math.PI / 180;
  const a = Math.sin(dLat / 2) * Math.sin(dLat / 2) +
            Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) *
            Math.sin(dLon / 2) * Math.sin(dLon / 2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return R * c;
}

export function saveRouteIntermediateLocation(data) {
  if (!data || !data.name || data.latitude === undefined || data.longitude === undefined) return null;
  const routeName = data.associatedRoute ? `${data.associatedRoute.from} -> ${data.associatedRoute.to}` : (data.associated_route || '');
  const cleanId = data.placeId || data.id || `loc-${data.name.toLowerCase().replace(/[^a-z0-9]/g, '-')}-${Math.round(data.latitude * 100)}-${Math.round(data.longitude * 100)}`;
  
  // Calculate nearby bus facilities if not provided
  let nearbyBuses = data.nearby_bus_facilities;
  if (!nearbyBuses) {
    const buses = db.prepare(`SELECT name, latitude, longitude, type FROM locations WHERE type = 'bus'`).all()
      .map(b => ({
        name: b.name,
        type: b.type,
        distanceKm: Math.round(getDistance(data.latitude, data.longitude, b.latitude, b.longitude) * 10) / 10
      }))
      .filter(b => b.distanceKm <= 25)
      .sort((a, b) => a.distanceKm - b.distanceKm)
      .slice(0, 4);
    nearbyBuses = JSON.stringify(buses);
  }

  // Calculate nearby transport points if not provided
  let nearbyTransport = data.nearby_transport_points;
  if (!nearbyTransport) {
    const transports = db.prepare(`SELECT name, latitude, longitude, type FROM locations WHERE type IN ('station', 'airport')`).all()
      .map(t => ({
        name: t.name,
        type: t.type,
        distanceKm: Math.round(getDistance(data.latitude, data.longitude, t.latitude, t.longitude) * 10) / 10
      }))
      .filter(t => t.distanceKm <= 40)
      .sort((a, b) => a.distanceKm - b.distanceKm)
      .slice(0, 3);
    nearbyTransport = JSON.stringify(transports);
  }

  const existing = db.prepare(`
    SELECT * FROM route_intermediate_locations
    WHERE id = ? OR (LOWER(name) = ? AND ABS(latitude - ?) < 0.005 AND ABS(longitude - ?) < 0.005)
    LIMIT 1
  `).get(cleanId, data.name.toLowerCase(), data.latitude, data.longitude);

  let routesList = routeName ? [routeName] : [];
  if (existing?.associated_routes) {
    try {
      const parsed = JSON.parse(existing.associated_routes);
      if (Array.isArray(parsed)) {
        routesList = Array.from(new Set([...parsed, ...routesList]));
      }
    } catch (_) {}
  }

  const upsertStmt = db.prepare(`
    INSERT INTO route_intermediate_locations (
      id, name, latitude, longitude, type, district, region,
      nearby_bus_facilities, nearby_transport_points, associated_routes,
      distance_from_route_km, source, google_place_id, google_maps_uri, retrieved_at
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      associated_routes = excluded.associated_routes,
      distance_from_route_km = MIN(route_intermediate_locations.distance_from_route_km, excluded.distance_from_route_km),
      retrieved_at = excluded.retrieved_at
  `);

  upsertStmt.run(
    existing?.id || cleanId,
    data.name,
    data.latitude,
    data.longitude,
    data.type,
    data.district || existing?.district || 'Andhra Pradesh',
    data.region || existing?.region || 'Andhra Pradesh',
    nearbyBuses,
    nearbyTransport,
    JSON.stringify(routesList),
    data.distanceFromRouteKm !== undefined ? data.distanceFromRouteKm : (data.distance_from_route_km || 0),
    data.source || 'Route Connect Platform',
    data.google_place_id || data.placeId || null,
    data.googleMapsUri || data.google_maps_uri || null,
    data.retrievedAt || data.retrieved_at || new Date().toISOString()
  );

  // Also register in main locations table so autocomplete and search know it
  const locId = `disc-${data.name.toLowerCase().replace(/[^a-z0-9]/g, '-')}`;
  db.prepare(`
    INSERT OR IGNORE INTO locations (id, name, latitude, longitude, district, state, type, source, verified)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    locId,
    data.name,
    data.latitude,
    data.longitude,
    data.district || 'Andhra Pradesh',
    data.region || 'Andhra Pradesh',
    data.type === 'bus_stop' || data.type === 'bus_station' ? 'bus' : (data.type === 'railway_station' || data.type === 'station' ? 'station' : data.type),
    data.source || 'route_discovery',
    1
  );

  return existing?.id || cleanId;
}

export function getStoredIntermediateLocations(routeFilter = '', typeFilter = '') {
  let query = 'SELECT * FROM route_intermediate_locations WHERE 1=1';
  const params = [];
  if (routeFilter) {
    query += ' AND (associated_routes LIKE ? OR LOWER(associated_routes) LIKE ?)';
    params.push(`%${routeFilter}%`, `%${routeFilter.toLowerCase()}%`);
  }
  if (typeFilter) {
    query += ' AND LOWER(type) = ?';
    params.push(typeFilter.toLowerCase());
  }
  query += ' ORDER BY retrieved_at DESC LIMIT 100';
  return db.prepare(query).all(...params);
}

export function findNearbyStoredBusFacilities(lat, lon, maxDistanceKm = 30) {
  const fromLocations = db.prepare(`SELECT id, name, latitude, longitude, type, district FROM locations WHERE type = 'bus'`).all();
  const fromDiscovered = db.prepare(`SELECT id, name, latitude, longitude, type, district FROM route_intermediate_locations WHERE type IN ('bus', 'bus_stop', 'bus_station', 'Bus Stop', 'Bus Station')`).all();
  
  const merged = new Map();
  for (const b of [...fromLocations, ...fromDiscovered]) {
    const key = b.name.toLowerCase().trim();
    if (!merged.has(key)) {
      merged.set(key, b);
    }
  }

  return Array.from(merged.values())
    .map(b => ({
      ...b,
      distanceKm: Math.round(getDistance(lat, lon, b.latitude, b.longitude) * 10) / 10
    }))
    .filter(b => b.distanceKm <= maxDistanceKm)
    .sort((a, b) => a.distanceKm - b.distanceKm);
}


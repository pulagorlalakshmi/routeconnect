// Must stay first: loads .env before any module that reads process.env at import time.
import './env.js';

import express from 'express';
import cors from 'cors';
import bcrypt from 'bcryptjs';
import crypto from 'crypto';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';

import { db, initializeDatabase, getStoredIntermediateLocations, getTransportStops, getStoredMultiModalRoutes } from './db/database.js';
import { searchStoredLocations, resolveLocation, reverseGeocode } from './services/geoService.js';
import { findMultiModalRoutes } from './services/routingEngine.js';
import { getGoogleRouteInsights } from './services/googleMapsService.js';
import { getFlightOptions } from './services/flightService.js';
import { getTransitStatus } from './transit/status.js';
import { handleMultimodalPlanRequest } from './transit/multimodal/planMultimodal.js';
import { getTransitNetwork, reloadTransitNetwork } from './transit/routing/dataLoader.js';
import { getHubMetrics, getConnectivity } from './transit/routing/hubs.js';
import { handlePlaceSearch } from './transit/routing/placeSearch.js';
import { getTransitConfig } from './transit/config.js';
import { ensureTransitData } from './transit/ensureData.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = process.env.PORT || 5000;
const GOOGLE_MAPS_SERVER_KEY = process.env.GOOGLE_MAPS_SERVER_API_KEY || process.env.GOOGLE_MAPS_API_KEY;

// Middleware
app.use(cors());
app.use(express.json());

// Initialize SQLite Database and Static Transit Topology
initializeDatabase();

// User auth statements
const findUserByEmail = db.prepare('SELECT * FROM users WHERE email = ?');
const findUserByPhone = db.prepare('SELECT * FROM users WHERE phone = ?');
const findUserByIdentifier = db.prepare('SELECT * FROM users WHERE email = ? OR phone = ?');
const createUser = db.prepare('INSERT INTO users (name, email, phone, password) VALUES (?, ?, ?, ?)');
const getUserById = db.prepare('SELECT * FROM users WHERE id = ?');
const getLastId = db.prepare('SELECT last_insert_rowid() as id');

// In-memory session store (sessions are lost on server restart)
const sessions = new Map();

// 256-bit cryptographically secure session token
function createSession(data) {
  const token = crypto.randomBytes(32).toString('hex');
  sessions.set(token, data);
  return token;
}

// Session token is read from "Authorization: Bearer <token>" (never from the URL)
function getSessionToken(req) {
  const header = req.headers.authorization || '';
  const match = /^Bearer\s+([A-Za-z0-9]+)$/.exec(header);
  return match ? match[1] : null;
}

// Authentication Endpoints
app.post('/api/auth/signup', async (req, res) => {
  try {
    const { name, email, phone, password, confirmPassword } = req.body;
    const normalizedName = typeof name === 'string' ? name.trim() : '';
    const normalizedEmail = typeof email === 'string' ? email.trim().toLowerCase() : '';
    const normalizedPhone = typeof phone === 'string' ? phone.trim() : '';

    if (!normalizedName || !normalizedEmail || !normalizedPhone || !password || !confirmPassword) {
      return res.status(400).json({ error: 'All fields are required' });
    }
    if (password !== confirmPassword) {
      return res.status(400).json({ error: 'Passwords do not match' });
    }
    if (password.length < 6) {
      return res.status(400).json({ error: 'Password must be at least 6 characters' });
    }
    if (findUserByEmail.get(normalizedEmail)) {
      return res.status(400).json({ error: 'This email is already registered, so sign in' });
    }
    if (findUserByPhone.get(normalizedPhone)) {
      return res.status(400).json({ error: 'This phone number is already registered, so sign in' });
    }

    const hashedPassword = await bcrypt.hash(password, 10);
    createUser.run(normalizedName, normalizedEmail, normalizedPhone, hashedPassword);
    const userId = getLastId.get().id;
    const sessionId = createSession({ userId, email: normalizedEmail, name: normalizedName });

    return res.status(201).json({
      message: 'User registered successfully',
      sessionId,
      user: { id: userId, name: normalizedName, email: normalizedEmail, phone: normalizedPhone }
    });
  } catch (error) {
    console.error('Signup error:', error);
    return res.status(500).json({ error: 'Signup error' });
  }
});

app.post('/api/auth/login', async (req, res) => {
  try {
    const { identifier, password } = req.body;
    const normalizedIdentifier = typeof identifier === 'string' ? identifier.trim() : '';
    const emailIdentifier = normalizedIdentifier.toLowerCase();
    const user = findUserByIdentifier.get(emailIdentifier, normalizedIdentifier);

    if (!user) {
      return res.status(401).json({ error: 'Invalid email/phone or password' });
    }
    const passwordMatch = await bcrypt.compare(password, user.password);
    if (!passwordMatch) {
      return res.status(401).json({ error: 'Invalid email/phone or password' });
    }

    const sessionId = createSession({ userId: user.id, email: user.email, name: user.name });

    return res.status(200).json({
      message: 'Login successful',
      sessionId,
      user: { id: user.id, name: user.name, email: user.email, phone: user.phone }
    });
  } catch (error) {
    console.error('Login error:', error);
    return res.status(500).json({ error: 'Login error' });
  }
});

app.get('/api/auth/profile', (req, res) => {
  const session = sessions.get(getSessionToken(req));
  if (!session) return res.status(401).json({ error: 'Invalid session' });
  const user = getUserById.get(session.userId);
  return res.status(200).json({ user: { id: user.id, name: user.name, email: user.email, phone: user.phone } });
});

app.put('/api/auth/profile', (req, res) => {
  const token = getSessionToken(req);
  const session = sessions.get(token);
  if (!session) return res.status(401).json({ error: 'Invalid session' });
  const { name, email, phone } = req.body;
  db.prepare('UPDATE users SET name = ?, email = ?, phone = ? WHERE id = ?').run(name, email, phone, session.userId);
  sessions.set(token, { ...session, email, name });
  return res.status(200).json({ user: { id: session.userId, name, email, phone } });
});

app.post('/api/auth/logout', (req, res) => {
  const token = getSessionToken(req);
  if (token) sessions.delete(token);
  return res.status(200).json({ message: 'Logged out successfully' });
});

// Location Search & Autocomplete
app.get('/api/locations', (req, res) => {
  try {
    const query = String(req.query.query || '').trim();
    const district = String(req.query.district || '').trim();
    const locations = searchStoredLocations(query, district);
    return res.status(200).json({ locations });
  } catch (error) {
    console.error('Locations error:', error);
    return res.status(500).json({ error: 'Server error loading locations' });
  }
});

// Reverse Geocoding Endpoint for Current Location Map
app.get('/api/geo/reverse', async (req, res) => {
  try {
    const lat = parseFloat(req.query.lat);
    const lng = parseFloat(req.query.lng);
    const result = await reverseGeocode(lat, lng);
    return res.status(200).json(result);
  } catch (error) {
    console.error('Reverse geocode error:', error);
    return res.status(500).json({ error: 'Server error reverse geocoding coordinates' });
  }
});

// Stored Route Intermediate Locations Endpoint
app.get('/api/locations/intermediate', (req, res) => {
  try {
    const route = String(req.query.route || '').trim();
    const type = String(req.query.type || '').trim();
    const locations = getStoredIntermediateLocations(route, type);
    return res.status(200).json({ locations });
  } catch (error) {
    console.error('Intermediate locations error:', error);
    return res.status(500).json({ error: 'Server error loading intermediate locations' });
  }
});

// Transport Stops Endpoint (Bus stops, bus stands, railway stations)
app.get('/api/stops', (req, res) => {
  try {
    const query = String(req.query.query || '').trim();
    const type = String(req.query.type || '').trim();
    const stops = getTransportStops(query, type);
    return res.status(200).json({ stops });
  } catch (error) {
    console.error('Transport stops error:', error);
    return res.status(500).json({ error: 'Server error loading transport stops' });
  }
});

// Stored Multi-Modal Routes Endpoint
app.get('/api/routes/stored', (req, res) => {
  try {
    const from = String(req.query.from || '').trim();
    const to = String(req.query.to || '').trim();
    const passengers = parseInt(req.query.passengers) || 1;
    const routes = getStoredMultiModalRoutes(from, to, passengers);
    return res.status(200).json({ routes });
  } catch (error) {
    console.error('Stored routes error:', error);
    return res.status(500).json({ error: 'Server error loading stored routes' });
  }
});

// Multi-Modal Journey Planner Endpoint
app.get('/api/planner', async (req, res) => {
  try {
    const { from, to, date, time, passengers } = req.query;
    if (!from || !to) {
      return res.status(400).json({ error: 'from and to locations are required' });
    }

    // Check same location validation
    if (from.trim().toLowerCase() === to.trim().toLowerCase()) {
      return res.status(400).json({ error: 'Your starting point and destination are the same. Please select different locations.' });
    }

    const isExplicitCurrentLocation = /^(?:📍\s*)?(?:my\s+)?current\s+location$/i.test(from.trim());
    let originCoordinates = null;
    if (req.query.origin === 'gps' && isExplicitCurrentLocation) {
      const latitude = Number(req.query.fromLat);
      const longitude = Number(req.query.fromLng);
      if (Number.isFinite(latitude) && latitude >= -90 && latitude <= 90
        && Number.isFinite(longitude) && longitude >= -180 && longitude <= 180) {
        originCoordinates = { latitude, longitude };
      }
    }

    // Default date if not explicitly provided
    const travelDate = (date && String(date).trim()) || new Date().toISOString().split('T')[0];

    // 1. Resolve multi-modal transit routes across bus, train, and transfer networks
    const routes = await findMultiModalRoutes(from, to, travelDate, null, passengers, originCoordinates);

    // 2. Fetch Google Maps route insights if configured
    let insights;
    try {
      insights = await getGoogleRouteInsights(from, to, originCoordinates);
    } catch (error) {
      console.warn('Google Maps route lookup failed:', error.message);
      insights = {
        configured: Boolean(GOOGLE_MAPS_SERVER_KEY),
        retrievedAt: new Date().toISOString(),
        source: 'Google Maps Platform',
        route: null,
        locations: [],
        nearestBusFacility: null,
        error: 'Live Google Maps route data is unavailable for this search.'
      };
    }

    // 3. Flight status info for metadata reporting
    const flightOptions = await getFlightOptions(from, to, date, originCoordinates, passengers);
    const flightSearch = {
      ...flightOptions.result,
      offerCount: routes.filter(r => r.segments.some(s => s.mode === 'flight')).length
    };

    return res.status(200).json({
      routes,
      originType: (isExplicitCurrentLocation && originCoordinates) ? 'CURRENT_GPS_LOCATION' : 'NAMED_LOCATION',
      insights,
      flightSearch
    });
  } catch (error) {
    console.error('Planner error:', error);
    return res.status(500).json({ error: 'Server error generating travel plan' });
  }
});

// In-flight transit bootstrap promise to prevent duplicate boots and coordinate with incoming requests
let transitBootstrapPromise = null;
let lastBootstrapFailureTime = 0;

async function bootstrapTransit() {
  if (transitBootstrapPromise) return transitBootstrapPromise;
  transitBootstrapPromise = (async () => {
    const config = getTransitConfig();
    try {
      let network = getTransitNetwork();
      if (!network) {
        if (process.env.ROUTECONNECT_AUTO_IMPORT_TRANSIT === 'false') {
          console.warn(`[Transit Diagnostics] Transit data missing at "${config.dbPath}", auto-bootstrap disabled.`);
          return null;
        }
        console.log(`[Transit] Checking transit dataset at "${config.dbPath}"...`);
        const result = await ensureTransitData();
        if (result.ready) {
          network = reloadTransitNetwork();
        }
      }
      if (network) {
        getHubMetrics(network);
        getConnectivity(network);
        console.log(`[Transit] Transit network ready: ${network.stats.patterns} patterns, ${network.stats.stops} stops (${network.stats.loadTimeMs} ms)`);
      } else {
        console.warn(`[Transit Diagnostics] Transit data is unavailable at "${config.dbPath}". Places and v2 routing endpoints will return 503.`);
        console.warn('[Transit Diagnostics] Troubleshooting: Run "npm run transit:download && npm run transit:import" or configure ROUTECONNECT_TRANSIT_DATABASE_PATH.');
      }
      return network;
    } catch (error) {
      lastBootstrapFailureTime = Date.now();
      console.warn('[Transit Diagnostics] Transit bootstrap failed:', error.message);
      console.warn(`[Transit Diagnostics] Database path checked: "${config.dbPath}"`);
      console.warn('[Transit Diagnostics] Troubleshooting: Run "npm run transit:download && npm run transit:import" or check network connectivity.');
      return null;
    } finally {
      transitBootstrapPromise = null;
    }
  })();
  return transitBootstrapPromise;
}

async function waitForTransitReady() {
  if (getTransitNetwork()) return;
  if (!transitBootstrapPromise && (Date.now() - lastBootstrapFailureTime > 30000)) {
    bootstrapTransit();
  }
  if (transitBootstrapPromise) {
    try {
      await Promise.race([
        transitBootstrapPromise,
        new Promise(resolve => setTimeout(resolve, 30000))
      ]);
    } catch {
      // Diagnostic messages are already logged by bootstrapTransit
    }
  }
}

// Transit dataset status (read-only provenance/validity/counts; not used by the planner yet)
app.get('/api/transit/status', async (req, res) => {
  await waitForTransitReady();
  try {
    return res.status(200).json(getTransitStatus());
  } catch (error) {
    console.error('Transit status error:', error.message);
    return res.status(500).json({ error: 'Unable to read transit dataset status' });
  }
});

// Multimodal planner: GTFS buses via RAPTOR plus any configured rail / flight / private-bus sources, shortlisted for
// diversity. Independent of the legacy /api/planner above, which is unchanged.
app.get('/api/v2/plan', async (req, res) => {
  await waitForTransitReady();
  try {
    const { status, body } = await handleMultimodalPlanRequest(req.query);
    return res.status(status).json(body);
  } catch (error) {
    console.error('Multimodal planning failed:', error);
    return res.status(500).json({ error: 'Journey planning failed.' });
  }
});

// Stop/place autocomplete for the GTFS planner: only places that exist in the timetable are suggested.
app.get('/api/v2/places', async (req, res) => {
  await waitForTransitReady();
  const { status, body } = handlePlaceSearch(req.query, () => getTransitNetwork());
  return res.status(status).json(body);
});

// Health check
app.get('/api/health', (req, res) => {
  res.status(200).json({
    status: 'Server is running',
    service: 'RouteConnect Multi-Modal Transit Planner',
    features: ['bus_network', 'train_network', 'multimodal_connections', 'village_coverage']
  });
});

// Serve frontend static build if available
const distPath = path.join(__dirname, '..', 'dist');
if (fs.existsSync(distPath)) {
  app.use(express.static(distPath));
  app.get('*', (req, res, next) => {
    if (req.path.startsWith('/api')) {
      return next();
    }
    const indexHtml = path.join(distPath, 'index.html');
    if (fs.existsSync(indexHtml)) {
      return res.sendFile(indexHtml);
    }
    next();
  });
}

app.listen(PORT, "0.0.0.0", () => {
  console.log(`RouteConnect server running on port ${PORT}`);
  // Bootstrap or warm the in-memory transit network
  bootstrapTransit();
});

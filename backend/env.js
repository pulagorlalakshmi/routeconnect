// Loads environment variables from .env files.
//
// This module must be the FIRST import of any entry point (see server.js).
// ES module imports are hoisted and evaluated in order, so services that read
// process.env at module load time (googleMapsService, geoService, flightService,
// database) only see these values if this file has already run.
//
// Precedence (dotenv never overrides a variable that is already set):
//   1. real process environment
//   2. backend/.env
//   3. .env in the current working directory (project root)
import path from 'path';
import { fileURLToPath } from 'url';
import dotenv from 'dotenv';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

dotenv.config({ path: path.join(__dirname, '.env') });
dotenv.config();

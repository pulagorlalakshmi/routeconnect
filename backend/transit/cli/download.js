// npm run transit:download [-- --url <zip url>] [-- --out <path>]
// Downloads a GTFS archive to the git-ignored data directory and records where/when it came from.
import '../../env.js';
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { getTransitConfig } from '../config.js';
import { parseArgs, writeJson, metaPathFor, relativeToCwd } from './common.js';

const MAX_BYTES = 200 * 1024 * 1024;
const TIMEOUT_MS = 120000;

const args = parseArgs();
const config = getTransitConfig();
const url = typeof args.url === 'string' ? args.url : config.feed.url;
const out = typeof args.out === 'string' ? path.resolve(args.out) : config.feedZipPath;

try {
  console.log(`Downloading GTFS feed from ${url}`);
  const response = await fetch(url, { redirect: 'follow', signal: AbortSignal.timeout(TIMEOUT_MS) });
  if (!response.ok) throw new Error(`HTTP ${response.status} ${response.statusText}`);

  const declared = Number(response.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > MAX_BYTES) throw new Error(`Feed is too large (${declared} bytes).`);

  const buffer = Buffer.from(await response.arrayBuffer());
  if (buffer.length > MAX_BYTES) throw new Error(`Feed is too large (${buffer.length} bytes).`);
  if (buffer.length < 4 || buffer[0] !== 0x50 || buffer[1] !== 0x4b) {
    throw new Error('Downloaded file is not a ZIP archive.');
  }

  fs.mkdirSync(path.dirname(out), { recursive: true });
  const tempPath = `${out}.download`;
  fs.writeFileSync(tempPath, buffer);
  fs.renameSync(tempPath, out);

  const meta = {
    sourceUrl: url,
    resolvedUrl: response.url,
    retrievedAt: new Date().toISOString(),
    httpStatus: response.status,
    etag: response.headers.get('etag'),
    lastModified: response.headers.get('last-modified'),
    bytes: buffer.length,
    sha256: crypto.createHash('sha256').update(buffer).digest('hex')
  };
  writeJson(metaPathFor(out), meta);

  console.log(`Saved ${buffer.length} bytes to ${relativeToCwd(out)}`);
  console.log(`sha256 ${meta.sha256}`);
  console.log('Note: community feed, licence unconfirmed. Local prototype use only; do not commit or redistribute it.');
  console.log('Next: npm run transit:validate  then  npm run transit:import');
} catch (error) {
  console.error(`Download failed: ${error.message}`);
  process.exitCode = 1;
}

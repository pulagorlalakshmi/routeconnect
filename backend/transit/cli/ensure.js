// npm run transit:ensure [-- --force]
// Ensures that the transit database is present and initialized.
// If the database already exists and contains data, it exits cleanly without downloading or re-importing.
// If missing, it downloads the feed (if needed), validates it, and imports it.
import '../../env.js';
import { ensureTransitData } from '../ensureData.js';
import { parseArgs } from './common.js';

const args = parseArgs();

try {
  const result = await ensureTransitData({ force: args.force === true });
  if (result.imported) {
    console.log(`Transit data imported successfully into: ${result.dbPath}`);
  } else {
    console.log(`Transit database is already ready at: ${result.dbPath}`);
  }
} catch (error) {
  console.error(`Transit ensure failed: ${error.message}`);
  process.exitCode = 1;
}

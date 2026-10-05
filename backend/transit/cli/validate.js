// npm run transit:validate [-- --zip <path>] [-- --asOf YYYY-MM-DD]
// Validates a GTFS archive and writes backend/transit/reports/latest-validation.json (git-ignored).
import '../../env.js';
import path from 'path';
import { getTransitConfig } from '../config.js';
import { readGtfsArchive } from '../gtfs/reader.js';
import { validateGtfs } from '../validators/gtfsValidator.js';
import { formatReportSummary } from '../validators/reportSummary.js';
import { parseArgs, writeJson, readMeta, relativeToCwd } from './common.js';

const args = parseArgs();
const config = getTransitConfig();
const zipPath = typeof args.zip === 'string' ? path.resolve(args.zip) : config.feedZipPath;

try {
  const archive = readGtfsArchive(zipPath);
  const report = validateGtfs(archive, { asOf: typeof args.asOf === 'string' ? args.asOf : undefined });
  report.source = { ...config.feed, retrievedAt: readMeta(zipPath)?.retrievedAt ?? null };

  writeJson(config.reportPath, report);
  console.log(formatReportSummary(report, { datasetLabel: config.feed.name }));
  console.log(`\nFull report: ${relativeToCwd(config.reportPath)}`);
  if (report.blocking) process.exitCode = 1;
} catch (error) {
  console.error(`Validation failed: ${error.message}`);
  if (error.code === 'ENOENT') console.error('Run "npm run transit:download" first, or pass --zip <path>.');
  process.exitCode = 1;
}

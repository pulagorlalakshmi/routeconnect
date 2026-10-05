// npm run transit:import [-- --zip <path>] [-- --force] [-- --asOf YYYY-MM-DD]
// Validates the archive, then imports it into the transit database (backend/transit/data/transit.db by default).
// Blocking validation errors abort the import and leave the existing database untouched.
import '../../env.js';
import path from 'path';
import { getTransitConfig } from '../config.js';
import { readGtfsArchive } from '../gtfs/reader.js';
import { validateGtfs } from '../validators/gtfsValidator.js';
import { formatReportSummary } from '../validators/reportSummary.js';
import { importGtfs, ImportBlockedError } from '../importers/gtfsImporter.js';
import { openTransitDb } from '../transitDb.js';
import { parseArgs, writeJson, readMeta, relativeToCwd } from './common.js';

const args = parseArgs();
const config = getTransitConfig();
const zipPath = typeof args.zip === 'string' ? path.resolve(args.zip) : config.feedZipPath;
const asOf = typeof args.asOf === 'string' ? args.asOf : undefined;
const force = args.force === true;

try {
  const archive = readGtfsArchive(zipPath);
  const meta = readMeta(zipPath);
  const report = validateGtfs(archive, { asOf });
  const source = { ...config.feed, url: meta?.sourceUrl ?? config.feed.url };
  report.source = { ...source, retrievedAt: meta?.retrievedAt ?? null };

  console.log(formatReportSummary(report, { datasetLabel: config.feed.name }));

  const db = openTransitDb(config.dbPath);
  let result;
  try {
    result = importGtfs({ db, archive, source, retrievedAt: meta?.retrievedAt, report, asOf, force });
  } finally {
    db.close();
  }

  if (result.skipped) {
    report.import = { skipped: true, reason: result.reason, datasetId: result.datasetId, importedAt: result.importedAt };
    console.log(`\nSkipped: this exact archive is already imported (dataset #${result.datasetId}, imported ${result.importedAt}). Use --force to re-import.`);
  } else {
    report.import = {
      datasetId: result.datasetId,
      importedAt: result.importedAt,
      counts: result.counts,
      timeQuality: result.timeQuality,
      validity: result.validity,
      confidence: source.confidence,
      verified: false
    };
    console.log('\n=== Import complete ===');
    console.log(`Dataset #${result.datasetId} | confidence: ${source.confidence} | verified: false | licence: ${source.license}`);
    console.log(`Imported: ${Object.entries(result.counts).map(([k, v]) => `${k} ${v}`).join(', ')}`);
    console.log(`Time quality: ${Object.entries(result.timeQuality).map(([k, v]) => `${k} ${v}`).join(', ')}`);
    if (!result.validity.currentlyValid) {
      console.log(`WARNING: feed validity (${result.validity.validFrom} -> ${result.validity.validTo}) does not cover ${result.validity.asOf}; routing must treat it as "inferred".`);
    }
    console.log(`Database: ${relativeToCwd(config.dbPath)}`);
  }

  writeJson(config.reportPath, report);
  console.log(`Report:   ${relativeToCwd(config.reportPath)}`);
} catch (error) {
  if (error instanceof ImportBlockedError) {
    writeJson(config.reportPath, error.report);
    console.error(`\nImport blocked: ${error.message}`);
    console.error(formatReportSummary(error.report, { datasetLabel: config.feed.name }));
  } else {
    console.error(`Import failed: ${error.message}`);
    if (error.code === 'ENOENT') console.error('Run "npm run transit:download" first, or pass --zip <path>.');
  }
  process.exitCode = 1;
}

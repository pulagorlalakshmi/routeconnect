// Human-readable console summary of a validation report.
const LABELS = [
  ['duplicate_stop_names', 'Duplicate stop names'],
  ['unused_stops', 'Unused stops'],
  ['invalid_stop_coordinates_used', 'Invalid coordinates (served stops)'],
  ['invalid_stop_coordinates_unused', 'Invalid coordinates (unused stops)'],
  ['non_monotonic_times', 'Trips with non-monotonic times'],
  ['times_at_or_after_24h', 'Stop times >= 24:00:00'],
  ['times_at_or_after_48h', 'Stop times >= 48:00:00'],
  ['suspiciously_long_trips', 'Suspiciously long trips (>24h)'],
  ['zero_travel_time_segments', 'Repeated identical stop times'],
  ['routes_missing_names', 'Routes missing names'],
  ['route_names_equal_id', 'Route names equal to ID'],
  ['trips_missing_headsign', 'Trips missing headsign'],
  ['trip_headsign_not_descriptive', 'Headsigns that are just IDs'],
  ['all_times_approximate', 'All times approximate (timepoint=0)'],
  ['missing_fares', 'Fare data missing'],
  ['missing_calendar_dates', 'calendar_dates.txt missing'],
  ['missing_transfers', 'transfers.txt missing'],
  ['missing_frequencies', 'frequencies.txt missing']
];

export function formatReportSummary(report, { datasetLabel = 'GTFS feed' } = {}) {
  const lines = [];
  const c = report.counts;
  const v = report.validity;
  const dup = Object.values(report.checks).filter(check => check.id.startsWith('duplicate_') && check.severity === 'error');
  const dangling = Object.values(report.checks).filter(check => check.id.startsWith('dangling_'));

  lines.push(`=== ${datasetLabel}: validation ${report.status.toUpperCase()} ===`);
  lines.push(`Agencies ${c.agencies} | Stops ${c.stops} | Routes ${c.routes} | Trips ${c.trips} | Stop times ${c.stopTimes} | Shape points ${c.shapePoints}`);
  if (v) {
    lines.push(`Validity: ${v.validFrom ?? '?'} -> ${v.validTo ?? '?'} | as of ${v.asOf} | status: ${v.status.toUpperCase()}${v.currentlyValid ? '' : '  (NOT currently valid)'}`);
  }
  lines.push(`Issues: ${report.errorCount} error(s), ${report.warningCount} warning(s), ${report.infoCount} info`);
  if (report.missingRequiredFiles.length) lines.push(`Missing required files: ${report.missingRequiredFiles.join(', ')}`);
  lines.push(`Duplicate IDs: ${dup.reduce((s, x) => s + x.count, 0)} | Dangling references: ${dangling.reduce((s, x) => s + x.count, 0)}`);

  for (const [id, label] of LABELS) {
    const check = report.checks[id];
    if (check) lines.push(`  - ${label}: ${check.count}${check.severity === 'info' ? ' (info)' : ''}`);
  }
  for (const check of Object.values(report.checks).filter(x => x.severity === 'error')) {
    lines.push(`  ! ERROR ${check.id}: ${check.count} - ${check.description}${check.samples.length ? ` e.g. ${check.samples.slice(0, 3).join(', ')}` : ''}`);
  }
  return lines.join('\n');
}

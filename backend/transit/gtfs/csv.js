// Minimal RFC 4180 CSV parser for GTFS files.
// Handles: UTF-8 BOM, CRLF / LF / CR line endings, quoted fields, escaped quotes (""),
// newlines inside quoted fields, blank lines, short rows (padded) and long rows (truncated).

export function parseCsv(input) {
  let text = String(input ?? '');
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);

  const records = [];
  let record = [];
  let field = '';
  let inQuotes = false;
  let unterminatedQuote = false;
  const n = text.length;

  const pushRecord = () => {
    // Skip completely blank lines
    if (record.length === 1 && record[0] === '') return;
    records.push(record);
  };

  for (let i = 0; i < n; i++) {
    const c = text[i];

    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        field += c;
      }
      continue;
    }

    if (c === '"' && field === '') {
      inQuotes = true;
    } else if (c === ',') {
      record.push(field);
      field = '';
    } else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      record.push(field);
      field = '';
      pushRecord();
      record = [];
    } else {
      field += c;
    }
  }

  if (inQuotes) unterminatedQuote = true;
  if (field !== '' || record.length > 0) {
    record.push(field);
    pushRecord();
  }

  if (records.length === 0) {
    return { header: [], rows: [], malformedRows: 0, unterminatedQuote };
  }

  const header = records[0].map(name => name.trim());
  const rows = [];
  let malformedRows = 0;

  for (let r = 1; r < records.length; r++) {
    const values = records[r];
    if (values.length !== header.length) malformedRows++;
    const row = {};
    for (let c = 0; c < header.length; c++) {
      row[header[c]] = values[c] === undefined ? '' : values[c].trim();
    }
    rows.push(row);
  }

  return { header, rows, malformedRows, unterminatedQuote };
}

/**
 * Shared CSV import utilities.
 *
 * Usage:
 *   const { parseCSV, validateRows } = require('../utils/csvImport');
 *   const { headers, rows } = parseCSV(req.file.buffer);
 *   const { valid, errors } = validateRows(rows, requiredFields);
 */

/**
 * Parse one CSV line, correctly handling quoted fields with embedded commas.
 * @param {string} line
 * @returns {string[]}
 */
function parseLine(line) {
  const fields = [];
  let i = 0;
  while (i <= line.length) {
    if (line[i] === '"') {
      let field = '';
      i++; // skip opening quote
      while (i < line.length) {
        if (line[i] === '"' && line[i + 1] === '"') {
          field += '"'; i += 2;            // escaped quote
        } else if (line[i] === '"') {
          i++; break;                       // closing quote
        } else {
          field += line[i++];
        }
      }
      fields.push(field);
      if (line[i] === ',') i++;
    } else {
      let field = '';
      while (i < line.length && line[i] !== ',') field += line[i++];
      fields.push(field.trim());
      if (line[i] === ',') i++;
    }
    if (i > line.length) break;
  }
  return fields;
}

/**
 * Parse a CSV buffer into { headers, rows }.
 *
 * @param {Buffer} buffer   Raw file buffer from multer memoryStorage.
 * @returns {{ headers: string[], rows: Array<{ rowNum: number, data: Record<string,string> }> }}
 */
function parseCSV(buffer) {
  const text  = buffer.toString('utf8').replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  const lines = text.split('\n');

  // Find first non-empty line (header row)
  const headerLineIdx = lines.findIndex(l => l.trim().length > 0);
  if (headerLineIdx === -1) return { headers: [], rows: [] };

  // Normalise headers: lowercase + underscores, strip BOM
  const rawHeaders = parseLine(lines[headerLineIdx]);
  const headers    = rawHeaders.map(h =>
    h.trim().replace(/^\uFEFF/, '').toLowerCase().replace(/\s+/g, '_')
  );

  const rows = [];
  for (let i = headerLineIdx + 1; i < lines.length; i++) {
    const line = lines[i];
    if (!line.trim()) continue; // skip blank rows

    const values = parseLine(line);
    if (values.every(v => !v.trim())) continue; // all-empty row

    const data = {};
    headers.forEach((h, idx) => {
      data[h] = (values[idx] ?? '').trim();
    });
    rows.push({ rowNum: i + 1, data });
  }

  return { headers, rows };
}

/**
 * Validate parsed rows against a list of required fields.
 *
 * @param {Array<{ rowNum, data }>} rows
 * @param {string[]} required   Field names that must be non-empty.
 * @returns {{ valid: Array<{ rowNum, data }>, errors: Array<{ row, message }> }}
 */
function validateRows(rows, required = []) {
  const valid  = [];
  const errors = [];

  for (const { rowNum, data } of rows) {
    const missing = required.filter(f => !data[f]?.trim());
    if (missing.length > 0) {
      errors.push({ row: rowNum, message: `Missing required field(s): ${missing.join(', ')}` });
    } else {
      valid.push({ rowNum, data });
    }
  }

  return { valid, errors };
}

/**
 * Build a CSV template string from column definitions.
 * @param {Array<{ header: string, example1?: string, example2?: string }>} columns
 * @returns {string}
 */
function buildTemplate(columns) {
  const q     = (v = '') => `"${String(v).replace(/"/g, '""')}"`;
  const header = columns.map(c => q(c.header)).join(',');
  const row1   = columns.map(c => q(c.example1 ?? '')).join(',');
  const row2   = columns.map(c => q(c.example2 ?? '')).join(',');
  return [header, row1, row2].join('\n');
}

module.exports = { parseCSV, validateRows, buildTemplate };

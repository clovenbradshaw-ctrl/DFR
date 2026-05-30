/**
 * dataset.js — Materialise an imported CSV / JSON file as a "set".
 *
 * A pure module: it parses the bytes, infers a schema, and returns
 * a plan describing the rows to INS and the field values to DEF.
 * The caller (main.js) is responsible for emitting the events.
 *
 * Why split? Keeping parsing/inference free of Matrix lets us unit-test
 * it standalone and re-use it from other entry points (paste-as-table,
 * drop-on-table, etc.).
 */

// ── CSV ────────────────────────────────────────────────────────────────────

/**
 * Parse a CSV string into { headers, rows }. RFC 4180-ish: double quotes
 * wrap fields; "" inside a quoted field is an escaped quote; newlines may
 * be \n or \r\n. Empty trailing lines are dropped.
 *
 * `rows` is an array of arrays of raw string cells (one entry per header).
 */
export function parseCsv(text) {
  const out = [];
  let field = '';
  let row = [];
  let inQuotes = false;
  const n = text.length;
  for (let i = 0; i < n; i++) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (i + 1 < n && text[i + 1] === '"') { field += '"'; i++; continue; }
        inQuotes = false;
        continue;
      }
      field += c;
      continue;
    }
    if (c === '"') { inQuotes = true; continue; }
    if (c === ',') { row.push(field); field = ''; continue; }
    if (c === '\n' || c === '\r') {
      row.push(field); field = '';
      if (row.length > 1 || row[0] !== '') out.push(row);
      row = [];
      if (c === '\r' && i + 1 < n && text[i + 1] === '\n') i++;
      continue;
    }
    field += c;
  }
  if (field.length > 0 || row.length > 0) {
    row.push(field);
    if (row.length > 1 || row[0] !== '') out.push(row);
  }
  if (out.length === 0) return { headers: [], rows: [] };
  const headers = normalizeHeaders(out[0].map(h => String(h ?? '').trim()));
  return { headers, rows: out.slice(1) };
}

/**
 * Normalise raw header strings into safe schema field names.
 * Empty or non-alphanumeric headers fall back to `col_N`; duplicates
 * get a numeric suffix so every column has a unique key.
 */
export function normalizeHeaders(raw) {
  const seen = new Map();
  return raw.map((h, i) => {
    let base = String(h ?? '').trim().replace(/[^a-zA-Z0-9_]+/g, '_').replace(/^_+|_+$/g, '');
    if (!base) base = `col_${i + 1}`;
    const count = seen.get(base) || 0;
    seen.set(base, count + 1);
    return count === 0 ? base : `${base}_${count + 1}`;
  });
}

// ── JSON / NSON ────────────────────────────────────────────────────────────

/**
 * Parse a JSON or NSON document into a uniform row list.
 *
 * - Array of objects     → each object is a row.
 * - Array of primitives  → wrap each value as { value: x }.
 * - Object whose first array property holds objects → use those as rows.
 * - Anything else        → the document itself becomes a single row.
 */
export function parseJsonDataset(text) {
  const data = JSON.parse(text);
  if (Array.isArray(data)) {
    if (data.length === 0) return { rows: [], shape: 'array' };
    if (isRowObject(data[0])) return { rows: data, shape: 'array' };
    return { rows: data.map(v => ({ value: v })), shape: 'array_of_primitives' };
  }
  if (data && typeof data === 'object') {
    for (const k of Object.keys(data)) {
      const v = data[k];
      if (Array.isArray(v) && v.length > 0 && isRowObject(v[0])) {
        return { rows: v, shape: 'wrapped_array', rootKey: k };
      }
    }
    return { rows: [data], shape: 'object' };
  }
  return { rows: [{ value: data }], shape: 'scalar' };
}

function isRowObject(v) {
  return v && typeof v === 'object' && !Array.isArray(v);
}

/**
 * Collect the union of keys observed across a sample of row objects,
 * preserving insertion order from the first row that introduced each key.
 */
export function collectJsonHeaders(rows, sampleSize = 200) {
  return collectJsonColumns(rows, sampleSize).map(c => c.name);
}

/**
 * Like collectJsonHeaders, but returns `{ raw, name }` pairs so a caller
 * can map a normalized schema field name back to the original JSON key it
 * came from. Needed by the lazy importer: rows are reconstructed from the
 * source blob by reading `row[raw]`, not the sanitized field name.
 */
export function collectJsonColumns(rows, sampleSize = 200) {
  const seen = new Set();
  const ordered = [];
  for (const r of rows.slice(0, sampleSize)) {
    if (!isRowObject(r)) continue;
    for (const k of Object.keys(r)) {
      if (!seen.has(k)) { seen.add(k); ordered.push(k); }
    }
  }
  const normalized = normalizeHeaders(ordered);
  return ordered.map((raw, i) => ({ raw, name: normalized[i] }));
}

// ── Type inference ─────────────────────────────────────────────────────────

const INT_RE      = /^-?\d+$/;
const FLOAT_RE    = /^-?\d+(\.\d+)?([eE][-+]?\d+)?$/;
const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}([T ]\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[-+]\d{2}:?\d{2})?)?$/;
const BOOL_RE     = /^(true|false)$/i;

/**
 * Infer a schema field type from a column of raw values.
 * Returns one of: text, longtext, number, boolean, date, json.
 *
 * Rules (in order): any object → json; all booleans → boolean; all
 * integers / numbers → number; all ISO datestamps → date; any long
 * value → longtext; otherwise text. Empty values don't constrain.
 */
export function inferColumnType(values) {
  let nonNull = 0, allBool = true, allInt = true, allNum = true, allDate = true;
  let anyLong = false, anyJson = false;
  for (const raw of values) {
    if (raw === null || raw === undefined || raw === '') continue;
    nonNull++;
    if (typeof raw === 'object') { anyJson = true; allBool = allInt = allNum = allDate = false; continue; }
    if (typeof raw === 'boolean') { allInt = allNum = allDate = false; continue; }
    if (typeof raw === 'number') {
      allBool = false; allDate = false;
      if (!Number.isInteger(raw)) allInt = false;
      continue;
    }
    const s = String(raw);
    if (s.length > 200) anyLong = true;
    if (!BOOL_RE.test(s))  allBool = false;
    if (!INT_RE.test(s))   allInt  = false;
    if (!FLOAT_RE.test(s)) allNum  = false;
    if (!ISO_DATE_RE.test(s)) allDate = false;
  }
  if (nonNull === 0) return 'text';
  if (anyJson)  return 'json';
  if (allBool)  return 'boolean';
  if (allInt)   return 'number';
  if (allNum)   return 'number';
  if (allDate)  return 'date';
  if (anyLong)  return 'longtext';
  return 'text';
}

/**
 * Coerce a raw cell into its typed form for storage.
 * Strings stay strings unless the column's type pulls them into a
 * primitive; objects/arrays pass through (already structured).
 */
export function coerceValue(value, type) {
  if (value === null || value === undefined || value === '') return null;
  if (typeof value === 'object') return value;
  if (typeof value === 'boolean' || typeof value === 'number') return value;
  const s = String(value);
  if (type === 'number')  { const n = Number(s); return Number.isFinite(n) ? n : s; }
  if (type === 'boolean') { if (/^true$/i.test(s))  return true;
                            if (/^false$/i.test(s)) return false; return s; }
  return s;
}

const MAX_FIELDS = 64;

/**
 * Build a fields array `[{ name, type }, …]` by inferring each column's
 * type from up to `sampleSize` rows. Caps at MAX_FIELDS so a runaway
 * CSV doesn't drown the schema.
 */
export function inferFields(headers, rows, sampleSize = 200) {
  const sample = rows.slice(0, sampleSize);
  return headers.slice(0, MAX_FIELDS).map((name, idx) => {
    const values = sample.map(r => Array.isArray(r) ? r[idx] : r?.[name]);
    return { name, type: inferColumnType(values) };
  });
}

// ── Naming ─────────────────────────────────────────────────────────────────

/**
 * Turn a file name (or any string) into a set name: drop the extension,
 * lowercase, replace runs of non-alphanumerics with `_`, ensure the
 * result starts with a letter. Falls back to `set` if nothing remains.
 */
export function slugifySetName(name) {
  let base = String(name ?? '').trim();
  const dot = base.lastIndexOf('.');
  if (dot > 0) base = base.slice(0, dot);
  base = base.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
  if (!base) base = 'set';
  if (/^[0-9]/.test(base)) base = 'set_' + base;
  return base;
}

/** Return `name`, or `name_2`, `name_3`, … so it doesn't collide. */
export function uniqueSetName(name, existing) {
  const taken = new Set(existing || []);
  if (!taken.has(name)) return name;
  for (let i = 2; i < 1000; i++) {
    const candidate = `${name}_${i}`;
    if (!taken.has(candidate)) return candidate;
  }
  return `${name}_${Date.now()}`;
}

// ── MIME / extension sniffing ──────────────────────────────────────────────

export function isCsvFile(file, mime) {
  const m = String(mime || file?.type || '').toLowerCase();
  if (m === 'text/csv' || m === 'application/csv' || m === 'text/x-csv') return true;
  const n = String(file?.name || '').toLowerCase();
  return n.endsWith('.csv') || n.endsWith('.tsv');
}

export function isJsonFile(file, mime) {
  const m = String(mime || file?.type || '').toLowerCase();
  if (m === 'application/json' || m === 'application/x-ndjson' || m === 'text/json') return true;
  const n = String(file?.name || '').toLowerCase();
  return n.endsWith('.json') || n.endsWith('.nson') || n.endsWith('.ndjson');
}

// ── End-to-end plan ────────────────────────────────────────────────────────

/**
 * Cap rows we materialise. Each row produces 1 INS + (#fields) DEF
 * events, all of which round-trip through the outbox; the cap keeps
 * the first import latency-friendly while still showing real data.
 */
export const DEFAULT_ROW_CAP = 500;

/**
 * Parse a file's text and return a plan the caller can emit:
 *   { setName, fields, rows, truncated, totalRows, shape }
 * `rows` is an array of objects keyed by field name, ready for DEF.
 *
 * Throws if the file can't be parsed; returns `null` if it's neither
 * CSV nor JSON.
 */
export async function planDatasetFromFile(file, { existingTables = [], rowCap = DEFAULT_ROW_CAP } = {}) {
  if (!file) return null;
  const csv = isCsvFile(file);
  const json = !csv && isJsonFile(file);
  if (!csv && !json) return null;

  const text = await file.text();
  let headers, allRows, shape;

  if (csv) {
    const parsed = parseCsv(text);
    headers = parsed.headers;
    allRows = parsed.rows;
    shape = 'csv';
  } else {
    const parsed = parseJsonDataset(text);
    headers = collectJsonHeaders(parsed.rows);
    allRows = parsed.rows;
    shape = parsed.shape;
  }

  if (headers.length === 0) return null;

  const fields = inferFields(headers, allRows);
  const cappedRows = allRows.slice(0, rowCap);

  // Materialise each row as an object keyed by field name, with values
  // coerced to their inferred type. Skip null/empty so DEF stays sparse.
  const rows = cappedRows.map((raw, i) => {
    const out = {};
    fields.forEach((f, idx) => {
      const v = Array.isArray(raw) ? raw[idx] : raw?.[f.name];
      const coerced = coerceValue(v, f.type);
      if (coerced !== null && coerced !== undefined) out[f.name] = coerced;
    });
    out._row = i + 1;
    return out;
  });

  const baseName = slugifySetName(file.name || 'set');
  const setName = uniqueSetName(baseName, existingTables);

  return {
    setName,
    fields,
    rows,
    truncated: allRows.length > cappedRows.length,
    totalRows: allRows.length,
    shape,
  };
}

/**
 * Plan a *lazy* dataset import: infer the schema and a per-field extraction
 * plan, but do NOT materialise any rows. The source file is stored once as a
 * blob; rows are reconstructed on demand from that blob (see
 * csv-import.jsx's materializeImportRows). This is how a 10k-row import
 * becomes a handful of events instead of one INS + N DEFs per row.
 *
 * Returns { setName, fields, fieldPlan, shape, totalRows } or null when the
 * file is neither CSV nor JSON.
 *
 * `fieldPlan` entries tell the materialiser how to pull each field out of a
 * parsed row:
 *   - CSV  → { name, type, csvIdx }   (positional)
 *   - JSON → { name, type, jsonKey }  (the original, pre-normalized key)
 */
export async function planLazyImport(file, { existingTables = [] } = {}) {
  if (!file) return null;
  const csv = isCsvFile(file);
  const json = !csv && isJsonFile(file);
  if (!csv && !json) return null;

  const text = await file.text();
  let fields, fieldPlan, shape, totalRows;

  if (csv) {
    const parsed = parseCsv(text);
    if (parsed.headers.length === 0) return null;
    fields = inferFields(parsed.headers, parsed.rows);
    fieldPlan = fields.map((f, idx) => ({ name: f.name, type: f.type, csvIdx: idx }));
    shape = 'csv';
    totalRows = parsed.rows.length;
  } else {
    const parsed = parseJsonDataset(text);
    const cols = collectJsonColumns(parsed.rows).slice(0, MAX_FIELDS);
    if (cols.length === 0) return null;
    const sample = parsed.rows.slice(0, 200);
    fields = cols.map(c => ({
      name: c.name,
      type: inferColumnType(sample.map(r => (isRowObject(r) ? r[c.raw] : undefined))),
    }));
    fieldPlan = cols.map((c, idx) => ({ name: c.name, type: fields[idx].type, jsonKey: c.raw }));
    shape = 'json';
    totalRows = parsed.rows.length;
  }

  const baseName = slugifySetName(file.name || 'set');
  const setName = uniqueSetName(baseName, existingTables);

  return { setName, fields, fieldPlan, shape, totalRows };
}

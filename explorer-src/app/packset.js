/**
 * packset.js — the DFR dataset as one compact binary blob.
 *
 * The whole dataset (flight metadata *and* path geometry, inline) is stored as
 * gzip-compressed NDJSON: one JSON record per line, then gzipped. That single
 * blob is what lives in OPFS (fast local working set) and, when small enough,
 * in the Matrix media store (durable/shared). The timeline never carries
 * per-flight events, so adding flights never spams Matrix.
 *
 * gzip-NDJSON is the pragmatic "binary": compact (geometry compresses well),
 * decompresses to the in-memory array in well under a second for this dataset,
 * and is trivially mergeable. A columnar format would scan faster still; this
 * is the upgrade path if the dataset ever outgrows "decompress once on open."
 */

import { fnv1a32 } from '../src/pack.js';

const encoder = new TextEncoder();
const decoder = new TextDecoder();

export function isGzip(bytes) {
  return bytes && bytes.length >= 2 && bytes[0] === 0x1f && bytes[1] === 0x8b;
}

async function pipe(bytes, transform) {
  const body = new Response(new Blob([bytes])).body.pipeThrough(transform);
  return new Uint8Array(await new Response(body).arrayBuffer());
}

export function gzip(bytes) {
  if (typeof CompressionStream === 'undefined') return Promise.resolve(bytes);
  return pipe(bytes, new CompressionStream('gzip'));
}

export function gunzip(bytes) {
  if (typeof DecompressionStream === 'undefined') return Promise.resolve(bytes);
  return pipe(bytes, new DecompressionStream('gzip'));
}

/** Identity used for dedup across hydration + scraping. */
export function flightId(f) {
  return f.flight_id || (f.object_id != null ? 'oid_' + f.object_id : null);
}

/** flights[] → gzipped NDJSON Uint8Array. */
export async function packFlights(flights) {
  const ndjson = flights.map(f => JSON.stringify(f)).join('\n');
  return gzip(encoder.encode(ndjson));
}

/** gzipped-or-plain NDJSON bytes → flights[]. Tolerant of blank lines. */
export async function unpackFlights(bytes) {
  if (!bytes || !bytes.length) return [];
  const raw = isGzip(bytes) ? await gunzip(bytes) : bytes;
  const text = decoder.decode(raw);
  const out = [];
  for (const line of text.split('\n')) {
    const s = line.trim();
    if (!s) continue;
    try { out.push(JSON.parse(s)); } catch { /* skip a corrupt line */ }
  }
  return out;
}

/**
 * Merge incoming records into a base set, deduping by flight identity.
 * Incoming wins on conflict (newer geometry/metadata). Returns the merged
 * array (sorted newest-takeoff-first) and how many were genuinely new.
 */
function geomPoints(g) {
  if (!g || !g.coordinates) return 0;
  return g.type === 'MultiLineString'
    ? g.coordinates.reduce((n, s) => n + (s ? s.length : 0), 0)
    : g.coordinates.length;
}

export function mergeFlights(base, incoming) {
  const byId = new Map();
  for (const f of base) { const id = flightId(f); if (id) byId.set(id, f); }
  let added = 0;
  for (const f of incoming) {
    const id = flightId(f);
    if (!id) continue;
    const existing = byId.get(id);
    if (!existing) { added++; byId.set(id, f); continue; }
    // Conflict: incoming wins on metadata, but never let a coarser geometry
    // overwrite a richer one (e.g. a lean event must not downgrade a full path).
    const keepGeom = geomPoints(existing.geometry) > geomPoints(f.geometry) ? existing.geometry : f.geometry;
    byId.set(id, { ...existing, ...f, geometry: keepGeom });
  }
  const merged = [...byId.values()].sort((a, b) => (b.takeoff || 0) - (a.takeoff || 0));
  return { merged, added };
}

/** Cheap content hash of the packed bytes, for change detection in room state. */
export function blobHash(bytes) {
  // Sample-based fnv: full scan of multi-MB on every publish is wasteful and
  // unnecessary for "did this change?" — hash length + a strided sample.
  let s = 'len:' + bytes.length + ';';
  const stride = Math.max(1, Math.floor(bytes.length / 4096));
  for (let i = 0; i < bytes.length; i += stride) s += bytes[i] + ',';
  return fnv1a32(s);
}

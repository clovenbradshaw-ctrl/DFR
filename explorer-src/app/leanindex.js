/**
 * leanindex.js — stream a (possibly multi-GB, possibly gzip) dataset and keep
 * only a lean, viewable index: per-record metadata + start coordinate, geometry
 * dropped. A few MB even for tens of thousands of flights, so it fits in a tab
 * and renders fast. The full geometry stays in the chained media blocks.
 *
 * Auto-detects the payload shape from the head of the (decompressed) text:
 *   • GeoJSON FeatureCollection  ({ … "features":[ … ] })
 *   • JSON array                 ([ {…}, … ])
 *   • NDJSON / JSONL             (one object per line)
 * and gzip transparently (via textStreamFrom). Tolerant: unknown field names
 * yield sparse records rather than throwing.
 */

import { textStreamFrom, readChunks, streamElements, streamNdjson } from './jsonstream.js';
import { toRecord } from './dfr.js';

/** Decide NDJSON vs array/FeatureCollection from a text head. */
function looksNdjson(head) {
  const t = head.replace(/^﻿/, '').trimStart();
  if (t.startsWith('[')) return false;
  if (t.startsWith('{')) {
    // FeatureCollection wrapper → array semantics; otherwise object-per-line.
    if (/"features"\s*:/.test(head.slice(0, 8192))) return false;
    // A second `{` after a newline within the head ⇒ object-per-line.
    return /\}\s*\n\s*\{/.test(head.slice(0, 8192)) || /^\{[^\n]*\}\s*$/m.test(head.slice(0, 8192));
  }
  return false;
}

/**
 * @param {ReadableStream<Uint8Array>} byteStream
 * @param {object} opts
 * @param {string}  [opts.payloadFormat]  'ndjson'|'jsonl'|'geojson'|'json'|'gzip'|...
 * @param {AbortSignal} [opts.signal]
 * @param {(p:{seen,kept})=>void} [opts.onProgress]
 * @param {(rec)=>void} [opts.onRecord]   optional sink (records not retained)
 * @param {(info:{keys:string[],sample:object})=>void} [opts.onSample]  first parsed element
 * @returns {Promise<Array>} lean flight records (geometry null)
 */
export async function extractLeanFlights(byteStream, { payloadFormat = 'auto', signal, onProgress, onRecord, onSample } = {}) {
  const text = await textStreamFrom(byteStream);
  const reader = text.getReader();

  // Buffer a head to auto-detect shape, then re-emit it ahead of the rest.
  // A single NDJSON flight (with full geometry) can exceed any fixed sniff
  // buffer, so cap the head at the first newline once we have one — we only
  // need enough to tell NDJSON from an array/FeatureCollection.
  let head = '';
  let firstDone = false;
  while (head.length < 1 << 20) {            // up to 1 MB, but stop early on a newline
    const { done, value } = await reader.read();
    if (done) { firstDone = true; break; }
    head += value;
    if (head.indexOf('\n') >= 0 && head.length >= 64) break;
  }

  let ndjson;
  if (payloadFormat === 'ndjson' || payloadFormat === 'jsonl') ndjson = true;
  else if (payloadFormat === 'geojson' || payloadFormat === 'json') ndjson = false;
  else ndjson = looksNdjson(head);

  async function* chunks() {
    if (head) yield head;
    if (firstDone) return;
    while (true) {
      if (signal?.aborted) throw new DOMException('aborted', 'AbortError');
      const { done, value } = await reader.read();
      if (done) return;
      if (value) yield value;
    }
  }

  const elements = ndjson ? streamNdjson(chunks()) : streamElements(chunks());
  const out = [];
  let seen = 0, sampled = false;
  for await (const el of elements) {
    if (signal?.aborted) break;
    seen++;
    // Surface the real field names of the first record so the mapping can be
    // corrected when a dataset uses non-standard keys.
    if (!sampled && onSample) {
      sampled = true;
      const src = (el && el.properties) ? el.properties : el;
      try { onSample({ keys: src && typeof src === 'object' ? Object.keys(src) : [], sample: src }); } catch {}
    }
    let rec;
    try { rec = toRecord(el); } catch { continue; }
    if (rec.geometry) rec.geometry = null;          // drop the bulky path
    if (rec.flight_id || rec.start_coords || rec.external_id) {
      if (onRecord) onRecord(rec); else out.push(rec);
    }
    if (onProgress && seen % 500 === 0) onProgress({ seen, kept: out.length });
  }
  if (onProgress) onProgress({ seen, kept: out.length, done: true });
  return out;
}

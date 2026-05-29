/**
 * hydrate.js — load a large (optionally gzip-compressed) JSON dataset.
 *
 * The hydration file can be several GB compressed, which is far too large to
 * JSON.parse() in one shot. So we never hold the whole thing in memory:
 *
 *   fetch/File  →  [DecompressionStream('gzip')]  →  TextDecoderStream
 *               →  incremental array-element parser  →  batched record()
 *
 * Two shapes are recognised automatically:
 *   • a top-level JSON array            [ {…}, {…}, … ]
 *   • an object with a `features` (or configurable) array
 *       { "type":"FeatureCollection", "features":[ … ] }   (GeoJSON)
 *   • NDJSON (one JSON object per line) — pass { ndjson:true }
 *
 * Each element is classified: GeoJSON-ish (has geometry/properties) → flight;
 * otherwise, if it has a name + coordinates → site. Records flow through the
 * same recorder as the live scraper (geometry → media block, metadata →
 * events), so hydrated history and scraped updates are indistinguishable in
 * the fold.
 */

import { recordFlight, recordSite } from './recorder.js';
import { uploadEncrypted } from '../src/media.js';
import { ins } from '../src/operators.js';
import { ENTITY } from './dfr.js';
import { textStreamFrom, readChunks, streamElements, streamNdjson } from './jsonstream.js';

// ── classification ─────────────────────────────────────────────────────────

function looksLikeFlight(el) {
  if (!el || typeof el !== 'object') return false;
  if (el.geometry && (el.type === 'Feature' || el.properties)) return true;
  const p = el.properties || el;
  return !!(p.flight_id || p.flight_purpose);
}

function asSite(el) {
  const p = el.properties || el;
  const name = p.name || p.NAME || p.title;
  let lat = p.lat ?? p.latitude ?? p.LAT;
  let lng = p.lng ?? p.lon ?? p.longitude ?? p.LON;
  if ((lat == null || lng == null) && el.geometry && el.geometry.type === 'Point') {
    lng = el.geometry.coordinates?.[0]; lat = el.geometry.coordinates?.[1];
  }
  if (!name || lat == null || lng == null) return null;
  return { name, kind: p.kind || p.type || p.amenity || 'site', lat, lng };
}

// ── public API ──────────────────────────────────────────────────────────────

/**
 * Stream a dataset into a room, recording flights/sites as it goes.
 *
 * @param {string} roomId
 * @param {{stream:()=>ReadableStream}|Response|File} source  fetch Response or File
 * @param {object} opts
 * @param {number} [opts.max=Infinity]   cap rows recorded (safety valve)
 * @param {boolean} [opts.ndjson=false]
 * @param {string}  [opts.rootKey='features']
 * @param {'auto'|'flight'|'site'} [opts.classify='auto']
 * @param {AbortSignal} [opts.signal]
 * @param {(p:{seen,recorded,flights,sites})=>void} [opts.onProgress]
 */
export async function hydrateStreaming(roomId, source, opts = {}) {
  const {
    max = Infinity, ndjson = false, rootKey = 'features',
    classify = 'auto', signal, onProgress,
  } = opts;

  const byteStream = source.body || source.stream();
  const text = await textStreamFrom(byteStream);
  const chunks = readChunks(text, signal);
  const elements = ndjson ? streamNdjson(chunks) : streamElements(chunks, { rootKey });

  let seen = 0, recorded = 0, nf = 0, ns = 0;
  for await (const el of elements) {
    if (signal?.aborted) break;
    if (recorded >= max) break;
    seen++;
    try {
      const isFlight = classify === 'flight' || (classify === 'auto' && looksLikeFlight(el));
      if (isFlight) {
        const feat = el.type === 'Feature' ? el : { type: 'Feature', properties: el.properties || el, geometry: el.geometry || null };
        if (await recordFlight(roomId, feat)) { recorded++; nf++; }
      } else {
        const site = asSite(el);
        if (site) { await recordSite(roomId, site); recorded++; ns++; }
      }
    } catch (e) {
      // skip a malformed element; keep going
      console.warn('[hydrate] element skipped:', e?.message || e);
    }
    if (onProgress && seen % 25 === 0) onProgress({ seen, recorded, flights: nf, sites: ns });
  }
  if (onProgress) onProgress({ seen, recorded, flights: nf, sites: ns, done: true });
  return { seen, recorded, flights: nf, sites: ns };
}

/**
 * Archive the *entire* source as one encrypted media block plus a `dataset`
 * entity (provenance). This is the "store the whole thing as a block" path —
 * useful when the file is too large to expand into per-row events but you
 * still want it captured, integrity-hashed, and lazily materialisable later.
 *
 * Note: a single media block must fit in memory and under the homeserver's
 * upload limit; for truly huge files prefer hydrateStreaming with a cap.
 */
export async function archiveDatasetBlob(roomId, file, { name } = {}) {
  const bytes = new Uint8Array(await file.arrayBuffer());
  const ref = await uploadEncrypted(bytes, {
    mime: file.type || 'application/gzip',
    name: name || file.name || 'dataset.json.gz',
  });
  return ins(roomId, ENTITY.DATASET, {
    name: name || file.name || 'dataset',
    size: bytes.length,
    blob: ref,
    archived_at: Date.now(),
  });
}

export async function fetchDataset(url, { signal } = {}) {
  const resp = await fetch(url, { signal });
  if (!resp.ok) throw new Error(`HTTP ${resp.status} fetching dataset`);
  return resp;
}

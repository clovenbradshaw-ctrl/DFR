/**
 * datastore.js — the in-memory dataset and how it moves between OPFS, Matrix
 * media (chained blocks), and the room-state pointer.
 *
 * Storage of the dataset blob, in order of preference:
 *   • single media block  — when the blob fits under the server upload limit.
 *   • chained media blocks + manifest — when it doesn't: the blob is sliced
 *     into block-sized, hash-chained pieces (chunks.js), each uploaded as its
 *     own encrypted media block; a manifest (itself a media block) lists them
 *     in order. The room-state pointer references the manifest.
 *   • OPFS — always the fast local working set (vault-encrypted, per room).
 *
 * Two ingestion shapes:
 *   • parsed     — JSONL/GeoJSON parsed to records, stored as the canonical
 *     gzip-NDJSON blob (single or chained, as size dictates).
 *   • chunked-raw — the user uploads the hydration file *as-is* (possibly
 *     multiple GB) by streaming it straight into chained blocks without ever
 *     buffering or parsing the whole thing. The manifest records its
 *     payload_format so a client small enough to hold it can reassemble + parse.
 */

import { getClient } from '../src/client.js';
import { uploadEncrypted, getMediaBytes } from '../src/media.js';
import { packFlights, unpackFlights, mergeFlights, blobHash } from './packset.js';
import { saveLocal, loadLocal } from './opfsbin.js';
import { readDatasetState, writeDatasetState } from './roomstate.js';
import { toRecord } from './dfr.js';
import { textStreamFrom, readChunks, streamElements, streamNdjson } from './jsonstream.js';
import { chunkBlob, frameBlock, hash64, reassemble } from './chunks.js';
import { fileChunks, streamChunks, guessFormat } from './chunkstream.js';

const FORMAT = 'gzip-ndjson';
const DEFAULT_MEDIA_LIMIT = 50 * 1024 * 1024;
const MAX_CHUNK = 24 * 1024 * 1024;            // cap per-block payload memory
// Reassemble + parse a chained-raw dataset locally only up to this size; beyond
// it, the browser can't hold the dataset, so we keep it archived in media only.
const RAW_AUTOLOAD_LIMIT = 200 * 1024 * 1024;

const PUBLISH_THRESHOLD = 25;
const PUBLISH_MIN_INTERVAL = 30 * 60e3;

const lvKey = (roomId) => `dfr.localver.${roomId}`;
const encoder = new TextEncoder();
const decoder = new TextDecoder();

export class DataStore {
  constructor({ log } = {}) {
    this.log = log || (() => {});
    this.roomId = null;
    this.flights = [];
    this.meta = null;
    this.localVersion = 0;
    this.dirty = 0;
    this.lastPublish = 0;
    this._mediaLimit = DEFAULT_MEDIA_LIMIT;
    this.onChange = null;
  }

  _notify() { if (this.onChange) this.onChange(); }

  async _mediaSizeLimit() {
    try {
      const cfg = getClient()?.getMediaConfig ? await getClient().getMediaConfig() : null;
      const v = cfg?.['m.upload.size'];
      if (typeof v === 'number' && v > 0) this._mediaLimit = v;
    } catch { /* keep default */ }
    return this._mediaLimit;
  }

  async _chunkSize() {
    const limit = await this._mediaSizeLimit();
    // Leave headroom under the limit for the block header + media envelope.
    return Math.max(256 * 1024, Math.min(limit - (1 << 20), MAX_CHUNK));
  }

  // ── open / sync ──────────────────────────────────────────────────────────

  async open(roomId) {
    this.roomId = roomId;
    this.flights = [];
    this.dirty = 0;
    this.localVersion = +localStorage.getItem(lvKey(roomId)) || 0;

    const local = await loadLocal(roomId);
    if (local) {
      this.flights = await unpackFlights(local);
      this.log(`Loaded ${this.flights.length} flights from local store.`, 'mut');
      this._notify();
    }
    this.meta = readDatasetState(roomId);
    if (this.meta && this.meta.version > this.localVersion) await this.sync();
    return { hydrated: !!this.meta?.hydrated, count: this.flights.length };
  }

  isHydrated() { return !!readDatasetState(this.roomId)?.hydrated; }

  async _downloadManifest(ref) {
    const bytes = await getMediaBytes(ref);
    if (!bytes) throw new Error('manifest unavailable');
    return JSON.parse(decoder.decode(bytes));
  }

  /** Download chained blocks named by a manifest and reassemble (verifies chain). */
  async _reassembleFromManifest(manifest) {
    const blocks = [];
    let i = 0;
    for (const c of manifest.chunks) {
      const b = await getMediaBytes(c.ref);
      if (!b) throw new Error(`block ${c.i} unavailable`);
      blocks.push(b);
      this.log(`Fetched block ${++i}/${manifest.chunks.length}…`, 'mut');
    }
    return reassemble(blocks);
  }

  async sync() {
    const state = readDatasetState(this.roomId);
    this.meta = state;
    if (!state) return { synced: false, reason: 'no-pointer' };
    if (state.version <= this.localVersion && this.flights.length) return { synced: false, reason: 'up-to-date' };

    let bytes = null;
    if (state.blob && state.blob.__media) {
      this.log('Downloading dataset snapshot…', 'mut');
      bytes = await getMediaBytes(state.blob);
    } else if (state.manifest && state.manifest.__media) {
      const manifest = await this._downloadManifest(state.manifest);
      if (state.mode === 'chunked-raw' && (manifest.total_bytes || 0) > RAW_AUTOLOAD_LIMIT) {
        this.log(`Dataset is ${(manifest.total_bytes / 1073741824).toFixed(2)} GB across ` +
                 `${manifest.chunk_count} blocks — archived in media, too large to load in-browser.`, 'warn');
        this._adoptVersion(state.version);
        return { synced: false, reason: 'too-large', archived: true };
      }
      this.log(`Reassembling ${manifest.chunk_count} chained blocks…`, 'mut');
      const raw = await this._reassembleFromManifest(manifest);
      if (state.mode === 'chunked-raw') {
        const flights = await flightsFromBytes(raw, manifest.payload_format);
        this._adopt(flights, state.version);
        await saveLocal(this.roomId, await packFlights(this.flights));
        this.log(`Loaded ${flights.length} flights from chained dataset.`, 'ok');
        this._notify();
        return { synced: true, added: flights.length };
      }
      bytes = raw; // canonical gzip-NDJSON
    } else if (state.source_url) {
      this.log('Fetching dataset from external host…', 'mut');
      const resp = await fetch(state.source_url);
      if (resp.ok) bytes = new Uint8Array(await resp.arrayBuffer());
    }
    if (!bytes) return { synced: false, reason: 'no-bytes' };

    const incoming = await unpackFlights(bytes);
    const { merged, added } = mergeFlights(this.flights, incoming);
    this.flights = merged;
    this._adoptVersion(state.version);
    await saveLocal(this.roomId, await packFlights(this.flights));
    this.log(`Synced snapshot v${state.version}: ${incoming.length} records (${added} new).`, 'ok');
    this._notify();
    return { synced: true, added };
  }

  _adoptVersion(v) { this.localVersion = v; localStorage.setItem(lvKey(this.roomId), String(v)); }
  _adopt(flights, v) { this.flights = flights; this._adoptVersion(v); }

  // ── ingestion: parsed ──────────────────────────────────────────────────────

  async hydrateFrom(source, { format = 'auto', sourceUrl = null, max = Infinity, signal, onProgress } = {}) {
    const records = [];
    let bin = format === 'binary';
    if (format === 'auto') bin = /\.(bin|gz)$/i.test(source.name || source.url || '');

    if (bin) {
      const buf = source.arrayBuffer ? await source.arrayBuffer() : await new Response(source.body).arrayBuffer();
      for (const f of await unpackFlights(new Uint8Array(buf))) { records.push(toRecord(f)); if (records.length >= max) break; }
    } else {
      const text = await textStreamFrom(source.body || source.stream());
      const chunks = readChunks(text, signal);
      const ndjson = format === 'jsonl' || /\.(ndjson|jsonl)$/i.test(source.name || source.url || '');
      const elements = ndjson ? streamNdjson(chunks) : streamElements(chunks);
      let seen = 0;
      for await (const el of elements) {
        if (signal?.aborted) break;
        records.push(toRecord(el)); seen++;
        if (onProgress && seen % 50 === 0) onProgress({ seen, recorded: records.length });
        if (records.length >= max) break;
      }
    }
    if (!records.length) throw new Error('No flight records found in the source.');

    const { merged, added } = mergeFlights(this.flights, records);
    this.flights = merged;
    await saveLocal(this.roomId, await packFlights(this.flights));
    this._notify();
    await this.publish({ markHydrated: true, sourceUrl });
    return { recorded: records.length, added, total: this.flights.length };
  }

  // ── ingestion: chunked-raw (multi-GB, streamed straight to media) ───────────

  async hydrateRawChunked(source, { format = 'auto', signal, onProgress } = {}) {
    const isFile = typeof source.slice === 'function';
    const name = source.name || source.url || 'dataset';
    const payload_format = format && format !== 'auto' ? format : guessFormat(name);
    const size = await this._chunkSize();
    const iter = isFile ? fileChunks(source, size, signal) : streamChunks(source.body, size, signal);

    let prev = [0, 0], i = 0, total = 0;
    const chunks = [];
    for await (const payload of iter) {
      if (signal?.aborted) throw new DOMException('aborted', 'AbortError');
      const self = hash64(payload);
      const framed = frameBlock(i, 0, prev, payload, 0);
      const ref = await uploadEncrypted(framed, { mime: 'application/octet-stream', name: `${name}.blk${i}.bin` });
      chunks.push({ i, size: payload.length, self, prev, ref });
      total += payload.length; prev = self; i++;
      if (onProgress) onProgress({ block: i, bytes: total });
      this.log(`Uploaded block ${i} (${(total / 1048576).toFixed(1)} MB total)…`, 'mut');
    }
    if (!i) throw new Error('Empty source — nothing to upload.');

    const manifestRef = await this._uploadManifest({ payload_format, name, total_bytes: total, chunks, head: prev });
    const prevState = readDatasetState(this.roomId);
    const version = (prevState?.version || this.localVersion || 0) + 1;
    const content = {
      hydrated: true, mode: 'chunked-raw', format: 'dfr-chain/1', payload_format,
      manifest: manifestRef, chunk_count: i, total_bytes: total, blob: null,
      count: prevState?.count ?? 0, version, hash: prev[0],
      source_url: source.url || prevState?.source_url || null,
      updated_at: Date.now(), updated_by: getClient()?.getUserId() || null,
    };
    await writeDatasetState(this.roomId, content);
    this.meta = content; this._adoptVersion(version); this.dirty = 0; this.lastPublish = Date.now();
    this.log(`Uploaded ${i} chained blocks (${(total / 1048576).toFixed(1)} MB) + manifest; pointer v${version}.`, 'ok');
    this._notify();
    return { chunkCount: i, totalBytes: total, version };
  }

  // ── scraper feed ────────────────────────────────────────────────────────────

  async addFlights(rawFlights) {
    const recs = rawFlights.map(toRecord);
    const { merged, added } = mergeFlights(this.flights, recs);
    if (!added) return { added: 0 };
    this.flights = merged;
    this.dirty += added;
    await saveLocal(this.roomId, await packFlights(this.flights));
    this._notify();
    return { added };
  }

  async maybePublish() {
    const due = this.dirty >= PUBLISH_THRESHOLD ||
                (this.dirty > 0 && Date.now() - this.lastPublish >= PUBLISH_MIN_INTERVAL);
    return due ? this.publish({}) : { published: false };
  }

  // ── publish (canonical: single block, or chained blocks + manifest) ─────────

  async _uploadManifest({ payload_format, name, total_bytes, chunks, head }) {
    const manifest = {
      dfr_manifest: 1, chain: 'dfr-chain/1', payload_format, name,
      total_bytes, chunk_count: chunks.length, head, chunks,
      created_at: Date.now(),
    };
    const bytes = encoder.encode(JSON.stringify(manifest));
    return uploadEncrypted(bytes, { mime: 'application/json', name: `${name}.manifest.json` });
  }

  async _uploadCanonicalChunked(bytes, version) {
    const size = await this._chunkSize();
    const { blocks, metas, head } = chunkBlob(bytes, size);
    const chunks = [];
    for (let j = 0; j < blocks.length; j++) {
      const ref = await uploadEncrypted(blocks[j], { mime: 'application/octet-stream', name: `dfr-v${version}.blk${j}.bin` });
      chunks.push({ i: j, size: metas[j].size, self: metas[j].self, prev: metas[j].prev, ref });
      this.log(`Uploaded block ${j + 1}/${blocks.length}…`, 'mut');
    }
    return this._uploadManifest({ payload_format: FORMAT, name: `dfr-v${version}`, total_bytes: bytes.length, chunks, head });
  }

  async publish({ markHydrated = false, sourceUrl = null } = {}) {
    if (!this.roomId) return { published: false };
    const bytes = await packFlights(this.flights);
    const limit = await this._mediaSizeLimit();
    const prev = readDatasetState(this.roomId);
    const version = (prev?.version || this.localVersion || 0) + 1;

    let blob = null, manifest = null, mode = 'empty', chunkCount = 0;
    if (this.flights.length === 0) {
      mode = 'empty';
    } else if (bytes.length <= limit) {
      this.log(`Uploading snapshot (${(bytes.length / 1048576).toFixed(2)} MB) as one block…`, 'mut');
      blob = await uploadEncrypted(bytes, { mime: 'application/gzip', name: `dfr-v${version}.ndjson.gz` });
      mode = 'single';
    } else {
      this.log(`Snapshot ${(bytes.length / 1048576).toFixed(1)} MB exceeds limit — chaining into blocks…`, 'mut');
      manifest = await this._uploadCanonicalChunked(bytes, version);
      mode = 'chunked';
      chunkCount = (await this._downloadManifest(manifest)).chunk_count;
    }

    const content = {
      hydrated: markHydrated || !!prev?.hydrated,
      mode, format: FORMAT, payload_format: FORMAT, version,
      count: this.flights.length, hash: blobHash(bytes),
      blob, manifest, chunk_count: chunkCount,
      source_url: sourceUrl ?? prev?.source_url ?? null,
      updated_at: Date.now(), updated_by: getClient()?.getUserId() || null,
    };
    await writeDatasetState(this.roomId, content);
    this.meta = content; this._adoptVersion(version); this.dirty = 0; this.lastPublish = Date.now();
    this.log(`Published v${version} (${content.count} flights, ${mode}).`, 'ok');
    this._notify();
    return { published: true, version, mode };
  }

  knownIds() {
    const s = new Set();
    for (const f of this.flights) {
      if (f.flight_id) s.add(f.flight_id);
      if (f.object_id != null) s.add('oid_' + f.object_id);
    }
    return s;
  }
}

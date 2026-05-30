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
import { toRecord, toAgency, agencyKey, focusQueryUrl, feedFetch } from './dfr.js';
import { textStreamFrom, readChunks, streamElements, streamNdjson } from './jsonstream.js';
import { chunkBlob, frameBlock, hash64, reassemble, reassembleStream } from './chunks.js';
import { fileChunks, streamChunks, guessFormat } from './chunkstream.js';
import { extractLeanFlights } from './leanindex.js';
import { act } from './activity.js';

const FORMAT = 'gzip-ndjson';
const DEFAULT_MEDIA_LIMIT = 50 * 1024 * 1024;
const MAX_CHUNK = 24 * 1024 * 1024;            // cap per-block payload memory

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
    this.agencies = [];
    this.meta = null;
    this.localVersion = 0;
    this.dirty = 0;
    this.lastPublish = 0;
    this._mediaLimit = DEFAULT_MEDIA_LIMIT;
    this.onChange = null;
    this.onBusy = null;   // (info|null) → UI loading overlay; null clears it
  }

  _notify() { if (this.onChange) this.onChange(); }
  _busy(title, sub, frac) { if (this.onBusy) this.onBusy(title == null ? null : { title, sub, frac }); }

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
    await this._loadAgencies();
    return { hydrated: !!this.meta?.hydrated, count: this.flights.length };
  }

  // ── agencies (a parallel lean layer) ────────────────────────────────────────

  async _loadAgencies() {
    this.agencies = [];
    const state = readDatasetState(this.roomId);
    const ref = state?.agencies_index;
    if (ref && ref.__media) {
      try {
        const bytes = await getMediaBytes(ref);
        if (bytes) { this.agencies = await unpackFlights(bytes); this._notify(); }
      } catch (e) { this.log(`Agencies load: ${e.message}`, 'warn'); }
    }
  }

  /**
   * Hydrate the agencies layer from an NDJSON/JSON/GeoJSON source (streamed,
   * gzip-aware). Stored as its own small gzip-NDJSON media block, referenced by
   * `agencies_index` in room state — independent of the flights dataset.
   */
  async hydrateAgencies(source, { format = 'auto', signal, onProgress } = {}) {
    const text = await textStreamFrom(source.body || source.stream());
    const chunks = readChunks(text, signal);
    const name = source.name || source.url || '';
    const ndjson = format === 'jsonl' || format === 'ndjson' || /\.(ndjson|jsonl)$/i.test(name);
    const elements = ndjson ? streamNdjson(chunks) : streamElements(chunks);
    const seen = new Set();
    const out = [];
    let n = 0;
    for await (const el of elements) {
      if (signal?.aborted) break;
      const a = toAgency(el.properties || el);
      const k = agencyKey(a);
      if (k && !seen.has(k)) { seen.add(k); out.push(a); }
      if (onProgress && ++n % 500 === 0) onProgress({ seen: n, kept: out.length });
    }
    if (!out.length) throw new Error('No agency records found (check the data shape).');
    this.agencies = out;
    const packed = await packFlights(out); // same gzip-NDJSON codec
    const ref = await uploadEncrypted(packed, { mime: 'application/gzip', name: 'dfr-agencies.ndjson.gz' });
    const state = readDatasetState(this.roomId) || {};
    const version = (state.version || this.localVersion || 0) + 1;
    await writeDatasetState(this.roomId, { ...state, agencies_index: ref, agencies_count: out.length,
      version, updated_at: Date.now(), updated_by: getClient()?.getUserId() || null });
    this._adoptVersion(version);
    this.log(`Loaded ${out.length} agencies.`, 'ok');
    this._notify();
    return { agencies: out.length };
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

  /**
   * Stream a chained archive from media and extract a lean, viewable index
   * (metadata + start coordinate; geometry dropped) without ever holding the
   * whole archive in memory. Returns the lean flight records.
   */
  async _indexFromManifest(manifest) {
    const total = manifest.chunk_count || (manifest.chunks ? manifest.chunks.length : 0);
    this._busy('Loading dataset from blocks', `0 / ${total} blocks`, 0);
    act.sync(`Reassembling dataset from ${total} block(s)`, { blocks: total });
    const payloadStream = reassembleStream(
      manifest.chunks,
      (ref) => getMediaBytes(ref),
      (n, t) => {
        if (n % 5 === 0 || n === t) this.log(`Reassembling block ${n}/${t}…`, 'mut');
        this._busy('Loading dataset from blocks', `block ${n} / ${t}`, total ? n / total : 0);
      },
    );
    const flights = await extractLeanFlights(payloadStream, {
      payloadFormat: manifest.payload_format,
      onProgress: (p) => {
        if (p.seen % 5000 === 0) {
          this.log(`…${p.kept} of ${p.seen} parsed kept`, 'mut');
          this._busy('Indexing flights', `${p.kept.toLocaleString()} flights`, null);
        }
      },
      onSample: (info) => this.log(`First record keys: ${(info.keys || []).join(', ') || '(none)'}`, 'mut'),
    });
    this._busy(null);
    return flights;
  }

  /**
   * Build (or rebuild) the lean index from the chained archive already in this
   * room's media — no re-upload. Publishes the index as a small media block and
   * points the room state at it so every client (incl. invitees) loads fast.
   */
  async buildIndexFromArchive() {
    const state = readDatasetState(this.roomId);
    if (!state?.manifest?.__media) throw new Error('No chained archive in this room to index.');
    const manifest = await this._downloadManifest(state.manifest);
    this.log(`Building index from ${manifest.chunk_count} blocks…`, 'mut');
    const flights = await this._indexFromManifest(manifest);
    if (!flights.length) throw new Error('No flight records found in the archive (check the data shape).');
    this.flights = flights;
    const packed = await packFlights(flights);
    await saveLocal(this.roomId, packed);
    const leanRef = await uploadEncrypted(packed, { mime: 'application/gzip', name: 'dfr-lean-index.ndjson.gz' });
    const version = (state.version || this.localVersion || 0) + 1;
    const content = { ...state, lean_index: leanRef, count: flights.length, version,
      updated_at: Date.now(), updated_by: getClient()?.getUserId() || null };
    await writeDatasetState(this.roomId, content);
    this.meta = content; this._adoptVersion(version);
    this.log(`Index ready: ${flights.length} flights (v${version}).`, 'ok');
    this._notify();
    return { flights: flights.length, version };
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
    } else if (state.lean_index && state.lean_index.__media) {
      // A small, already-extracted viewable index exists — the fast path. The
      // full geometry stays in the chained archive (state.manifest).
      this.log('Downloading lean flight index…', 'mut');
      bytes = await getMediaBytes(state.lean_index);
    } else if (state.manifest && state.manifest.__media) {
      const manifest = await this._downloadManifest(state.manifest);
      if (state.mode === 'chunked-raw') {
        // No prebuilt index: stream the chained archive block-by-block and
        // extract a lean index in-flight (never holds the whole archive).
        this.log(`Indexing ${manifest.chunk_count} chained blocks (${(manifest.total_bytes / 1073741824).toFixed(2)} GB)…`, 'mut');
        const flights = await this._indexFromManifest(manifest);
        this._adopt(flights, state.version);
        await saveLocal(this.roomId, await packFlights(this.flights));
        this.log(`Indexed ${flights.length} flights from chained dataset.`, 'ok');
        act.sync(`Loaded ${flights.length.toLocaleString()} flights from ${manifest.chunk_count} blocks`, { flights: flights.length, blocks: manifest.chunk_count });
        this._notify();
        return { synced: true, added: flights.length };
      }
      this.log(`Reassembling ${manifest.chunk_count} chained blocks…`, 'mut');
      bytes = await this._reassembleFromManifest(manifest); // canonical gzip-NDJSON
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
    act.sync(`Synced snapshot v${state.version} — ${added.toLocaleString()} new of ${incoming.length.toLocaleString()}`, { version: state.version, added });
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
      act.block(`Block #${i} created`, { index: i, sizeMB: +(payload.length / 1048576).toFixed(2), totalMB: +(total / 1048576).toFixed(1) });
    }
    if (!i) throw new Error('Empty source — nothing to upload.');

    const manifest = { dfr_manifest: 1, chain: 'dfr-chain/1', payload_format, name,
      total_bytes: total, chunk_count: i, head: prev, chunks, created_at: Date.now() };
    const manifestRef = await this._uploadManifest({ payload_format, name, total_bytes: total, chunks, head: prev });
    const prevState = readDatasetState(this.roomId);
    const version = (prevState?.version || this.localVersion || 0) + 1;

    // Stream the just-uploaded archive back from media block-by-block and build
    // a small viewable index, so flights show immediately (and invitees load
    // the few-MB index, not the multi-GB archive).
    let leanRef = null, count = prevState?.count ?? 0;
    try {
      this.log('Building viewable index from the upload…', 'mut');
      const flights = await this._indexFromManifest(manifest);
      if (flights.length) {
        this.flights = flights;
        const packed = await packFlights(flights);
        await saveLocal(this.roomId, packed);
        leanRef = await uploadEncrypted(packed, { mime: 'application/gzip', name: `${name}.lean.ndjson.gz` });
        count = flights.length;
        this._notify();
      } else {
        this.log('No flight records recognised in the upload — stored as raw archive. ' +
                 'Use "Build index" after confirming the data shape.', 'warn');
      }
    } catch (e) {
      this.log(`Index build deferred: ${e.message}. Raw archive is safe; use "Build index".`, 'warn');
    }

    const content = {
      hydrated: true, mode: 'chunked-raw', format: 'dfr-chain/1', payload_format,
      manifest: manifestRef, lean_index: leanRef, chunk_count: i, total_bytes: total, blob: null,
      count, version, hash: prev[0],
      source_url: source.url || prevState?.source_url || null,
      updated_at: Date.now(), updated_by: getClient()?.getUserId() || null,
    };
    await writeDatasetState(this.roomId, content);
    this.meta = content; this._adoptVersion(version); this.dirty = 0; this.lastPublish = Date.now();
    this.log(`Uploaded ${i} chained blocks (${(total / 1048576).toFixed(1)} MB) + manifest; ${count} flights indexed; pointer v${version}.`, 'ok');
    this._notify();
    return { chunkCount: i, totalBytes: total, version, indexed: count };
  }

  // ── focus fetch (live, targeted — no full sync) ─────────────────────────────

  /**
   * Pull recent flights intersecting a map bbox straight from the live Skydio
   * feed and merge them into the working set immediately — independent of the
   * (possibly multi-GB) archive. Same bbox-query pattern as the main app, with
   * a direct-then-proxy fetch and pagination.
   *
   * @param {[number,number,number,number]} bbox  [west,south,east,north] WGS84
   * @param {object} opts
   * @param {number} [opts.sinceTs]  recency floor on takeoff (ms); default 7 days
   * @param {string} [opts.proxy]    CORS proxy prefix
   * @param {AbortSignal} [opts.signal]
   */
  async focusFetch(bbox, { sinceTs = Date.now() - 7 * 864e5, proxy = '', signal } = {}) {
    act.api('Checking live feed for recent flights in view', { bbox: bbox.map(n => +n.toFixed(3)) });
    const PAGE = 2000, CAP = 8000;
    let offset = 0, fetched = [];
    while (offset < CAP) {
      if (signal?.aborted) throw new DOMException('aborted', 'AbortError');
      const url = focusQueryUrl(bbox, { sinceTs, offset, pageSize: PAGE });
      const gj = await feedFetch(url, proxy);
      const fs = (gj && gj.features) || [];
      fetched = fetched.concat(fs);
      if (fs.length < PAGE) break;
      offset += PAGE;
    }
    if (!fetched.length) { this.log('No recent flights in this area.', 'mut'); return { added: 0, fetched: 0 }; }

    const recs = fetched.map(toRecord);
    const { merged, added } = mergeFlights(this.flights, recs);
    this.flights = merged;
    if (added) {
      this.dirty += added;
      await saveLocal(this.roomId, await packFlights(this.flights));
    }
    this._notify();
    this.log(`Focus fetch: ${fetched.length} flights here, ${added} new.`, added ? 'ok' : 'mut');
    if (added) act.add(`Added ${added} flight(s) from live focus`, { added, source: 'focus' });
    return { added, fetched: fetched.length };
  }

  // ── scraper feed ────────────────────────────────────────────────────────────

  async addFlights(rawFlights) {
    const recs = rawFlights.map(toRecord);
    const { merged, added } = mergeFlights(this.flights, recs);
    if (!added) return { added: 0 };
    this.flights = merged;
    this.dirty += added;
    const newAgencies = this._discoverAgencies(recs);
    await saveLocal(this.roomId, await packFlights(this.flights));
    this._notify();
    act.add(`Added ${added} flight(s) to the dataset`, { added, source: 'scraper' });
    if (newAgencies) act.add(`Discovered ${newAgencies} new department(s)`, { newAgencies });
    return { added, newAgencies };
  }

  /**
   * Mint stub agencies for any organization_id we see on flights but don't yet
   * have an agency record for. Keeps the department list complete as new
   * departments start flying, before their metadata is loaded. Centroid is the
   * mean of the new flights' start points so the stub is mappable.
   */
  _discoverAgencies(recs) {
    const known = new Set(this.agencies.map(a => a.id));
    const acc = new Map();
    for (const f of recs) {
      const u = f.organization_id;
      if (!u || known.has(u)) continue;
      const c = f.start_coords;
      const e = acc.get(u) || { id: u, name: '', city: '', county: '', state: '', address: '', sx: 0, sy: 0, n: 0, discovered: true };
      if (c && c.length >= 2) { e.sx += c[0]; e.sy += c[1]; e.n++; }
      acc.set(u, e);
    }
    let added = 0;
    for (const e of acc.values()) {
      if (e.n) { e.lng = e.sx / e.n; e.lat = e.sy / e.n; }
      delete e.sx; delete e.sy; delete e.n;
      this.agencies.push(e);
      added++;
    }
    return added;
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
      act.block(`Snapshot block ${j + 1}/${blocks.length} created (v${version})`, { index: j, version });
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
      act.block(`Snapshot block created (v${version}, ${(bytes.length / 1048576).toFixed(2)} MB)`, { version, sizeMB: +(bytes.length / 1048576).toFixed(2) });
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

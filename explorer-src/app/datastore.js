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
 *
 * Live updates (scraper / focus fetch) use an event-log → rollup model:
 *   • Each genuinely-new flight posts immediately as a durable room *event*
 *     (INS, lean geometry) via the offline outbox — so it's in Matrix the moment
 *     it's found and survives the user leaving; no flush race.
 *   • Once ROLLUP_THRESHOLD loose events accumulate, they're folded into the
 *     dataset blob (a fresh snapshot block) and the superseded events are
 *     redacted, keeping the room timeline lean. The block is the compaction;
 *     the events are the durable interim. open()/onTimeline fold loose events
 *     into the working set (dedup by flight_id) so nothing is missed.
 */

import { getClient } from '../src/client.js';
import { ins } from '../src/operators.js';
import { getTimeline } from '../src/rooms.js';
import { uploadEncrypted, getMediaBytes } from '../src/media.js';
import { packFlights, unpackFlights, mergeFlights, blobHash, flightId } from './packset.js';
import { saveLocal, loadLocal } from './opfsbin.js';
import { readDatasetState, writeDatasetState } from './roomstate.js';
import { toRecord, toAgency, agencyKey, focusQueryUrl, feedFetch,
         fsForOrg, countUrl, agencyTailUrl, agencyQueryUrl } from './dfr.js';
import { textStreamFrom, readChunks, streamElements, streamNdjson } from './jsonstream.js';
import { chunkBlob, frameBlock, hash64, reassemble, reassembleStream } from './chunks.js';
import { fileChunks, streamChunks, guessFormat } from './chunkstream.js';
import { extractLeanFlights } from './leanindex.js';
import { ENTITY } from './dfr.js';
import { act } from './activity.js';

// New flights post as durable room *events* the moment they're found, then get
// rolled up into a block once enough accumulate (and the loose events redacted).
// 100 ≈ a comfortable margin under Matrix homeservers' typical per-request /
// timeline limits, so we compact well before hitting them.
const ROLLUP_THRESHOLD = 100;

const FORMAT = 'gzip-ndjson';
const DEFAULT_MEDIA_LIMIT = 50 * 1024 * 1024;
const MAX_CHUNK = 24 * 1024 * 1024;            // cap per-block payload memory

// Keep a department's batch event comfortably under typical Matrix event-size
// limits (~64KB). Beyond this we split into multiple events; a single flight
// whose full geometry alone exceeds it is hoisted to media by the outbox.
// Matrix's hard cap is 65536 bytes for the WHOLE event (PDU), not just content
// — the homeserver rejects anything larger with M_TOO_LARGE. The Megolm
// envelope, event_id, sender, signatures, and our INS wrapper (entity_type,
// anchor, payload keys) all count against it, so we budget content well under
// 64KB and measure the actual sent shape, not just the flight array.
const EVENT_MAX = 65536;
const EVENT_OVERHEAD = 12 * 1024;             // envelope + INS wrapper headroom
const EVENT_BUDGET = EVENT_MAX - EVENT_OVERHEAD;   // ≈ 53KB for the encoded payload
const encoder0 = new TextEncoder();
const jsonBytes = (v) => encoder0.encode(JSON.stringify(v)).length;   // UTF-8 bytes, not chars

function bytesToB64(bytes) {
  let s = ''; const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) s += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
  return btoa(s);
}
function b64ToBytes(b64) {
  const bin = atob(b64); const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/**
 * Pack flights into BINARY batches that fit the Matrix event limit. Each batch
 * is gzipped NDJSON, base64'd into the event — far denser than raw JSON (gzip
 * ≈4-5× on flight data), so one event holds many more flights. We grow a batch
 * greedily, compress, and verify the encoded size is under budget, backing off
 * if a record pushes it over. Returns [{ b64, n }] (n = flight count).
 */
async function packedBatches(records) {
  const out = [];
  let i = 0;
  while (i < records.length) {
    // Grow the batch until the gzipped+base64 payload would exceed the budget,
    // then emit the largest size that fit. Doubling probe keeps it ~O(log n)
    // compressions per batch.
    let take = Math.min(records.length - i, 256);
    let best = 0, bestB64 = null;
    while (true) {
      const slice = records.slice(i, i + take);
      const b64 = bytesToB64(await packFlights(slice));
      if (b64.length <= EVENT_BUDGET) {
        best = take; bestB64 = b64;
        if (i + take >= records.length) break;            // consumed everything
        take = Math.min(records.length - i, take * 2);     // try to fit more
        continue;
      }
      if (best) break;                                     // last smaller size stands
      take = Math.max(1, Math.floor(take / 2));            // even one slice too big → shrink
      if (take === 1) { best = 1; bestB64 = bytesToB64(await packFlights(records.slice(i, i + 1))); break; }
    }
    out.push({ b64: bestB64, n: best });
    i += best;
  }
  return out;
}

const PUBLISH_THRESHOLD = 25;
const PUBLISH_MIN_INTERVAL = 30 * 60e3;
const UPLOAD_CONCURRENCY = 4;   // parallel media uploads during publish/hydrate
const SHARD_LOAD_CONCURRENCY = 8;   // parallel department-shard fetches on open/sync (reads are cheap to overlap)
const SHARD_NOTIFY_EVERY = 5;       // repaint the map every N shards landed, not every one

/** Run `fn` over items with at most `limit` in flight; returns results in order. */
async function parallelMap(items, limit, fn) {
  const out = new Array(items.length);
  let next = 0;
  const worker = async () => {
    while (true) {
      const i = next++;
      if (i >= items.length) return;
      out[i] = await fn(items[i], i);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}

const lvKey = (roomId) => `dfr.localver.${roomId}`;
const encoder = new TextEncoder();
const decoder = new TextDecoder();

/** bbox [w,s,e,n] over a set of flights' start coords (for the manifest index). */
function bboxOf(flights) {
  let w = Infinity, s = Infinity, e = -Infinity, n = -Infinity, any = false;
  for (const f of flights) {
    const c = f.start_coords;
    if (!c || c.length < 2) continue;
    any = true;
    if (c[0] < w) w = c[0]; if (c[0] > e) e = c[0];
    if (c[1] < s) s = c[1]; if (c[1] > n) n = c[1];
  }
  return any ? [w, s, e, n] : null;
}

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
    await this.mergeLooseEvents();   // fold in any flight events not yet rolled into the block
    return { hydrated: !!this.meta?.hydrated, count: this.flights.length };
  }

  /**
   * Merge flight INS events from the live timeline into the working set. These
   * are flights posted since the last rollup (durable, but not yet in a block).
   * Idempotent — dedup by flight_id — so it's safe to call on open and on each
   * new timeline event.
   */
  async mergeLooseEvents() {
    if (!this.roomId) return 0;
    const evs = getTimeline(this.roomId) || [];
    const recs = [];
    let loose = 0;
    for (const e of evs) {
      const t = typeof e.getType === 'function' ? e.getType() : e.type;
      if (!t || !t.endsWith('.ins')) continue;
      const u = typeof e.getUnsigned === 'function' ? e.getUnsigned() : e.unsigned;
      if (u && u.redacted_because) continue;          // already rolled up
      const c = typeof e.getContent === 'function' ? e.getContent() : e.content;
      if (!c) continue;
      if (c.entity_type === ENTITY.FLIGHT_BATCH) {
        if (c.data && c.enc === 'gzip-ndjson-b64') {            // binary batch
          try { for (const f of await unpackFlights(b64ToBytes(c.data))) recs.push(toRecord(f)); } catch {}
        } else if (c.payload?.flights) {                        // legacy JSON batch
          for (const f of c.payload.flights) recs.push(toRecord(f));
        }
        loose++;
      } else if (c.entity_type === ENTITY.FLIGHT && c.payload) { // legacy single-flight
        recs.push(toRecord(c.payload));
        loose++;
      }
    }
    this.looseEvents = loose;
    if (!recs.length) return 0;
    const { merged, added } = mergeFlights(this.flights, recs);
    if (added) { this.flights = merged; this._notify(); }
    return added;
  }

  // ── agencies (a parallel lean layer) ────────────────────────────────────────

  async _loadAgencies() {
    const state = readDatasetState(this.roomId);
    const ref = state?.agencies_index;
    let loaded = [];
    if (ref && ref.__media) {
      try {
        const bytes = await getMediaBytes(ref);
        if (bytes) loaded = await unpackFlights(bytes);
      } catch (e) { this.log(`Agencies load: ${e.message}`, 'warn'); }
    }
    // Merge real agency records over any manifest-seeded stubs (don't wipe the
    // stubs — they give every sharded department a name/location fallback).
    const byId = new Map();
    for (const a of (this.agencies || [])) if (a.id) byId.set(a.id, a);
    for (const a of loaded) if (a.id) byId.set(a.id, { ...byId.get(a.id), ...a, stub: false });
    this.agencies = [...byId.values()];
    // Re-seed stubs for any sharded department still missing an agency record.
    if (this.deptManifest) this._seedAgenciesFromManifest(this.deptManifest);
    this._notify();
  }

  // ── lazy per-department loading (sharded manifest) ──────────────────────────

  /** Department index from the manifest: [{ org, count, bbox, tmin, tmax, loaded }]. */
  deptIndex() {
    const m = this.deptManifest;
    if (!m || !m.departments) return [];
    return Object.entries(m.departments).map(([org, d]) => ({
      org, count: d.count || 0, bbox: d.bbox || null, tmin: d.tmin, tmax: d.tmax,
      loaded: this._loadedOrgs?.has(org) || false,
    }));
  }

  // Sharded datasets are now loaded eagerly on open (all shards), so the UI
  // treats them as fully present — not lazy. (Lazy-on-open was reverted.)
  isLazy() { return false; }

  /** Give the Departments tab counts/locations before any block is fetched. */
  _seedAgenciesFromManifest(manifest) {
    const known = new Set((this.agencies || []).map(a => a.id));
    for (const [org, d] of Object.entries(manifest.departments || {})) {
      if (known.has(org)) continue;
      const bb = d.bbox;
      this.agencies.push({ id: org, name: '', city: '', county: '', state: '', address: '',
        lat: bb ? (bb[1] + bb[3]) / 2 : null, lng: bb ? (bb[0] + bb[2]) / 2 : null, stub: true });
    }
  }

  /**
   * Fetch ONE department's flight block on demand and merge it into the working
   * set. Idempotent — repeat calls are cheap no-ops once loaded.
   */
  async loadDepartment(org) {
    const m = this.deptManifest;
    const d = m && m.departments && m.departments[org];
    if (!d) return { added: 0 };
    if (this._loadedOrgs?.has(org)) return { added: 0, already: true };
    this._busy('Loading department', org.slice(0, 8), null);
    try {
      let bytes;
      if (d.ref && d.ref.__media) bytes = await getMediaBytes(d.ref);
      else if (d.chunks) bytes = reassemble(await Promise.all(d.chunks.map(c => getMediaBytes(c.ref))));
      if (!bytes) { this.log(`Department ${org.slice(0, 8)} block unavailable.`, 'warn'); return { added: 0 }; }
      const recs = await unpackFlights(bytes);
      const { merged, added } = mergeFlights(this.flights, recs);
      this.flights = merged;
      (this._loadedOrgs || (this._loadedOrgs = new Set())).add(org);
      await saveLocal(this.roomId, await packFlights(this.flights));
      act.add(`Loaded department ${org.slice(0, 8)}: ${recs.length} flights`, { org: org.slice(0, 8), flights: recs.length });
      this._notify();
      return { added, total: recs.length };
    } finally { this._busy(null); }
  }

  /** Load every department block (used by Demographics / full-map). */
  async loadAllDepartments(onProgress) {
    const idx = this.deptIndex();
    let i = 0;
    for (const d of idx) {
      if (!d.loaded) await this.loadDepartment(d.org);
      if (onProgress) onProgress(++i, idx.length);
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
    if (state.mode === 'sharded' && state.manifest && state.manifest.__media) {
      // Read the per-department manifest, then load EVERY department shard so
      // the whole dataset (map, stats, departments) is present on open — the
      // behavior before lazy loading. (Reverted from lazy-on-open: lazy left
      // the map/stats empty until each department was manually opened.)
      //
      // Shards are fetched with bounded concurrency rather than one request at
      // a time — with dozens/hundreds of departments, network round-trip
      // latency (not bandwidth) dominates, so overlapping requests cuts total
      // load time roughly by the concurrency factor. Flights are merged into
      // the working set — and the UI notified — incrementally as shards land,
      // so the map fills in progressively instead of staying empty until the
      // very last department finishes.
      this.log('Loading department manifest…', 'mut');
      const manifest = await this._downloadManifest(state.manifest);
      this.deptManifest = manifest;
      this._loadedOrgs = new Set();
      this._seedAgenciesFromManifest(manifest);
      this._notify();   // paint agency stubs on the map right away
      const orgs = Object.keys(manifest.departments || {});
      this._busy('Loading dataset', `0 / ${orgs.length} departments`, 0);
      let done = 0, pending = [];
      const flushPending = () => {
        if (!pending.length) return;
        const { merged } = mergeFlights(this.flights, pending);
        this.flights = merged;
        pending = [];
        this._notify();   // progressive paint — the map fills in as shards land
      };
      let next = 0;
      const worker = async () => {
        while (true) {
          const idx = next++;
          if (idx >= orgs.length) return;
          const org = orgs[idx];
          const d = manifest.departments[org];
          try {
            let b;
            if (d.ref && d.ref.__media) b = await getMediaBytes(d.ref);
            else if (d.chunks) b = reassemble(await Promise.all(d.chunks.map(c => getMediaBytes(c.ref))));
            if (b) { for (const r of await unpackFlights(b)) pending.push(r); this._loadedOrgs.add(org); }
          } catch (e) { this.log(`Department ${org.slice(0, 8)} load failed: ${e.message}`, 'warn'); }
          done++;
          if (done % 10 === 0 || done === orgs.length) this._busy('Loading dataset', `${done} / ${orgs.length} departments`, done / orgs.length);
          if (done % SHARD_NOTIFY_EVERY === 0) flushPending();
        }
      };
      await Promise.all(Array.from({ length: Math.min(SHARD_LOAD_CONCURRENCY, orgs.length) }, worker));
      flushPending();   // merge any remainder
      this._busy(null);
      this._adoptVersion(state.version);
      await saveLocal(this.roomId, await packFlights(this.flights));
      act.sync(`Loaded ${this.flights.length.toLocaleString()} flights from ${orgs.length} department shards`, { flights: this.flights.length, departments: orgs.length });
      this.log(`Loaded ${this.flights.length.toLocaleString()} flights from ${orgs.length} departments.`, 'ok');
      this._notify();
      return { synced: true, added: this.flights.length };
    }
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

    // Stream the source slice-by-slice (never fully buffered). The hash chain
    // is sequential & cheap, computed as we go; the uploads — the slow part —
    // run through a bounded parallel pool (≤UPLOAD_CONCURRENCY in flight).
    let prev = [0, 0], i = 0, total = 0;
    const chunks = [];
    const inflight = new Set();
    const pumpUpload = (framed, meta) => {
      const pr = uploadEncrypted(framed, { mime: 'application/octet-stream', name: `${name}.blk${meta.i}.bin` })
        .then(ref => { meta.ref = ref; })
        .finally(() => inflight.delete(pr));
      inflight.add(pr);
      return pr;
    };
    for await (const payload of iter) {
      if (signal?.aborted) throw new DOMException('aborted', 'AbortError');
      const self = hash64(payload);
      const framed = frameBlock(i, 0, prev, payload, 0);
      const meta = { i, size: payload.length, self, prev, ref: null };
      chunks.push(meta);
      pumpUpload(framed, meta);
      total += payload.length; prev = self; i++;
      if (onProgress) onProgress({ block: i, bytes: total });
      this.log(`Uploading block ${i} (${(total / 1048576).toFixed(1)} MB, ${inflight.size} in flight)…`, 'mut');
      // Backpressure: don't let more than the pool size queue up (keeps memory
      // ~N chunks and avoids overwhelming the homeserver).
      while (inflight.size >= UPLOAD_CONCURRENCY) await Promise.race(inflight);
    }
    await Promise.all(inflight);   // drain remaining uploads
    if (!i) throw new Error('Empty source — nothing to upload.');
    if (chunks.some(c => !c.ref)) throw new Error('Some blocks failed to upload.');

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
  async focusFetch(bbox, { sinceTs = Date.now() - 90 * 864e5, proxy = '', signal } = {}) {
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
    // Which are genuinely new (dedup against the working set)?
    const have = new Set(this.flights.map(flightId).filter(Boolean));
    const fresh = recs.filter(r => { const id = flightId(r); return id && !have.has(id); });
    if (!fresh.length) return { added: 0 };

    // 1) Post new flights as durable room EVENTS immediately — packed as FULL as
    //    possible (across departments) so each event holds as many flights as fit
    //    under the Matrix size cap. Each flight carries its own organization_id,
    //    so a single batch can span departments. Events carry full precise
    //    geometry; an oversize single flight is hoisted to media by the outbox.
    //    Delivery is guaranteed even if the tab closes mid-send.
    for (const batch of await packedBatches(fresh)) {
      try {
        // Binary payload: gzip-NDJSON, base64'd — packs ~4-5× more flights per
        // event than raw JSON while staying under the Matrix size cap.
        await ins(this.roomId, ENTITY.FLIGHT_BATCH, { enc: 'gzip-ndjson-b64', n: batch.n, data: batch.b64 });
        this.looseEvents = (this.looseEvents || 0) + 1;
      } catch (e) { act.err(`Flight batch failed: ${e.message}`); }
    }

    // 2) Update the in-memory working set + local OPFS cache.
    const { merged, added } = mergeFlights(this.flights, fresh);
    this.flights = merged;
    this.dirty = (this.dirty || 0) + added;   // flights pending in the next block
    const newAgencies = this._discoverAgencies(fresh);
    await saveLocal(this.roomId, await packFlights(this.flights));
    this._notify();
    act.add(`Recorded ${added} flight(s) as room event(s)`, { added, events: this.looseEvents, unpublished: this.dirty, source: 'scraper' });
    if (newAgencies) act.add(`Discovered ${newAgencies} new department(s)`, { newAgencies });

    // 3) Roll up into a block when ~100 timeline events have accrued OR a large
    //    flight backlog has built up (so a big import doesn't sit uncompacted).
    if ((this.looseEvents || 0) >= ROLLUP_THRESHOLD || this.dirty >= 2000) await this.rollup();
    return { added, newAgencies };
  }

  /**
   * Compaction: fold the loose per-flight events into the dataset blob, publish
   * a fresh snapshot block, then redact the now-superseded loose events so the
   * room timeline stays lean. The block is the durable rollup; the events were
   * the durable interim. Safe to call anytime.
   */
  async rollup() {
    if (this._publishing || !this.roomId) return { rolled: 0 };
    const client = getClient();
    const looseIds = this._looseEventIds();   // event_ids of flight INS events
    await this.publish({});                   // snapshot now supersedes them
    let redacted = 0;
    if (client && looseIds.length) {
      act.block(`Rolling up ${looseIds.length} flight events into the block`, { count: looseIds.length });
      for (const id of looseIds) {
        try { await client.redactEvent(this.roomId, id); redacted++; }
        catch { /* best-effort; a missed redaction is harmless */ }
      }
    }
    this.looseEvents = 0;
    act.block(`Rolled up: ${redacted} event(s) redacted into snapshot v${this.meta?.version ?? '?'}`, { redacted });
    return { rolled: redacted };
  }

  /**
   * Redact ALL of this app's data events in the room and reset the dataset
   * pointer to empty — a clean slate. Clears the in-memory + OPFS working set
   * too. (Media blocks linger until the homeserver GCs; this clears the data
   * the app reads.) Returns { redacted }.
   */
  async redactAllData() {
    const client = getClient();
    if (!client || !this.roomId) return { redacted: 0 };
    const evs = getTimeline(this.roomId) || [];
    let redacted = 0;
    for (const e of evs) {
      const t = typeof e.getType === 'function' ? e.getType() : e.type;
      if (!t || !t.startsWith('org.dfr.explorer.')) continue;   // only our app's ops
      const u = typeof e.getUnsigned === 'function' ? e.getUnsigned() : e.unsigned;
      if (u && u.redacted_because) continue;
      const id = typeof e.getId === 'function' ? e.getId() : e.event_id;
      if (!id) continue;
      try { await client.redactEvent(this.roomId, id); redacted++; }
      catch { /* best-effort */ }
      if (redacted % 25 === 0) this._busy('Redacting data', `${redacted} events…`, null);
    }
    // Reset the dataset pointer to empty so no client tries to load old blocks.
    try {
      await writeDatasetState(this.roomId, {
        hydrated: false, mode: 'empty', version: (this.meta?.version || 0) + 1,
        count: 0, total: 0, blob: null, manifest: null, agencies_index: null,
        raw_archive: null, updated_at: Date.now(), updated_by: client.getUserId() || null,
      });
    } catch (e) { this.log(`Pointer reset failed: ${e.message}`, 'warn'); }
    // Clear local state.
    this.flights = []; this.agencies = []; this.deptManifest = null;
    this._loadedOrgs = new Set(); this.dirty = 0; this.looseEvents = 0;
    try { await saveLocal(this.roomId, await packFlights([]), { allowShrink: true }); } catch {}
    this._busy(null);
    act.block(`Redacted all data: ${redacted} events cleared`, { redacted });
    this.log(`Cleared room data: ${redacted} events redacted, pointer reset.`, 'ok');
    this._notify();
    return { redacted };
  }

  /** Collect event_ids of our app's flight INS events currently in the timeline. */
  _looseEventIds() {
    const evs = getTimeline(this.roomId) || [];
    const out = [];
    for (const e of evs) {
      const t = typeof e.getType === 'function' ? e.getType() : e.type;
      if (!t || !t.endsWith('.ins')) continue;
      const c = typeof e.getContent === 'function' ? e.getContent() : e.content;
      if (c && (c.entity_type === ENTITY.FLIGHT_BATCH || c.entity_type === ENTITY.FLIGHT)) {
        const id = typeof e.getId === 'function' ? e.getId() : e.event_id;
        const u = typeof e.getUnsigned === 'function' ? e.getUnsigned() : e.unsigned;
        if (id && !(u && u.redacted_because)) out.push(id);
      }
    }
    return out;
  }

  /** Redact the loose flight events now superseded by a published block. */
  async _redactLooseEvents() {
    const client = getClient();
    if (!client) return;
    const ids = this._looseEventIds();
    for (const id of ids) { try { await client.redactEvent(this.roomId, id); } catch {} }
    if (ids.length) act.block(`Rolled ${ids.length} flight event(s) into the block`, { redacted: ids.length });
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
    // Roll loose timeline events into a block once ~100 have accumulated (a
    // comfortable margin under Matrix per-request limits), or after the time
    // interval if anything is pending. Until then the flights live durably as
    // room events (read back via mergeLooseEvents) — the block is compaction.
    const due = (this.looseEvents || 0) >= ROLLUP_THRESHOLD ||
                (this.dirty || 0) >= 2000 ||
                (this.dirty > 0 && Date.now() - this.lastPublish >= PUBLISH_MIN_INTERVAL);
    return due ? this.publish({}) : { published: false };
  }

  /**
   * Live-refresh ONE department against its ArcGIS feed: count-check, and if the
   * feed has more than we hold, pull the delta (tail) and merge. Used when a
   * department detail is opened so its count reflects the true live total
   * (fixes "stored 45 but feed has 47"). `proxy` is the CORS proxy prefix.
   */
  async refreshDepartment(org, proxy = '') {
    if (!org) return { added: 0 };
    const fs = fsForOrg(org);
    let cnt = null;
    try { cnt = (await feedFetch(countUrl(fs), proxy, { preferProxy: true }))?.count ?? null; } catch { return { added: 0 }; }
    const have = this.flights.filter(f => f.organization_id === org).length;
    if (cnt == null || cnt <= have) return { added: 0, cnt, have };
    const delta = cnt - have;
    let feats;
    try {
      feats = delta <= 5000
        ? (await feedFetch(agencyTailUrl(fs, delta), proxy, { preferProxy: true }))?.features || []
        : (await feedFetch(agencyQueryUrl(fs), proxy, { preferProxy: true }))?.features || [];
    } catch { return { added: 0, cnt, have }; }
    const r = await this.addFlights(feats);   // dedups, posts events, persists
    if (r.added) act.add(`Department ${org.slice(0, 8)}: +${r.added} from live feed`, { added: r.added });
    return { added: r.added || 0, cnt, have };
  }

  /**
   * Deduped local flight count per department — unique flight identity (not raw
   * row count), so the upstream duplicate-flight_id inflation can't
   * skew the comparison. Returns a Map<org, count>.
   */
  localDeptCounts() {
    const byOrg = new Map();
    const seen = new Set();
    for (const f of this.flights) {
      const id = flightId(f);
      if (!id || seen.has(id)) continue;   // skip dupes so the count is true
      seen.add(id);
      const org = f.organization_id || 'unknown';
      byOrg.set(org, (byOrg.get(org) || 0) + 1);
    }
    return byOrg;
  }

  /**
   * Proactively check that what we hold per department matches the live ArcGIS
   * feed. For every known department we fetch the live count (the cheap
   * returnCountOnly query) and compare it against our deduped local count,
   * flagging drift in BOTH directions:
   *   behind  — feed has more than we hold (we're missing flights)
   *   ahead   — we hold more than the feed reports (upstream removals / stale
   *             feed / a duplicate that slipped in)
   *   match   — counts agree
   *   error   — the count query failed (network/proxy)
   *
   * This is read-only: it never fetches flights or mutates the dataset; it just
   * reports the truth so you can decide whether to Sync. Results are emitted to
   * the Activity feed (kind `check`) and returned as a structured report, also
   * stashed on `this.lastReconcile` for the UI.
   *
   * @param {object}   [opts]
   * @param {string}   [opts.proxy]        CORS proxy prefix
   * @param {function} [opts.onProgress]   ({done,total}) => void
   * @param {AbortSignal} [opts.signal]
   */
  async reconcile({ proxy = '', onProgress = null, signal = null } = {}) {
    const local = this.localDeptCounts();
    // Departments to check: everything we know about — agencies, sharded
    // manifest, and any org seen on a flight — so nothing is silently skipped.
    const orgs = new Set();
    for (const a of (this.agencies || [])) if (a.id) orgs.add(a.id);
    for (const d of this.deptIndex()) if (d.org) orgs.add(d.org);
    for (const org of local.keys()) if (org && org !== 'unknown') orgs.add(org);
    const list = [...orgs];

    const report = { ts: Date.now(), checked: 0, total: list.length,
                     match: 0, behind: 0, ahead: 0, error: 0, drift: [], errors: [] };
    if (!list.length) { this.lastReconcile = report; return report; }

    act.check(`Reconciling ${list.length} department(s) against the live feed…`, { total: list.length });

    let next = 0;
    const worker = async () => {
      while (true) {
        if (signal?.aborted) return;
        const idx = next++;
        if (idx >= list.length) return;
        const org = list[idx];
        const have = local.get(org) || 0;
        let live = null;
        try { live = (await feedFetch(countUrl(fsForOrg(org)), proxy, { preferProxy: true }))?.count ?? null; }
        catch (e) { live = null; }
        report.checked++;
        if (live == null) {
          report.error++; report.errors.push({ org, have });
        } else if (live === have) {
          report.match++;
        } else if (live > have) {
          report.behind++; report.drift.push({ org, have, live, gap: live - have, dir: 'behind' });
        } else {
          report.ahead++; report.drift.push({ org, have, live, gap: have - live, dir: 'ahead' });
        }
        if (onProgress) { try { onProgress({ done: report.checked, total: list.length }); } catch {} }
      }
    };
    const CONCURRENCY = 3;
    await Promise.all(Array.from({ length: CONCURRENCY }, worker));

    // Surface the verdict. Drift is the headline — sorted by biggest gap first.
    report.drift.sort((a, b) => b.gap - a.gap);
    if (report.behind || report.ahead) {
      act.check(`Drift on ${report.drift.length}/${report.checked} dept(s): ${report.behind} behind, ${report.ahead} ahead`,
                { behind: report.behind, ahead: report.ahead, errors: report.error });
      for (const d of report.drift.slice(0, 25)) {
        const verb = d.dir === 'behind' ? `feed has +${d.gap} we don't` : `we hold +${d.gap} the feed dropped`;
        act.err(`${d.org.slice(0, 8)}: ${verb} (local ${d.have} vs live ${d.live})`,
                { org: d.org.slice(0, 8), local: d.have, live: d.live, dir: d.dir });
      }
    } else {
      act.check(`In sync: all ${report.match} department(s) match the live feed${report.error ? ` (${report.error} unchecked)` : ''}.`,
                { match: report.match, errors: report.error });
    }
    this.lastReconcile = report;
    return report;
  }

  /** How many flights are in loose events but not yet rolled into a block. */
  unrolledCount() { return this.looseEvents || 0; }

  /**
   * Summarize the room's live timeline for the diagnostic Events view: the
   * actual Matrix events (newest first), so you can SEE whether flight/agency/
   * dataset events landed in the database. Decodes our app's op types.
   */
  roomEvents(limit = 500) {
    const evs = getTimeline(this.roomId) || [];
    const out = [];
    for (let i = evs.length - 1; i >= 0 && out.length < limit; i--) {
      const e = evs[i];
      const type = typeof e.getType === 'function' ? e.getType() : e.type;
      if (!type) continue;
      const ts = typeof e.getTs === 'function' ? e.getTs() : e.origin_server_ts;
      const sender = typeof e.getSender === 'function' ? e.getSender() : e.sender;
      const c = (typeof e.getContent === 'function' ? e.getContent() : e.content) || {};
      const u = (typeof e.getUnsigned === 'function' ? e.getUnsigned() : e.unsigned) || {};
      const id = typeof e.getId === 'function' ? e.getId() : e.event_id;
      let summary = '';
      if (type.endsWith('.ins') && c.entity_type === ENTITY.FLIGHT_BATCH) {
        const n = c.n ?? (c.payload?.flights?.length || 0);
        summary = `flight batch · ${n} flights${c.enc ? ' · binary' : ''}`;
      }
      else if (type.endsWith('.ins') && c.entity_type === ENTITY.FLIGHT) summary = `flight · ${c.payload?.flight_id?.slice(0, 8) || ''}`;
      else if (type.endsWith('.ins')) summary = `ins ${c.entity_type || ''}`;
      else if (type.endsWith('.def')) summary = `def ${c.path || ''}`;
      else if (type === 'm.room.encrypted') summary = '(encrypted — not yet decrypted)';
      else summary = type.replace(/^.*\./, '');
      out.push({ id, type: type.replace('org.dfr.explorer.', '·'), ts, sender, summary, redacted: !!u.redacted_because });
    }
    return out;
  }

  /** True while a publish is in flight (used by the leave-guard). */
  get publishing() { return !!this._publishing; }

  /**
   * Flush any unpublished local flights to the room *now* — used when the user
   * is leaving (tab hidden) so scraped data isn't stranded in OPFS on this
   * device. No-op when nothing is pending or a publish is already running.
   */
  async flushNow() {
    if (this.dirty <= 0 || this._publishing) return { published: false };
    return this.publish({});
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

  /**
   * Department-sharded publish: one (gzip-NDJSON) block per department, plus a
   * small manifest indexing each department by org → { ref, count, bbox, ts
   * range }. A fresh client downloads only the manifest up front and pulls a
   * department's block lazily when it's opened — never the whole dataset on load.
   * A department larger than the media limit is split into chained blocks.
   */
  async _publishSharded(version) {
    const limit = await this._mediaSizeLimit();
    const byOrg = new Map();
    for (const f of this.flights) {
      const o = f.organization_id || 'unknown';
      (byOrg.get(o) || byOrg.set(o, []).get(o)).push(f);
    }
    // ADDITIVE: seed from the prior manifest so departments NOT in the current
    // working set keep their existing shard. This prevents a partial working set
    // (e.g. only some departments loaded) from shrinking the published dataset.
    const departments = {};
    let carried = 0;
    if (this.deptManifest?.departments) {
      for (const [org, entry] of Object.entries(this.deptManifest.departments)) {
        if (!byOrg.has(org)) { departments[org] = entry; carried++; }
      }
    }
    if (carried) this.log(`Carrying ${carried} unloaded department shard(s) forward unchanged.`, 'mut');
    // Upload department shards in parallel (each is independent) — much faster
    // than one-at-a-time across hundreds of departments.
    const orgList = [...byOrg.keys()];
    const chunkSize = await this._chunkSize();
    const prevDepts = this.deptManifest?.departments || {};
    let done = 0, reused = 0, rewritten = 0;
    await parallelMap(orgList, UPLOAD_CONCURRENCY, async (org) => {
      const list = byOrg.get(org);
      const bytes = await packFlights(list);
      const hash = blobHash(bytes);
      // INCREMENTAL: if this department's content hash matches the prior shard,
      // reuse the existing block ref — don't re-upload. This stops a +1-flight
      // cycle from re-uploading all ~291 shards (~3 GB) every time.
      const prev = prevDepts[org];
      if (prev && prev.hash === hash && (prev.ref || prev.chunks)) {
        departments[org] = prev; reused++;
        if (++done % 50 === 0 || done === orgList.length) this.log(`Sharding ${done}/${orgList.length} (${reused} unchanged)…`, 'mut');
        return;
      }
      let entry;
      if (bytes.length <= limit) {
        const ref = await uploadEncrypted(bytes, { mime: 'application/gzip', name: `dfr-v${version}-${org.slice(0, 8)}.ndjson.gz` });
        entry = { ref };
      } else {
        const { blocks, metas, head } = chunkBlob(bytes, chunkSize);
        const refs = await parallelMap(blocks, UPLOAD_CONCURRENCY, async (blk, j) => {
          const r = await uploadEncrypted(blk, { mime: 'application/octet-stream', name: `dfr-v${version}-${org.slice(0, 8)}.blk${j}.bin` });
          return { i: j, size: metas[j].size, self: metas[j].self, prev: metas[j].prev, ref: r };
        });
        entry = { chunks: refs, head };
      }
      entry.count = list.length;
      entry.hash = hash;
      entry.bbox = bboxOf(list);
      entry.tmin = Math.min(...list.map(f => f.takeoff || Infinity));
      entry.tmax = Math.max(...list.map(f => f.takeoff || 0));
      departments[org] = entry;
      rewritten++;
      if (++done % 50 === 0 || done === orgList.length) this.log(`Sharding ${done}/${orgList.length} (${rewritten} changed)…`, 'mut');
    });
    this.log(`Sharded: ${rewritten} department(s) re-uploaded, ${reused} unchanged.`, 'ok');
    // Totals span ALL departments in the manifest (rewritten + carried).
    const allOrgs = Object.keys(departments);
    const total = allOrgs.reduce((n, o) => n + (departments[o].count || 0), 0);
    const manifest = {
      dfr_manifest: 2, sharded: true, payload_format: FORMAT, version,
      total, department_count: allOrgs.length,
      departments, created_at: Date.now(),
    };
    const ref = await uploadEncrypted(encoder.encode(JSON.stringify(manifest)),
      { mime: 'application/json', name: `dfr-v${version}.deptmanifest.json` });
    this._shardTotal = total;   // so _publish can record the true count in room state
    act.block(`Published ${allOrgs.length} department shards (v${version}, ${total.toLocaleString()} flights)`, { departments: allOrgs.length, flights: total });
    return ref;
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
    this._publishing = true;
    try { return await this._publish({ markHydrated, sourceUrl }); }
    finally { this._publishing = false; }
  }

  async _publish({ markHydrated = false, sourceUrl = null } = {}) {
    const bytes = await packFlights(this.flights);
    const limit = await this._mediaSizeLimit();
    const prev = readDatasetState(this.roomId);
    const version = (prev?.version || this.localVersion || 0) + 1;

    // Count distinct departments — sharding only helps when there are several.
    const orgs = new Set(this.flights.map(f => f.organization_id || 'unknown'));

    let blob = null, manifest = null, mode = 'empty', chunkCount = 0;
    if (this.flights.length === 0) {
      mode = 'empty';
    } else if (orgs.size > 1 && (bytes.length > limit || orgs.size >= 8)) {
      // Department-sharded: lazy per-department loading. The default for any
      // real multi-department dataset so a fresh client never downloads it all.
      this.log(`Publishing ${orgs.size} department shards (v${version})…`, 'mut');
      manifest = await this._publishSharded(version);
      mode = 'sharded';
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

    // Sharded shards carry FULL geometry regrouped by department, so they fully
    // APPEND-ONLY: never drop or redact prior blocks/archives. Old media simply
    // stops being referenced as new shards are added; nothing is destroyed.
    // Carry forward unrelated room-state keys (agencies_index, raw_archive, …)
    // so a publish only adds/updates what changed.
    const content = {
      ...(prev || {}),
      hydrated: markHydrated || !!prev?.hydrated,
      mode, format: FORMAT, payload_format: FORMAT, version,
      // For sharded mode the true total spans all manifest departments
      // (rewritten + carried-forward), not just the loaded working set.
      count: mode === 'sharded' ? (this._shardTotal ?? this.flights.length) : this.flights.length, hash: blobHash(bytes),
      total: mode === 'sharded' ? (this._shardTotal ?? this.flights.length) : (prev?.total ?? this.flights.length),
      blob, manifest, chunk_count: chunkCount,
      source_url: sourceUrl ?? prev?.source_url ?? null,
      raw_archive: prev?.raw_archive ?? (prev?.mode === 'chunked-raw' ? prev?.manifest : null),
      raw_payload_format: prev?.raw_payload_format ?? (prev?.mode === 'chunked-raw' ? prev?.payload_format : null),
      raw_bytes: prev?.raw_bytes ?? (prev?.mode === 'chunked-raw' ? prev?.total_bytes : null),
      updated_at: Date.now(), updated_by: getClient()?.getUserId() || null,
    };
    await writeDatasetState(this.roomId, content);
    this.meta = content; this._adoptVersion(version); this.dirty = 0; this.lastPublish = Date.now();
    // APPEND-ONLY: keep the loose per-flight events in the timeline (the durable
    // append-only log); the published block is just a compaction index over
    // them. mergeLooseEvents dedups so they're not double-counted. We only reset
    // the in-memory counter that gates how often we compact.
    this.looseEvents = 0;
    this.log(`Published v${version} (${content.count} flights, ${mode}).`, 'ok');
    this._notify();
    return { published: true, version, mode };
  }

  /**
   * After re-sharding, the original raw archive is dead weight. Matrix has no
   * client API to delete media, so to reclaim the space we:
   *   1. collect every orphaned mxc URI (manifest + all its blocks),
   *   2. best-effort redact any event-attached refs (lets a homeserver with
   *      redaction-driven media cleanup reclaim them),
   *   3. record the mxc list in room state + expose it for download, so a
   *      Synapse admin can purge them immediately (a one-line admin call).
   * The bytes themselves are freed by the homeserver, not the client.
   */
  async _dropRawArchive(prev) {
    const client = getClient();
    if (!client) return;
    const ref = prev.raw_archive || (prev.mode === 'chunked-raw' ? prev.manifest : null);
    if (!ref?.__media) return;
    const orphans = [];
    if (ref.mxc) orphans.push(ref.mxc);
    try {
      const man = await this._downloadManifest(ref);
      for (const c of (man.chunks || [])) if (c.ref?.mxc) orphans.push(c.ref.mxc);
      // Best-effort: redact any event-attached refs (most are pure media uploads
      // with no event, so this is usually a no-op — the purge list is the lever).
      let redacted = 0;
      for (const c of (man.chunks || [])) {
        const eid = c.ref?.event_id;
        if (eid) { try { await client.redactEvent(this.roomId, eid); redacted++; } catch {} }
      }
      // Stash the orphan list so an admin can reclaim the space.
      try {
        await writeDatasetState(this.roomId, { ...readDatasetState(this.roomId), purgeable_media: orphans });
      } catch {}
      this._purgeableMedia = orphans;
      act.block(`Re-shard freed ${man.chunk_count} raw blocks (~${((man.total_bytes||0)/1073741824).toFixed(2)} GB) — ${orphans.length} mxc URIs queued for purge`,
        { blocks: man.chunk_count, orphans: orphans.length, redacted });
      this.log(`Original archive superseded: ${orphans.length} media URIs can be purged. Use "Download purge list".`, 'ok');
    } catch { /* manifest already gone */ }
  }

  /** The orphaned mxc URIs from the last re-shard (for the purge list download). */
  purgeableMedia() {
    return this._purgeableMedia || readDatasetState(this.roomId)?.purgeable_media || [];
  }

  /**
   * Re-shard the current dataset into per-department blocks for lazy loading.
   * One-time migration from a whole-dataset (chunked-raw / single / chunked)
   * layout. Requires the working set to be loaded first.
   */
  async reshardByDepartment() {
    if (!this.flights.length) throw new Error('Load the dataset first (Build index), then re-shard.');
    this.log(`Re-sharding ${this.flights.length} flights by department…`, 'mut');
    const r = await this.publish({});   // multi-dept → sharded path, drops raw
    return r;
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

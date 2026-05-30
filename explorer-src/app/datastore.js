/**
 * datastore.js — the in-memory dataset and how it moves between OPFS, Matrix
 * media, and the room-state pointer.
 *
 * Model (replaces per-flight timeline events):
 *   • working set  : `flights[]` in memory, queried by the UI.
 *   • fast local   : one gzip-NDJSON blob per room in OPFS (vault-encrypted),
 *                    written on every local change, read once on open.
 *   • durable/shared: the same blob in the Matrix media store *if small enough*.
 *   • pointer      : a single room-state event (version, count, blob ref /
 *                    source_url, hydration status).
 *
 * Why: the timeline never carries per-flight noise (no Matrix spam), local
 * reads are a single decompress (fast), and peers sync only when the pointer's
 * version actually advances (intelligent download, OPFS-cached).
 */

import { getClient } from '../src/client.js';
import { uploadEncrypted, getMediaBytes } from '../src/media.js';
import { packFlights, unpackFlights, mergeFlights, blobHash } from './packset.js';
import { saveLocal, loadLocal } from './opfsbin.js';
import { readDatasetState, writeDatasetState } from './roomstate.js';
import { toRecord } from './dfr.js';
import { textStreamFrom, readChunks, streamElements, streamNdjson } from './jsonstream.js';

const FORMAT = 'gzip-ndjson';
const DEFAULT_MEDIA_LIMIT = 50 * 1024 * 1024; // fallback if server config is unknown

// Throttle for scraper-driven snapshots, so frequent local appends don't turn
// into frequent Matrix writes.
const PUBLISH_THRESHOLD = 25;            // publish once this many new flights pile up
const PUBLISH_MIN_INTERVAL = 30 * 60e3;  // …or this long since the last publish

const lvKey = (roomId) => `dfr.localver.${roomId}`;

export class DataStore {
  constructor({ log } = {}) {
    this.log = log || (() => {});
    this.roomId = null;
    this.flights = [];
    this.meta = null;          // last room-state pointer we saw
    this.localVersion = 0;
    this.dirty = 0;            // unpublished local additions
    this.lastPublish = 0;
    this._mediaLimit = DEFAULT_MEDIA_LIMIT;
    this.onChange = null;
  }

  _notify() { if (this.onChange) this.onChange(); }

  async _mediaSizeLimit() {
    try {
      const client = getClient();
      const cfg = client?.getMediaConfig ? await client.getMediaConfig() : null;
      const v = cfg?.['m.upload.size'];
      if (typeof v === 'number' && v > 0) this._mediaLimit = v;
    } catch { /* keep default */ }
    return this._mediaLimit;
  }

  /** Open a room: load the fast local copy, then sync if the pointer is newer. */
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
    if (this.meta && this.meta.version > this.localVersion) {
      await this.sync();
    }
    return { hydrated: !!this.meta?.hydrated, count: this.flights.length };
  }

  isHydrated() { return !!readDatasetState(this.roomId)?.hydrated; }

  /**
   * Intelligent download: only pull the blob when the room pointer's version is
   * ahead of ours. getMediaBytes reads the OPFS mirror first, so an up-to-date
   * client never touches the network.
   */
  async sync() {
    const state = readDatasetState(this.roomId);
    this.meta = state;
    if (!state) return { synced: false, reason: 'no-pointer' };
    if (state.version <= this.localVersion && this.flights.length) {
      return { synced: false, reason: 'up-to-date' };
    }
    let bytes = null;
    if (state.blob && state.blob.__media) {
      this.log('Downloading dataset snapshot…', 'mut');
      bytes = await getMediaBytes(state.blob);
    } else if (state.source_url) {
      this.log('Fetching dataset from external host…', 'mut');
      const resp = await fetch(state.source_url);
      if (resp.ok) bytes = new Uint8Array(await resp.arrayBuffer());
    }
    if (!bytes) return { synced: false, reason: 'no-bytes' };

    const incoming = await unpackFlights(bytes);
    const { merged, added } = mergeFlights(this.flights, incoming);
    this.flights = merged;
    this.localVersion = state.version;
    localStorage.setItem(lvKey(this.roomId), String(state.version));
    await saveLocal(this.roomId, await packFlights(this.flights));
    this.log(`Synced snapshot v${state.version}: ${incoming.length} records (${added} new).`, 'ok');
    this._notify();
    return { synced: true, added };
  }

  // ── ingestion ──────────────────────────────────────────────────────────────

  /**
   * One-time hydration from an external source. `source` is a fetch Response
   * (URL) or a File. `format` is 'auto' | 'jsonl' | 'binary'.
   * On success the dataset is persisted locally and published, and the room is
   * marked hydrated so no client asks again.
   */
  async hydrateFrom(source, { format = 'auto', sourceUrl = null, max = Infinity, signal, onProgress } = {}) {
    const records = [];
    const isBinaryName = (n) => /\.(bin|gz)$/i.test(n || '');
    let bin = format === 'binary';
    if (format === 'auto') {
      const name = source.name || source.url || '';
      bin = isBinaryName(name);
    }

    if (bin) {
      // Whole-file binary (our gzip-NDJSON, or a .gz of NDJSON).
      const buf = source.arrayBuffer ? await source.arrayBuffer() : await new Response(source.body).arrayBuffer();
      const flights = await unpackFlights(new Uint8Array(buf));
      for (const f of flights) { records.push(toRecord(f)); if (records.length >= max) break; }
    } else {
      // Streamed JSONL / JSON / GeoJSON — never fully buffered.
      const byteStream = source.body || source.stream();
      const text = await textStreamFrom(byteStream);
      const chunks = readChunks(text, signal);
      // Probe: NDJSON if the source looks line-delimited; else array/FeatureCollection.
      const ndjson = format === 'jsonl' || /\.(ndjson|jsonl)$/i.test(source.name || source.url || '');
      const elements = ndjson ? streamNdjson(chunks) : streamElements(chunks);
      let seen = 0;
      for await (const el of elements) {
        if (signal?.aborted) break;
        records.push(toRecord(el));
        seen++;
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

  /** Append scraped flights to the local working set (no Matrix write yet). */
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

  /** Publish a snapshot to media + room state only when it's worth it. */
  async maybePublish() {
    const due = this.dirty >= PUBLISH_THRESHOLD ||
                (this.dirty > 0 && Date.now() - this.lastPublish >= PUBLISH_MIN_INTERVAL);
    if (!due) return { published: false };
    return this.publish({});
  }

  /**
   * Pack the working set, upload to media when within the server limit, and
   * overwrite the single room-state pointer. Bumps the version so peers sync.
   */
  async publish({ markHydrated = false, sourceUrl = null } = {}) {
    if (!this.roomId) return { published: false };
    const bytes = await packFlights(this.flights);
    const limit = await this._mediaSizeLimit();
    const prev = readDatasetState(this.roomId);
    const version = (prev?.version || this.localVersion || 0) + 1;

    let blob = null;
    let url = sourceUrl ?? prev?.source_url ?? null;
    if (bytes.length <= limit) {
      this.log(`Uploading snapshot (${(bytes.length / 1048576).toFixed(2)} MB) to media…`, 'mut');
      blob = await uploadEncrypted(bytes, { mime: 'application/gzip', name: `dfr-dataset-v${version}.ndjson.gz` });
    } else {
      this.log(`Snapshot ${(bytes.length / 1048576).toFixed(1)} MB exceeds media limit — kept in OPFS only.`, 'warn');
    }

    const content = {
      hydrated: markHydrated || !!prev?.hydrated,
      format: FORMAT,
      version,
      count: this.flights.length,
      hash: blobHash(bytes),
      blob,
      source_url: url,
      updated_at: Date.now(),
      updated_by: getClient()?.getUserId() || null,
    };
    await writeDatasetState(this.roomId, content);

    this.meta = content;
    this.localVersion = version;
    localStorage.setItem(lvKey(this.roomId), String(version));
    this.dirty = 0;
    this.lastPublish = Date.now();
    this.log(`Published snapshot v${version} (${content.count} flights${blob ? ', in media' : ', OPFS only'}).`, 'ok');
    this._notify();
    return { published: true, version };
  }

  /** Known flight identities — the scraper's dedup set. */
  knownIds() {
    const s = new Set();
    for (const f of this.flights) {
      if (f.flight_id) s.add(f.flight_id);
      if (f.object_id != null) s.add('oid_' + f.object_id);
    }
    return s;
  }
}

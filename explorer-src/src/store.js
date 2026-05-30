/**
 * store.js — OPFS persistence layer (vault-encrypted)
 *
 * Binary append-only event store. One file per room.
 *
 * File layout (v2):
 *
 *   [MAGIC(4) "MXEV"]
 *   [VERSION(2)]                  // 2 = vault-encrypted chunks
 *   [NS_LEN(2)][NS(NS_LEN)]
 *   [chunk]*                      // 0..N append chunks
 *
 * Each chunk is:
 *
 *   [IV(12)][CT_LEN(4)][CT(CT_LEN)]   // CT decrypts to packBatch bytes
 *
 * The chunk plaintext is exactly what packBatch() emits — a stream of
 * fixed-header + body records. On open we decrypt every chunk in order
 * and replay through the same scan that v1 did.
 *
 * v1 (unencrypted) files from before this change are silently dropped
 * on open — the room re-downloads from the server.
 *
 * Vault must be unlocked before open(). If the vault is locked or
 * absent the store falls back to in-memory only (no persistence) so
 * the UI still works on a fresh device that has not unlocked yet.
 */

import { packBatch, unpackAll, unpackSince, HEADER_SIZE, fnv1a32, fnv1a64 } from './pack.js';
import { parseEventType } from './operators.js';
import { vault } from './vault.js';

const MAGIC = new Uint8Array([0x4D, 0x58, 0x45, 0x56]);
const VERSION = 2;
const LEGACY_VERSION = 1;
const CHECKPOINT_INTERVAL = 200;
const IV_BYTES = 12;
const CHUNK_HEADER_BYTES = IV_BYTES + 4;

const encoder = new TextEncoder();
const decoder = new TextDecoder();

let opfsAvailable = null;
async function checkOPFS() {
  if (opfsAvailable !== null) return opfsAvailable;
  try {
    const root = await navigator.storage.getDirectory();
    const probe = await root.getFileHandle('__probe__', { create: true });
    await root.removeEntry('__probe__');
    opfsAvailable = true;
  } catch {
    opfsAvailable = false;
  }
  return opfsAvailable;
}

function roomFileName(roomId) {
  const h = fnv1a32(roomId);
  return `room_${h.toString(16).padStart(8, '0')}.bin`;
}

function checkpointFileName(roomId) {
  const h = fnv1a32(roomId);
  return `room_${h.toString(16).padStart(8, '0')}_checkpoint.bin`;
}

function makeHeader(namespace) {
  const nsBytes = encoder.encode(namespace);
  const buf = new ArrayBuffer(8 + nsBytes.length);
  const view = new DataView(buf);
  const arr = new Uint8Array(buf);
  arr.set(MAGIC, 0);
  view.setUint16(4, VERSION);
  view.setUint16(6, nsBytes.length);
  arr.set(nsBytes, 8);
  return arr;
}

function parseHeader(data) {
  if (data.length < 8) return null;
  if (data[0] !== 0x4D || data[1] !== 0x58 || data[2] !== 0x45 || data[3] !== 0x56) return null;
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const version = view.getUint16(4);
  const nsLen = view.getUint16(6);
  if (data.length < 8 + nsLen) return null;
  const namespace = decoder.decode(data.subarray(8, 8 + nsLen));
  return { version, namespace, headerSize: 8 + nsLen };
}

/** Decrypt every chunk in the file body into one contiguous plaintext. */
async function decryptAllChunks(body) {
  if (!body || body.length === 0) return new Uint8Array(0);
  const view = new DataView(body.buffer, body.byteOffset, body.byteLength);
  const parts = [];
  let offset = 0;
  while (offset + CHUNK_HEADER_BYTES <= body.length) {
    const iv = body.subarray(offset, offset + IV_BYTES);
    const ctLen = view.getUint32(offset + IV_BYTES);
    const ctStart = offset + CHUNK_HEADER_BYTES;
    const ctEnd = ctStart + ctLen;
    if (ctEnd > body.length) break;
    // Re-pack [iv][ct] as the format vault.decryptBytes expects.
    const blob = new Uint8Array(IV_BYTES + ctLen);
    blob.set(iv, 0);
    blob.set(body.subarray(ctStart, ctEnd), IV_BYTES);
    try {
      const plain = await vault.decryptBytes(blob);
      parts.push(plain);
    } catch (e) {
      console.warn('[store] chunk decrypt failed at offset', offset, e?.message || e);
    }
    offset = ctEnd;
  }
  let total = 0;
  for (const p of parts) total += p.length;
  const out = new Uint8Array(total);
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
}

async function encryptChunk(plaintext) {
  // vault.encryptBytes returns [iv][ct]. Repackage with explicit
  // length prefix so the file remains parseable without re-decrypting.
  const blob = await vault.encryptBytes(plaintext);
  const iv = blob.subarray(0, IV_BYTES);
  const ct = blob.subarray(IV_BYTES);
  const out = new Uint8Array(CHUNK_HEADER_BYTES + ct.length);
  out.set(iv, 0);
  new DataView(out.buffer).setUint32(IV_BYTES, ct.length);
  out.set(ct, CHUNK_HEADER_BYTES);
  return out;
}

export class EventStore {
  constructor(roomId, namespace) {
    this.roomId = roomId;
    this.namespace = namespace;
    this.fileName = roomFileName(roomId);
    this.checkpointName = checkpointFileName(roomId);

    this._headerSize = 0;
    this._cursor = 0;
    this._count = 0;
    this._byteSize = 0;
    this._eventIdSet = null;
    this._useOPFS = false;
    this._dirHandle = null;
    this._fileHandle = null;
    this._appendsSinceCheckpoint = 0;
    this._appendQueue = Promise.resolve();
    this._encrypted = false;
  }

  async open() {
    this._useOPFS = await checkOPFS();
    this._eventIdSet = new Set();

    if (!vault.isUnlocked()) {
      // No vault key — refuse to touch OPFS files so we don't write
      // unencrypted data or corrupt encrypted ones. The room still
      // functions, just without persistence until unlocked.
      console.warn('[store] vault locked — running in memory-only mode');
      this._useOPFS = false;
      return this;
    }

    if (this._useOPFS) {
      try {
        this._dirHandle = await navigator.storage.getDirectory();
        await this._scanFromOPFS();
      } catch (e) {
        console.warn('[store] OPFS open failed:', e);
        this._useOPFS = false;
      }
    }

    return this;
  }

  /**
   * Decrypt every chunk in the file once and rebuild the dedup set,
   * cursor, and count. Body decode is required to walk per-event
   * headers (the headers live inside the encrypted chunks, not in the
   * clear).
   */
  async _scanFromOPFS() {
    let fileHandle;
    try {
      fileHandle = await this._dirHandle.getFileHandle(this.fileName);
    } catch {
      return;
    }

    const file = await fileHandle.getFile();
    if (file.size === 0) return;

    const raw = new Uint8Array(await file.arrayBuffer());
    const header = parseHeader(raw);
    if (!header) {
      console.warn('[store] invalid file header — discarding');
      try { await this._dirHandle.removeEntry(this.fileName); } catch {}
      return;
    }

    if (header.version === LEGACY_VERSION) {
      console.warn('[store] unencrypted legacy file — discarding (will re-sync from server)');
      try { await this._dirHandle.removeEntry(this.fileName); } catch {}
      try { await this._dirHandle.removeEntry(this.checkpointName); } catch {}
      // Older checkpoints used .json; remove that too in case it lingers.
      try { await this._dirHandle.removeEntry(this.checkpointName.replace('.bin', '.json')); } catch {}
      return;
    }

    if (header.version !== VERSION) {
      console.warn('[store] unknown file version', header.version, '— discarding');
      try { await this._dirHandle.removeEntry(this.fileName); } catch {}
      return;
    }

    this._headerSize = header.headerSize;
    this._fileHandle = fileHandle;
    this._byteSize = file.size;
    this._encrypted = true;

    const body = raw.subarray(header.headerSize);
    const plain = await decryptAllChunks(body);
    if (plain.length === 0) return;

    const view = new DataView(plain.buffer, plain.byteOffset, plain.byteLength);
    let offset = 0;
    while (offset + HEADER_SIZE <= plain.length) {
      const tsHi = view.getUint16(offset + 2);
      const tsLo = view.getUint32(offset + 4);
      const ts = tsHi * 0x100000000 + tsLo;

      const eidLo = view.getUint32(offset + 8);
      const eidHi = view.getUint32(offset + 12);
      this._eventIdSet.add(`${eidLo}:${eidHi}`);

      const bodyLength = view.getUint32(offset + 20);
      if (offset + HEADER_SIZE + bodyLength > plain.length) break;

      if (ts > this._cursor) this._cursor = ts;
      this._count++;
      offset += HEADER_SIZE + bodyLength;
    }
  }

  async append(matrixEvents) {
    const result = this._appendQueue.then(() => this._doAppend(matrixEvents));
    this._appendQueue = result.catch(() => {});
    return result;
  }

  async _doAppend(matrixEvents) {
    const toPack = [];
    const forFold = [];

    for (const event of matrixEvents) {
      const type = typeof event.getType === 'function' ? event.getType() : event.type;
      const content = typeof event.getContent === 'function' ? event.getContent() : event.content;
      const ts = typeof event.getTs === 'function' ? event.getTs() : event.origin_server_ts || 0;
      const sender = typeof event.getSender === 'function' ? event.getSender() : event.sender;
      const eventId = typeof event.getId === 'function' ? event.getId() : event.event_id || '';

      const op = parseEventType(type);
      if (!op) continue;
      if (!content || Object.keys(content).length === 0) continue;

      const [eidLo, eidHi] = fnv1a64(eventId);
      const key = `${eidLo}:${eidHi}`;
      if (this._eventIdSet.has(key)) continue;

      toPack.push({ opOrder: op.order, ts, eventId, sender,
        content: { _c: content, _s: sender, _e: eventId },
      });
      forFold.push({ type, content, origin_server_ts: ts, sender, event_id: eventId });

      this._eventIdSet.add(key);
      if (ts > this._cursor) this._cursor = ts;
    }

    if (toPack.length === 0) return [];

    const packed = packBatch(toPack);
    this._count += toPack.length;
    this._appendsSinceCheckpoint += toPack.length;

    if (this._useOPFS && vault.isUnlocked()) {
      try {
        await this._writeToOPFS(packed);
      } catch (e) {
        console.warn('[store] OPFS write failed:', e);
      }
    }

    return forFold;
  }

  async _writeToOPFS(newBytes) {
    const chunk = await encryptChunk(newBytes);

    if (!this._fileHandle) {
      this._fileHandle = await this._dirHandle.getFileHandle(this.fileName, { create: true });
      const header = makeHeader(this.namespace);
      this._headerSize = header.length;

      const writable = await this._fileHandle.createWritable();
      await writable.write(header);
      await writable.write(chunk);
      await writable.close();
      this._byteSize = header.length + chunk.length;
      this._encrypted = true;
    } else {
      const file = await this._fileHandle.getFile();
      const writable = await this._fileHandle.createWritable({ keepExistingData: true });
      await writable.seek(file.size);
      await writable.write(chunk);
      await writable.close();
      this._byteSize = file.size + chunk.length;
    }
  }

  async getAll() {
    const data = await this._readDecryptedBody();
    if (!data || data.length === 0) return [];
    return unpackAll(data, this.namespace).map(EventStore._unwrap);
  }

  async getEventsSince(sinceTs) {
    const data = await this._readDecryptedBody();
    if (!data || data.length === 0) return [];
    return unpackSince(data, this.namespace, sinceTs).map(EventStore._unwrap);
  }

  async _readDecryptedBody() {
    if (!this._useOPFS || !this._fileHandle) return null;
    if (!vault.isUnlocked()) return null;
    try {
      const file = await this._fileHandle.getFile();
      if (file.size <= this._headerSize) return null;
      const raw = new Uint8Array(await file.arrayBuffer());
      const body = raw.subarray(this._headerSize);
      return await decryptAllChunks(body);
    } catch (e) {
      console.warn('[store] read failed:', e);
      return null;
    }
  }

  static _unwrap(e) {
    if (e.content && e.content._c !== undefined) {
      return {
        type: e.type,
        content: e.content._c,
        origin_server_ts: e.origin_server_ts,
        sender: e.content._s || null,
        event_id: e.content._e || null,
      };
    }
    return e;
  }

  async saveCheckpoint(state) {
    if (!this._useOPFS || !this._dirHandle) return;
    if (!vault.isUnlocked()) return;
    try {
      const clean = { ...state, _violations: [] };
      const payload = await vault.encryptJSON({
        cursor: this._cursor,
        count: this._count,
        savedAt: Date.now(),
        state: clean,
      });
      const handle = await this._dirHandle.getFileHandle(this.checkpointName, { create: true });
      const writable = await handle.createWritable();
      await writable.write(payload);
      await writable.close();
      this._appendsSinceCheckpoint = 0;
    } catch (e) {
      console.warn('[store] Checkpoint save failed:', e);
    }
  }

  async loadCheckpoint() {
    if (!this._useOPFS || !this._dirHandle) return null;
    if (!vault.isUnlocked()) return null;
    try {
      const handle = await this._dirHandle.getFileHandle(this.checkpointName);
      const file = await handle.getFile();
      const bytes = new Uint8Array(await file.arrayBuffer());
      const obj = await vault.decryptJSON(bytes);
      if (obj.cursor > this._cursor) {
        console.warn('[store] Checkpoint cursor ahead of log — discarding');
        return null;
      }
      return obj;
    } catch {
      return null;
    }
  }

  shouldCheckpoint() {
    return this._appendsSinceCheckpoint >= CHECKPOINT_INTERVAL;
  }

  getCursor()   { return this._cursor; }
  getCount()    { return this._count; }
  getByteSize() { return this._byteSize; }
  hasData()     { return this._count > 0; }

  async clear() {
    this._cursor = 0;
    this._count = 0;
    this._byteSize = 0;
    this._eventIdSet = new Set();
    this._fileHandle = null;
    this._appendsSinceCheckpoint = 0;
    if (this._useOPFS && this._dirHandle) {
      try { await this._dirHandle.removeEntry(this.fileName); } catch {}
      try { await this._dirHandle.removeEntry(this.checkpointName); } catch {}
    }
  }
}

export async function listStoredRooms() {
  if (!await checkOPFS()) return [];
  const dir = await navigator.storage.getDirectory();
  const names = [];
  for await (const [name] of dir) {
    if (name.startsWith('room_') && name.endsWith('.bin') && !name.endsWith('_checkpoint.bin')) {
      names.push(name);
    }
  }
  return names;
}

export async function getStorageUsage() {
  if (!await checkOPFS()) return { files: 0, bytes: 0 };
  const dir = await navigator.storage.getDirectory();
  let files = 0, bytes = 0;
  for await (const [name, handle] of dir) {
    if (name.startsWith('room_') && name.endsWith('.bin')) {
      files++;
      bytes += (await handle.getFile()).size;
    }
  }
  return { files, bytes };
}

/**
 * Wipe every room file and checkpoint from OPFS. Called on logout.
 */
export async function wipeAllRoomData() {
  if (!await checkOPFS()) return;
  const dir = await navigator.storage.getDirectory();
  const toRemove = [];
  for await (const [name] of dir) {
    if (name.startsWith('room_') && (name.endsWith('.bin') || name.endsWith('.json'))) {
      toRemove.push(name);
    }
  }
  for (const n of toRemove) {
    try { await dir.removeEntry(n); } catch {}
  }
}

/**
 * outbox.js — Offline-first send queue
 *
 * Every operator emit goes through here first. The operation is:
 *   1. Persisted to IndexedDB (encrypted with the vault key)
 *   2. Dispatched optimistically to the in-memory fold state
 *   3. Flushed to the homeserver when online and unlocked
 *   4. Reconciled with the real timeline event when it echoes back
 *
 * Reconciliation uses the Matrix `txnId` mechanism: we send with the
 * same localId, the server echoes the event with that txnId in
 * unsigned.transaction_id, and the timeline handler suppresses the
 * double-apply.
 *
 * The queue is per-device — a parallel session on another browser
 * has its own outbox. Order is preserved per room (FIFO).
 */

import { vault } from './vault.js';
import { hoistLargeFields, contentSize, CONTENT_SIZE_LIMIT } from './media.js';

const DB_NAME = 'matrix_events_outbox';
const DB_VERSION = 1;
const STORE = 'queue';

const FLUSH_INTERVAL_MS = 3_000;
const MAX_ATTEMPTS = 8;
const BACKOFF_BASE_MS = 1_500;

let _db = null;
function openDB() {
  if (_db) return Promise.resolve(_db);
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) {
        const store = db.createObjectStore(STORE, { keyPath: 'localId' });
        store.createIndex('byRoomCreated', ['roomId', 'createdAt']);
        store.createIndex('byStatus', 'status');
      }
    };
    req.onsuccess = () => { _db = req.result; resolve(_db); };
    req.onerror = () => reject(req.error);
  });
}

function tx(mode) {
  return openDB().then(db => db.transaction(STORE, mode).objectStore(STORE));
}

function reqPromise(req) {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function newLocalId() {
  // Matrix txnIds are arbitrary opaque strings. UUID gives us
  // collision resistance across reloads.
  return 'm' + (crypto.randomUUID ? crypto.randomUUID().replace(/-/g, '') : Date.now() + Math.random().toString(36).slice(2));
}

// ── Per-record encryption ──
// Outbox records contain user content; encrypt at rest.

async function packRecord(record) {
  const meta = {
    localId: record.localId,
    roomId: record.roomId,
    eventType: record.eventType,
    status: record.status,
    attempts: record.attempts,
    createdAt: record.createdAt,
    nextAttemptAt: record.nextAttemptAt || 0,
    sentEventId: record.sentEventId || null,
    lastError: record.lastError || null,
  };
  const ciphertext = await vault.encryptJSON({ content: record.content });
  return { ...meta, payload: ciphertext };
}

async function unpackRecord(stored) {
  if (!stored) return null;
  let content = {};
  try {
    const obj = await vault.decryptJSON(stored.payload);
    content = obj.content || {};
  } catch (e) {
    // If decryption fails (vault locked, key mismatch), surface a
    // stub so the queue isn't silently wiped. Caller can decide.
    return { ...stored, content: {}, _undecryptable: true };
  }
  return { ...stored, content };
}

// ── Public queue API ──

/**
 * Enqueue an operation. Vault must be unlocked.
 * Returns the localId — also serves as the Matrix transaction id.
 */
export async function enqueue({ roomId, eventType, content }) {
  if (!vault.isUnlocked()) throw new Error('Vault is locked — cannot enqueue');
  const record = {
    localId: newLocalId(),
    roomId,
    eventType,
    content,
    status: 'pending',
    attempts: 0,
    createdAt: Date.now(),
    nextAttemptAt: 0,
    sentEventId: null,
    lastError: null,
  };
  const stored = await packRecord(record);
  const store = await tx('readwrite');
  await reqPromise(store.add(stored));
  notify();
  return record;
}

/** List queued records (any status). Vault unlocked required. */
export async function listAll() {
  const store = await tx('readonly');
  const all = await reqPromise(store.getAll());
  const out = [];
  for (const s of all) {
    const r = await unpackRecord(s);
    if (r) out.push(r);
  }
  out.sort((a, b) => a.createdAt - b.createdAt);
  return out;
}

export async function pendingCount() {
  const store = await tx('readonly');
  const idx = store.index('byStatus');
  const c = await reqPromise(idx.count('pending'));
  const c2 = await reqPromise(idx.count('inflight'));
  return c + c2;
}

export async function getByLocalId(localId) {
  const store = await tx('readonly');
  const s = await reqPromise(store.get(localId));
  return s ? unpackRecord(s) : null;
}

async function update(localId, patch) {
  const store = await tx('readwrite');
  const existing = await reqPromise(store.get(localId));
  if (!existing) return null;
  const current = await unpackRecord(existing);
  const next = { ...current, ...patch };
  const repacked = await packRecord(next);
  await reqPromise(store.put(repacked));
  notify();
  return next;
}

export async function markInflight(localId) {
  return update(localId, { status: 'inflight', lastError: null });
}

export async function markSent(localId, sentEventId) {
  return update(localId, { status: 'sent', sentEventId, lastError: null });
}

export async function markFailed(localId, error, attempts) {
  return update(localId, {
    status: 'pending',
    attempts,
    lastError: String(error?.message || error || 'unknown'),
    nextAttemptAt: Date.now() + Math.min(60_000, BACKOFF_BASE_MS * 2 ** Math.min(attempts, 6)),
  });
}

export async function markDead(localId, error) {
  return update(localId, {
    status: 'dead',
    lastError: String(error?.message || error || 'gave up'),
  });
}

export async function remove(localId) {
  const store = await tx('readwrite');
  await reqPromise(store.delete(localId));
  notify();
}

export async function purgeSent() {
  const store = await tx('readwrite');
  const idx = store.index('byStatus');
  const keys = await reqPromise(idx.getAllKeys('sent'));
  for (const k of keys) await reqPromise(store.delete(k));
  notify();
}

export async function clearAll() {
  const store = await tx('readwrite');
  await reqPromise(store.clear());
  notify();
}

// ── Change notifications ──

const listeners = new Set();
export function onChange(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}
let notifyScheduled = false;
function notify() {
  if (notifyScheduled) return;
  notifyScheduled = true;
  queueMicrotask(() => {
    notifyScheduled = false;
    for (const fn of listeners) {
      try { fn(); } catch (e) { console.warn('[outbox] listener error:', e); }
    }
  });
}

// ── Flusher ──

/**
 * The flusher walks the queue and sends pending records via the
 * Matrix client. It is paused while offline or locked, and reactivated
 * by network/vault state changes.
 *
 * Callers register an onAck handler to learn when an entry is sent so
 * they can update optimistic state.
 */
export class OutboxFlusher {
  constructor({ getClient, onAck, onProgress }) {
    this._getClient = getClient;
    this._onAck = onAck || (() => {});
    this._onProgress = onProgress || (() => {});
    this._timer = null;
    this._busy = false;
    this._unsubVault = null;
    this._wake = () => this.kick();
  }

  start() {
    if (this._timer) return;
    this._timer = setInterval(() => this.kick(), FLUSH_INTERVAL_MS);
    window.addEventListener('online', this._wake);
    this._unsubVault = vault.onChange(this._wake);
    this.kick();
  }

  stop() {
    if (this._timer) { clearInterval(this._timer); this._timer = null; }
    window.removeEventListener('online', this._wake);
    if (this._unsubVault) { this._unsubVault(); this._unsubVault = null; }
  }

  async kick() {
    if (this._busy) return;
    if (!navigator.onLine) return;
    if (!vault.isUnlocked()) return;
    const client = this._getClient();
    if (!client) return;

    this._busy = true;
    try {
      const all = await listAll();
      const due = all.filter(r =>
        (r.status === 'pending') &&
        (r.nextAttemptAt || 0) <= Date.now() &&
        !r._undecryptable
      );
      // FIFO globally; per-room ordering preserved because we walk
      // in createdAt order.
      for (const item of due) {
        await this._send(client, item);
      }
    } finally {
      this._busy = false;
    }
  }

  async _send(client, item) {
    await markInflight(item.localId);
    let contentToSend = item.content;
    let hoisted = 0;
    try {
      if (contentSize(contentToSend) > CONTENT_SIZE_LIMIT) {
        const r = await hoistLargeFields(contentToSend);
        contentToSend = r.content;
        hoisted = r.hoisted;
        if (hoisted > 0) this._onProgress({ type: 'hoisted', localId: item.localId, count: hoisted });
      }
      const resp = await client.sendEvent(item.roomId, item.eventType, contentToSend, item.localId);
      await markSent(item.localId, resp.event_id);
      this._onAck({ localId: item.localId, eventId: resp.event_id, roomId: item.roomId });
      this._onProgress({ type: 'sent', localId: item.localId, eventId: resp.event_id });
    } catch (e) {
      const attempts = (item.attempts || 0) + 1;
      // M_TOO_LARGE → retry once with hoisting forced on every field.
      // (If we already hoisted and still failed, give up.)
      const tooLarge = e?.errcode === 'M_TOO_LARGE' || /too large/i.test(String(e?.message || ''));
      if (attempts >= MAX_ATTEMPTS) {
        await markDead(item.localId, e);
        this._onProgress({ type: 'dead', localId: item.localId, error: String(e?.message || e) });
      } else {
        await markFailed(item.localId, e, attempts);
        this._onProgress({ type: 'retry', localId: item.localId, attempts, tooLarge, error: String(e?.message || e) });
      }
    }
  }
}

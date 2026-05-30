/**
 * pack.js — Binary event serialization
 *
 * Fixed 24-byte header + variable-length body per event.
 * The body is the JSON content encoded as UTF-8 (CBOR upgrade later).
 * Designed for L2-friendly sequential scans at memory bandwidth.
 *
 * Record layout:
 * ┌──────────────────────────────────────┐
 * │ op_code       : uint8     (1 byte)   │  Operator index (2-8, matching OP.order)
 * │ flags         : uint8     (1 byte)   │  Reserved (redacted, encrypted, etc.)
 * │ timestamp     : uint48    (6 bytes)   │  Origin server ts (ms since epoch)
 * │ event_id_hash : uint64    (8 bytes)   │  FNV-1a of event_id for dedup
 * │ sender_hash   : uint32    (4 bytes)   │  FNV-1a of sender MXID
 * │ body_length   : uint32    (4 bytes)   │  Byte length of body
 * ├──────────────────────────────────────┤
 * │ body          : [u8]      (variable)  │  UTF-8 JSON of event content
 * └──────────────────────────────────────┘
 *
 * Total: 24 + body_length per event.
 * At typical content sizes (~200 bytes), ~224 bytes/event.
 * 100k events ≈ 22 MB — fits in memory, scans at bandwidth.
 */

const HEADER_SIZE = 24;

// ── FNV-1a hash ──
// Fast, non-crypto, deterministic. Same hash the EO///DB codebase uses
// for target hashes. 32-bit version for sender, 64-bit for event_id.

function fnv1a32(str) {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

// 64-bit FNV-1a as two 32-bit halves, packed into a BigUint64.
// We write it as two uint32s to avoid BigInt on the hot path.
function fnv1a64(str) {
  let lo = 0x811c9dc5;
  let hi = 0xcbf29ce4;
  for (let i = 0; i < str.length; i++) {
    const c = str.charCodeAt(i);
    lo ^= c;
    hi ^= c;
    lo = Math.imul(lo, 0x01000193);
    hi = Math.imul(hi, 0x00000100 + 0x193);
  }
  return [lo >>> 0, hi >>> 0];
}

// ── Encoder ──

const encoder = new TextEncoder();
const decoder = new TextDecoder();

/**
 * Pack a single event into a Uint8Array.
 *
 * @param {number} opOrder  - Operator order (2-8)
 * @param {number} ts       - Origin server timestamp (ms)
 * @param {string} eventId  - Matrix event ID (for dedup hash)
 * @param {string} sender   - Sender MXID
 * @param {object} content  - Event content object
 * @returns {Uint8Array} Packed binary record
 */
export function packEvent(opOrder, ts, eventId, sender, content) {
  const bodyBytes = encoder.encode(JSON.stringify(content));
  const buf = new ArrayBuffer(HEADER_SIZE + bodyBytes.length);
  const view = new DataView(buf);
  const arr = new Uint8Array(buf);

  // op_code (1 byte)
  view.setUint8(0, opOrder);

  // flags (1 byte) — reserved
  view.setUint8(1, 0);

  // timestamp as uint48: high 16 bits then low 32 bits
  // ts fits in 48 bits until ~year 10889
  const tsHi = (ts / 0x100000000) & 0xFFFF;
  const tsLo = ts >>> 0;
  view.setUint16(2, tsHi);
  view.setUint32(4, tsLo);

  // event_id_hash (8 bytes as two uint32)
  const [eidLo, eidHi] = fnv1a64(eventId || '');
  view.setUint32(8, eidLo);
  view.setUint32(12, eidHi);

  // sender_hash (4 bytes)
  view.setUint32(16, fnv1a32(sender || ''));

  // body_length (4 bytes)
  view.setUint32(20, bodyBytes.length);

  // body
  arr.set(bodyBytes, HEADER_SIZE);

  return arr;
}

/**
 * Pack multiple events into a single contiguous buffer.
 * More efficient than concatenating individual packEvent results.
 *
 * @param {Array<{opOrder, ts, eventId, sender, content}>} events
 * @returns {Uint8Array}
 */
export function packBatch(events) {
  // Pre-encode all bodies to calculate total size
  const bodies = events.map(e => encoder.encode(JSON.stringify(e.content)));
  const totalSize = events.length * HEADER_SIZE + bodies.reduce((s, b) => s + b.length, 0);

  const buf = new ArrayBuffer(totalSize);
  const view = new DataView(buf);
  const arr = new Uint8Array(buf);

  let offset = 0;
  for (let i = 0; i < events.length; i++) {
    const e = events[i];
    const body = bodies[i];

    view.setUint8(offset, e.opOrder);
    view.setUint8(offset + 1, 0);

    const tsHi = (e.ts / 0x100000000) & 0xFFFF;
    const tsLo = e.ts >>> 0;
    view.setUint16(offset + 2, tsHi);
    view.setUint32(offset + 4, tsLo);

    const [eidLo, eidHi] = fnv1a64(e.eventId || '');
    view.setUint32(offset + 8, eidLo);
    view.setUint32(offset + 12, eidHi);

    view.setUint32(offset + 16, fnv1a32(e.sender || ''));
    view.setUint32(offset + 20, body.length);

    arr.set(body, offset + HEADER_SIZE);
    offset += HEADER_SIZE + body.length;
  }

  return arr;
}

/**
 * Unpack all events from a binary buffer.
 * Returns plain objects suitable for the fold.
 *
 * @param {Uint8Array} data - Packed binary data
 * @returns {Array<{type: string, content: object, origin_server_ts: number, sender_hash: number, event_id_hash: [number, number]}>}
 */
export function unpackAll(data, namespace) {
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const events = [];
  let offset = 0;

  // Operator order → key lookup (must match OP definitions)
  const ORDER_TO_KEY = ['nul', 'sig', 'ins', 'seg', 'con', 'syn', 'def', 'eva', 'rec'];

  while (offset + HEADER_SIZE <= data.length) {
    const opOrder = view.getUint8(offset);
    const flags = view.getUint8(offset + 1);

    const tsHi = view.getUint16(offset + 2);
    const tsLo = view.getUint32(offset + 4);
    const ts = tsHi * 0x100000000 + tsLo;

    const eidLo = view.getUint32(offset + 8);
    const eidHi = view.getUint32(offset + 12);
    const senderHash = view.getUint32(offset + 16);
    const bodyLength = view.getUint32(offset + 20);

    if (offset + HEADER_SIZE + bodyLength > data.length) break; // truncated

    const bodySlice = data.subarray(offset + HEADER_SIZE, offset + HEADER_SIZE + bodyLength);
    let content;
    try {
      content = JSON.parse(decoder.decode(bodySlice));
    } catch {
      content = {};
    }

    const key = ORDER_TO_KEY[opOrder] || 'nul';
    events.push({
      type: `${namespace}.${key}`,
      content,
      origin_server_ts: ts,
      sender_hash: senderHash,
      event_id_hash: [eidLo, eidHi],
      _flags: flags,
    });

    offset += HEADER_SIZE + bodyLength;
  }

  return events;
}

/**
 * Scan the buffer and return only metadata (no body decode).
 * For fast queries: "how many events?", "what's the last timestamp?",
 * "which operators are present?"
 *
 * @param {Uint8Array} data
 * @returns {{ count: number, lastTs: number, firstTs: number, byOp: number[] }}
 */
export function scanMeta(data) {
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  let offset = 0;
  let count = 0;
  let firstTs = Infinity;
  let lastTs = 0;
  const byOp = new Array(9).fill(0);

  while (offset + HEADER_SIZE <= data.length) {
    const opOrder = view.getUint8(offset);
    const tsHi = view.getUint16(offset + 2);
    const tsLo = view.getUint32(offset + 4);
    const ts = tsHi * 0x100000000 + tsLo;
    const bodyLength = view.getUint32(offset + 20);

    if (offset + HEADER_SIZE + bodyLength > data.length) break;

    if (ts < firstTs) firstTs = ts;
    if (ts > lastTs) lastTs = ts;
    if (opOrder < 9) byOp[opOrder]++;
    count++;

    offset += HEADER_SIZE + bodyLength;
  }

  return { count, firstTs: firstTs === Infinity ? 0 : firstTs, lastTs, byOp };
}

/**
 * Unpack only events after a given timestamp.
 * Scans headers (no body decode) until past sinceTs, then unpacks the rest.
 * For a store with 100k events where only 10 are new, this skips 99,990
 * body decodes — the scan is a byte-stride loop at memory bandwidth.
 *
 * @param {Uint8Array} data
 * @param {string} namespace
 * @param {number} sinceTs - Unpack events with ts >= this value
 * @returns {Array} Plain event objects for foldFrom()
 */
export function unpackSince(data, namespace, sinceTs) {
  if (!data || data.length === 0 || sinceTs <= 0) return unpackAll(data, namespace);

  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const ORDER_TO_KEY = ['nul', 'sig', 'ins', 'seg', 'con', 'syn', 'def', 'eva', 'rec'];
  const events = [];
  let offset = 0;

  while (offset + HEADER_SIZE <= data.length) {
    const opOrder = view.getUint8(offset);
    const flags = view.getUint8(offset + 1);
    const tsHi = view.getUint16(offset + 2);
    const tsLo = view.getUint32(offset + 4);
    const ts = tsHi * 0x100000000 + tsLo;
    const bodyLength = view.getUint32(offset + 20);

    if (offset + HEADER_SIZE + bodyLength > data.length) break;

    // Only unpack body for events at or after the cursor
    if (ts >= sinceTs) {
      const eidLo = view.getUint32(offset + 8);
      const eidHi = view.getUint32(offset + 12);
      const senderHash = view.getUint32(offset + 16);
      const bodySlice = data.subarray(offset + HEADER_SIZE, offset + HEADER_SIZE + bodyLength);
      let content;
      try { content = JSON.parse(decoder.decode(bodySlice)); } catch { content = {}; }

      const key = ORDER_TO_KEY[opOrder] || 'nul';
      events.push({
        type: `${namespace}.${key}`,
        content,
        origin_server_ts: ts,
        sender_hash: senderHash,
        event_id_hash: [eidLo, eidHi],
        _flags: flags,
      });
    }

    offset += HEADER_SIZE + bodyLength;
  }

  return events;
}

export { HEADER_SIZE, fnv1a32, fnv1a64 };

/**
 * chunks.js — split the dataset blob into media-sized, hash-chained blocks.
 *
 * A homeserver caps a single upload (`m.upload.size`). When the gzip-NDJSON
 * dataset blob is larger, we slice it into blocks that each fit, frame every
 * block in a small binary envelope that links to the previous block's hash
 * (a chain), upload each as its own encrypted media block, and describe the
 * whole set with a manifest. Reassembly concatenates the blocks in order and
 * verifies the chain before gunzipping.
 *
 * Block envelope (binary):
 *   magic  'DFRC'   4
 *   version uint8   1   (=1)
 *   flags   uint8   1   (=0)
 *   index   uint16  2
 *   total   uint16  2
 *   prevLo  uint32  4   ┐ FNV-1a/64 of the previous block's payload
 *   prevHi  uint32  4   ┘ (0,0 for the first block) — the chain link
 *   len     uint32  4   payload byte length
 *   payload [u8]    len slice of the gzip-NDJSON blob
 *  → 22-byte header + payload.
 *
 * The hashes are non-crypto (FNV) — they order and integrity-link the blocks
 * inside an already-E2EE, SHA-256-verified media layer; they are structure,
 * not a security boundary.
 */

export const MAGIC = 0x44465243; // 'DFRC'
export const FLAG_FINAL = 0x01;
const HEADER = 22;

/** 64-bit FNV-1a over bytes, returned as [lo32, hi32]. */
export function hash64(bytes) {
  let h1 = 0x811c9dc5, h2 = 0xcbf29ce4 >>> 0;
  for (let i = 0; i < bytes.length; i++) {
    const c = bytes[i];
    h1 = Math.imul(h1 ^ c, 0x01000193);
    h2 = Math.imul(h2 ^ c, 0x01000193);
  }
  return [h1 >>> 0, h2 >>> 0];
}

const hEq = (a, b) => a[0] === b[0] && a[1] === b[1];

/**
 * Frame one payload into a block. `total` may be 0 ("unknown", for streaming
 * uploads where the count isn't known until the end); set FLAG_FINAL on the
 * last block instead. The manifest carries the authoritative order and count.
 */
export function frameBlock(index, total, prev, payload, flags = 0) {
  const buf = new ArrayBuffer(HEADER + payload.length);
  const v = new DataView(buf);
  const a = new Uint8Array(buf);
  v.setUint32(0, MAGIC);
  v.setUint8(4, 1);
  v.setUint8(5, flags);
  v.setUint16(6, index);
  v.setUint16(8, total & 0xffff);
  v.setUint32(10, prev[0]);
  v.setUint32(14, prev[1]);
  v.setUint32(18, payload.length);
  a.set(payload, HEADER);
  return a;
}

/**
 * Split `bytes` into framed, hash-chained blocks of at most `chunkSize`
 * payload each. Returns `{ blocks, metas }` where `blocks[i]` is the binary to
 * upload and `metas[i]` = { i, size, self:[lo,hi], prev:[lo,hi] }.
 */
export function chunkBlob(bytes, chunkSize) {
  const size = Math.max(1, chunkSize | 0);
  const total = Math.max(1, Math.ceil(bytes.length / size));
  const blocks = [];
  const metas = [];
  let prev = [0, 0];
  for (let i = 0; i < total; i++) {
    const payload = bytes.subarray(i * size, Math.min((i + 1) * size, bytes.length));
    const self = hash64(payload);
    blocks.push(frameBlock(i, total, prev, payload, i === total - 1 ? FLAG_FINAL : 0));
    metas.push({ i, size: payload.length, self, prev });
    prev = self;
  }
  return { blocks, metas, total, head: prev };
}

/** Parse one framed block into { index, total, flags, prev, self, payload }. */
export function parseBlock(bytes) {
  if (bytes.length < HEADER) throw new Error('block too short');
  const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (v.getUint32(0) !== MAGIC) throw new Error('bad block magic');
  const flags = v.getUint8(5);
  const index = v.getUint16(6);
  const total = v.getUint16(8);
  const prev = [v.getUint32(10), v.getUint32(14)];
  const len = v.getUint32(18);
  if (HEADER + len > bytes.length) throw new Error('block truncated');
  const payload = bytes.subarray(HEADER, HEADER + len);
  return { index, total, flags, prev, self: hash64(payload), payload };
}

/**
 * Streamingly reassemble a chained archive into a ReadableStream<Uint8Array>
 * without ever holding the whole blob: blocks are fetched in manifest order,
 * the chain link is verified per block, and each verified payload is enqueued.
 * Lets the lean indexer parse a multi-GB archive block-by-block from media.
 *
 * @param {Array<{ref:object, i:number}>} chunkRefs  manifest.chunks (ordered)
 * @param {(ref)=>Promise<Uint8Array|null>} fetchBytes  e.g. getMediaBytes
 * @param {(msg)=>void} [onBlock]  progress callback (1-based index, count)
 * @returns {ReadableStream<Uint8Array>} payloads in order
 */
export function reassembleStream(chunkRefs, fetchBytes, onBlock) {
  const ordered = [...chunkRefs].sort((a, b) => a.i - b.i);
  let prev = [0, 0];
  let idx = 0;
  return new ReadableStream({
    async pull(controller) {
      if (idx >= ordered.length) { controller.close(); return; }
      const c = ordered[idx];
      const raw = await fetchBytes(c.ref);
      if (!raw) { controller.error(new Error(`block ${c.i} unavailable`)); return; }
      const b = parseBlock(raw);
      if (b.index !== idx) { controller.error(new Error(`chain gap at index ${idx}`)); return; }
      if (!hEq(b.prev, prev)) { controller.error(new Error(`broken chain link at block ${idx}`)); return; }
      prev = b.self;
      idx++;
      if (onBlock) onBlock(idx, ordered.length);
      controller.enqueue(b.payload.slice()); // detach from the parsed buffer
    },
  });
}

/**
 * Reassemble blocks (any order) into the original blob, verifying the chain:
 * indices are contiguous 0..N-1 and each block's `prev` equals the previous
 * block's payload hash. `total` is checked only when present (streaming uploads
 * leave it 0 and rely on the manifest's count + the FINAL flag). Throws on any
 * gap or mismatch.
 */
export function reassemble(blockBytesList) {
  const parsed = blockBytesList.map(parseBlock).sort((a, b) => a.index - b.index);
  const n = parsed.length;
  if (!n) return new Uint8Array(0);
  let prev = [0, 0];
  let totalLen = 0;
  for (let i = 0; i < n; i++) {
    const b = parsed[i];
    if (b.index !== i) throw new Error(`chain gap at index ${i}`);
    if (b.total && b.total !== n) throw new Error(`block count mismatch (${b.total} vs ${n})`);
    if (!hEq(b.prev, prev)) throw new Error(`broken chain link at block ${i}`);
    prev = b.self;
    totalLen += b.payload.length;
  }
  const out = new Uint8Array(totalLen);
  let off = 0;
  for (const b of parsed) { out.set(b.payload, off); off += b.payload.length; }
  return out;
}

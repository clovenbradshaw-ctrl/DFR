/**
 * media.js — Encrypted attachments + offline media mirror
 *
 * All blobs uploaded to the homeserver media store are end-to-end
 * encrypted with the same trust boundary as the room itself:
 *
 *   - A fresh 256-bit key + 128-bit IV (8 random bytes ‖ 8 counter bytes)
 *     is generated per blob.
 *   - The plaintext is AES-CTR encrypted.
 *   - SHA-256 of the ciphertext is recorded for integrity.
 *   - The ciphertext goes to /_matrix/media (server sees opaque bytes).
 *   - The key + iv + hash live inside the room event content, which is
 *     itself Megolm-encrypted when the event is sent into an E2EE room.
 *
 * So: anyone with the room's Megolm session can decrypt the event and
 * thereby decrypt the blob. The homeserver and any non-member cannot.
 *
 * The reference format embedded in event content is:
 *
 *   { __media: 2, mxc, mime, size, name, file: { v:'v2', key, iv, hashes } }
 *
 * Legacy `__media: 1` references (plaintext on the media store, from
 * an earlier version) are still readable so old events keep working.
 *
 * Two layers of at-rest protection apply locally:
 *   - The plaintext bytes are mirrored to OPFS, vault-encrypted, so
 *     readers can resolve without contacting the server.
 *   - The mirror is keyed by mxc URL hash; on logout it is wiped along
 *     with the rest of the user's local data.
 */

import { getClient } from './client.js';
import { vault } from './vault.js';

const HOIST_THRESHOLD = 16 * 1024;       // hoist string fields >= 16KB
const CONTENT_SIZE_LIMIT = 24 * 1024;    // total target after hoist
const MAX_HOIST_PER_EVENT = 8;
const IV_BYTES = 16;
const KEY_BYTES = 32;
const CACHE_PREFIX = 'media_';
const CACHE_SUFFIX = '.bin';

const encoder = new TextEncoder();
const decoder = new TextDecoder();

// ── Encoding helpers ──

function b64Url(bytes) {
  let s = '';
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function b64UrlDecode(str) {
  const pad = str.length % 4 === 0 ? '' : '='.repeat(4 - (str.length % 4));
  const bin = atob(str.replace(/-/g, '+').replace(/_/g, '/') + pad);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function b64Unpadded(bytes) {
  let s = '';
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
  return btoa(s).replace(/=+$/, '');
}

function b64UnpaddedDecode(str) {
  const pad = str.length % 4 === 0 ? '' : '='.repeat(4 - (str.length % 4));
  const bin = atob(str + pad);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function byteLength(str) {
  return encoder.encode(str).length;
}

export function contentSize(content) {
  return byteLength(JSON.stringify(content));
}

// ── Matrix encrypted attachments (v2) ──

async function aesCtrEncrypt(keyBytes, iv, plaintext) {
  const key = await crypto.subtle.importKey(
    'raw', keyBytes, { name: 'AES-CTR' }, false, ['encrypt']
  );
  const ct = await crypto.subtle.encrypt(
    { name: 'AES-CTR', counter: iv, length: 64 },
    key, plaintext
  );
  return new Uint8Array(ct);
}

async function aesCtrDecrypt(keyBytes, iv, ciphertext) {
  const key = await crypto.subtle.importKey(
    'raw', keyBytes, { name: 'AES-CTR' }, false, ['decrypt']
  );
  const pt = await crypto.subtle.decrypt(
    { name: 'AES-CTR', counter: iv, length: 64 },
    key, ciphertext
  );
  return new Uint8Array(pt);
}

async function sha256(bytes) {
  return new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
}

/**
 * Encrypt `plaintext` with a fresh AES-CTR key. Returns the
 * ciphertext to upload and the file info envelope to embed in the
 * Megolm-encrypted event content.
 */
export async function encryptAttachment(plaintext) {
  const keyBytes = crypto.getRandomValues(new Uint8Array(KEY_BYTES));
  const iv = new Uint8Array(IV_BYTES);
  // Upper 8 bytes random, lower 8 zero — leaves the 64-bit block counter
  // free to count up through ciphertext blocks. Matches the spec.
  crypto.getRandomValues(iv.subarray(0, 8));
  const ciphertext = await aesCtrEncrypt(keyBytes, iv, plaintext);
  const digest = await sha256(ciphertext);
  return {
    data: ciphertext,
    info: {
      v: 'v2',
      key: {
        kty: 'oct',
        alg: 'A256CTR',
        ext: true,
        k: b64Url(keyBytes),
        key_ops: ['encrypt', 'decrypt'],
      },
      iv: b64Unpadded(iv),
      hashes: { sha256: b64Unpadded(digest) },
    },
  };
}

/**
 * Decrypt a file ciphertext blob using the `file` envelope from a
 * `__media: 2` reference. Verifies SHA-256 before returning plaintext.
 */
export async function decryptAttachment(ciphertext, info) {
  if (!info || !info.key || !info.key.k || !info.iv || !info.hashes?.sha256) {
    throw new Error('Missing attachment envelope fields');
  }
  const keyBytes = b64UrlDecode(info.key.k);
  const iv = b64UnpaddedDecode(info.iv);
  const expected = b64UnpaddedDecode(info.hashes.sha256);
  const actual = await sha256(ciphertext);
  if (expected.length !== actual.length) throw new Error('Hash length mismatch');
  let diff = 0;
  for (let i = 0; i < expected.length; i++) diff |= expected[i] ^ actual[i];
  if (diff !== 0) throw new Error('Hash mismatch — corrupt or tampered attachment');
  return aesCtrDecrypt(keyBytes, iv, ciphertext);
}

// ── OPFS-backed local mirror (vault-encrypted) ──

async function getOpfsRoot() {
  try { return await navigator.storage.getDirectory(); }
  catch { return null; }
}

async function mxcToFileName(mxc) {
  const digest = await sha256(encoder.encode(mxc));
  let hex = '';
  for (let i = 0; i < 16; i++) hex += digest[i].toString(16).padStart(2, '0');
  return `${CACHE_PREFIX}${hex}${CACHE_SUFFIX}`;
}

/**
 * Stash `bytes` in OPFS keyed by `mxc`, encrypted with the vault key.
 * No-op if OPFS is unavailable or the vault is locked.
 */
export async function cacheMediaBytes(mxc, bytes) {
  if (!mxc || !bytes) return;
  if (!vault.isUnlocked()) return;
  const root = await getOpfsRoot();
  if (!root) return;
  try {
    const name = await mxcToFileName(mxc);
    const handle = await root.getFileHandle(name, { create: true });
    const blob = await vault.encryptBytes(bytes);
    const writable = await handle.createWritable();
    await writable.write(blob);
    await writable.close();
  } catch (e) {
    console.warn('[media] cache write failed:', e?.message || e);
  }
}

/**
 * Read previously-cached bytes for `mxc`. Returns null if absent or
 * undecryptable. Pure-local — no network.
 */
export async function getCachedMediaBytes(mxc) {
  if (!mxc) return null;
  if (!vault.isUnlocked()) return null;
  const root = await getOpfsRoot();
  if (!root) return null;
  try {
    const name = await mxcToFileName(mxc);
    const handle = await root.getFileHandle(name);
    const file = await handle.getFile();
    const blob = new Uint8Array(await file.arrayBuffer());
    return await vault.decryptBytes(blob);
  } catch {
    return null;
  }
}

/**
 * Wipe every cached media blob from OPFS. Called on logout.
 */
export async function wipeMediaCache() {
  const root = await getOpfsRoot();
  if (!root) return;
  const toRemove = [];
  try {
    for await (const [name] of root) {
      if (name.startsWith(CACHE_PREFIX) && name.endsWith(CACHE_SUFFIX)) toRemove.push(name);
    }
    for (const n of toRemove) { try { await root.removeEntry(n); } catch {} }
  } catch (e) {
    console.warn('[media] cache wipe failed:', e?.message || e);
  }
}

// ── Upload (encrypted) ──

/**
 * Encrypt `plaintext`, upload the ciphertext to the homeserver media
 * store, and mirror the plaintext locally for offline reads. Returns
 * a `__media: 2` reference suitable for embedding in event content.
 */
export async function uploadEncrypted(plaintext, { mime = 'application/octet-stream', name = 'file' } = {}) {
  const client = getClient();
  if (!client) throw new Error('Not connected — cannot upload media');

  const bytes = plaintext instanceof Uint8Array ? plaintext : new Uint8Array(plaintext);
  const { data, info } = await encryptAttachment(bytes);

  // The Matrix media endpoint accepts any MIME; we deliberately send
  // application/octet-stream for the ciphertext so the server can't
  // sniff structure.
  const blob = new Blob([data], { type: 'application/octet-stream' });
  const resp = await client.uploadContent(blob, {
    type: 'application/octet-stream',
    name,
  });
  const mxc = resp && resp.content_uri;
  if (!mxc) throw new Error('Upload returned no content_uri');

  await cacheMediaBytes(mxc, bytes);

  return {
    __media: 2,
    mxc,
    mime,
    size: bytes.length,
    name,
    file: info,
  };
}

/**
 * Convenience: encrypt + upload + cache a user-supplied File / Blob,
 * preserving its declared MIME type and filename.
 */
export async function uploadFile(file, opts = {}) {
  const bytes = new Uint8Array(await file.arrayBuffer());
  return uploadEncrypted(bytes, {
    mime: opts.mime || file.type || 'application/octet-stream',
    name: opts.name || file.name || 'file',
  });
}

// ── Hoist (sending side) ──

/**
 * For every string field above the hoist threshold, encrypt + upload
 * it as an attachment and replace the value with a `__media: 2` ref.
 * Largest fields first, capped at MAX_HOIST_PER_EVENT.
 */
export async function hoistLargeFields(content) {
  if (!content || typeof content !== 'object') return { content, hoisted: 0 };
  if (contentSize(content) <= CONTENT_SIZE_LIMIT) return { content, hoisted: 0 };

  const client = getClient();
  if (!client) return { content, hoisted: 0 };

  const out = structuredClone(content);
  let hoisted = 0;

  const candidates = [];
  collectCandidates(out, [], candidates);
  candidates.sort((a, b) => b.size - a.size);

  for (const cand of candidates) {
    if (hoisted >= MAX_HOIST_PER_EVENT) break;
    if (contentSize(out) <= CONTENT_SIZE_LIMIT) break;

    try {
      const bytes = encoder.encode(cand.value);
      const ref = await uploadEncrypted(bytes, {
        mime: 'text/plain;charset=utf-8',
        name: cand.path.join('.') || 'value',
      });
      setPath(out, cand.path, ref);
      hoisted++;
    } catch (e) {
      console.warn('[media] hoist failed for', cand.path, e?.message || e);
    }
  }

  return { content: out, hoisted };
}

// ── Read (receiving side) ──

/**
 * Build the ordered list of download attempts for an mxc URI.
 *
 * Synapse 1.100+ (enforced by default in recent releases) serves media
 * only from the *authenticated* endpoint — `/_matrix/client/v1/media/
 * download/...` — which requires the access token in an Authorization
 * header. A plain unauthenticated `fetch` of the legacy `/_matrix/media/
 * v3/download/...` URL gets a 401/404 there.
 *
 * This matters specifically after a cache wipe: during a normal session
 * blobs resolve from the local OPFS mirror and never hit the network, so
 * the unauthenticated path silently "worked". Once the mirror is gone the
 * re-download is the only source of truth, and on an authenticated-media
 * homeserver it must carry the token — otherwise imported rows (which are
 * materialised from the source blob, not stored as events) never come
 * back even though the schema does.
 *
 * We try the authenticated endpoint first (with the token) and fall back
 * to the legacy unauthenticated one for older servers. On an SDK build
 * that predates the `useAuthentication` argument the first entry collapses
 * to the legacy URL — harmless, the Bearer header is simply ignored.
 */
function mediaDownloadAttempts(client, mxc) {
  const attempts = [];
  const token = typeof client.getAccessToken === 'function' ? client.getAccessToken() : null;

  let authedUrl = null;
  try {
    // (mxc, width, height, resizeMethod, allowDirectLinks, allowRedirects, useAuthentication)
    authedUrl = client.mxcUrlToHttp(mxc, undefined, undefined, undefined, true, undefined, true);
  } catch { /* older SDK signature — fall through to the legacy URL */ }
  if (authedUrl && token) {
    attempts.push({ url: authedUrl, init: { headers: { Authorization: `Bearer ${token}` } } });
  }

  let legacyUrl = null;
  try {
    legacyUrl = client.mxcUrlToHttp(mxc, undefined, undefined, undefined, true);
  } catch { /* ignore */ }
  // Only add the legacy URL when it's actually different from the authed
  // one (older SDKs return the same string for both calls).
  if (legacyUrl && legacyUrl !== authedUrl) {
    attempts.push({ url: legacyUrl, init: {} });
  } else if (legacyUrl && !attempts.length) {
    attempts.push({ url: legacyUrl, init: {} });
  }

  return attempts;
}

/**
 * Fetch the plaintext bytes referenced by a `__media` envelope.
 * Tries the local mirror first; falls back to the homeserver media
 * store (authenticated endpoint first, then legacy), decrypting if the
 * envelope is v2.
 *
 * Returns null when the bytes cannot be obtained (offline + no cache,
 * or every download attempt failed).
 */
export async function getMediaBytes(ref) {
  if (!ref || !ref.mxc) return null;

  const cached = await getCachedMediaBytes(ref.mxc);
  if (cached) return cached;

  const client = getClient();
  if (!client) return null;

  const attempts = mediaDownloadAttempts(client, ref.mxc);
  if (!attempts.length) return null;

  for (const { url, init } of attempts) {
    try {
      const resp = await fetch(url, init);
      if (!resp.ok) {
        console.warn(`[media] download ${resp.status} for ${ref.mxc} via ${url}`);
        continue;
      }
      const downloaded = new Uint8Array(await resp.arrayBuffer());
      let plaintext;
      if (ref.__media === 2 && ref.file) {
        plaintext = await decryptAttachment(downloaded, ref.file);
      } else {
        // Legacy plaintext upload.
        plaintext = downloaded;
      }
      await cacheMediaBytes(ref.mxc, plaintext);
      return plaintext;
    } catch (e) {
      console.warn('[media] download failed:', e?.message || e);
      // Try the next endpoint before giving up.
    }
  }
  return null;
}

/**
 * Walk `content`, replacing every `__media` ref with the dereferenced
 * value. v2 refs are interpreted as text by default (matches the
 * hoist source). Callers that need raw bytes for a specific ref
 * should use `getMediaBytes` directly.
 */
export async function resolveMediaReferences(content) {
  if (!content || typeof content !== 'object') return content;
  const out = structuredClone(content);
  const refs = [];
  collectMediaRefs(out, [], refs);
  if (refs.length === 0) return content;

  for (const r of refs) {
    try {
      const bytes = await getMediaBytes(r.ref);
      if (!bytes) continue;
      setPath(out, r.path, decoder.decode(bytes));
    } catch (e) {
      console.warn('[media] resolve failed for', r.path, e?.message || e);
    }
  }
  return out;
}

function collectCandidates(node, path, out) {
  if (typeof node === 'string') {
    const sz = byteLength(node);
    if (sz >= HOIST_THRESHOLD) out.push({ path: [...path], value: node, size: sz });
    return;
  }
  if (node && typeof node === 'object') {
    // Don't descend into existing media refs — they're already hoisted.
    if (node.__media) return;
    for (const k of Object.keys(node)) collectCandidates(node[k], [...path, k], out);
  }
}

function collectMediaRefs(node, path, out) {
  if (node && typeof node === 'object') {
    if ((node.__media === 1 || node.__media === 2) && typeof node.mxc === 'string') {
      out.push({ path: [...path], ref: node });
      return;
    }
    for (const k of Object.keys(node)) collectMediaRefs(node[k], [...path, k], out);
  }
}

function setPath(root, path, value) {
  if (path.length === 0) return;
  let node = root;
  for (let i = 0; i < path.length - 1; i++) node = node[path[i]];
  node[path[path.length - 1]] = value;
}

export { HOIST_THRESHOLD, CONTENT_SIZE_LIMIT };

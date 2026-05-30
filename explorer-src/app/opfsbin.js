/**
 * opfsbin.js — direct OPFS persistence for the dataset blob.
 *
 * The media layer already mirrors uploaded blobs to OPFS keyed by mxc, but that
 * only exists *after* an upload. The scraper appends flights locally and must
 * persist them instantly — before (or without) any Matrix round-trip — so the
 * working set survives reloads and stays the fast path. This is that store:
 * one vault-encrypted file per room, written on every local change, read once
 * on open.
 */

import { vault } from '../src/vault.js';
import { fnv1a32 } from '../src/pack.js';

const PREFIX = 'dfrset_';
const SUFFIX = '.bin';

function fileFor(roomId) {
  return `${PREFIX}${fnv1a32(roomId).toString(16)}${SUFFIX}`;
}

async function root() {
  try { return await navigator.storage.getDirectory(); }
  catch { return null; }
}

export async function saveLocal(roomId, bytes, { allowShrink = false } = {}) {
  if (!vault.isUnlocked()) return false;
  const dir = await root();
  if (!dir) return false;
  try {
    // Guard against clobbering a populated local store with a tiny/empty blob
    // (e.g. a save fired before the working set finished loading). Refuse to
    // shrink the file by >50% unless the caller explicitly allows it.
    if (!allowShrink) {
      try {
        const existing = await dir.getFileHandle(fileFor(roomId));
        const cur = await (await existing.getFile()).size;
        if (cur > 4096 && bytes.length < cur * 0.5) {
          console.warn(`[opfsbin] refusing to shrink local store ${cur}→${bytes.length} bytes`);
          return false;
        }
      } catch { /* no existing file — fine */ }
    }
    const handle = await dir.getFileHandle(fileFor(roomId), { create: true });
    const enc = await vault.encryptBytes(bytes);
    const w = await handle.createWritable();
    await w.write(enc);
    await w.close();
    return true;
  } catch (e) {
    console.warn('[opfsbin] save failed:', e?.message || e);
    return false;
  }
}

export async function loadLocal(roomId) {
  if (!vault.isUnlocked()) return null;
  const dir = await root();
  if (!dir) return null;
  try {
    const handle = await dir.getFileHandle(fileFor(roomId));
    const file = await handle.getFile();
    const enc = new Uint8Array(await file.arrayBuffer());
    return await vault.decryptBytes(enc);
  } catch {
    return null; // absent or undecryptable
  }
}

export async function clearLocal(roomId) {
  const dir = await root();
  if (!dir) return;
  try { await dir.removeEntry(fileFor(roomId)); } catch {}
}

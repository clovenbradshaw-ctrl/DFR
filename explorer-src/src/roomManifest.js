/**
 * roomManifest.js — Vault-encrypted local cache of known rooms.
 *
 * matrix-js-sdk's default in-memory store loses its room list on every
 * cold reload, so an offline boot — or one where the server is briefly
 * unreachable — leaves `client.getRooms()` empty and the room picker
 * blank. This manifest persists the bare minimum needed to repopulate
 * the picker without contacting the homeserver.
 *
 * Storage: per-user localStorage key, AES-GCM encrypted with the vault
 * key (so the room list is opaque on disk to anyone without the
 * Matrix password).
 *
 * The manifest is a snapshot, not a source of truth. As soon as the
 * SDK delivers fresh state, listRooms() returns the live list and
 * the manifest is overwritten with it.
 */

import { vault } from './vault.js';

const KEY = (userId) => `room_manifest_enc:${userId}`;

function b64(bytes) {
  let s = '';
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
  return btoa(s);
}

function unb64(s) {
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/**
 * Load the manifest for `userId`. Returns [] if there is no manifest,
 * the vault is locked, or the blob can't be decrypted with the
 * current key.
 */
export async function loadManifest(userId) {
  if (!userId) return [];
  if (!vault.isUnlocked() || vault.getUserId() !== userId) return [];
  const raw = localStorage.getItem(KEY(userId));
  if (!raw) return [];
  try {
    const arr = await vault.decryptJSON(unb64(raw));
    return Array.isArray(arr) ? arr : [];
  } catch (e) {
    console.warn('[manifest] decrypt failed:', e?.message || e);
    return [];
  }
}

/**
 * Persist a snapshot of `rooms` for `userId`. Vault must be unlocked
 * for the same user. Returns true on success, false if locked.
 */
export async function saveManifest(userId, rooms) {
  if (!userId) return false;
  if (!vault.isUnlocked() || vault.getUserId() !== userId) return false;
  const snapshot = (rooms || []).map(r => ({
    roomId: r.roomId,
    name: r.name || null,
    roomType: r.roomType || null,
    membership: r.membership || 'join',
  }));
  try {
    const blob = await vault.encryptJSON(snapshot);
    localStorage.setItem(KEY(userId), b64(blob));
    return true;
  } catch (e) {
    console.warn('[manifest] save failed:', e?.message || e);
    return false;
  }
}

export function wipeManifest(userId) {
  if (!userId) return;
  localStorage.removeItem(KEY(userId));
}

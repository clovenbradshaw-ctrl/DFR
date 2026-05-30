/**
 * vault.js — Local-at-rest encryption
 *
 * Every byte we persist (OPFS event files, checkpoints, outbox payloads,
 * session token) is AES-GCM encrypted with a key derived from the user's
 * Matrix password via PBKDF2. The key lives only in memory.
 *
 * Three states:
 *   - sealed   : no key in memory. Local data is opaque.
 *   - unlocked : key in memory. Reads and writes succeed.
 *   - absent   : no vault metadata at all (first launch or post-logout).
 *
 * Lock clears the key, keeps the data. Logout wipes everything.
 *
 * Per-user vault metadata (salt + verifier ciphertext) lives in
 * localStorage. It is small and non-secret — knowing the salt and an
 * encrypted "userId" string does not help an attacker recover the key
 * without the password.
 */

const PBKDF2_ITERATIONS = 250_000;
const SALT_BYTES = 16;
const IV_BYTES = 12;
const KEY_BITS = 256;
const VAULT_META_VERSION = 1;

const encoder = new TextEncoder();
const decoder = new TextDecoder();

function metaKey(userId) {
  return `vault:${userId}`;
}

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

async function deriveKey(password, salt) {
  const material = await crypto.subtle.importKey(
    'raw',
    encoder.encode(password),
    'PBKDF2',
    false,
    ['deriveKey']
  );
  // Extractable so we can stash a copy in sessionStorage for refresh-only
  // persistence. The raw key never reaches localStorage or disk.
  return crypto.subtle.deriveKey(
    { name: 'PBKDF2', hash: 'SHA-256', salt, iterations: PBKDF2_ITERATIONS },
    material,
    { name: 'AES-GCM', length: KEY_BITS },
    true,
    ['encrypt', 'decrypt']
  );
}

// sessionStorage key for the tab-scoped vault stash. Survives F5,
// dies when the tab/browser closes.
const SESSION_STASH_KEY = 'vault:session_stash';

// localStorage key for the persistent ("keep me signed in") vault stash.
// Survives browser restarts, so the user isn't prompted for their
// password on every cold boot.
//
// SECURITY TRADE-OFF: this writes the raw AES vault key to disk. Anyone
// with access to this browser profile can then decrypt the user's
// local-at-rest data without knowing the password. It is strictly
// opt-in (the login screen's "keep me signed in" toggle) for exactly
// that reason. The non-persistent path keeps the key in sessionStorage
// only — never on disk. Deliberately NOT prefixed `vault:` so it stays
// out of listVaultUsers()'s scan.
const PERSIST_STASH_KEY = 'vault_persist_stash';

function loadMeta(userId) {
  const raw = localStorage.getItem(metaKey(userId));
  if (!raw) return null;
  try {
    const obj = JSON.parse(raw);
    if (obj.v !== VAULT_META_VERSION) return null;
    return {
      salt: unb64(obj.salt),
      verifierIv: unb64(obj.verifierIv),
      verifierCt: unb64(obj.verifierCt),
    };
  } catch {
    return null;
  }
}

function saveMeta(userId, salt, verifierIv, verifierCt) {
  localStorage.setItem(metaKey(userId), JSON.stringify({
    v: VAULT_META_VERSION,
    salt: b64(salt),
    verifierIv: b64(verifierIv),
    verifierCt: b64(verifierCt),
  }));
}

class Vault {
  constructor() {
    this._key = null;
    this._userId = null;
    // Where the unlocked key is stashed for resume: false → sessionStorage
    // (tab-scoped), true → localStorage ("keep me signed in", survives
    // browser restart). Set by initialize/unlock and by the adopt path.
    this._persist = false;
    this._listeners = new Set();
  }

  isUnlocked() { return this._key !== null; }
  getUserId() { return this._userId; }
  /** True when the resume key is persisted to disk ("keep me signed in"). */
  isPersistent() { return this._persist; }
  hasMeta(userId) { return loadMeta(userId) !== null; }

  onChange(fn) {
    this._listeners.add(fn);
    return () => this._listeners.delete(fn);
  }

  _notify() {
    for (const fn of this._listeners) {
      try { fn({ unlocked: this.isUnlocked(), userId: this._userId }); }
      catch (e) { console.warn('[vault] listener error:', e); }
    }
  }

  /**
   * First-time setup. Generates a salt and verifier from `password`,
   * stores the metadata locally, and unlocks the vault in memory.
   *
   * Called on the first successful Matrix login for a given user on
   * this device. Subsequent logins use unlock() instead.
   *
   * `persist` controls where the resume key is stashed — see _stashKey.
   */
  async initialize(userId, password, { persist = false } = {}) {
    const salt = crypto.getRandomValues(new Uint8Array(SALT_BYTES));
    const key = await deriveKey(password, salt);

    const verifierIv = crypto.getRandomValues(new Uint8Array(IV_BYTES));
    const verifierPlain = encoder.encode(`verify:${userId}`);
    const verifierCt = new Uint8Array(
      await crypto.subtle.encrypt({ name: 'AES-GCM', iv: verifierIv }, key, verifierPlain)
    );

    saveMeta(userId, salt, verifierIv, verifierCt);
    this._key = key;
    this._userId = userId;
    this._persist = persist;
    await this._stashKey();
    this._notify();
  }

  /**
   * Unlock an existing vault. Returns true on success, false on bad
   * password. Works fully offline — no network calls.
   *
   * `persist` controls where the resume key is stashed — see _stashKey.
   */
  async unlock(userId, password, { persist = false } = {}) {
    const meta = loadMeta(userId);
    if (!meta) return false;
    const candidate = await deriveKey(password, meta.salt);
    try {
      const plain = await crypto.subtle.decrypt(
        { name: 'AES-GCM', iv: meta.verifierIv },
        candidate,
        meta.verifierCt
      );
      if (decoder.decode(new Uint8Array(plain)) !== `verify:${userId}`) return false;
      this._key = candidate;
      this._userId = userId;
      this._persist = persist;
      await this._stashKey();
      this._notify();
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Re-key after a password change. Existing data stays decryptable
   * with the old key until callers rewrite it; this is intentionally
   * not handled here.
   */
  async rekey(userId, newPassword) {
    if (!this.isUnlocked() || this._userId !== userId) {
      throw new Error('Vault must be unlocked for the same user to rekey');
    }
    // Preserve the user's persistence choice across a password change.
    await this.initialize(userId, newPassword, { persist: this._persist });
  }

  /** Lock: clear key from memory, keep data on disk. */
  lock() {
    this._key = null;
    this._userId = null;
    this._persist = false;
    this._clearStash();
    this._notify();
  }

  /**
   * Stash the current key so a later launch can re-adopt it without
   * prompting for the password again.
   *
   * When `this._persist` is false (default) the key goes to
   * sessionStorage: it survives an F5 but tab close / browser quit
   * clears it. When true ("keep me signed in") it goes to localStorage
   * so it survives a browser restart — at the cost of writing the key
   * to disk (see PERSIST_STASH_KEY). Only one store holds the stash at
   * a time; the other is cleared so a stale copy can't linger.
   */
  async _stashKey() {
    if (!this._key || !this._userId) return;
    let payload;
    try {
      const raw = await crypto.subtle.exportKey('raw', this._key);
      payload = JSON.stringify({
        userId: this._userId,
        key: b64(new Uint8Array(raw)),
      });
    } catch (e) {
      // Non-extractable key — resume persistence just won't work.
      console.warn('[vault] stash failed:', e?.message || e);
      return;
    }
    try {
      if (this._persist) {
        localStorage.setItem(PERSIST_STASH_KEY, payload);
        sessionStorage.removeItem(SESSION_STASH_KEY);
      } else {
        sessionStorage.setItem(SESSION_STASH_KEY, payload);
        localStorage.removeItem(PERSIST_STASH_KEY);
      }
    } catch (e) {
      // Storage disabled or over quota — resume just won't work.
      console.warn('[vault] stash failed:', e?.message || e);
    }
  }

  _clearStash() {
    try { sessionStorage.removeItem(SESSION_STASH_KEY); } catch {}
    try { localStorage.removeItem(PERSIST_STASH_KEY); } catch {}
  }

  /**
   * Restore the vault from a sessionStorage stash left by an earlier
   * unlock/initialize in this tab. Returns true on success.
   *
   * The stashed key is verified against the on-disk vault meta before
   * we expose it as "unlocked", so a tampered stash can't trick us.
   */
  async tryAdoptStashedKey(expectedUserId) {
    // Prefer the persistent ("keep me signed in") stash so a browser
    // restart resumes; otherwise fall back to the tab-scoped one.
    let raw = null;
    let persistent = false;
    try { raw = localStorage.getItem(PERSIST_STASH_KEY); } catch {}
    if (raw) {
      persistent = true;
    } else {
      try { raw = sessionStorage.getItem(SESSION_STASH_KEY); }
      catch { return false; }
    }
    if (!raw) return false;

    let parsed;
    try { parsed = JSON.parse(raw); } catch { this._clearStash(); return false; }
    if (!parsed?.userId || !parsed.key) { this._clearStash(); return false; }
    if (expectedUserId && parsed.userId !== expectedUserId) return false;

    const meta = loadMeta(parsed.userId);
    if (!meta) { this._clearStash(); return false; }

    try {
      const keyBytes = unb64(parsed.key);
      const key = await crypto.subtle.importKey(
        'raw', keyBytes, { name: 'AES-GCM' }, true, ['encrypt', 'decrypt']
      );
      const plain = await crypto.subtle.decrypt(
        { name: 'AES-GCM', iv: meta.verifierIv }, key, meta.verifierCt
      );
      if (decoder.decode(new Uint8Array(plain)) !== `verify:${parsed.userId}`) {
        this._clearStash();
        return false;
      }
      this._key = key;
      this._userId = parsed.userId;
      this._persist = persistent;
      this._notify();
      return true;
    } catch {
      this._clearStash();
      return false;
    }
  }

  /**
   * Wipe vault metadata for this user. Caller is responsible for
   * deleting the encrypted payloads themselves (OPFS files, outbox DB,
   * encrypted session). Use clearAll() for a full nuke.
   */
  wipe(userId) {
    localStorage.removeItem(metaKey(userId));
    // Sweep any encrypted secret entries we stashed for this user — they
    // would otherwise become unreadable bytes after the vault key changes.
    const prefix = `vault_secret:${userId}:`;
    for (let i = localStorage.length - 1; i >= 0; i--) {
      const k = localStorage.key(i);
      if (k && k.startsWith(prefix)) localStorage.removeItem(k);
    }
    if (this._userId === userId) {
      this._key = null;
      this._userId = null;
      this._persist = false;
      this._clearStash();
      this._notify();
    }
  }

  /**
   * Encrypt arbitrary bytes. Returns a single Uint8Array of
   * [iv(12)][ciphertext+tag].
   */
  async encryptBytes(plaintext) {
    if (!this._key) throw new Error('Vault is locked');
    const iv = crypto.getRandomValues(new Uint8Array(IV_BYTES));
    const ct = new Uint8Array(
      await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, this._key, plaintext)
    );
    const out = new Uint8Array(iv.length + ct.length);
    out.set(iv, 0);
    out.set(ct, iv.length);
    return out;
  }

  /** Decrypt an [iv][ct] blob produced by encryptBytes. */
  async decryptBytes(blob) {
    if (!this._key) throw new Error('Vault is locked');
    const iv = blob.subarray(0, IV_BYTES);
    const ct = blob.subarray(IV_BYTES);
    const pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, this._key, ct);
    return new Uint8Array(pt);
  }

  async encryptJSON(obj) {
    return this.encryptBytes(encoder.encode(JSON.stringify(obj)));
  }

  async decryptJSON(blob) {
    const bytes = await this.decryptBytes(blob);
    return JSON.parse(decoder.decode(bytes));
  }

  async encryptString(str) {
    return this.encryptBytes(encoder.encode(str));
  }

  async decryptString(blob) {
    return decoder.decode(await this.decryptBytes(blob));
  }
}

export const vault = new Vault();

/**
 * Convenience: encode an encrypted blob as base64 for localStorage.
 * Use for small values (session token, single-record stores).
 */
export async function encryptToB64(plaintextStr) {
  const bytes = await vault.encryptString(plaintextStr);
  return b64(bytes);
}

export async function decryptFromB64(b64Str) {
  return vault.decryptString(unb64(b64Str));
}

/** Per-user encrypted-session key in localStorage. */
export function sessionKey(userId) {
  return `mx_session_enc:${userId}`;
}

/**
 * Encrypted-at-rest secret stash. Small string values keyed by
 * (userId, name) and AES-GCM encrypted with the vault key. Used for
 * non-critical caches like a copy of the Matrix recovery key — losing
 * the vault loses the stash, that's fine, the server-side SSSS is the
 * source of truth.
 */
function secretKey(userId, name) {
  return `vault_secret:${userId}:${name}`;
}

export async function storeSecret(userId, name, value) {
  if (!vault.isUnlocked() || vault.getUserId() !== userId) {
    throw new Error('Vault locked');
  }
  localStorage.setItem(secretKey(userId, name), await encryptToB64(value));
}

export async function loadSecret(userId, name) {
  if (!vault.isUnlocked() || vault.getUserId() !== userId) return null;
  const raw = localStorage.getItem(secretKey(userId, name));
  if (!raw) return null;
  try { return await decryptFromB64(raw); }
  catch { return null; }
}

export function removeSecret(userId, name) {
  localStorage.removeItem(secretKey(userId, name));
}

/** Public list of users that have a vault on this device. */
export function listVaultUsers() {
  const ids = [];
  for (let i = 0; i < localStorage.length; i++) {
    const k = localStorage.key(i);
    if (k && k.startsWith('vault:')) ids.push(k.slice('vault:'.length));
  }
  return ids;
}

/** Track which user last logged in so the unlock UI can prefill. */
const LAST_USER_KEY = 'vault:last_user';
export function rememberLastUser(userId) {
  localStorage.setItem(LAST_USER_KEY, userId);
}
export function getLastUser() {
  return localStorage.getItem(LAST_USER_KEY) || null;
}
export function forgetLastUser() {
  localStorage.removeItem(LAST_USER_KEY);
}

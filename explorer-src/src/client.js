/**
 * client.js — Matrix connection layer
 *
 * Wraps matrix-js-sdk: login, session persistence, sync, crypto init.
 * Adds vault-encrypted session storage and offline-capable unlock.
 *
 * Three entry points:
 *   - login(hs, user, password)         : first time on this device
 *   - unlock(userId, password)          : subsequent launches; works offline
 *   - restoreSession(userId)            : auto-unlock from in-memory key (no-op when locked)
 *
 * The session token is stored vault-encrypted in localStorage so that a
 * device with a locked vault cannot mint Matrix requests, and the
 * token is wiped from disk on full logout.
 */

// Must run before matrix-js-sdk opens its IDB store, so it sees the
// scoped names instead of the global `matrix-js-sdk::*` ones.
import './idbScope.js';
import * as sdk from 'matrix-js-sdk';
import { decodeRecoveryKey } from 'matrix-js-sdk/lib/crypto-api/index.js';
import { deriveRecoveryKeyFromPassphrase } from 'matrix-js-sdk/lib/crypto-api/key-passphrase.js';
import { vault, sessionKey, rememberLastUser, forgetLastUser, getLastUser,
         storeSecret, loadSecret } from './vault.js';
import { wipeAllRoomData } from './store.js';
import { clearAll as clearOutbox } from './outbox.js';
import { watchSync } from './network.js';
import { wipeMediaCache } from './media.js';
import { wipeManifest } from './roomManifest.js';

let client = null;
let _watchSyncUnsub = null;

// matrix-js-sdk logs at DEBUG by default, which floods the console with every
// HTTP request, perf mark, and crypto trace. We don't want any of that. Pass
// this quiet logger to createClient: it drops trace/debug/info, forwards
// real warnings/errors, and filters a couple of known-benign warnings the SDK
// emits constantly for rooms whose `m.room.create` event isn't loaded under
// our minimal sync (`[getVersion]` / `[getType]` "does not have an
// m.room.create event"). Children (getChild) stay quiet too.
const QUIET_PATTERNS = [
  'does not have an m.room.create event',
  'No membership changes detected',
  'Adding default global',            // push-rule setup noise on every login
  'GroupCallEventHandler',            // call subsystem we disable anyway
];
function makeQuietLogger() {
  const noop = () => {};
  const passes = (msg) => {
    const first = typeof msg[0] === 'string' ? msg[0] : '';
    return !QUIET_PATTERNS.some((p) => first.includes(p));
  };
  const self = {
    trace: noop, debug: noop, info: noop, log: noop,
    warn: (...m) => { if (passes(m)) console.warn(...m); },
    error: (...m) => { if (passes(m)) console.error(...m); },
    getChild: () => self,
  };
  return self;
}
const QUIET_LOGGER = makeQuietLogger();

// Sync options tuned for a small idle footprint. matrix-js-sdk's default
// MemoryStore holds the user's *entire* Matrix account in RAM — every joined
// room's state, and for E2EE the device list of every member of every
// encrypted room. For an account in large/public rooms that is the bulk of
// the tab's memory, and it sits there even when the app shows nothing.
//
//   - lazyLoadMembers: don't pull or track member lists during sync; load
//     them on demand (only when a member list is actually opened). This is
//     the single biggest reduction for member-heavy accounts. Encryption
//     still works — the crypto layer loads targets before sending.
//   - initialSyncLimit 1: this app reads history from its own OPFS store and
//     paginates the tail on demand, so the SDK never needs to hold a per-room
//     timeline. Keep the initial burst to the minimum across all rooms.
//   - disablePresence: we never render presence; skip processing it.
const SYNC_OPTS = {
  initialSyncLimit: 1,
  lazyLoadMembers: true,
  disablePresence: true,
};

// matrix-js-sdk spins up TWO call subsystems for *every room in the account*
// and re-scans them on every sync — the newer MatrixRTCSession manager and the
// older GroupCallEventHandler. Both are pure overhead for a data app with no
// calls (the "[MatrixRTCSession … No membership changes detected]" /
// "GroupCallEventHandler start()" spam). Tear both down right after
// startClient. Safe: nothing in this app touches calls.
function disableMatrixRTC(c) {
  try { c.matrixRTC?.stop?.(); } catch (e) { progress(`RTC disable skipped: ${e.message}`); }
  try { c.groupCallEventHandler?.stop?.(); } catch (e) { progress(`GroupCall disable skipped: ${e.message}`); }
}

let progress = (msg) => console.log('[matrix]', msg);
export function setProgress(fn) {
  progress = (msg) => { console.log('[matrix]', msg); fn(msg); };
}

let recoveryKeyProvider = null;
let recoveryKeyDisplayer = null;
export function setRecoveryKeyProvider(fn) { recoveryKeyProvider = fn; }
export function setRecoveryKeyDisplayer(fn) { recoveryKeyDisplayer = fn; }

// In-memory password cache, alive only for the span of a login()/unlock()
// flow. Used by `getSecretStorageKey` to derive the SSSS key from the
// account's stored passphrase parameters without prompting the user.
// Cleared as soon as the secure-backup setup finishes, and on lock/logout.
let _currentPassword = null;
const VAULT_SECRET_SSSS_KEY = 'ssss_private_key_b64';
const VAULT_SECRET_RECOVERY_KEY = 'recovery_key_encoded';

export function getClient() { return client; }

const CRYPTO_STORE_NAME = 'matrix-js-sdk::matrix-sdk-crypto';
const CRYPTO_OWNER_KEY = 'eomx:crypto-owner';

function clearCryptoStore() {
  return new Promise((resolve) => {
    progress('Clearing stale crypto store…');
    const req = indexedDB.deleteDatabase(CRYPTO_STORE_NAME);
    let blockedTimer = null;
    const settle = () => {
      if (blockedTimer) { clearTimeout(blockedTimer); blockedTimer = null; }
      resolve();
    };
    req.onsuccess = () => { progress('Crypto store cleared'); settle(); };
    req.onerror = () => {
      progress('Crypto store clear failed: ' + (req.error?.message || 'unknown'));
      settle();
    };
    // onblocked means another connection is still open. Don't resolve
    // synchronously — that would race the caller's next initRustCrypto
    // against an in-flight delete and produce confusing failures. Wait
    // briefly for the lingering connection to close, then give up.
    req.onblocked = () => {
      progress('Crypto store delete blocked — waiting for connections to close');
      blockedTimer = setTimeout(() => {
        progress('Crypto store delete still blocked — proceeding anyway');
        settle();
      }, 3000);
    };
  });
}

/**
 * Pre-empt the "account in the store doesn't match" failure by wiping
 * the crypto store before init when we know it belongs to a different
 * user. Avoids hitting the exception-based retry path inside
 * initCryptoWithRetry, which has worse timing characteristics.
 */
async function ensureCryptoStoreOwner(userId) {
  const prior = localStorage.getItem(CRYPTO_OWNER_KEY);
  if (prior && prior !== userId) {
    progress(`Crypto store belonged to ${prior}; resetting for ${userId}`);
    await clearCryptoStore();
  }
  localStorage.setItem(CRYPTO_OWNER_KEY, userId);
}

function isCryptoStoreMismatch(err) {
  const msg = String(err && err.message || err || '');
  return msg.includes('account in the store doesn\'t match') ||
         msg.includes('account in the store does not match');
}

async function initCryptoWithRetry(c, timeoutMs = 30000) {
  try {
    await withTimeout(c.initRustCrypto(), timeoutMs, 'Crypto init');
  } catch (err) {
    // Any failure here — known mismatch, corrupted indexed DB, or partial
    // wipe from a previous session — recovers the same way: drop the
    // crypto store and let the SDK rebuild it from the server. Without
    // this fallback, users hit "wipe local data to log in" loops.
    progress('Crypto init failed — clearing crypto store and retrying: ' + err.message);
    try { await clearCryptoStore(); } catch {}
    await withTimeout(c.initRustCrypto(), timeoutMs, 'Crypto init (retry)');
  }
}

function waitForSync(c, timeoutMs = 60000) {
  return new Promise((resolve, reject) => {
    const current = c.getSyncState && c.getSyncState();
    if (current === 'PREPARED' || current === 'SYNCING') {
      resolve();
      return;
    }

    const onSync = (state, prevState, data) => {
      progress(`sync state: ${state}`);
      if (state === 'PREPARED' || state === 'SYNCING') {
        cleanup();
        resolve();
      } else if (state === 'ERROR' && data && data.error) {
        const err = data.error;
        if (err.httpStatus === 401 || err.httpStatus === 403 ||
            err.errcode === 'M_UNKNOWN_TOKEN') {
          cleanup();
          reject(new Error('Session expired — please log in again'));
        }
      }
    };

    const timer = setTimeout(() => {
      cleanup();
      reject(new Error(`Sync did not become ready within ${timeoutMs / 1000}s (last state: ${c.getSyncState && c.getSyncState()})`));
    }, timeoutMs);

    const cleanup = () => {
      clearTimeout(timer);
      c.off(sdk.ClientEvent.Sync, onSync);
    };

    c.on(sdk.ClientEvent.Sync, onSync);
  });
}

function withTimeout(promise, ms, label) {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`${label} timed out after ${ms / 1000}s`)), ms);
    promise.then(
      (v) => { clearTimeout(t); resolve(v); },
      (e) => { clearTimeout(t); reject(e); }
    );
  });
}

function b64ToBytes(b64) {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function bytesToB64(bytes) {
  let s = '';
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
  return btoa(s);
}

async function getSecretStorageKey({ keys }) {
  const keyId = Object.keys(keys)[0];
  if (!keyId) return null;
  const keyInfo = keys[keyId];
  const uid = vault.getUserId();

  // Fast path: a previous successful login stashed the raw SSSS key in
  // the vault. Use it directly so the user never sees a prompt.
  if (uid) {
    const stashed = await loadSecret(uid, VAULT_SECRET_SSSS_KEY);
    if (stashed) {
      try { return [keyId, b64ToBytes(stashed)]; }
      catch { /* fall through */ }
    }
  }

  // Password-derived path: account_data carries the PBKDF2 salt+iterations
  // for the SSSS key. If the user's Matrix password is currently in scope
  // (login or unlock flow), derive the key transparently and cache it.
  if (_currentPassword && keyInfo?.passphrase?.algorithm === 'm.pbkdf2'
      && keyInfo.passphrase.salt && keyInfo.passphrase.iterations) {
    try {
      const privateKey = await deriveRecoveryKeyFromPassphrase(
        _currentPassword,
        keyInfo.passphrase.salt,
        keyInfo.passphrase.iterations,
      );
      if (uid) {
        try { await storeSecret(uid, VAULT_SECRET_SSSS_KEY, bytesToB64(privateKey)); }
        catch { /* non-fatal */ }
      }
      return [keyId, privateKey];
    } catch (e) {
      progress(`Passphrase-derived secret-storage key failed: ${e.message}`);
    }
  }

  // Last resort: ask the user for their encoded recovery key.
  if (!recoveryKeyProvider) {
    progress('Recovery key required but no UI provider registered');
    return null;
  }
  const encoded = await recoveryKeyProvider();
  if (!encoded) return null;

  try {
    const privateKey = decodeRecoveryKey(encoded.trim());
    if (uid) {
      try { await storeSecret(uid, VAULT_SECRET_SSSS_KEY, bytesToB64(privateKey)); }
      catch { /* non-fatal */ }
    }
    return [keyId, privateKey];
  } catch (e) {
    progress(`Recovery key invalid: ${e.message}`);
    return null;
  }
}

async function discoverBaseUrl(rawHs, mxid) {
  const serverName = mxid && mxid.includes(':')
    ? mxid.split(':').slice(1).join(':')
    : new URL(rawHs).hostname;

  try {
    const config = await withTimeout(
      sdk.AutoDiscovery.findClientConfig(serverName),
      10000,
      'Homeserver discovery'
    );
    const action = config['m.homeserver'] && config['m.homeserver'].state;
    const discovered = config['m.homeserver'] && config['m.homeserver'].base_url;
    if (action === 'SUCCESS' && discovered) {
      progress(`Discovered homeserver: ${discovered}`);
      return discovered.replace(/\/+$/, '');
    }
  } catch (e) {
    progress(`Discovery skipped: ${e.message}`);
  }
  return rawHs.replace(/\/+$/, '');
}

// ── Secure backup (cross-signing + SSSS + key backup) ──

/**
 * Idempotent setup of cross-signing, secret storage, and key backup.
 *
 * Three scenarios converge into one call:
 *   - Fresh account: creates cross-signing keys, creates SSSS with a
 *     passphrase = the user's Matrix password, creates a new key backup
 *     version, stashes the encoded recovery key in the local vault.
 *   - Returning device, vault intact: a fast no-op; just makes sure
 *     this device is cross-signed and the backup engine is running.
 *   - Post-wipe re-login: SSSS exists on the server but the local
 *     crypto store is fresh. The password derives the SSSS key (via
 *     the server-stored PBKDF2 parameters); the SDK pulls cross-signing
 *     and backup secrets out of SSSS; we restore the Megolm key backup
 *     so historical messages decrypt; this device gets cross-signed.
 *
 * The password is held in module state for the duration of this call
 * because `getSecretStorageKey` may fire multiple times during bootstrap.
 *
 * Failures are non-fatal — the user can still send and read live messages.
 */
async function ensureSecureBackup(password, userId) {
  if (!client) return;
  const crypto = client.getCrypto?.();
  if (!crypto) return;

  _currentPassword = password;
  try {
    const ssssOnServer = await client.secretStorage.hasKey();

    progress(ssssOnServer ? 'Linking secure backup…' : 'Initializing secure backup…');

    // Bootstrap cross-signing. If keys already exist on the server, this
    // pulls them out of SSSS into the local store (via getSecretStorageKey).
    // If they don't, it creates and uploads them; UIA below replays the
    // Matrix password we already have.
    await crypto.bootstrapCrossSigning({
      authUploadDeviceSigningKeys: async (makeRequest) => {
        const user = userId.startsWith('@') ? userId.slice(1).split(':')[0] : userId;
        await makeRequest({
          type: 'm.login.password',
          identifier: { type: 'm.id.user', user },
          password,
          // Some homeservers require user/password at the top level too.
          user,
        });
      },
    });

    let generatedKey = null;
    await crypto.bootstrapSecretStorage({
      setupNewKeyBackup: !ssssOnServer,
      createSecretStorageKey: ssssOnServer ? undefined : async () => {
        generatedKey = await crypto.createRecoveryKeyFromPassphrase(password);
        return generatedKey;
      },
    });

    if (generatedKey?.encodedPrivateKey) {
      // Stash the key in the local vault so users can view it later from
      // a settings screen if they want a copy outside the browser. We
      // deliberately do NOT surface it on first login — the user's Matrix
      // password derives the same SSSS key on demand, so the recovery key
      // is a belt-and-suspenders backup, not a thing every user has to
      // memorise during onboarding.
      try {
        await storeSecret(userId, VAULT_SECRET_RECOVERY_KEY, generatedKey.encodedPrivateKey);
        if (generatedKey.privateKey) {
          await storeSecret(userId, VAULT_SECRET_SSSS_KEY, bytesToB64(generatedKey.privateKey));
        }
      } catch (e) {
        progress(`Could not stash recovery key locally: ${e.message}`);
      }
    }

    // Make sure the locally-stored SSSS key is up to date when the server
    // already had one (post-wipe path).
    if (ssssOnServer) {
      try {
        await crypto.loadSessionBackupPrivateKeyFromSecretStorage();
      } catch (e) {
        progress(`Loading session backup key: ${e.message}`);
      }
    }

    // Pull historical Megolm keys down from the server backup so old
    // encrypted rooms decrypt. Cheap if the backup is empty; potentially
    // long if the user has years of history. Don't fail login if it
    // stumbles partway through.
    const backupInfo = await crypto.getKeyBackupInfo();
    if (backupInfo) {
      try {
        await crypto.restoreKeyBackup();
        progress('Historical message keys restored');
      } catch (e) {
        progress(`Key backup restore: ${e.message}`);
      }
    }

    // Start the engine so future-received Megolm keys flow up to the
    // server backup automatically.
    try { await crypto.checkKeyBackupAndEnable(); } catch {}

    // Sign this device with the master cross-signing key so other devices
    // trust it. Idempotent if the device is already signed.
    try {
      const deviceId = client.getDeviceId();
      if (deviceId) await crypto.crossSignDevice(deviceId);
    } catch (e) {
      progress(`Cross-signing this device: ${e.message}`);
    }
  } catch (e) {
    progress(`Secure backup setup failed (continuing): ${e.message}`);
  } finally {
    _currentPassword = null;
  }
}

/** Read the local copy of the user's encoded recovery key, if any. */
export async function getStashedRecoveryKey(userId) {
  if (!userId) userId = vault.getUserId();
  if (!userId) return null;
  return loadSecret(userId, VAULT_SECRET_RECOVERY_KEY);
}

// ── Vault-encrypted session storage ──

async function persistSession(userId, session) {
  if (!vault.isUnlocked()) throw new Error('Vault locked — cannot persist session');
  const blob = await vault.encryptJSON(session);
  // localStorage can't store Uint8Array directly — base64 it.
  let s = '';
  for (let i = 0; i < blob.length; i++) s += String.fromCharCode(blob[i]);
  localStorage.setItem(sessionKey(userId), btoa(s));
}

async function loadSession(userId) {
  const raw = localStorage.getItem(sessionKey(userId));
  if (!raw) return null;
  if (!vault.isUnlocked()) throw new Error('Vault locked — cannot read session');
  const bin = atob(raw);
  const blob = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) blob[i] = bin.charCodeAt(i);
  return vault.decryptJSON(blob);
}

function dropSession(userId) {
  localStorage.removeItem(sessionKey(userId));
}

// ── Public API ──

export async function login(homeserver, username, password, { persist = false } = {}) {
  const user = username.replace(/^@/, '').split(':')[0];

  progress('Resolving homeserver…');
  const baseUrl = await discoverBaseUrl(homeserver, username);
  progress(`Using ${baseUrl}`);

  progress('Authenticating…');
  const tmp = sdk.createClient({ baseUrl });
  const resp = await withTimeout(
    tmp.login('m.login.password', {
      identifier: { type: 'm.id.user', user },
      password,
      initial_device_display_name: 'Matrix Events',
    }),
    30000,
    'Login request'
  );
  progress(`Authenticated as ${resp.user_id}`);

  // Bootstrap or unlock the vault using the Matrix password. The vault
  // key never leaves memory; the password is only used here for KDF.
  if (!vault.hasMeta(resp.user_id)) {
    progress('Initializing local vault…');
    await vault.initialize(resp.user_id, password, { persist });
  } else if (!vault.isUnlocked() || vault.getUserId() !== resp.user_id) {
    progress('Unlocking local vault…');
    const ok = await vault.unlock(resp.user_id, password, { persist });
    if (!ok) {
      // Password changed on the server; the old key can't decrypt this
      // user's local data anymore. Reset the vault so the new password
      // becomes the unlock. The OPFS room files and outbox entries are
      // left in place — they're dead bytes (unreadable without the old
      // key) but other users' files on this device stay intact.
      progress('Vault password mismatch — rotating to current password (prior local data is no longer readable)');
      vault.wipe(resp.user_id);
      wipeManifest(resp.user_id);
      await vault.initialize(resp.user_id, password, { persist });
    }
  }

  rememberLastUser(resp.user_id);

  // Persist session (encrypted) immediately so a reload mid-bootstrap
  // doesn't drop us back to the login form with a new device id.
  await persistSession(resp.user_id, {
    baseUrl,
    accessToken: resp.access_token,
    userId: resp.user_id,
    deviceId: resp.device_id,
  });

  client = sdk.createClient({
    baseUrl,
    accessToken: resp.access_token,
    userId: resp.user_id,
    deviceId: resp.device_id,
    cryptoCallbacks: { getSecretStorageKey },
    logger: QUIET_LOGGER,
  });

  await ensureCryptoStoreOwner(resp.user_id);
  progress('Initializing encryption…');
  await initCryptoWithRetry(client);

  progress('Starting sync…');
  await client.startClient(SYNC_OPTS);
  disableMatrixRTC(client);
  if (_watchSyncUnsub) _watchSyncUnsub();
  _watchSyncUnsub = watchSync(client);
  await waitForSync(client);
  progress('Sync ready');

  await ensureSecureBackup(password, resp.user_id);

  return { client, userId: resp.user_id, deviceId: resp.device_id };
}

/**
 * Restore a previously saved session. Vault must already be unlocked
 * for `userId`. Returns the client (online or offline-shimmed) or
 * null if there is no saved session for this user.
 *
 * If the network is reachable, this brings up sync. If not, the
 * client is left "offline" — startClient is still called but sync
 * will be in RECONNECTING. The local store + outbox keep functioning.
 */
export async function restoreSession(userId) {
  if (!vault.isUnlocked() || vault.getUserId() !== userId) {
    return null;
  }

  let session;
  try {
    session = await loadSession(userId);
  } catch (e) {
    console.warn('[matrix] could not load session:', e);
    return null;
  }
  if (!session) return null;

  const { baseUrl, accessToken, userId: sid, deviceId } = session;

  client = sdk.createClient({
    baseUrl,
    accessToken,
    userId: sid,
    deviceId,
    cryptoCallbacks: { getSecretStorageKey },
    logger: QUIET_LOGGER,
  });
  await ensureCryptoStoreOwner(sid);
  progress('Restoring session…');
  try {
    await initCryptoWithRetry(client);
  } catch (e) {
    progress(`Crypto init failed (continuing offline): ${e.message}`);
  }

  let sessionExpired = false;
  try {
    await client.startClient(SYNC_OPTS);
    disableMatrixRTC(client);
    if (_watchSyncUnsub) _watchSyncUnsub();
    _watchSyncUnsub = watchSync(client);
    // Best-effort wait for sync — short timeout so offline boots fast.
    try { await waitForSync(client, 12000); }
    catch (e) {
      if (/Session expired/i.test(e.message)) sessionExpired = true;
      progress(`Sync deferred (${e.message}); local data available`);
    }
  } catch (e) {
    progress(`Sync start failed (continuing offline): ${e.message}`);
  }

  if (sessionExpired) {
    // The homeserver rejected the saved access token. Drop the blob
    // (it's dead bytes) but leave the vault, manifest, and OPFS data
    // intact — caller can either mint a fresh token via mxLogin or
    // fall back to local-only mode if the network is unreachable.
    try { client.stopClient(); } catch {}
    if (_watchSyncUnsub) { _watchSyncUnsub(); _watchSyncUnsub = null; }
    client = null;
    dropSession(userId);
    progress('Saved session was rejected by the server — log in again to refresh credentials.');
    return null;
  }

  return client;
}

/**
 * Offline-capable unlock: derive the vault key from the password and
 * (if we have a saved session) bring up the client without requiring
 * network. Returns { userId, online } where online indicates whether
 * sync reached a ready state.
 */
export async function unlock(userId, password, { persist = false } = {}) {
  const ok = await vault.unlock(userId, password, { persist });
  if (!ok) throw new Error('Invalid password');
  rememberLastUser(userId);

  // No session blob → vault is unlocked but we have no Matrix token.
  // Caller must try a fresh online login (and may fall back to
  // local-only mode if the homeserver is unreachable).
  if (!localStorage.getItem(sessionKey(userId))) {
    return { userId, online: false, needsLogin: true };
  }

  const c = await restoreSession(userId);
  if (!c) {
    // restoreSession either failed or dropped a rejected token — vault
    // is still unlocked, so local data is accessible, but the caller
    // needs to refresh credentials to talk to the server again.
    return { userId, online: false, needsLogin: true };
  }
  const state = c.getSyncState && c.getSyncState();
  const online = state === 'PREPARED' || state === 'SYNCING';

  // We have the password in scope right now. If secret storage isn't
  // ready locally (post-wipe re-login on the same homeserver), this
  // derives the SSSS key from the password, pulls cross-signing and
  // backup secrets out of SSSS, and restores the Megolm key backup.
  if (online) {
    try { await ensureSecureBackup(password, userId); }
    catch (e) { progress(`Secure backup link skipped: ${e.message}`); }
  }

  return { userId, online, needsLogin: false };
}

/**
 * Cold-boot auto-restore. If a previous unlock in this tab stashed the
 * vault key in sessionStorage, adopt it back into the vault and bring
 * the Matrix client online. Returns null when there's nothing to
 * resume (no stash, no last user, or the stash is stale).
 *
 * sessionStorage is per-tab, so closing the tab/browser forgets the
 * key and the next launch requires the password again.
 */
export async function tryAutoUnlock() {
  const lastUser = getLastUser();
  if (!lastUser) return null;
  if (!vault.hasMeta(lastUser)) return null;

  const adopted = await vault.tryAdoptStashedKey(lastUser);
  if (!adopted) return null;

  progress('Resuming session…');

  let online = false;
  try {
    const c = await restoreSession(lastUser);
    if (c) {
      const state = c.getSyncState && c.getSyncState();
      online = state === 'PREPARED' || state === 'SYNCING';
    }
  } catch (e) {
    progress(`Auto-restore: ${e.message}`);
  }

  return { userId: lastUser, online };
}

/**
 * Lock the device: clear the in-memory key + stop the client, but
 * keep the encrypted session token, OPFS data, and outbox on disk.
 * The user can re-enter their password to resume.
 */
export async function lock() {
  if (_watchSyncUnsub) { _watchSyncUnsub(); _watchSyncUnsub = null; }
  if (client) {
    try { client.stopClient(); } catch {}
    client = null;
  }
  vault.lock();
}

/**
 * Sign out: revoke the access token on the server, drop the cached
 * session token, and lock the vault. Local data (OPFS rooms, media,
 * outbox, vault metadata, room manifest) is kept on disk so the same
 * user can sign back in later without losing their workspace, and so
 * a different user signing in on this device doesn't blow away the
 * previous user's encrypted-at-rest data.
 *
 * The crypto store is left alone; if a different user signs in next,
 * `initCryptoWithRetry` detects the mismatch and rebuilds from the
 * server's key backup.
 *
 * Call `wipeLocalData()` separately for a full device clean.
 */
export async function logout() {
  const uid = vault.getUserId();
  if (_watchSyncUnsub) { _watchSyncUnsub(); _watchSyncUnsub = null; }
  if (client) {
    try { client.stopClient(); } catch {}
    try { await client.logout(true); } catch {}
    client = null;
  }
  if (uid) dropSession(uid);
  vault.lock();
  // Keep `getLastUser()` so the login form can pre-fill the username.
  // The next sign-in will re-derive the vault key from the password.
}

/**
 * Destructive wipe: removes every byte of local state this app owns —
 * OPFS room files, media cache, outbox, every vault, every saved
 * session, room manifests, and the matrix-js-sdk crypto store. The
 * `getLastUser()` hint is forgotten too.
 *
 * Call this when the user explicitly asks to "clear local data" or
 * when the local vault has been irrecoverably corrupted.
 */
export async function wipeLocalData() {
  const uid = vault.getUserId();
  if (_watchSyncUnsub) { _watchSyncUnsub(); _watchSyncUnsub = null; }
  if (client) {
    try { client.stopClient(); } catch {}
    try { await client.logout(true); } catch {}
    client = null;
  }
  if (uid) {
    dropSession(uid);
    wipeManifest(uid);
    vault.wipe(uid);
  }
  try { await wipeAllRoomData(); } catch {}
  try { await wipeMediaCache(); } catch {}
  try { await clearOutbox(); } catch {}
  try { await clearCryptoStore(); } catch {}
  localStorage.removeItem(CRYPTO_OWNER_KEY);
  forgetLastUser();
}

/**
 * Does the local device have a vault for this user? If true, the
 * Matrix password can unlock local data even when the homeserver is
 * unreachable or the saved token has been revoked. The session blob
 * may or may not still be present; that's the bridge's problem to
 * sort out.
 */
export function hasLocalAccount(userId) {
  return vault.hasMeta(userId);
}

/** Does the user have a usable saved access token? */
export function hasSavedSession(userId) {
  return !!localStorage.getItem(sessionKey(userId));
}

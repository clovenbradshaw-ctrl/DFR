/**
 * network.js — Online/offline observation
 *
 * Combines navigator.onLine with the Matrix sync state to decide
 * whether the app is reachable. The browser's onLine flag is a hint;
 * a successful sync ping is ground truth.
 */

import { ClientEvent } from 'matrix-js-sdk';

const listeners = new Set();
let lastState = navigator.onLine ? 'online' : 'offline';
let lastSyncState = null;

function emit() {
  const state = computeState();
  if (state === lastState) return;
  lastState = state;
  for (const fn of listeners) {
    try { fn(state); } catch (e) { console.warn('[network] listener error:', e); }
  }
}

function computeState() {
  if (!navigator.onLine) return 'offline';
  if (lastSyncState === 'ERROR' || lastSyncState === 'STOPPED') return 'degraded';
  return 'online';
}

window.addEventListener('online', emit);
window.addEventListener('offline', emit);

export function getNetworkState() {
  return computeState();
}

export function onNetworkChange(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

/**
 * Attach to a matrix-js-sdk client to observe sync state.
 * Returns an unsubscribe.
 */
export function watchSync(client) {
  if (!client) return () => {};
  const handler = (state) => {
    lastSyncState = state;
    emit();
  };
  client.on(ClientEvent.Sync, handler);
  return () => client.removeListener(ClientEvent.Sync, handler);
}

export function getSyncState() {
  return lastSyncState;
}

/**
 * roomstate.js — the dataset pointer lives in Matrix *room state*, not the
 * timeline.
 *
 * A single state event (type `${NAMESPACE}.dataset`, empty state_key) holds the
 * authoritative pointer to the current dataset blob plus the one-time hydration
 * status. State events overwrite in place, so publishing a new snapshot updates
 * one key instead of appending an event — the room never fills with per-update
 * noise, and a freshly-synced client reads the pointer immediately without
 * folding any history.
 *
 * Content shape:
 *   {
 *     hydrated:   boolean,         // the one-time hydration completed
 *     format:     'gzip-ndjson',
 *     version:    number,          // bumps on every snapshot
 *     count:      number,          // flight count in the blob
 *     hash:       number,          // cheap change-detect
 *     blob:       __media ref|null,// in Matrix media (when small enough)
 *     source_url: string|null,     // external host (when too big / initial)
 *     updated_at: number,
 *     updated_by: mxid,
 *   }
 */

import { getClient } from '../src/client.js';
import { getNamespace } from '../src/operators.js';
import { RoomStateEvent } from 'matrix-js-sdk';

const TYPE = () => `${getNamespace()}.dataset`;

export function readDatasetState(roomId) {
  const client = getClient();
  if (!client) return null;
  const room = client.getRoom(roomId);
  if (!room) return null;
  const ev = room.currentState.getStateEvents(TYPE(), '');
  return ev ? ev.getContent() : null;
}

export async function writeDatasetState(roomId, content) {
  const client = getClient();
  if (!client) throw new Error('Not connected');
  await client.sendStateEvent(roomId, TYPE(), content, '');
}

export function isHydrated(roomId) {
  return !!readDatasetState(roomId)?.hydrated;
}

/** Fire `cb` when this room's dataset pointer changes (e.g. a peer published). */
export function onDatasetState(roomId, cb) {
  const client = getClient();
  if (!client) return () => {};
  const type = TYPE();
  const listener = (event, state) => {
    if (state.roomId === roomId && event.getType() === type) cb(event.getContent());
  };
  client.on(RoomStateEvent.Events, listener);
  return () => client.removeListener(RoomStateEvent.Events, listener);
}

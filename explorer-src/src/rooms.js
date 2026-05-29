/**
 * rooms.js — Room management
 *
 * Rooms are tables. Room membership is access control.
 *
 * Rooms created by this module get:
 *   - A state event marking them as app rooms (for discovery)
 *   - Private visibility (invite-only)
 */

import { getClient } from './client.js';
import { getNamespace } from './operators.js';
import { ClientEvent, MatrixEventEvent, RoomEvent, RoomStateEvent, EventStatus } from 'matrix-js-sdk';

const META_TYPE = () => `${getNamespace()}.meta`;

/**
 * Create a new room for this app.
 *
 * @param {string} name     - Human-readable room name
 * @param {string} roomType - App-level type (e.g. "project", "journal", "board")
 * @param {object} [meta]   - Additional metadata stored in the room state event
 * @returns {string} The room ID
 */
export async function createRoom(name, roomType, meta = {}) {
  const client = getClient();
  if (!client) throw new Error('Not connected');

  const resp = await client.createRoom({
    name,
    visibility: 'private',
    preset: 'private_chat',
    initial_state: [
      {
        type: META_TYPE(),
        state_key: '',
        content: {
          app: getNamespace(),
          room_type: roomType,
          created_at: new Date().toISOString(),
          ...meta,
        },
      },
    ],
  });

  return resp.room_id;
}

/**
 * Discover all rooms belonging to this app.
 * Only rooms carrying the app's meta state event (set at createRoom time)
 * are returned. Untagged rooms — DMs, rooms from other apps, rooms whose
 * state hasn't fully synced — are filtered out.
 *
 * Pending invites are included only when their stripped state advertises
 * the app's meta event. Homeservers that don't forward custom state on
 * invites will hide such invites until they're joined elsewhere; this is
 * the cost of strict app-scoping.
 *
 * @param {string} [roomType] - Optional filter by room type
 * @returns {Array<{ roomId, name, roomType, membership, meta, inviter }>}
 */
export function discoverRooms(roomType = null) {
  const client = getClient();
  if (!client) return [];

  const ns = getNamespace();
  const metaType = META_TYPE();
  const rooms = client.getRooms();
  const appRooms = [];

  for (const room of rooms) {
    const membership = room.getMyMembership();
    if (membership !== 'join' && membership !== 'invite') continue;

    const metaEvent = room.currentState.getStateEvents(metaType, '');
    if (!metaEvent) continue;

    const content = metaEvent.getContent();
    if (content.app !== ns) continue;
    if (roomType && content.room_type !== roomType) continue;

    let inviter = null;
    if (membership === 'invite') {
      const myUserId = client.getUserId();
      const myMember = room.getMember(myUserId);
      inviter = myMember?.events?.member?.getSender() || null;
    }

    appRooms.push({
      roomId: room.roomId,
      name: room.name,
      roomType: content.room_type,
      membership,
      inviter,
      meta: content,
    });
  }

  return appRooms;
}

/**
 * Accept a pending invite. After this resolves the room moves to `join`
 * membership and the full timeline becomes available.
 *
 * @param {string} roomId
 */
export async function acceptInvite(roomId) {
  const client = getClient();
  if (!client) throw new Error('Not connected');
  await client.joinRoom(roomId);
}

/**
 * Subscribe to events that change which rooms should appear in the list:
 * a new room arriving via sync (e.g. a fresh invite), our own membership
 * flipping (invite → join, leave, etc.), or a room's state events updating
 * (so the meta event appearing after join triggers a refresh).
 *
 * @param {function} handler - Called with no arguments on any change
 * @returns {function} Unsubscribe
 */
export function onRoomChanges(handler) {
  const client = getClient();
  if (!client) throw new Error('Not connected');

  const onRoom = () => handler();
  const onMembership = () => handler();
  // Also listen for state events so that when the meta event arrives
  // after a join, the room list refreshes with the correct type.
  const onState = () => handler();
  client.on(ClientEvent.Room, onRoom);
  client.on(RoomEvent.MyMembership, onMembership);
  client.on(RoomStateEvent.Events, onState);
  return () => {
    client.removeListener(ClientEvent.Room, onRoom);
    client.removeListener(RoomEvent.MyMembership, onMembership);
    client.removeListener(RoomStateEvent.Events, onState);
  };
}

/**
 * Get all timeline events from a room, in chronological order.
 * These are the events that feed the fold.
 *
 * NOTE: After initial sync, the timeline may be incomplete (only the
 * last N events). Call loadFullTimeline() first if the fold needs
 * the complete history.
 *
 * @param {string} roomId
 * @returns {Array} MatrixEvent objects
 */
export function getTimeline(roomId) {
  const client = getClient();
  if (!client) return [];

  const room = client.getRoom(roomId);
  if (!room) return [];

  const timeline = room.getLiveTimeline();
  return timeline.getEvents();
}

/**
 * Paginate backwards until the entire room history is loaded.
 * Call this before folding if you need the complete event stream.
 * The SDK decrypts each page as it arrives.
 *
 * @param {string} roomId
 * @returns {number} Total events loaded
 */
export async function loadFullTimeline(roomId) {
  const client = getClient();
  if (!client) return 0;

  const room = client.getRoom(roomId);
  if (!room) return 0;

  const timeline = room.getLiveTimeline();
  let hasMore = true;
  while (hasMore) {
    hasMore = await client.paginateEventTimeline(timeline, { backwards: true, limit: 100 });
  }
  return timeline.getEvents().length;
}

/**
 * Listen for new timeline events in a room.
 * Calls the handler whenever new events arrive via sync.
 *
 * @param {string} roomId
 * @param {function} handler - Called with (event, room)
 * @returns {function} Unsubscribe function
 */
export function onTimeline(roomId, handler) {
  const client = getClient();
  if (!client) throw new Error('Not connected');

  const listener = (event, room) => {
    if (room?.roomId === roomId) {
      handler(event, room);
    }
  };

  client.on(RoomEvent.Timeline, listener);
  return () => client.removeListener(RoomEvent.Timeline, listener);
}

/**
 * Listen for events that were initially undecryptable (no Megolm session
 * yet) becoming decrypted later, once keys arrive over `to_device`. Without
 * this, the fold misses any event still encrypted at the moment the
 * timeline loaded — it skips `m.room.encrypted` because that type isn't
 * one of the app's operators.
 *
 * @param {string} roomId
 * @param {function} handler - Called with (event) when a decrypt completes
 * @returns {function} Unsubscribe
 */
export function onDecrypted(roomId, handler) {
  const client = getClient();
  if (!client) throw new Error('Not connected');

  const listener = (event) => {
    if (event.getRoomId() === roomId) {
      handler(event);
    }
  };

  client.on(MatrixEventEvent.Decrypted, listener);
  return () => client.removeListener(MatrixEventEvent.Decrypted, listener);
}

/**
 * Listen for local-echo lifecycle changes on the given room: a sent
 * event transitioning from SENDING → SENT, the SDK updating its
 * placeholder event_id to the real server id, or a failure flipping
 * to NOT_SENT. Handler receives (event, oldEventId, oldStatus).
 *
 * @param {string} roomId
 * @param {function} handler
 * @returns {function} Unsubscribe
 */
export function onLocalEchoUpdated(roomId, handler) {
  const client = getClient();
  if (!client) throw new Error('Not connected');
  const room = client.getRoom(roomId);
  if (!room) return () => {};
  const listener = (event, _room, oldEventId, oldStatus) => {
    handler(event, oldEventId, oldStatus);
  };
  room.on(RoomEvent.LocalEchoUpdated, listener);
  return () => room.removeListener(RoomEvent.LocalEchoUpdated, listener);
}

export { EventStatus };

/**
 * Load timeline events newer than `sinceTs` and return them.
 * Used for delta sync: the OPFS store already has everything up to
 * `sinceTs`, so we only need the tail.
 *
 * Critically, this paginates backwards *only as far as the cursor* rather
 * than walking the entire room history. matrix-js-sdk keeps every event it
 * paginates in the room's in-memory live timeline for the life of the
 * session, so paging the full history of a large room (this app stores one
 * event per record/cell edit) pulls hundreds of MB — often gigabytes — of
 * decrypted MatrixEvent objects into RAM and never releases them. The
 * persisted store is the source of truth for history; the SDK only needs to
 * surface what arrived since we last looked.
 *
 * @param {string} roomId
 * @param {number} sinceTs - Timestamp (ms) of last stored event
 * @returns {{ total: number, newEvents: Array }} Loaded timeline size + new events only
 */
export async function loadTimelineSince(roomId, sinceTs) {
  const client = getClient();
  if (!client) return { total: 0, newEvents: [] };
  const room = client.getRoom(roomId);
  if (!room) return { total: 0, newEvents: [] };

  const timeline = room.getLiveTimeline();

  // First load (empty store): we genuinely need the whole history to seed
  // the store. This is a one-time cost; subsequent opens take the cheap
  // delta path below.
  if (sinceTs <= 0) {
    let hasMore = true;
    while (hasMore) {
      hasMore = await client.paginateEventTimeline(timeline, { backwards: true, limit: 100 });
    }
    const all = timeline.getEvents();
    return { total: all.length, newEvents: all };
  }

  // Delta load: page backwards until the oldest loaded event predates the
  // cursor, then stop — everything older is already persisted. In the
  // common case the events already present from sync are all older than the
  // cursor, so we paginate nothing at all.
  const olderThanCursor = (ev) => {
    const ts = typeof ev?.getTs === 'function' ? ev.getTs() : ev?.origin_server_ts || 0;
    return ts < sinceTs;
  };

  let hasMore = true;
  while (hasMore) {
    const oldest = timeline.getEvents()[0];
    if (oldest && olderThanCursor(oldest)) break;
    hasMore = await client.paginateEventTimeline(timeline, { backwards: true, limit: 100 });
  }

  const all = timeline.getEvents();
  const newEvents = all.filter(e => {
    const ts = typeof e.getTs === 'function' ? e.getTs() : e.origin_server_ts || 0;
    return ts >= sinceTs;
  });

  return { total: all.length, newEvents };
}

/**
 * Paginate backwards to load more history.
 * The SDK fetches, decrypts, and appends to the timeline automatically.
 *
 * @param {string} roomId
 * @param {number} [limit=50]
 * @returns {boolean} True if more history is available
 */
export async function loadMore(roomId, limit = 50) {
  const client = getClient();
  if (!client) return false;

  const room = client.getRoom(roomId);
  if (!room) return false;

  const timeline = room.getLiveTimeline();
  return client.paginateEventTimeline(timeline, { backwards: true, limit });
}

/**
 * Invite a user to a room.
 *
 * @param {string} roomId
 * @param {string} userId - Full MXID, e.g. "@kevin:app.aminoimmigration.com"
 */
export async function invite(roomId, userId) {
  const client = getClient();
  if (!client) throw new Error('Not connected');
  await client.invite(roomId, userId);
}

/**
 * Ensure a room's full member list is loaded. With lazy-loaded members
 * (see SYNC_OPTS in client.js) the SDK only knows a room's "essential"
 * members until this is called, which keeps idle memory low. Call it before
 * showing a member list. Resolves once members are present; no-op if already
 * loaded or offline.
 *
 * @param {string} roomId
 */
export async function loadRoomMembers(roomId) {
  const client = getClient();
  if (!client) return;
  const room = client.getRoom(roomId);
  if (!room) return;
  try { await room.loadMembersIfNeeded(); }
  catch (e) { console.warn('[rooms] loadMembersIfNeeded failed:', e?.message || e); }
}

/**
 * Get current room members (joined + invited) with their power levels.
 * With lazy-loaded members this returns only the members the SDK has so far;
 * call loadRoomMembers(roomId) first for the complete list.
 *
 * @param {string} roomId
 * @returns {Array<{ userId, displayName, membership, powerLevel }>}
 */
export function getMembers(roomId) {
  const client = getClient();
  if (!client) return [];

  const room = client.getRoom(roomId);
  if (!room) return [];

  const plEvent = room.currentState.getStateEvents('m.room.power_levels', '');
  const plContent = plEvent?.getContent() || {};
  const usersPL = plContent.users || {};
  const defaultPL = typeof plContent.users_default === 'number' ? plContent.users_default : 0;

  const members = room.getMembers().filter(m =>
    m.membership === 'join' || m.membership === 'invite'
  );

  return members.map(m => ({
    userId: m.userId,
    displayName: m.name || m.userId,
    membership: m.membership,
    powerLevel: typeof usersPL[m.userId] === 'number' ? usersPL[m.userId] : defaultPL,
  }));
}

/**
 * Get the current user's power level in a room.
 *
 * @param {string} roomId
 * @returns {number}
 */
export function myPowerLevel(roomId) {
  const client = getClient();
  if (!client) return 0;
  const room = client.getRoom(roomId);
  if (!room) return 0;
  const me = client.getUserId();
  const plEvent = room.currentState.getStateEvents('m.room.power_levels', '');
  const c = plEvent?.getContent() || {};
  const u = c.users || {};
  const def = typeof c.users_default === 'number' ? c.users_default : 0;
  return typeof u[me] === 'number' ? u[me] : def;
}

/**
 * Kick a user out of the room.
 *
 * @param {string} roomId
 * @param {string} userId
 * @param {string} [reason]
 */
export async function kickMember(roomId, userId, reason) {
  const client = getClient();
  if (!client) throw new Error('Not connected');
  await client.kick(roomId, userId, reason);
}

/**
 * Set a user's power level in the room. Pass `null` or `undefined` to
 * reset them to the room's default (effectively "demote to default").
 *
 * @param {string} roomId
 * @param {string} userId
 * @param {number} level
 */
export async function setMemberPowerLevel(roomId, userId, level) {
  const client = getClient();
  if (!client) throw new Error('Not connected');
  const room = client.getRoom(roomId);
  if (!room) throw new Error('Room not found: ' + roomId);
  const plEvent = room.currentState.getStateEvents('m.room.power_levels', '');
  if (!plEvent) throw new Error('No power_levels state event');
  await client.setPowerLevel(roomId, userId, level, plEvent);
}

/**
 * Set the human-readable name of a room (m.room.name state event).
 * Other clients will see the new name on their next sync.
 */
export async function setName(roomId, name) {
  const client = getClient();
  if (!client) throw new Error('Not connected');
  await client.setRoomName(roomId, name);
}

/**
 * Resolve a user's display name from the SDK's profile cache. Returns
 * null when no profile is known yet — the caller should fall back to
 * something readable (e.g. the local part of the MXID).
 */
export function getDisplayName(userId) {
  const client = getClient();
  if (!client || !userId) return null;
  const user = client.getUser(userId);
  return user?.displayName || user?.rawDisplayName || null;
}

/**
 * Subscribe to membership / power-level changes in a room. The handler
 * is called (with no arguments) whenever m.room.member or
 * m.room.power_levels state events arrive for the given room.
 *
 * @param {string} roomId
 * @param {function} handler
 * @returns {function} Unsubscribe
 */
export function onMembersChange(roomId, handler) {
  const client = getClient();
  if (!client) throw new Error('Not connected');
  const listener = (event, state) => {
    if (state.roomId !== roomId) return;
    const type = event.getType();
    if (type === 'm.room.member' || type === 'm.room.power_levels') handler();
  };
  client.on(RoomStateEvent.Events, listener);
  return () => client.removeListener(RoomStateEvent.Events, listener);
}

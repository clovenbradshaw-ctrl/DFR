/**
 * space.js — create a well-configured DFR "space" (room) with a shareable,
 * UUID-addressed deep-link URL, and resolve such a link back to a room.
 *
 * A space is a normal app dataset room, but created with:
 *   • a UUID-based canonical alias  (#dfr_<uuid>:<homeserver>) so it has a
 *     stable, shareable handle independent of the opaque room_id,
 *   • the app meta + schema-as-log written at creation,
 *   • sharded/additive publishing as the default (the caller uses DataStore).
 *
 * The deep link is:  <origin><path>#/s/<uuid>:<server>
 * Opening that URL makes the app join (if needed) and open the space.
 */

import { getClient } from '../src/client.js';
import { createRoom } from '../src/rooms.js';
import { defSchema } from '../src/operators.js';
import { ROOM_TYPE, SCHEMA } from './dfr.js';

function uuid() {
  return (crypto.randomUUID ? crypto.randomUUID() : 'x'.repeat(8) + Date.now().toString(16))
    .replace(/-/g, '').slice(0, 24);
}

/** Local part of the alias for a given uuid (no leading # / server). */
function aliasLocal(id) { return `dfr_${id}`; }

/** Server name from the signed-in MXID (e.g. "hyphae.social"). */
function homeserverName() {
  const c = getClient();
  const uid = c && c.getUserId();
  return uid && uid.includes(':') ? uid.split(':').slice(1).join(':') : null;
}

/**
 * Create a new space. Returns { roomId, alias, uuid, url }.
 * `name` is the human label; the alias/url are UUID-based and shareable.
 */
export async function createSpace(name) {
  const client = getClient();
  if (!client) throw new Error('Not connected');
  const server = homeserverName();
  const id = uuid();
  const local = aliasLocal(id);

  // Create the room with the UUID alias + app meta in one shot.
  const resp = await client.createRoom({
    name: name || 'DFR dataset',
    visibility: 'private',
    preset: 'private_chat',
    room_alias_name: local,                 // → #dfr_<id>:<server>
    initial_state: [{
      type: 'org.dfr.explorer.meta',
      state_key: '',
      content: { app: 'org.dfr.explorer', room_type: ROOM_TYPE, space_uuid: id, created_at: new Date().toISOString() },
    }],
  });
  const roomId = resp.room_id;
  const alias = server ? `#${local}:${server}` : null;

  // Schema-as-log so a fresh client can render the space without prior knowledge.
  try {
    await defSchema(roomId, 'version', SCHEMA?.version ?? 1);
    await defSchema(roomId, 'space_uuid', id);
  } catch { /* non-fatal */ }

  return { roomId, alias, uuid: id, url: spaceUrl(id, server) };
}

/** Build the shareable deep-link URL for a space uuid. */
export function spaceUrl(id, server) {
  server = server || homeserverName() || '';
  const base = location.origin + location.pathname.replace(/index\.html$/, '');
  return `${base}#/s/${id}${server ? ':' + server : ''}`;
}

/** Parse the current URL hash → { uuid, server } or null. */
export function parseSpaceFromUrl() {
  const m = /#\/s\/([a-z0-9]+)(?::(.+))?$/i.exec(location.hash || '');
  if (!m) return null;
  return { uuid: m[1], server: m[2] || homeserverName() };
}

/**
 * Resolve a space link to a room id, joining if necessary.
 * Returns the room_id, or null if it can't be resolved/joined.
 */
export async function openSpaceFromLink({ uuid: id, server }) {
  const client = getClient();
  if (!client) return null;
  const srv = server || homeserverName();
  const alias = `#${aliasLocal(id)}:${srv}`;
  // Already joined? find by alias among known rooms first (cheap, offline-ok).
  for (const room of client.getRooms()) {
    if (room.getCanonicalAlias() === alias || (room.getAltAliases?.() || []).includes(alias)) return room.roomId;
  }
  // Resolve the alias → room_id, then join.
  try {
    const res = await client.getRoomIdForAlias(alias);
    const roomId = res && res.room_id;
    if (!roomId) return null;
    const room = client.getRoom(roomId);
    if (!room || room.getMyMembership() !== 'join') {
      try { await client.joinRoom(alias); } catch (e) { /* maybe invite-only */ }
    }
    return roomId;
  } catch {
    return null;   // alias not found (wrong server / not shared with us)
  }
}

/** Set the location hash to a space's deep link (no reload). */
export function setUrlToSpace(id, server) {
  const want = `#/s/${id}${(server || homeserverName()) ? ':' + (server || homeserverName()) : ''}`;
  if (location.hash !== want) history.replaceState(null, '', want);
}

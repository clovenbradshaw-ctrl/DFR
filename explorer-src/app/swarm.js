/**
 * swarm.js — cooperative live-fetching across devices in the same room.
 *
 * Every device "raises a hand" by writing a per-device room-state event
 * (`${NS}.focus` with state_key = its own device id) advertising the area it's
 * currently focused on and when it last fetched there. Because state events are
 * keyed by device, each device has exactly one hand up at a time and everyone
 * sees everyone else's — no timeline spam, and a fresh client reads the current
 * picture immediately.
 *
 * The coordination rule is deliberately simple and decentralised (no leader):
 * before a device live-fetches an area, it checks whether a *peer* already
 * covers that area and fetched it recently. If so, it yields (that peer's
 * results reach everyone via the published snapshot). Devices therefore spread
 * out to cover more ground per unit time — a swarm — instead of redundantly
 * pulling the same bbox.
 */

import { getClient } from '../src/client.js';
import { getNamespace } from '../src/operators.js';
import { RoomStateEvent } from 'matrix-js-sdk';

const TYPE = () => `${getNamespace()}.focus`;
const FRESH_MS = 90 * 1000;     // a peer's fetch "covers" an area for this long
const HAND_TTL_MS = 5 * 60_000; // ignore hands older than this (device went away)

/** Do two [w,s,e,n] bboxes overlap enough that one covers the other's centre? */
function covers(peerBbox, bbox) {
  if (!peerBbox || peerBbox.length < 4) return false;
  const cx = (bbox[0] + bbox[2]) / 2, cy = (bbox[1] + bbox[3]) / 2;
  // pad the peer's box slightly so near-identical viewports count as covered
  const padX = (peerBbox[2] - peerBbox[0]) * 0.15, padY = (peerBbox[3] - peerBbox[1]) * 0.15;
  return cx >= peerBbox[0] - padX && cx <= peerBbox[2] + padX &&
         cy >= peerBbox[1] - padY && cy <= peerBbox[3] + padY;
}

export class Swarm {
  /**
   * @param {object} deps
   * @param {()=>string} deps.getRoomId
   * @param {(msg,level)=>void} [deps.log]
   * @param {()=>void} [deps.onPeersChange]  re-render peer hands
   */
  constructor({ getRoomId, log, onPeersChange }) {
    this.getRoomId = getRoomId;
    this.log = log || (() => {});
    this.onPeersChange = onPeersChange || (() => {});
    this._unsub = null;
    this._lastHand = 0;
  }

  start() {
    const client = getClient();
    if (!client || this._unsub) return;
    const type = TYPE();
    const listener = (event, state) => {
      if (state.roomId === this.getRoomId() && event.getType() === type) this.onPeersChange();
    };
    client.on(RoomStateEvent.Events, listener);
    this._unsub = () => client.removeListener(RoomStateEvent.Events, listener);
  }

  stop() { if (this._unsub) { this._unsub(); this._unsub = null; } }

  _deviceId() { const c = getClient(); return c ? (c.getDeviceId() || c.getUserId()) : 'anon'; }

  /** All peer hands except our own, fresh ones only: [{device, user, bbox, ts, label}]. */
  peers() {
    const client = getClient();
    const roomId = this.getRoomId();
    if (!client || !roomId) return [];
    const room = client.getRoom(roomId);
    if (!room) return [];
    const me = this._deviceId();
    const now = Date.now();
    const events = room.currentState.getStateEvents(TYPE()) || [];
    const out = [];
    for (const ev of events) {
      const key = ev.getStateKey();
      if (key === me) continue;
      const c = ev.getContent() || {};
      if (!c.bbox || !c.ts || now - c.ts > HAND_TTL_MS) continue;
      out.push({ device: key, user: ev.getSender(), bbox: c.bbox, ts: c.ts, label: c.label || '' });
    }
    return out;
  }

  /**
   * Raise/replace this device's hand to advertise the area it's looking at.
   * Throttled so panning doesn't spam state events.
   */
  async raiseHand(bbox, { label = '', fetchedTs = null } = {}) {
    const client = getClient();
    const roomId = this.getRoomId();
    if (!client || !roomId || !bbox) return;
    const now = Date.now();
    if (now - this._lastHand < 4000) return;     // throttle
    this._lastHand = now;
    try {
      await client.sendStateEvent(roomId, TYPE(), {
        bbox, label, ts: now, fetched_ts: fetchedTs || now,
        device: this._deviceId(),
      }, this._deviceId());
    } catch (e) { this.log(`Swarm hand failed: ${e.message}`, 'mut'); }
  }

  /**
   * Should *this* device fetch `bbox` now, or is a peer already covering it
   * recently? Returns { fetch:boolean, by?:peer }. Decentralised tie-break:
   * if multiple cover it, the lexicographically smallest device id "wins" the
   * area, so exactly one keeps it warm.
   */
  shouldFetch(bbox) {
    const now = Date.now();
    const me = this._deviceId();
    const coverers = this.peers().filter(p => covers(p.bbox, bbox) && now - (p.ts) < FRESH_MS);
    if (!coverers.length) return { fetch: true };
    // A peer covers it; yield unless we're the designated owner (smallest id).
    const owner = [me, ...coverers.map(p => p.device)].sort()[0];
    if (owner === me) return { fetch: true };
    return { fetch: false, by: coverers[0] };
  }

  /** Drop this device's hand (on room switch / stop). */
  async lowerHand() {
    const client = getClient();
    const roomId = this.getRoomId();
    if (!client || !roomId) return;
    try { await client.sendStateEvent(roomId, TYPE(), {}, this._deviceId()); } catch {}
  }
}

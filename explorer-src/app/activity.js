/**
 * activity.js — a structured record of what the app is doing.
 *
 * Replaces the free-text log with typed events so a dedicated view can show
 * sync activity, API checks for new flights/departments, what was added to the
 * dataset, and when a new media block is created. A small ring buffer keeps it
 * lean; subscribers re-render on change.
 *
 * Event kinds:
 *   sync     — reassembling/indexing/syncing the dataset from blocks
 *   api      — checking the live feed for new flights / departments
 *   add      — records added to the dataset (flights, agencies)
 *   block    — a media block (or manifest/snapshot) created or fetched
 *   swarm    — peer-coordination notes
 *   info/err — everything else
 */

const MAX = 300;

export const Activity = {
  events: [],            // newest last
  _subs: new Set(),
  _seq: 0,

  /** Record a structured event. `data` is small, render-ready metadata. */
  push(kind, message, data = {}) {
    const ev = { id: ++this._seq, kind, message, data, ts: Date.now() };
    this.events.push(ev);
    if (this.events.length > MAX) this.events.splice(0, this.events.length - MAX);
    for (const fn of this._subs) { try { fn(ev); } catch {} }
    return ev;
  },

  subscribe(fn) { this._subs.add(fn); return () => this._subs.delete(fn); },

  clear() { this.events = []; for (const fn of this._subs) { try { fn(null); } catch {} } },

  /** Rolling counts by kind, for a compact header. */
  counts() {
    const c = { sync: 0, api: 0, add: 0, block: 0, swarm: 0, err: 0 };
    for (const e of this.events) if (c[e.kind] != null) c[e.kind]++;
    return c;
  },
};

// Convenience emitters (keep call sites terse).
export const act = {
  sync:  (m, d) => Activity.push('sync', m, d),
  api:   (m, d) => Activity.push('api', m, d),
  add:   (m, d) => Activity.push('add', m, d),
  block: (m, d) => Activity.push('block', m, d),
  swarm: (m, d) => Activity.push('swarm', m, d),
  info:  (m, d) => Activity.push('info', m, d),
  err:   (m, d) => Activity.push('err', m, d),
};

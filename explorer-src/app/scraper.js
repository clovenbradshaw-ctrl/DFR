/**
 * scraper.js — the background updater that runs on the user's computer.
 *
 * Browser port of dfr_scraper.py. Polls Skydio's ArcGIS FeatureServer on an
 * interval, diffs against flights already in the working set, and appends new
 * ones to the DataStore.
 *
 * It does NOT write to Matrix per flight. New flights land in OPFS instantly;
 * a Matrix snapshot (one media blob + one room-state pointer update) is
 * published only when enough has changed (DataStore.maybePublish) — so the
 * room is never spammed. Closing/reopening the tab loses nothing: the working
 * set is in OPFS and the pointer is in room state.
 */

import { feedQueryUrl, proxied } from './dfr.js';

const SETTINGS_KEY = 'dfr.scraper.settings';
const loadSettings = () => { try { return JSON.parse(localStorage.getItem(SETTINGS_KEY)) || {}; } catch { return {}; } };
const saveSettings = (s) => { try { localStorage.setItem(SETTINGS_KEY, JSON.stringify(s)); } catch {} };

export class Scraper {
  /**
   * @param {object} deps
   * @param {import('./datastore.js').DataStore} deps.store
   * @param {(msg,level)=>void} deps.log
   */
  constructor({ store, log }) {
    this.store = store;
    this.log = log || (() => {});
    const s = loadSettings();
    this.intervalMin = s.intervalMin || 15;
    this.proxy = s.proxy || '';
    this.lastRun = s.lastRun || null;
    this.timer = null;
    this.running = false;
    this.busy = false;
    this.onChange = null;
  }

  get state() {
    return { running: this.running, busy: this.busy, intervalMin: this.intervalMin, proxy: this.proxy, lastRun: this.lastRun };
  }
  _emit() { if (this.onChange) this.onChange(this.state); }

  configure({ intervalMin, proxy } = {}) {
    if (intervalMin != null) this.intervalMin = Math.max(1, +intervalMin || 15);
    if (proxy != null) this.proxy = proxy.trim();
    saveSettings({ intervalMin: this.intervalMin, proxy: this.proxy, lastRun: this.lastRun });
    if (this.running) { this.stop(); this.start(); }
    this._emit();
  }

  start() {
    if (this.running) return;
    this.running = true;
    this.log(`Scraper started — polling every ${this.intervalMin} min.`, 'ok');
    this._emit();
    this.pollOnce();
    this.timer = setInterval(() => this.pollOnce(), this.intervalMin * 60 * 1000);
  }

  stop() {
    this.running = false;
    if (this.timer) { clearInterval(this.timer); this.timer = null; }
    this.log('Scraper stopped.', 'mut');
    this._emit();
  }

  async pollOnce() {
    if (this.busy) return;
    if (!this.store?.roomId) { this.log('No active dataset — open or create one first.', 'warn'); return; }
    this.busy = true; this._emit();
    try {
      this.log('Fetching live feed…', 'mut');
      const resp = await fetch(proxied(feedQueryUrl(), this.proxy), { headers: { Accept: 'application/json' } });
      if (!resp.ok) throw new Error(`feed HTTP ${resp.status}`);
      const geojson = await resp.json();
      const features = (geojson && geojson.features) || [];

      const known = this.store.knownIds();
      const fresh = features.filter(f => {
        const p = f.properties || {};
        const id = p.flight_id || (p.ObjectId != null ? 'oid_' + p.ObjectId : null);
        return id && !known.has(id);
      });

      if (fresh.length) {
        const { added } = await this.store.addFlights(fresh);
        this.log(`Appended ${added} new flight(s) locally.`, 'ok');
        const r = await this.store.maybePublish();
        if (r.published) this.log(`Snapshot published (v${r.version}).`, 'ok');
        else this.log(`Holding ${this.store.dirty} unpublished — will snapshot when it's worth it.`, 'mut');
      } else {
        this.log(`No new flights (${features.length} in feed).`, 'mut');
      }

      this.lastRun = Date.now();
      saveSettings({ intervalMin: this.intervalMin, proxy: this.proxy, lastRun: this.lastRun });
    } catch (e) {
      this.log(`Poll failed: ${e.message}. ${this.proxy ? '' : 'A CORS proxy may be required.'}`, 'err');
    } finally {
      this.busy = false; this._emit();
    }
  }
}

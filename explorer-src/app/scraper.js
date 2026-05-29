/**
 * scraper.js — the background poller that runs on the user's computer.
 *
 * This is the browser-native equivalent of dfr_scraper.py: it polls Skydio's
 * ArcGIS FeatureServer on an interval, diffs the result against flights already
 * in the fold (by flight_id), and records each genuinely new flight into the
 * Matrix room (geometry → media block, metadata → in-room events).
 *
 * "In background" = a timer alive for the life of the tab. There is no server.
 * Because the dataset *is* the room timeline, progress survives reloads: on the
 * next launch the fold rehydrates what was already recorded and the diff
 * resumes from there. No external state, no API keys.
 */

import { recordFlight, recordSnapshot } from './recorder.js';
import { feedQueryUrl, proxied } from './dfr.js';

const SETTINGS_KEY = 'dfr.scraper.settings';

function loadSettings() {
  try { return JSON.parse(localStorage.getItem(SETTINGS_KEY)) || {}; }
  catch { return {}; }
}
function saveSettings(s) {
  try { localStorage.setItem(SETTINGS_KEY, JSON.stringify(s)); } catch {}
}

export class Scraper {
  /**
   * @param {object} deps
   * @param {() => string} deps.getRoomId      currently active dataset room
   * @param {() => Set<string>} deps.getKnown  known flight keys from fold state
   * @param {(msg, level) => void} deps.log
   */
  constructor({ getRoomId, getKnown, log }) {
    this.getRoomId = getRoomId;
    this.getKnown = getKnown;
    this.log = log || (() => {});
    const s = loadSettings();
    this.intervalMin = s.intervalMin || 15;
    this.proxy = s.proxy || '';
    this.timer = null;
    this.running = false;
    this.busy = false;
    this.lastRun = s.lastRun || null;
    this.onChange = null; // UI hook
  }

  get state() {
    return {
      running: this.running,
      intervalMin: this.intervalMin,
      proxy: this.proxy,
      lastRun: this.lastRun,
      busy: this.busy,
    };
  }

  _emitChange() { if (this.onChange) this.onChange(this.state); }

  configure({ intervalMin, proxy } = {}) {
    if (intervalMin != null) this.intervalMin = Math.max(1, +intervalMin || 15);
    if (proxy != null) this.proxy = proxy.trim();
    saveSettings({ intervalMin: this.intervalMin, proxy: this.proxy, lastRun: this.lastRun });
    if (this.running) { this.stop(); this.start(); }
    this._emitChange();
  }

  start() {
    if (this.running) return;
    this.running = true;
    this.log(`Scraper started — polling every ${this.intervalMin} min.`, 'ok');
    this._emitChange();
    // Kick once immediately, then on the interval.
    this.pollOnce();
    this.timer = setInterval(() => this.pollOnce(), this.intervalMin * 60 * 1000);
  }

  stop() {
    this.running = false;
    if (this.timer) { clearInterval(this.timer); this.timer = null; }
    this.log('Scraper stopped.', 'mut');
    this._emitChange();
  }

  async pollOnce() {
    if (this.busy) { this.log('Poll already in progress — skipping.', 'mut'); return; }
    const roomId = this.getRoomId();
    if (!roomId) { this.log('No active dataset room — open or create one first.', 'warn'); return; }

    this.busy = true; this._emitChange();
    try {
      const url = proxied(feedQueryUrl(), this.proxy);
      this.log('Fetching live feed…', 'mut');
      const resp = await fetch(url, { headers: { Accept: 'application/json' } });
      if (!resp.ok) throw new Error(`feed HTTP ${resp.status}`);
      const geojson = await resp.json();
      const features = (geojson && geojson.features) || [];
      this.log(`Feed returned ${features.length} flights.`, 'mut');

      const known = this.getKnown();
      const fresh = features.filter(f => {
        const p = f.properties || {};
        const fid = p.flight_id || (p.ObjectId != null ? 'oid_' + p.ObjectId : null);
        return fid && !known.has(fid);
      });

      let recorded = 0;
      for (const f of fresh) {
        try {
          const anchor = await recordFlight(roomId, f);
          if (anchor) { recorded++; known.add(f.properties?.flight_id); }
        } catch (e) {
          this.log(`Failed to record a flight: ${e.message}`, 'err');
        }
      }

      await recordSnapshot(roomId, {
        featureCount: features.length, newCount: recorded, source: 'arcgis',
      });

      this.lastRun = Date.now();
      saveSettings({ intervalMin: this.intervalMin, proxy: this.proxy, lastRun: this.lastRun });
      this.log(
        recorded ? `Recorded ${recorded} new flight(s).` : 'No new flights.',
        recorded ? 'ok' : 'mut'
      );
    } catch (e) {
      this.log(`Poll failed: ${e.message}. ${this.proxy ? '' : 'A CORS proxy may be required.'}`, 'err');
    } finally {
      this.busy = false; this._emitChange();
    }
  }
}

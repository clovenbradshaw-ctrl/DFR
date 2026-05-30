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
import { act } from './activity.js';

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
    // Default to the shared n8n CORS proxy (same one the main DFR site uses)
    // so live fetches work without setup; feedFetch still tries direct first.
    this.proxy = s.proxy != null ? s.proxy : 'https://n8n.intelechia.com/webhook/feed?url=';
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
      this.log('Checking all departments for new flights…', 'mut');
      act.api('Checking all departments for new flights…');
      // The feature service returns every department's flights; one paginated
      // sweep covers them all. We page so we don't miss anything past the
      // server's max record count.
      const features = await this._fetchAll();

      const known = this.store.knownIds();
      const knownDepts = new Set((this.store.agencies || []).map(a => a.id));
      const fresh = features.filter(f => {
        const p = f.properties || f;
        const id = p.flight_id || p.id || (p.ObjectId != null ? 'oid_' + p.ObjectId : null);
        return id && !known.has(id);
      });
      act.api(`Feed returned ${features.length.toLocaleString()} flights; ${fresh.length} new`, { total: features.length, fresh: fresh.length });

      if (fresh.length) {
        // Group the new flights by department (org/operator id) for reporting.
        const byOrg = {};
        for (const f of fresh) {
          const p = f.properties || f;
          const org = p.organization_id || p.u || p.o || 'unknown';
          byOrg[org] = (byOrg[org] || 0) + 1;
        }
        const newDepts = Object.keys(byOrg).filter(o => !knownDepts.has(o));
        const { added } = await this.store.addFlights(fresh);
        const depts = Object.keys(byOrg).length;
        this.log(`Found ${added} new flight(s) across ${depts} department(s).`, 'ok');
        if (newDepts.length) act.api(`${newDepts.length} new department(s) seen on the feed`, { newDepts: newDepts.length });
        for (const [org, n] of Object.entries(byOrg).sort((a, b) => b[1] - a[1]).slice(0, 8)) {
          this.log(`  ${this._deptLabel(org)}: +${n}`, 'mut');
        }
        const r = await this.store.maybePublish();
        if (r.published) this.log(`Snapshot published as block(s) (v${r.version}).`, 'ok');
        else this.log(`Holding ${this.store.dirty} unpublished — will snapshot when it's worth it.`, 'mut');
      } else {
        this.log(`No new flights (${features.length} in feed across all departments).`, 'mut');
      }

      this.lastRun = Date.now();
      saveSettings({ intervalMin: this.intervalMin, proxy: this.proxy, lastRun: this.lastRun });
    } catch (e) {
      this.log(`Poll failed: ${e.message}. ${this.proxy ? '' : 'A CORS proxy may be required.'}`, 'err');
    } finally {
      this.busy = false; this._emit();
    }
  }

  /** Map an org/operator UUID to a readable department name via the agencies layer. */
  _deptLabel(org) {
    const a = (this.store.agencies || []).find(x => x.id === org);
    if (a) return a.name || [a.city, a.county, a.state].filter(Boolean).join(', ') || org;
    return org.length > 12 ? org.slice(0, 8) + '…' : org;
  }

  /** Paginate the whole feed (all departments). */
  async _fetchAll() {
    const PAGE = 2000, CAP = 100000;
    let offset = 0, all = [];
    while (offset < CAP) {
      const url = `${feedQueryUrl()}&resultRecordCount=${PAGE}&resultOffset=${offset}`;
      const resp = await fetch(proxied(url, this.proxy), { headers: { Accept: 'application/json' } });
      if (!resp.ok) throw new Error(`feed HTTP ${resp.status}`);
      const gj = await resp.json();
      const fs = (gj && gj.features) || [];
      all = all.concat(fs);
      if (fs.length < PAGE) break;
      offset += PAGE;
    }
    return all;
  }
}

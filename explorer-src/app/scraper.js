/**
 * scraper.js — background updater, faithful to dfr.py's pipeline.
 *
 * Per cycle (runs on the user's machine, in the tab):
 *   1. DISCOVER  every -production FeatureServer in Skydio's ArcGIS org
 *                (auto-finds new agencies/departments).
 *   2. COUNT     each agency's flight count (cheap) and skip it when the count
 *                is unchanged since last cycle — exactly dfr.py's optimisation.
 *   3. FETCH     only changed/new agencies, paginated.
 *   4. DEDUPE    by flight_id against the working set before adding.
 *   5. RECORD    new flights locally; throttled snapshot to Matrix media.
 *
 * It emits terminal-style lines so the Activity/Terminal view shows what a
 * `python3 dfr.py` run would print. Per-agency counts persist in localStorage
 * so "unchanged, skip" survives reloads.
 */

import { discoverFromDirectory, countUrl, agencyQueryUrl, agencyTailUrl, feedFetch,
         DIRECTORY_URL } from './dfr.js';
import { act } from './activity.js';

const SETTINGS_KEY = 'dfr.scraper.settings';
const COUNTS_KEY = 'dfr.scraper.counts';
const STATS_KEY = 'dfr.scraper.stats';
const loadJSON = (k, d) => { try { return JSON.parse(localStorage.getItem(k)) ?? d; } catch { return d; } };
const saveJSON = (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch {} };
const sleep = (ms) => ms > 0 ? new Promise(r => setTimeout(r, ms)) : Promise.resolve();

export class Scraper {
  constructor({ store, log, term }) {
    this.store = store;
    this.log = log || (() => {});
    this.term = term || ((line) => {});   // terminal-style sink
    const s = loadJSON(SETTINGS_KEY, {});
    this.intervalMin = s.intervalMin || 15;
    this.proxy = s.proxy != null ? s.proxy : 'https://n8n.intelechia.com/webhook/feed?url=';
    this.includeStaging = !!s.includeStaging;
    this.autoStart = s.autoStart !== false;   // default on; manual Stop opts out
    this.lastRun = s.lastRun || null;
    this.counts = loadJSON(COUNTS_KEY, {});   // uuid -> last flight_count
    this.stats = loadJSON(STATS_KEY, {});     // uuid -> { count, lastChange, lastChecked }
    this.timer = null; this.running = false; this.busy = false;
    this.paused = false;          // set true during a big import so the cycle yields
    this.busyDelayMs = 8;         // per-iteration yield → never freezes the UI
    this.concurrency = 3;         // departments processed in parallel, continuously
    this.cycleN = 0; this.onChange = null;
  }

  /** Pause the cycle (e.g. while a large import runs) and resume it after. */
  pause() { this.paused = true; this._emit(); }
  resume() { this.paused = false; this._emit(); }

  /**
   * Order departments for this cycle by *priority*, not directory order, so we
   * don't starve high-volume / recently-active ones:
   *   1. all NEW departments first (always discover);
   *   2. then known departments by a score = activity recency + total volume;
   *   3. with a random subset of the long tail spliced in (exploration), so
   *      quiet/never-checked departments still get visited.
   */
  _prioritize(uuids, knownDeptSet) {
    const now = Date.now();
    const isNew = (u) => !knownDeptSet.has(u);
    const news = uuids.filter(isNew);
    const known = uuids.filter(u => !isNew(u));

    const score = (u) => {
      const s = this.stats[u] || {};
      const vol = Math.log10((s.count || this.counts[u] || 0) + 1);        // dampened volume
      const recency = s.lastChange ? Math.max(0, 1 - (now - s.lastChange) / (30 * 864e5)) : 0; // 0..1 over 30d
      const neverChecked = s.lastChecked ? 0 : 0.5;                        // nudge the unseen
      return vol * 2 + recency * 3 + neverChecked;
    };
    const ranked = known.slice().sort((a, b) => score(b) - score(a));

    // Exploration: shuffle the bottom 60% and interleave ~1 random per 4 ranked.
    const cut = Math.floor(ranked.length * 0.4);
    const top = ranked.slice(0, cut);
    const tail = ranked.slice(cut);
    for (let i = tail.length - 1; i > 0; i--) { const j = (Math.random() * (i + 1)) | 0; [tail[i], tail[j]] = [tail[j], tail[i]]; }
    const woven = [];
    let ti = 0, xi = 0;
    while (ti < top.length || xi < tail.length) {
      for (let k = 0; k < 4 && ti < top.length; k++) woven.push(top[ti++]);
      if (xi < tail.length) woven.push(tail[xi++]);
    }
    return [...news, ...woven];
  }

  get state() {
    return { running: this.running, busy: this.busy, intervalMin: this.intervalMin,
             proxy: this.proxy, lastRun: this.lastRun, cycleN: this.cycleN };
  }
  _emit() { if (this.onChange) this.onChange(this.state); }
  _persist() { saveJSON(SETTINGS_KEY, { intervalMin: this.intervalMin, proxy: this.proxy, includeStaging: this.includeStaging, autoStart: this.autoStart, lastRun: this.lastRun }); }

  configure({ intervalMin, proxy, includeStaging } = {}) {
    if (intervalMin != null) this.intervalMin = Math.max(1, +intervalMin || 15);
    if (proxy != null) this.proxy = proxy.trim();
    if (includeStaging != null) this.includeStaging = !!includeStaging;
    this._persist();
    if (this.running) { this.stop(); this.start(); }
    this._emit();
  }

  start() {
    if (this.running) return;
    this.running = true;
    this.autoStart = true; this._persist();   // remember the user wants it on
    this.log(`Background updates on — every ${this.intervalMin} min.`, 'ok');
    this._emit();
    this.cycle();
    this.timer = setInterval(() => this.cycle(), this.intervalMin * 60 * 1000);
  }
  stop() {
    this.running = false;
    this.autoStart = false; this._persist();   // a manual Stop opts out of auto-start
    if (this.timer) { clearInterval(this.timer); this.timer = null; }
    this.log('Background updates off.', 'mut');
    this._emit();
  }

  _t(line) { this.term(line); }

  async cycle() {
    if (this.busy) return;
    if (!this.store?.roomId) { this.log('No active dataset — open or create one first.', 'warn'); return; }
    this.busy = true; this._emit();
    const n = ++this.cycleN;
    const stamp = new Date().toISOString().replace('T', ' ').slice(0, 19);
    this._t(`${'='.repeat(56)}`);
    this._t(`[${stamp}] cycle ${n}`);
    this._t(`  discovering dashboards from ArcGIS org …`);
    act.api(`Cycle ${n}: discovering departments`);
    let fetched = 0, skipped = 0, totAdded = 0, totRemoved = 0, newDepts = 0;
    try {
      const dir = await feedFetch(DIRECTORY_URL, this.proxy);
      const found = discoverFromDirectory(dir, this.includeStaging);
      const knownDepts = new Set((this.store.agencies || []).map(a => a.id));
      const allUuids = Object.keys(found);
      const fresh = allUuids.filter(u => !knownDepts.has(u));
      // Search by priority (active+high-volume first, random exploration mixed
      // in) rather than directory order, and always front-load NEW departments.
      const uuids = this._prioritize(allUuids, knownDepts);
      this._t(`  ${allUuids.length} dashboards live  (${fresh.length} new, ${allUuids.length - fresh.length} known) — priority order`);
      act.api(`${allUuids.length} departments live`, { total: allUuids.length, new: fresh.length });

      const known = this.store.knownIds();   // dedup set (flight_id / oid)
      const ctx = { i: 0, fetched: 0, skipped: 0, totAdded: 0, newDepts: 0, known, knownDepts, found, total: uuids.length };

      // Worker pool: process CONCURRENCY departments at once, continuously. The
      // network calls (count + fetch) run in parallel; the shared-state merge
      // (addFlights → OPFS) is serialized via _mergeLock so they don't race.
      const CONCURRENCY = this.concurrency || 3;
      let next = 0;
      const worker = async () => {
        while (true) {
          if (!this.running && this.timer === null) return;
          while (this.paused) { await sleep(1500); if (!this.running) return; }
          const idx = next++;
          if (idx >= uuids.length) return;
          await this._processDept(uuids[idx], ctx);
        }
      };
      await Promise.all(Array.from({ length: CONCURRENCY }, worker));
      fetched = ctx.fetched; skipped = ctx.skipped; totAdded = ctx.totAdded; newDepts = ctx.newDepts;

      saveJSON(COUNTS_KEY, this.counts);   // persist all counts (incl. empties) once per cycle
      saveJSON(STATS_KEY, this.stats);     // persist priority stats
      const r = await this.store.maybePublish();
      if (r.published) { this._t(`  snapshot published as block(s) (v${r.version})`); act.block(`Snapshot v${r.version} published`, { version: r.version }); }
      this._t(`  --- cycle ${n} done: fetched ${fetched}, skipped ${skipped} | +${totAdded} flights, ${newDepts} new dept(s)`);
      act.add(`Cycle ${n}: +${totAdded} flights, ${newDepts} new department(s)`, { added: totAdded, newDepts, fetched, skipped });
      this.lastRun = Date.now(); this._persist();
    } catch (e) {
      this._t(`  ! cycle ${n} failed: ${e.message}`);
      this.log(`Update cycle failed: ${e.message}. ${this.proxy ? '' : 'A CORS proxy may be required.'}`, 'err');
    } finally {
      this.busy = false; this._emit();
    }
  }

  /**
   * Process one department: count-check, skip-if-unchanged, fetch (tail/full),
   * dedupe, merge. Network I/O runs free (the pool gives parallelism); the
   * shared-state merge is serialized via _mergeLock to avoid races on the
   * working set / OPFS / dedup sets.
   */
  async _processDept(uuid, ctx) {
    const i = ++ctx.i;
    const { fs } = ctx.found[uuid];
    const isNew = !ctx.knownDepts.has(uuid);
    const head = `  [${String(i).padStart(3)}/${ctx.total}] ${isNew ? 'NEW ' : '    '}${uuid.slice(0, 8)}`;

    let cnt = null;
    try { cnt = (await feedFetch(countUrl(fs), this.proxy))?.count ?? null; } catch {}
    const prev = this.counts[uuid];
    const st = this.stats[uuid] || (this.stats[uuid] = {});
    st.lastChecked = Date.now();
    if (cnt != null) { st.count = cnt; if (cnt !== prev) st.lastChange = Date.now(); }
    if (cnt === 0) { ctx.skipped++; this.counts[uuid] = 0; this._t(`${head} cnt=0 = empty, skip`); return; }
    const why = isNew ? 'new' : (cnt !== prev ? 'count changed' : null);
    if (why === null) { ctx.skipped++; this._t(`${head} cnt=${cnt} = unchanged, skip`); return; }

    const grew = typeof prev === 'number' && cnt > prev;
    let feats, mode;
    try {
      if (grew && (cnt - prev) <= 5000) { feats = await this._fetchTail(fs, cnt - prev); mode = `tail +${cnt - prev}`; }
      else { feats = await this._fetchAll(fs); mode = 'full'; }
    } catch (e) { this._t(`${head} cnt=${cnt} -> ! fetch failed: ${e.message}`); return; }
    ctx.fetched++;
    this._t(`${head} cnt=${cnt} (was ${prev ?? '—'}) -> FETCH [${why}, ${mode}] …`);

    // Serialize the merge so parallel workers don't race shared state.
    await (this._mergeLock = (this._mergeLock || Promise.resolve()).then(async () => {
      const newFeats = feats.filter(f => {
        const p = f.properties || f;
        const id = p.flight_id || p.id || (p.ObjectId != null ? 'oid_' + p.ObjectId : null);
        return id && !ctx.known.has(id);
      });
      let added = 0;
      if (newFeats.length) {
        const r = await this.store.addFlights(newFeats);
        added = r.added; ctx.totAdded += added;
        for (const f of newFeats) { const p = f.properties || f; if (p.flight_id) ctx.known.add(p.flight_id); }
        if (r.newAgencies) ctx.newDepts += r.newAgencies;
      }
      this.counts[uuid] = cnt;
      this._t(`            + fetched ${feats.length}  added ${added}  archived ${cnt}`);
      if (isNew) act.api(`New department ${uuid.slice(0, 8)} (+${added})`, { uuid: uuid.slice(0, 8), added });
    }));
  }

  /** Fetch just the newest `n` rows (OBJECTID DESC), paged if n exceeds a page. */
  async _fetchTail(fs, n) {
    const PAGE = 2000;
    if (n <= PAGE) {
      const gj = await feedFetch(agencyTailUrl(fs, n), this.proxy);
      return (gj && gj.features) || [];
    }
    // Larger tail: page the DESC order until we've collected n.
    let all = [], offset = 0;
    while (all.length < n) {
      const gj = await feedFetch(`${agencyTailUrl(fs, Math.min(PAGE, n - all.length))}&resultOffset=${offset}`, this.proxy);
      const fsx = (gj && gj.features) || [];
      all = all.concat(fsx);
      if (fsx.length < PAGE) break;
      offset += fsx.length;
    }
    return all;
  }

  /** Paginate one agency's layer fully (GeoJSON). */
  async _fetchAll(fs) {
    const PAGE = 2000, CAP = 100000;
    let offset = 0, all = [], pages = 0;
    while (offset < CAP) {
      const gj = await feedFetch(agencyQueryUrl(fs, { offset, pageSize: PAGE }), this.proxy);
      const fsx = (gj && gj.features) || [];
      all = all.concat(fsx); pages++;
      const more = (gj && (gj.exceededTransferLimit || gj.properties?.exceededTransferLimit)) || fsx.length === PAGE;
      if (pages > 1) this._t(`            page ${pages}: +${fsx.length} (total ${all.length})`);
      if (!fsx.length || !more) break;
      offset += fsx.length;
    }
    return all;
  }

  // Manual "check now".
  pollOnce() { return this.cycle(); }
}

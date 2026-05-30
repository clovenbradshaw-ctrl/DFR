/**
 * departments.js — department-centric explorer view.
 *
 * Aggregates the in-memory flights by organisation (the `u`/organization_id on
 * each record), with a searchable department sidebar, per-department detail
 * (purpose breakdown, stats, metadata from the agencies layer) and a sortable,
 * paginated flight table + CSV export. Paginated tables keep this fast even at
 * tens of thousands of flights — no giant DOM.
 *
 * Pure rendering over data the DataStore already holds; it never fetches.
 */

const NOPURP = '(unspecified)';
const PER = 100;

const esc = (v) => ('' + (v == null ? '' : v)).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const fmtTime = (ms) => ms ? new Date(ms).toISOString().slice(0, 16).replace('T', ' ') : '';
function fmtDurMin(min) {
  if (!min) return '';
  const s = Math.round(min * 60), h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60;
  if (h) return h + 'h ' + String(m).padStart(2, '0') + 'm';
  if (m) return m + 'm ' + String(sec).padStart(2, '0') + 's';
  return sec + 's';
}

export class DepartmentsView {
  /**
   * @param {object} deps
   * @param {HTMLElement} deps.sidebar  list container
   * @param {HTMLElement} deps.main     detail container
   * @param {()=>{flights:Array,agencies:Array}} deps.getData
   * @param {(a)=>void} [deps.onPickAgency]  focus the map on a department's agency
   */
  constructor({ sidebar, main, getData, onPickAgency }) {
    this.sidebar = sidebar; this.main = main; this.getData = getData;
    this.onPickAgency = onPickAgency || (() => {});
    this.selected = null; this.filter = '';
    this.sort = { key: 't', dir: -1 }; this.page = 0;
    this._depts = new Map(); this._order = []; this._labels = new Map(); this._agencies = new Map();
    this._tableRows = [];
  }

  /** Recompute aggregates from current store data and repaint. Skips the work
   *  when neither the flight count nor agency count changed since last time. */
  refresh(force = false) {
    const { flights, agencies } = this.getData();
    const sig = (flights ? flights.length : 0) + ':' + (agencies ? agencies.length : 0);
    if (!force && sig === this._sig) return;
    this._sig = sig;
    this._agencies = new Map((agencies || []).map(a => [a.id, a]));
    const depts = new Map();
    for (const f of flights || []) {
      const u = f.organization_id || 'unknown';
      let d = depts.get(u);
      if (!d) { d = { u, count: 0, purposes: new Map(), tmin: null, tmax: null, totMin: 0, flights: [] }; depts.set(u, d); }
      d.count++;
      const p = f.flight_purpose || NOPURP;
      d.purposes.set(p, (d.purposes.get(p) || 0) + 1);
      if (f.takeoff) { if (d.tmin == null || f.takeoff < d.tmin) d.tmin = f.takeoff; if (d.tmax == null || f.takeoff > d.tmax) d.tmax = f.takeoff; }
      d.totMin += (f.duration_min || 0);
      d.flights.push(f);
    }
    this._depts = depts;
    this._order = [...depts.keys()].sort((a, b) => depts.get(b).count - depts.get(a).count);
    this._labels = this._buildLabels(this._order);
    this.renderSidebar(); this.renderMain();
  }

  deptName(u) { return this._labels.get(u) || (u ? u.slice(0, 8) + '…' : '(unknown)'); }

  _buildLabels(uuids) {
    const out = new Map(), base = new Map();
    for (const u of uuids) {
      const a = this._agencies.get(u);
      let s = a ? [a.city, a.state].filter(Boolean).join(', ') : '';
      if (!s) s = (a && a.address) ? a.address : (u ? u.slice(0, 8) + '…' : '(unknown)');
      base.set(u, s);
    }
    const groups = new Map();
    for (const [u, lab] of base) { if (!groups.has(lab)) groups.set(lab, []); groups.get(lab).push(u); }
    for (const [lab, uus] of groups) {
      if (uus.length === 1) { out.set(uus[0], lab); continue; }
      // Disambiguate colliding "city, state" by the first field that's unique across the group.
      let chosen = null;
      for (const field of ['county', 'address', null]) {
        const vals = new Map(); let anyEmpty = false; const counts = new Map();
        for (const u of uus) {
          const a = this._agencies.get(u) || {};
          let v;
          if (field === null) v = 'id ' + (u || '').slice(0, 6);
          else if (field === 'county' && a.county) v = /county$/i.test(a.county) ? a.county : a.county + ' County';
          else if (field === 'address' && a.address) v = a.address.length > 36 ? a.address.slice(0, 33) + '…' : a.address;
          else v = '';
          if (!v) { anyEmpty = true; }
          vals.set(u, v); counts.set(v, (counts.get(v) || 0) + 1);
        }
        if (!anyEmpty && counts.size === uus.length) { chosen = vals; break; }
      }
      if (!chosen) chosen = new Map(uus.map(u => [u, 'id ' + (u || '').slice(0, 6)]));
      for (const u of uus) out.set(u, lab + ' · ' + chosen.get(u));
    }
    return out;
  }

  // ── sidebar ──
  renderSidebar() {
    const q = this.filter.toLowerCase();
    const total = [...this._depts.values()].reduce((n, d) => n + d.count, 0);
    let html = `<div class="dept ${this.selected === null ? 'sel' : ''}" data-u="__all__">
      <span class="name">All departments<div class="sub">overview</div></span>
      <span class="count">${total.toLocaleString()}</span></div>`;
    for (const u of this._order) {
      const name = this.deptName(u);
      if (q && name.toLowerCase().indexOf(q) < 0 && (u || '').toLowerCase().indexOf(q) < 0) continue;
      const a = this._agencies.get(u);
      const sub = a ? [a.county, a.state].filter(Boolean).join(', ') : (u || '').slice(0, 12);
      html += `<div class="dept ${this.selected === u ? 'sel' : ''}" data-u="${esc(u)}">
        <span class="name">${esc(name)}<div class="sub">${esc(sub)}</div></span>
        <span class="count">${this._depts.get(u).count.toLocaleString()}</span></div>`;
    }
    this.sidebar.innerHTML = html;
    this.sidebar.querySelectorAll('.dept').forEach(el => {
      el.onclick = () => {
        const u = el.getAttribute('data-u');
        this.selected = (u === '__all__') ? null : u;
        this.page = 0; this.sort = { key: 't', dir: -1 };
        this.renderSidebar(); this.renderMain();
        if (this.selected) { const a = this._agencies.get(this.selected); if (a) this.onPickAgency(a); }
      };
    });
  }

  setFilter(v) { this.filter = v; this.renderSidebar(); }

  // ── main ──
  renderMain() {
    const total = [...this._depts.values()].reduce((n, d) => n + d.count, 0);
    if (!total) { this.main.innerHTML = '<div class="empty">No flights yet. Hydrate the dataset (Build index) or start the scraper.</div>'; return; }
    this.main.innerHTML = (this.selected === null) ? this._overviewHTML(total) : this._deptHTML(this.selected);
    this._wire();
  }

  _stat(n, l) { return `<div class="stat"><div class="n">${typeof n === 'number' ? n.toLocaleString() : esc(n)}</div><div class="l">${l}</div></div>`; }

  _barList(pairs, total) {
    if (!pairs.length) return '<div class="empty">No data.</div>';
    const max = pairs[0][1];
    return '<div class="bars">' + pairs.map(([lab, n]) => {
      const pct = total ? Math.round(n / total * 100) : 0, w = max ? (n / max * 100) : 0;
      return `<div class="barrow"><div class="lab" title="${esc(lab)}">${esc(lab)}</div>
        <div class="track"><div class="fill" style="width:${w}%"></div></div>
        <div class="val">${n.toLocaleString()} · ${pct}%</div></div>`;
    }).join('') + '</div>';
  }

  _overviewHTML(total) {
    const g = new Map();
    for (const d of this._depts.values()) for (const [p, c] of d.purposes) g.set(p, (g.get(p) || 0) + c);
    const purposes = [...g.entries()].sort((a, b) => b[1] - a[1]);
    const topDepts = this._order.slice(0, 15).map(u => [this.deptName(u), this._depts.get(u).count]);
    return `<div class="title">All departments</div>
      <p class="title-sub">Aggregate view. Select a department on the left for detail.</p>
      <div class="card"><div class="stats">${this._stat(total, 'flights')}${this._stat(this._depts.size, 'departments')}${this._stat(purposes.length, 'distinct purposes')}</div></div>
      <div class="card"><h2>Why they flew — purposes (all departments)</h2>${this._barList(purposes, total)}</div>
      <div class="card"><h2>Top departments by flight count</h2>${this._barList(topDepts, total)}</div>`;
  }

  _row(label, val, raw) { return (val == null || val === '') ? '' : `<dt>${label}</dt><dd>${raw ? val : esc(val)}</dd>`; }

  _deptHTML(u) {
    const d = this._depts.get(u), a = this._agencies.get(u) || {};
    const purposes = [...d.purposes.entries()].sort((x, y) => y[1] - x[1]);
    const avgMin = d.count ? d.totMin / d.count : 0;
    const meta = '<dl class="meta">' +
      this._row('City', a.city) + this._row('County', a.county) + this._row('State', a.state) +
      this._row('Address', a.address) + this._row('UUID', u) + '</dl>';
    return `<div class="title">${esc(this.deptName(u))}</div>
      <p class="title-sub">${esc(u)}</p>
      <div class="card"><div class="stats">
        ${this._stat(d.count, 'flights observed')}${this._stat(purposes.length, 'purposes')}
        ${this._stat(avgMin ? fmtDurMin(avgMin) : '—', 'avg duration')}
        <div class="stat"><div class="n" style="font-size:14px">${d.tmin ? fmtTime(d.tmin) : '—'} → ${d.tmax ? fmtTime(d.tmax) : '—'}</div><div class="l">first → last takeoff (UTC)</div></div>
      </div></div>
      <div class="card"><h2>Metadata</h2>${meta}</div>
      <div class="card"><h2>Why they flew — purposes</h2>${this._barList(purposes, d.count)}</div>
      <div class="card"><h2>Flights</h2><div class="toolbar"><span></span><button id="csvBtn">Download CSV</button></div>${this._table(d.flights)}</div>`;
  }

  // ── flight table ──
  get _cols() {
    return [
      ['id', 'Flight ID', false, f => f.flight_id || ''],
      ['x', 'Case', false, f => f.external_id || ''],
      ['p', 'Purpose', false, f => f.flight_purpose || ''],
      ['t', 'Takeoff (UTC)', false, f => fmtTime(f.takeoff)],
      ['d', 'Duration', true, f => f.duration_min || 0, f => fmtDurMin(f.duration_min)],
      ['pts', 'Pts', true, f => f.num_points || 0],
    ];
  }

  _table(rows) {
    this._tableRows = rows;
    const col = this._cols.find(c => c[0] === this.sort.key);
    const sorted = rows.slice().sort((a, b) => {
      let va = col[3](a), vb = col[3](b);
      if (col[2]) return ((+va || 0) - (+vb || 0)) * this.sort.dir;
      va = ('' + va).toLowerCase(); vb = ('' + vb).toLowerCase();
      return (va < vb ? -1 : va > vb ? 1 : 0) * this.sort.dir;
    });
    const pages = Math.max(1, Math.ceil(sorted.length / PER));
    if (this.page >= pages) this.page = pages - 1; if (this.page < 0) this.page = 0;
    const slice = sorted.slice(this.page * PER, this.page * PER + PER);
    const head = '<tr>' + this._cols.map(c => {
      const arr = this.sort.key === c[0] ? (this.sort.dir > 0 ? ' ▲' : ' ▼') : '';
      return `<th class="${c[2] ? 'num' : ''}" data-key="${c[0]}">${c[1]}${arr}</th>`;
    }).join('') + '</tr>';
    const body = slice.map(f => '<tr>' + this._cols.map(c => {
      const disp = c[4] ? c[4](f) : c[3](f);
      return `<td class="${c[2] ? 'num' : ''}">${esc(disp)}</td>`;
    }).join('') + '</tr>').join('');
    const pager = `<div class="pager">Page ${this.page + 1} of ${pages} · ${sorted.length.toLocaleString()} rows
      <button data-nav="prev" ${this.page <= 0 ? 'disabled' : ''}>Prev</button>
      <button data-nav="next" ${this.page >= pages - 1 ? 'disabled' : ''}>Next</button></div>`;
    return `<div class="toolbar"><span></span>${pager}</div><table><thead>${head}</thead><tbody>${body}</tbody></table>`;
  }

  _wire() {
    this.main.querySelectorAll('th[data-key]').forEach(th => {
      th.onclick = () => {
        const k = th.getAttribute('data-key');
        if (this.sort.key === k) this.sort.dir = -this.sort.dir; else { this.sort.key = k; this.sort.dir = 1; }
        this.renderMain();
      };
    });
    this.main.querySelectorAll('button[data-nav]').forEach(btn => {
      btn.onclick = () => { this.page += (btn.getAttribute('data-nav') === 'next' ? 1 : -1); this.renderMain(); };
    });
    const csv = this.main.querySelector('#csvBtn');
    if (csv) csv.onclick = () => this._downloadCSV();
  }

  _downloadCSV() {
    const rows = this._tableRows;
    if (!rows.length) return;
    const headers = ['department', 'flight_id', 'case', 'purpose', 'takeoff_utc', 'duration_min', 'points'];
    const out = [headers];
    for (const f of rows) out.push([this.deptName(f.organization_id), f.flight_id, f.external_id, f.flight_purpose, fmtTime(f.takeoff), f.duration_min || 0, f.num_points || 0]);
    const csv = out.map(r => r.map(c => {
      const s = '' + (c == null ? '' : c);
      return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
    }).join(',')).join('\n');
    const blob = new Blob([csv], { type: 'text/csv' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = (this.selected ? this.deptName(this.selected).replace(/[^a-z0-9]+/gi, '_') : 'all') + '_flights.csv';
    a.click(); URL.revokeObjectURL(a.href);
  }
}

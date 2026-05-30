/**
 * main.js — DFR Explorer bootstrap (binary-dataset model).
 *
 * Foundation (mirrored): Matrix auth, rooms, media, vault, OPFS. DFR-specific:
 * the dataset is a binary blob (OPFS + media) addressed by a single room-state
 * pointer; the scraper appends locally and snapshots rarely. No per-flight
 * timeline events, no folding thousands of rows on open.
 *
 *   open room → load OPFS blob (fast) → sync if pointer is newer → render.
 *   first run → hydration gate (ask until done) → publish + mark hydrated.
 *   scrape    → append to OPFS → throttled snapshot → bump pointer.
 */

import {
  login, unlock, tryAutoUnlock, logout,
  hasLocalAccount, getClient, setProgress, setRecoveryKeyProvider,
} from '../src/client.js';
import { setNamespace } from '../src/operators.js';
import { createRoom, discoverRooms, onRoomChanges,
         invite, getMembers, loadRoomMembers, onMembersChange } from '../src/rooms.js';

import { NAMESPACE, ROOM_TYPE } from './dfr.js';
import { DataStore } from './datastore.js';
import { onDatasetState } from './roomstate.js';
import * as sel from './selectors.js';
import { Scraper } from './scraper.js';
import { DfrMap } from './mapview.js';
import { DepartmentsView } from './departments.js';
import { Swarm } from './swarm.js';
import { Activity, act } from './activity.js';

const $ = (id) => document.getElementById(id);
let deptsView = null, swarm = null;

let store = null, scraper = null, dfrMap = null;
let currentRoomId = null, unsubDatasetState = null, unsubMembers = null;
let gateAbort = null, gateMode = 'hydrate';

// ── activity log (sidebar text) + structured Activity feed ──
function log(msg, level = 'mut') {
  const el = $('log');
  if (el) {
    const line = document.createElement('div');
    line.className = level;
    line.textContent = `${new Date().toLocaleTimeString()}  ${msg}`;
    el.appendChild(line); el.scrollTop = el.scrollHeight;
    while (el.children.length > 200) el.removeChild(el.firstChild);
  }
  // Mirror errors/warnings into the structured feed so they appear in Activity.
  if (level === 'err') act.err(msg);
}

// ── Activity view ──
const ACT_KINDS = ['sync', 'api', 'add', 'block', 'swarm', 'err'];
let actFilter = new Set(ACT_KINDS);   // all on
function renderActivity() {
  const list = $('actList');
  if (!list) return;
  const counts = Activity.counts();
  // filter chips
  $('actFilters').innerHTML = ACT_KINDS.map(k =>
    `<span class="act-chip ${actFilter.has(k) ? 'on' : ''}" data-k="${k}">${k}<span class="c">${counts[k] || 0}</span></span>`).join('');
  $('actFilters').querySelectorAll('.act-chip').forEach(ch => ch.onclick = () => {
    const k = ch.getAttribute('data-k');
    if (actFilter.has(k)) actFilter.delete(k); else actFilter.add(k);
    renderActivity();
  });
  const rows = Activity.events.filter(e => actFilter.has(e.kind))
    .slice(-400).reverse().map(e => {
      const t = new Date(e.ts).toLocaleTimeString();
      const d = e.data && Object.keys(e.data).length
        ? `<span class="d">${esc(Object.entries(e.data).map(([k, v]) => `${k}: ${Array.isArray(v) ? v.join(',') : v}`).join(' · '))}</span>` : '';
      return `<div class="act-row"><span class="t">${t}</span><span class="k ${e.kind}">${e.kind}</span><span class="m">${esc(e.message)}${d}</span></div>`;
    }).join('');
  list.innerHTML = rows || '<div class="act-empty">No activity yet. Sync, scraping, and block creation will appear here.</div>';
}

// ── auth ──
const hostFrom = (hs) => { try { return new URL(hs).host; } catch { return hs.replace(/^https?:\/\//, ''); } };
function loginStatus(msg, err = false) { const e = $('loginStatus'); e.textContent = msg || ''; e.classList.toggle('err', !!err); }

async function doSignIn() {
  const hs = $('hs').value.trim(), u = $('user').value.trim(), pw = $('pw').value, persist = $('persist').checked;
  if (!u || !pw) { loginStatus('Enter a user ID and password.', true); return; }
  const mxid = u.startsWith('@') ? u : `@${u.replace(/^@/, '')}:${hostFrom(hs)}`;
  $('signin').disabled = true;
  try {
    if (hasLocalAccount(mxid)) {
      const r = await unlock(mxid, pw, { persist });
      if (r.needsLogin) await login(hs, mxid, pw, { persist });
    } else {
      await login(hs, mxid, pw, { persist });
    }
    await onAuthed();
  } catch (e) { loginStatus(e.message || String(e), true); }
  finally { $('signin').disabled = false; }
}

async function onAuthed() {
  const client = getClient();
  if (!client) { loginStatus('Connected but no client — try again.', true); return; }
  $('who').textContent = client.getUserId();
  $('login').classList.add('hidden');
  $('app').classList.remove('hidden');

  store = new DataStore({ log });
  store.onChange = scheduleRender;
  store.onBusy = showLoading;
  scraper = new Scraper({ store, log });
  scraper.onChange = renderScraper;
  swarm = new Swarm({ getRoomId: () => currentRoomId, log, onPeersChange: () => {} });
  $('interval').value = scraper.intervalMin;
  $('proxy').value = scraper.proxy;

  onRoomChanges(() => refreshRooms());
  await refreshRooms();
}

async function doLogout() {
  try { scraper?.stop(); } catch {}
  await logout();
  location.reload();
}

// ── rooms ──
async function refreshRooms() {
  const rooms = discoverRooms(ROOM_TYPE);
  const selEl = $('roomSel');
  selEl.innerHTML = '';
  for (const r of rooms) {
    const o = document.createElement('option');
    o.value = r.roomId; o.textContent = r.name + (r.membership === 'invite' ? ' (invite)' : '');
    selEl.appendChild(o);
  }
  if (!rooms.length) {
    const o = document.createElement('option'); o.textContent = '— no dataset yet —'; o.disabled = true; selEl.appendChild(o);
    log('No DFR dataset room found. Click "+ Dataset" to create one.', 'warn');
    return;
  }
  if (!currentRoomId || !rooms.some(r => r.roomId === currentRoomId)) await openRoom(rooms[0].roomId);
  else selEl.value = currentRoomId;
}

async function createDataset() {
  const name = prompt('Name this DFR dataset room:', 'Nashville DFR');
  if (!name) return;
  $('newRoom').disabled = true;
  try {
    const roomId = await createRoom(name, ROOM_TYPE);
    log(`Created dataset "${name}".`, 'ok');
    await refreshRooms();
    await openRoom(roomId);
  } catch (e) { log(`Create failed: ${e.message}`, 'err'); }
  finally { $('newRoom').disabled = false; }
}

async function openRoom(roomId) {
  if (unsubDatasetState) unsubDatasetState();
  if (unsubMembers) unsubMembers();
  if (swarm) { swarm.lowerHand(); swarm.stop(); }
  currentRoomId = roomId;
  $('roomSel').value = roomId;
  dfrMap && (dfrMap._fitDone = false);
  agenciesDrawn = false;
  log('Opening dataset…');
  const { hydrated } = await store.open(roomId);
  render();
  // React to snapshots published by peers (intelligent, version-gated sync).
  unsubDatasetState = onDatasetState(roomId, async () => {
    log('Dataset pointer changed — syncing…', 'mut');
    await store.sync(); render();
  });
  // Member list + live updates (joins, invites, power-level changes).
  unsubMembers = onMembersChange(roomId, () => renderMembers());
  renderMembers();
  if (swarm) swarm.start();
  if (!hydrated) openGate('hydrate');
  else log('Dataset ready.', 'ok');
}

async function renderMembers() {
  const el = $('memberList');
  if (!el || !currentRoomId) return;
  const roomId = currentRoomId;
  try { await loadRoomMembers(roomId); } catch {}
  if (roomId !== currentRoomId) return; // room switched while loading
  const me = getClient()?.getUserId();
  const members = getMembers(roomId);
  el.innerHTML = members.map(m => {
    const role = m.membership === 'invite' ? 'invited'
      : m.powerLevel >= 100 ? 'admin' : m.powerLevel >= 50 ? 'mod' : 'member';
    return `<div class="member${m.membership === 'invite' ? ' invited' : ''}">
      <span class="mid">${esc(m.displayName || m.userId)}${m.userId === me ? ' (you)' : ''}</span>
      <span class="role">${role}</span>
    </div>`;
  }).join('') || '<div class="hint">No members loaded.</div>';
}

async function doInvite() {
  const raw = $('inviteId').value.trim();
  if (!currentRoomId) { log('Open or create a dataset first.', 'warn'); return; }
  if (!/^@[^:]+:.+/.test(raw)) { log('Enter a full Matrix ID, e.g. @name:hyphae.social', 'warn'); return; }
  $('inviteBtn').disabled = true;
  try {
    await invite(currentRoomId, raw);
    log(`Invited ${raw}.`, 'ok');
    $('inviteId').value = '';
    renderMembers();
  } catch (e) {
    log(`Invite failed: ${e.message}`, 'err');
  } finally {
    $('inviteBtn').disabled = false;
  }
}

// ── render ──
let tab = 'depts';
// Coalesce bursts of onChange (e.g. during indexing) into one paint per frame.
let renderScheduled = false;
function scheduleRender() {
  if (renderScheduled) return;
  renderScheduled = true;
  requestAnimationFrame(() => { renderScheduled = false; render(); });
}
let actRenderScheduled = false;
function scheduleActRender() {
  if (actRenderScheduled) return;
  actRenderScheduled = true;
  requestAnimationFrame(() => { actRenderScheduled = false; renderActivity(); });
}
function render() {
  const flights = store?.flights || [];
  const s = sel.stats(flights);
  $('sFlights').textContent = s.flights;
  $('sSites').textContent = store?.dirty ?? 0;        // unpublished local additions
  $('sGeom').textContent = s.withGeometry;            // flights with a path
  $('sSnap').textContent = store?.meta?.version ?? 0; // current snapshot version
  const span = (s.earliest && s.latest)
    ? `${new Date(s.earliest).toLocaleDateString()} – ${new Date(s.latest).toLocaleDateString()}` : '—';
  $('span').textContent = `span ${span}`;

  const m = store?.meta;
  const ag = store?.agencies?.length ? ` · ${store.agencies.length} agencies` : '';
  if (m && m.mode === 'chunked-raw' && !m.lean_index && !store.flights.length) {
    $('syncStatus').textContent = `v${m.version} · raw archive (${((m.total_bytes||0)/1073741824).toFixed(2)} GB) — click "Build index" to view flights${ag}`;
  } else {
    $('syncStatus').textContent = (m
      ? `v${m.version} · ${m.count} flights · ${m.lean_index ? 'indexed' : m.blob ? 'in media' : (m.source_url ? 'external host' : 'OPFS only')}` +
        `${store.dirty ? ` · ${store.dirty} unpublished` : ''}`
      : (store?.flights?.length ? `${store.flights.length} local · not published` : 'not hydrated')) + ag;
  }

  if (tab === 'depts') ensureDepts().refresh();
  if (tab === 'map') renderMap(flights);

  // Once the room holds data, fold the hydration-setup panel away.
  const hasData = (store?.flights?.length || 0) > 0;
  const setup = $('setupPanel');
  if (setup && hasData && !setup.dataset.autoclosed) { setup.open = false; setup.dataset.autoclosed = '1'; }
}

const FOCUS_MIN_ZOOM = 12;     // only auto-pull when zoomed in this far
const FOCUS_DEBOUNCE = 700;    // ms after the user stops moving
let focusEnabled = true;
let focusTimer = null, focusAbort = null, lastFocusKey = '';

function ensureMap() {
  if (dfrMap) return dfrMap;
  if (typeof L === 'undefined') { log('Leaflet failed to load (offline?).', 'warn'); return null; }
  dfrMap = new DfrMap('map');
  // Auto-pull recent flights for the viewport once zoomed in.
  dfrMap.onFocusChange((bbox, zoom) => scheduleFocus(bbox, zoom));
  dfrMap.onCount = (shown, total, capped) => setFocusHint(
    total ? `Showing ${shown.toLocaleString()} of ${total.toLocaleString()} flights in view${capped ? ' (capped — zoom in for more)' : ''}` : '');
  return dfrMap;
}
let agenciesDrawn = false;
function renderMap(flights) {
  const m = ensureMap();
  if (!m) return;
  m.render(flights);
  // Agencies rarely change; only (re)draw when the set changes.
  if (!agenciesDrawn && store?.agencies?.length) {
    m.renderAgencies(store.agencies, (a) => { m.focusOn(a); focusFetchNow(m.bbox(), { agency: a.name }); });
    agenciesDrawn = true;
  }
}

// ── loading overlay (recurring: reassembling/indexing blocks) ──
function showLoading(info) {
  const el = $('loading');
  if (!info) { el.classList.add('hidden'); return; }
  el.classList.remove('hidden');
  $('loadingTitle').textContent = info.title || 'Loading…';
  $('loadingSub').textContent = info.sub || '';
  const bar = $('loadingBar');
  if (info.frac == null) { bar.style.width = '100%'; bar.style.opacity = '.35'; }
  else { bar.style.opacity = '1'; bar.style.width = Math.round(Math.max(0, Math.min(1, info.frac)) * 100) + '%'; }
}

function scheduleFocus(bbox, zoom) {
  if (!focusEnabled || !store?.roomId) return;
  if (zoom < FOCUS_MIN_ZOOM) { setFocusHint(`Zoom in to level ${FOCUS_MIN_ZOOM}+ to pull recent flights here.`); return; }
  const key = bbox.map(n => n.toFixed(3)).join(',');
  if (key === lastFocusKey) return;
  clearTimeout(focusTimer);
  focusTimer = setTimeout(() => { lastFocusKey = key; focusFetchNow(bbox); }, FOCUS_DEBOUNCE);
}

async function focusFetchNow(bbox, { agency } = {}) {
  if (!store?.roomId) return;
  // Swarm: raise our hand for this area, and yield if a peer already covers it.
  if (swarm) {
    swarm.raiseHand(bbox, { label: agency || '' });
    const decision = swarm.shouldFetch(bbox);
    if (!decision.fetch) {
      setFocusHint(`Covered by a peer device — their results sync here.`);
      act.swarm('Yielded this area to a peer device', { by: decision.by?.device?.slice(0, 8) });
      return;
    }
  }
  if (focusAbort) focusAbort.abort();
  focusAbort = new AbortController();
  setFocusHint(agency ? `Pulling recent flights near ${agency}…` : 'Pulling recent flights in view…');
  try {
    const proxy = $('proxy').value.trim();
    const r = await store.focusFetch(bbox, { proxy, signal: focusAbort.signal });
    if (swarm) swarm.raiseHand(bbox, { label: agency || '', fetchedTs: Date.now() });
    setFocusHint(r.fetched ? `${r.fetched} recent flights here (${r.added} new).` : 'No recent flights in this area.');
    render();
  } catch (e) {
    if (e.name !== 'AbortError') setFocusHint(`Live pull failed: ${e.message}`);
  } finally { focusAbort = null; }
}

function setFocusHint(msg) { const el = $('focusHint'); if (el) el.textContent = msg || ''; }

function renderScraper(st = scraper?.state) {
  if (!st) return;
  const pill = $('scrapeState');
  pill.textContent = st.busy ? 'polling…' : (st.running ? 'on' : 'off');
  pill.classList.toggle('on', st.running);
  $('scrapeToggle').textContent = st.running ? 'Stop' : 'Start';
}

// ── hydration gate ──
function openGate(mode) {
  gateMode = mode;
  $('gateTitle').textContent = mode === 'import' ? 'Import more flights' : 'Hydrate this dataset';
  $('gateStatus').textContent = '';
  $('gateStatus').className = 'status';
  $('gateBar').style.width = '0';
  $('gateSkip').classList.toggle('hidden', mode === 'import');
  $('hydrateGate').classList.remove('hidden');
}
function closeGate() { $('hydrateGate').classList.add('hidden'); }
function gateStatus(msg, level = '') { const e = $('gateStatus'); e.textContent = msg || ''; e.className = 'status ' + level; }

const LARGE_FILE = 48 * 1024 * 1024; // auto-route files this big to chained upload

async function gateLoad(source) {
  const format = $('gateFormat').value;
  const isFile = typeof source.slice === 'function';
  const raw = format === 'chunked-raw' || (format === 'auto' && isFile && source.size > LARGE_FILE);
  gateAbort = gateAbort || new AbortController();
  $('gateLoad').disabled = true; $('gateStop').disabled = false;
  gateStatus(raw ? 'Uploading as chained blocks…' : 'Loading…');
  try {
    if (raw) {
      const res = await store.hydrateRawChunked(source, {
        format: 'auto', signal: gateAbort.signal,
        onProgress: p => {
          gateStatus(`Uploaded ${p.block} block(s) · ${(p.bytes / 1048576).toFixed(1)} MB…`);
          $('gateBar').style.width = '50%'; // indeterminate; total size may be unknown
        },
      });
      $('gateBar').style.width = '100%';
      gateStatus(`Uploaded ${res.chunkCount} blocks (${(res.totalBytes / 1048576).toFixed(1)} MB). Syncing…`, 'ok');
      log(`Chained upload done: ${res.chunkCount} blocks, v${res.version}.`, 'ok');
      await store.sync(); // pull back + parse if within the in-browser size limit
      render();
      setTimeout(closeGate, 900);
    } else {
      const res = await store.hydrateFrom(source, {
        format, signal: gateAbort.signal, sourceUrl: source.url || null,
        onProgress: p => { gateStatus(`Read ${p.seen}, recorded ${p.recorded}…`); $('gateBar').style.width = '60%'; },
      });
      $('gateBar').style.width = '100%';
      gateStatus(`Hydrated: ${res.total} flights (${res.added} new).`, 'ok');
      log(`Hydration complete: ${res.total} flights.`, 'ok');
      render();
      setTimeout(closeGate, 700);
    }
  } catch (e) {
    // "Ask until done": stay on the gate so the user can retry.
    if (e.name === 'AbortError') gateStatus('Stopped.', '');
    else gateStatus(`Failed: ${e.message}. Try again.`, 'err');
    log(`Hydration failed: ${e.message}`, 'err');
  } finally {
    gateAbort = null; $('gateLoad').disabled = false; $('gateStop').disabled = true;
  }
}

async function gateSkip() {
  // Start empty but mark hydrated in room state so we don't ask again; the
  // scraper becomes the source of truth.
  $('gateSkip').disabled = true;
  try { await store.publish({ markHydrated: true }); render(); closeGate(); log('Started empty — scraper will fill the dataset.', 'mut'); }
  catch (e) { gateStatus(`Could not save status: ${e.message}`, 'err'); }
  finally { $('gateSkip').disabled = false; }
}

function esc(s) { return String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])); }

// ── tabs ──
function setTab(t) {
  tab = t;
  $('tabDepts').setAttribute('aria-selected', t === 'depts');
  $('tabMap').setAttribute('aria-selected', t === 'map');
  $('tabActivity').setAttribute('aria-selected', t === 'activity');
  $('deptsView').classList.toggle('hidden', t !== 'depts');
  $('mapView').classList.toggle('hidden', t !== 'map');
  $('activityView').classList.toggle('hidden', t !== 'activity');
  if (t === 'map') { renderMap(store?.flights || []); dfrMap?.invalidate(); }
  else if (t === 'depts') ensureDepts().refresh();
  else if (t === 'activity') renderActivity();
}

function ensureDepts() {
  if (deptsView) return deptsView;
  deptsView = new DepartmentsView({
    sidebar: $('deptList'), main: $('deptMain'),
    getData: () => ({ flights: store?.flights || [], agencies: store?.agencies || [] }),
    onPickAgency: (a) => { if (dfrMap && a.lat != null) { setTab('map'); dfrMap.focusOn(a); focusFetchNow(dfrMap.bbox(), { agency: a.name }); } },
  });
  $('deptSearch').addEventListener('input', e => deptsView.setFilter(e.target.value));
  return deptsView;
}

// ── wire ──
function wire() {
  $('signin').addEventListener('click', doSignIn);
  $('pw').addEventListener('keydown', e => { if (e.key === 'Enter') doSignIn(); });
  $('logout').addEventListener('click', doLogout);
  $('newRoom').addEventListener('click', createDataset);
  $('inviteBtn').addEventListener('click', doInvite);
  $('inviteId').addEventListener('keydown', e => { if (e.key === 'Enter') doInvite(); });
  $('roomSel').addEventListener('change', e => openRoom(e.target.value));
  $('tabDepts').addEventListener('click', () => setTab('depts'));
  $('tabMap').addEventListener('click', () => setTab('map'));
  $('tabActivity').addEventListener('click', () => setTab('activity'));
  $('actClear').addEventListener('click', () => { Activity.clear(); renderActivity(); });
  // Live-update the Activity view (and the tab is cheap to repaint when visible).
  Activity.subscribe(() => { if (tab === 'activity') scheduleActRender(); });
  $('focusToggle').addEventListener('change', e => {
    focusEnabled = e.target.checked;
    setFocusHint(focusEnabled ? 'Live focus on — zoom in to pull recent flights.' : 'Live focus off.');
    if (focusEnabled && dfrMap && dfrMap.zoom() >= FOCUS_MIN_ZOOM) { lastFocusKey = ''; scheduleFocus(dfrMap.bbox(), dfrMap.zoom()); }
  });

  $('scrapeToggle').addEventListener('click', () => {
    scraper.configure({ intervalMin: $('interval').value, proxy: $('proxy').value });
    scraper.running ? scraper.stop() : scraper.start();
  });
  $('pollNow').addEventListener('click', () => {
    scraper.configure({ intervalMin: $('interval').value, proxy: $('proxy').value });
    scraper.pollOnce();
  });
  $('interval').addEventListener('change', () => scraper.configure({ intervalMin: $('interval').value }));
  $('proxy').addEventListener('change', () => scraper.configure({ proxy: $('proxy').value }));

  $('publishNow').addEventListener('click', async () => {
    try { const r = await store.publish({}); log(r.published ? `Published v${r.version}.` : 'Nothing to publish.', 'ok'); }
    catch (e) { log(`Publish failed: ${e.message}`, 'err'); }
  });
  $('syncNow').addEventListener('click', async () => { await store.sync(); render(); });
  $('rehydrateBtn').addEventListener('click', () => openGate('import'));

  $('buildIndexBtn').addEventListener('click', async () => {
    $('buildIndexBtn').disabled = true;
    try { const r = await store.buildIndexFromArchive(); log(`Built index: ${r.flights} flights.`, 'ok'); render(); }
    catch (e) { log(`Build index failed: ${e.message}`, 'err'); }
    finally { $('buildIndexBtn').disabled = false; }
  });

  // Agencies: pick a local NDJSON/JSON file and load it as its own layer.
  $('agenciesBtn').addEventListener('click', () => $('agenciesFile').click());
  $('agenciesFile').addEventListener('change', async e => {
    const file = e.target.files?.[0];
    if (!file) return;
    if (!currentRoomId) { log('Open or create a dataset first.', 'warn'); return; }
    log(`Loading agencies from ${file.name}…`);
    try {
      const r = await store.hydrateAgencies(file, { onProgress: p => log(`…${p.kept} agencies`, 'mut') });
      log(`Loaded ${r.agencies} agencies.`, 'ok');
      render();
    } catch (err) { log(`Agencies load failed: ${err.message}`, 'err'); }
    e.target.value = '';
  });

  $('gateLoad').addEventListener('click', async () => {
    const url = $('gateUrl').value.trim();
    const file = $('gateFile').files?.[0];
    if (file) return gateLoad(file);
    if (!url) { gateStatus('Enter a URL or pick a file.', 'err'); return; }
    gateAbort = new AbortController();
    gateStatus('Fetching…');
    try {
      const resp = await fetch(url, { signal: gateAbort.signal });
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
      await gateLoad(resp); // Response.url is already the final URL
    } catch (e) { gateStatus(`Fetch failed: ${e.message}`, 'err'); }
  });
  $('gateFile').addEventListener('change', e => { if (e.target.files?.[0]) gateLoad(e.target.files[0]); });
  $('gateStop').addEventListener('click', () => gateAbort?.abort());
  $('gateSkip').addEventListener('click', gateSkip);
}

// ── boot ──
async function boot() {
  setNamespace(NAMESPACE);
  wire();
  setProgress(msg => loginStatus(msg));
  setRecoveryKeyProvider(async () =>
    prompt('Your account has secure backup. Enter your Matrix recovery key (or cancel to skip):') || null);
  try {
    const auto = await tryAutoUnlock();
    if (auto && auto.userId && getClient()) { loginStatus(''); await onAuthed(); return; }
  } catch (e) { console.warn('[boot] auto-unlock:', e); }
  loginStatus('');
}
boot();

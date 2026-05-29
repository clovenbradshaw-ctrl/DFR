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
import { createRoom, discoverRooms, onRoomChanges } from '../src/rooms.js';

import { NAMESPACE, ROOM_TYPE } from './dfr.js';
import { DataStore } from './datastore.js';
import { onDatasetState } from './roomstate.js';
import * as sel from './selectors.js';
import { Scraper } from './scraper.js';
import { DfrMap } from './mapview.js';

const $ = (id) => document.getElementById(id);

let store = null, scraper = null, dfrMap = null;
let currentRoomId = null, unsubDatasetState = null;
let gateAbort = null, gateMode = 'hydrate';

// ── activity log ──
function log(msg, level = 'mut') {
  const el = $('log'); if (!el) return;
  const line = document.createElement('div');
  line.className = level;
  line.textContent = `${new Date().toLocaleTimeString()}  ${msg}`;
  el.appendChild(line); el.scrollTop = el.scrollHeight;
  while (el.children.length > 200) el.removeChild(el.firstChild);
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
  store.onChange = render;
  scraper = new Scraper({ store, log });
  scraper.onChange = renderScraper;
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
  currentRoomId = roomId;
  $('roomSel').value = roomId;
  dfrMap && (dfrMap._fitDone = false);
  log('Opening dataset…');
  const { hydrated } = await store.open(roomId);
  render();
  // React to snapshots published by peers (intelligent, version-gated sync).
  unsubDatasetState = onDatasetState(roomId, async () => {
    log('Dataset pointer changed — syncing…', 'mut');
    await store.sync(); render();
  });
  if (!hydrated) openGate('hydrate');
  else log('Dataset ready.', 'ok');
}

// ── render ──
let tab = 'map';
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
  $('syncStatus').textContent = m
    ? `v${m.version} · ${m.count} flights · ${m.blob ? 'in media' : (m.source_url ? 'external host' : 'OPFS only')}` +
      `${store.dirty ? ` · ${store.dirty} unpublished` : ''}`
    : (store?.flights?.length ? `${store.flights.length} local · not published` : 'not hydrated');

  if (tab === 'table') renderTable(flights);
  if (tab === 'map') renderMap(flights);
}

function renderTable(flights) {
  const rows = sel.sortedByTakeoff(flights).slice(0, 2000).map(f => `<tr>
    <td><span class="dot" style="background:var(--red)"></span>${esc(f.flight_purpose || '')}</td>
    <td>${esc(f.external_id || f.flight_id || '')}</td>
    <td>${f.takeoff ? new Date(f.takeoff).toLocaleString() : ''}</td>
    <td>${f.duration_min ?? ''}</td>
    <td>${f.num_points ?? ''}</td>
    <td>${f.geometry ? 'yes' : '—'}</td>
  </tr>`).join('');
  $('tableView').innerHTML = `<table>
    <thead><tr><th>Purpose</th><th>Case / Flight ID</th><th>Takeoff</th><th>Min</th><th>Pts</th><th>Path</th></tr></thead>
    <tbody>${rows || '<tr><td colspan="6" style="color:var(--mut)">No flights. Hydrate the dataset or start the scraper.</td></tr>'}</tbody>
  </table>`;
}

function ensureMap() {
  if (dfrMap) return dfrMap;
  if (typeof L === 'undefined') { log('Leaflet failed to load (offline?).', 'warn'); return null; }
  dfrMap = new DfrMap('map');
  return dfrMap;
}
function renderMap(flights) { const m = ensureMap(); if (m) m.render(flights); }

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

async function gateLoad(source) {
  const format = $('gateFormat').value;
  gateAbort = new AbortController();
  $('gateLoad').disabled = true; $('gateStop').disabled = false;
  gateStatus('Loading…');
  try {
    const res = await store.hydrateFrom(source, {
      format, signal: gateAbort.signal,
      sourceUrl: source.url || null,
      onProgress: p => { gateStatus(`Read ${p.seen}, recorded ${p.recorded}…`); $('gateBar').style.width = '60%'; },
    });
    $('gateBar').style.width = '100%';
    gateStatus(`Hydrated: ${res.total} flights (${res.added} new).`, 'ok');
    log(`Hydration complete: ${res.total} flights.`, 'ok');
    render();
    setTimeout(closeGate, 700);
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
  $('tabMap').setAttribute('aria-selected', t === 'map');
  $('tabTable').setAttribute('aria-selected', t === 'table');
  $('mapView').classList.toggle('hidden', t !== 'map');
  $('tableView').classList.toggle('hidden', t !== 'table');
  if (t === 'map') { renderMap(store?.flights || []); dfrMap?.invalidate(); }
  else renderTable(store?.flights || []);
}

// ── wire ──
function wire() {
  $('signin').addEventListener('click', doSignIn);
  $('pw').addEventListener('keydown', e => { if (e.key === 'Enter') doSignIn(); });
  $('logout').addEventListener('click', doLogout);
  $('newRoom').addEventListener('click', createDataset);
  $('roomSel').addEventListener('change', e => openRoom(e.target.value));
  $('tabMap').addEventListener('click', () => setTab('map'));
  $('tabTable').addEventListener('click', () => setTab('table'));

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

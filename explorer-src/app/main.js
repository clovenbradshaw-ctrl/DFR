/**
 * main.js — DFR Explorer bootstrap.
 *
 * Wires the mirrored bare-metal foundation (Matrix auth + event-sourced
 * database) to the DFR-specific UI. The loop is exactly the one in
 * BUILDING.md §4: state = fold(timeline); UI = render(state); action =
 * emit(operator). Nothing here invents a backend.
 */

import {
  login, unlock, restoreSession, tryAutoUnlock, logout,
  hasLocalAccount, getClient, setProgress, setRecoveryKeyProvider,
} from '../src/client.js';
import { setNamespace, setOptimisticHook } from '../src/operators.js';
import { defSchema } from '../src/operators.js';
import { OutboxFlusher } from '../src/outbox.js';
import {
  createRoom, discoverRooms, getTimeline, onTimeline, onDecrypted,
  onRoomChanges, loadTimelineSince,
} from '../src/rooms.js';
import { fold, foldFrom, initial } from '../src/fold.js';

import { NAMESPACE, ROOM_TYPE, SCHEMA } from './dfr.js';
import * as sel from './selectors.js';
import { Scraper } from './scraper.js';
import { hydrateStreaming, fetchDataset } from './hydrate.js';
import { DfrMap } from './mapview.js';

const $ = (id) => document.getElementById(id);

// ── app state ──
let state = initial();
let currentRoomId = null;
let pending = [];          // optimistic events not yet confirmed in the timeline
let unsubTimeline = null, unsubDecrypt = null;
let flusher = null, scraper = null, dfrMap = null;
let hydrateAbort = null;
let refoldScheduled = false;

// ── activity log ──
function log(msg, level = 'mut') {
  const el = $('log');
  if (!el) return;
  const line = document.createElement('div');
  line.className = level;
  line.textContent = `${new Date().toLocaleTimeString()}  ${msg}`;
  el.appendChild(line);
  el.scrollTop = el.scrollHeight;
  while (el.children.length > 200) el.removeChild(el.firstChild);
}

// ── auth ──
function hostFrom(hs) { try { return new URL(hs).host; } catch { return hs.replace(/^https?:\/\//, ''); } }
function loginStatus(msg, err = false) {
  const el = $('loginStatus');
  el.textContent = msg || '';
  el.classList.toggle('err', !!err);
}

async function doSignIn() {
  const hs = $('hs').value.trim();
  const u = $('user').value.trim();
  const pw = $('pw').value;
  const persist = $('persist').checked;
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
  } catch (e) {
    loginStatus(e.message || String(e), true);
  } finally {
    $('signin').disabled = false;
  }
}

async function onAuthed() {
  const client = getClient();
  if (!client) { loginStatus('Connected but no client — try again.', true); return; }
  $('who').textContent = client.getUserId();
  $('login').classList.add('hidden');
  $('app').classList.remove('hidden');

  // Optimistic dispatch: show emitted operators before the server echoes.
  setOptimisticHook(({ roomId, event }) => {
    if (roomId === currentRoomId) { pending.push(event); scheduleRefold(); }
  });

  // Offline-first send queue. Re-render when an entry is acknowledged.
  flusher = new OutboxFlusher({ getClient, onAck: () => scheduleRefold() });
  flusher.start();

  scraper = new Scraper({
    getRoomId: () => currentRoomId,
    getKnown: () => sel.knownFlightKeys(state),
    log,
  });
  scraper.onChange = renderScraper;
  $('interval').value = scraper.intervalMin;
  $('proxy').value = scraper.proxy;

  onRoomChanges(() => refreshRooms());
  await refreshRooms();
}

async function doLogout() {
  try { scraper?.stop(); flusher?.stop(); } catch {}
  await logout();
  location.reload();
}

// ── rooms (datasets) ──
async function refreshRooms() {
  const rooms = discoverRooms(ROOM_TYPE);
  const selEl = $('roomSel');
  selEl.innerHTML = '';
  for (const r of rooms) {
    const opt = document.createElement('option');
    opt.value = r.roomId;
    opt.textContent = r.name + (r.membership === 'invite' ? ' (invite)' : '');
    selEl.appendChild(opt);
  }
  if (!rooms.length) {
    const opt = document.createElement('option');
    opt.textContent = '— no dataset yet —';
    opt.disabled = true;
    selEl.appendChild(opt);
    log('No DFR dataset room found. Click "+ Dataset" to create one.', 'warn');
    return;
  }
  if (!currentRoomId || !rooms.some(r => r.roomId === currentRoomId)) {
    await openRoom(rooms[0].roomId);
  } else {
    selEl.value = currentRoomId;
  }
}

async function createDataset() {
  const name = prompt('Name this DFR dataset room:', 'Nashville DFR');
  if (!name) return;
  $('newRoom').disabled = true;
  try {
    const roomId = await createRoom(name, ROOM_TYPE);
    // Write the schema-as-log so a fresh client can render without prior knowledge.
    await defSchema(roomId, 'version', SCHEMA.version);
    await defSchema(roomId, 'tables', SCHEMA.tables);
    log(`Created dataset "${name}".`, 'ok');
    await refreshRooms();
    await openRoom(roomId);
  } catch (e) {
    log(`Create failed: ${e.message}`, 'err');
  } finally {
    $('newRoom').disabled = false;
  }
}

async function openRoom(roomId) {
  if (unsubTimeline) unsubTimeline();
  if (unsubDecrypt) unsubDecrypt();
  currentRoomId = roomId;
  pending = [];
  state = initial();
  $('roomSel').value = roomId;
  render();
  log('Loading dataset timeline…');
  try {
    await loadTimelineSince(roomId, 0);
  } catch (e) {
    log(`Timeline load: ${e.message}`, 'warn');
  }
  unsubTimeline = onTimeline(roomId, () => scheduleRefold());
  unsubDecrypt = onDecrypted(roomId, () => scheduleRefold());
  refold();
  log('Dataset ready.', 'ok');
}

// ── fold ──
function collectTxns(events) {
  const s = new Set();
  for (const ev of events) {
    const u = typeof ev.getUnsigned === 'function' ? ev.getUnsigned() : ev.unsigned;
    if (u && u.transaction_id) s.add(u.transaction_id);
    const id = typeof ev.getId === 'function' ? ev.getId() : ev.event_id;
    if (id) s.add(id);
  }
  return s;
}

function scheduleRefold() {
  if (refoldScheduled) return;
  refoldScheduled = true;
  requestAnimationFrame(() => { refoldScheduled = false; refold(); });
}

function refold() {
  if (!currentRoomId) return;
  const events = getTimeline(currentRoomId);
  const txns = collectTxns(events);
  pending = pending.filter(p => !txns.has(p.event_id));
  state = foldFrom(fold(events), pending);
  render();
}

// ── render ──
let tab = 'map';
function render() {
  const s = sel.stats(state);
  $('sFlights').textContent = s.flights;
  $('sSites').textContent = s.sites;
  $('sGeom').textContent = s.withGeometry;
  $('sSnap').textContent = s.snapshots;
  const span = (s.earliest && s.latest)
    ? `${new Date(s.earliest).toLocaleDateString()} – ${new Date(s.latest).toLocaleDateString()}`
    : '—';
  let extra = `span ${span}`;
  if (s.undecryptable) extra += ` · ${s.undecryptable} awaiting keys`;
  if (s.violations) extra += ` · ${s.violations} fold violations`;
  $('span').textContent = extra;

  if (tab === 'table') renderTable();
  if (tab === 'map') renderMap();
}

function renderTable() {
  const fl = sel.flights(state);
  const rows = fl.slice(0, 1000).map(f => `<tr>
    <td><span class="dot" style="background:var(--red)"></span>${esc(f.flight_purpose || '')}</td>
    <td>${esc(f.external_id || f.flight_id || '')}</td>
    <td>${f.takeoff ? new Date(f.takeoff).toLocaleString() : ''}</td>
    <td>${f.duration_min ?? ''}</td>
    <td>${f.num_points ?? ''}</td>
    <td>${f.geometry ? (f.geometry.__media ? 'block' : 'inline') : '—'}</td>
  </tr>`).join('');
  $('tableView').innerHTML = `<table>
    <thead><tr><th>Purpose</th><th>Case / Flight ID</th><th>Takeoff</th>
      <th>Min</th><th>Pts</th><th>Geometry</th></tr></thead>
    <tbody>${rows || '<tr><td colspan="6" style="color:var(--mut)">No flights yet. Start the scraper or hydrate a dataset.</td></tr>'}</tbody>
  </table>`;
}

function ensureMap() {
  if (dfrMap) return dfrMap;
  if (typeof L === 'undefined') { log('Leaflet failed to load (offline?).', 'warn'); return null; }
  dfrMap = new DfrMap('map');
  return dfrMap;
}

function renderMap() {
  const m = ensureMap();
  if (!m) return;
  m.renderSites(sel.sites(state));
  m.renderFlights(sel.flights(state));
}

// ── scraper UI ──
function renderScraper(st = scraper?.state) {
  if (!st) return;
  const pill = $('scrapeState');
  pill.textContent = st.busy ? 'polling…' : (st.running ? 'on' : 'off');
  pill.classList.toggle('on', st.running);
  $('scrapeToggle').textContent = st.running ? 'Stop' : 'Start';
}

// ── hydration UI ──
function setHydrateProgress(p) {
  const total = +$('hydrateMax').value || 0;
  if (total > 0) $('hydrateBar').style.width = Math.min(100, (p.recorded / total) * 100) + '%';
  $('hydrateProg').textContent = p.done
    ? `Done — ${p.recorded} recorded (${p.flights} flights, ${p.sites} sites) from ${p.seen} seen.`
    : `Seen ${p.seen} · recorded ${p.recorded} (${p.flights} flights, ${p.sites} sites)`;
}

async function runHydration(source) {
  if (!currentRoomId) { log('Open or create a dataset first.', 'warn'); return; }
  const max = +$('hydrateMax').value || Infinity;
  hydrateAbort = new AbortController();
  $('hydrateAbort').disabled = false;
  $('hydrateUrlBtn').disabled = true;
  log('Hydrating…');
  try {
    const res = await hydrateStreaming(currentRoomId, source, {
      max, signal: hydrateAbort.signal, onProgress: setHydrateProgress,
    });
    log(`Hydration complete: ${res.recorded} records.`, 'ok');
  } catch (e) {
    if (e.name === 'AbortError') log('Hydration stopped.', 'mut');
    else log(`Hydration failed: ${e.message}`, 'err');
  } finally {
    hydrateAbort = null;
    $('hydrateAbort').disabled = true;
    $('hydrateUrlBtn').disabled = false;
  }
}

function esc(s) {
  return String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
}

// ── tabs ──
function setTab(t) {
  tab = t;
  $('tabMap').setAttribute('aria-selected', t === 'map');
  $('tabTable').setAttribute('aria-selected', t === 'table');
  $('mapView').classList.toggle('hidden', t !== 'map');
  $('tableView').classList.toggle('hidden', t !== 'table');
  if (t === 'map') { renderMap(); dfrMap?.invalidate(); }
  else renderTable();
}

// ── wire DOM ──
function wire() {
  $('signin').addEventListener('click', doSignIn);
  $('pw').addEventListener('keydown', e => { if (e.key === 'Enter') doSignIn(); });
  $('logout').addEventListener('click', doLogout);
  $('newRoom').addEventListener('click', createDataset);
  $('roomSel').addEventListener('change', e => openRoom(e.target.value));

  $('tabMap').addEventListener('click', () => setTab('map'));
  $('tabTable').addEventListener('click', () => setTab('table'));

  $('scrapeToggle').addEventListener('click', () => {
    if (!scraper) return;
    scraper.configure({ intervalMin: $('interval').value, proxy: $('proxy').value });
    scraper.running ? scraper.stop() : scraper.start();
  });
  $('pollNow').addEventListener('click', () => {
    scraper?.configure({ intervalMin: $('interval').value, proxy: $('proxy').value });
    scraper?.pollOnce();
  });
  $('interval').addEventListener('change', () => scraper?.configure({ intervalMin: $('interval').value }));
  $('proxy').addEventListener('change', () => scraper?.configure({ proxy: $('proxy').value }));

  $('hydrateUrlBtn').addEventListener('click', async () => {
    const url = $('hydrateUrl').value.trim();
    if (!url) { log('Enter a dataset URL.', 'warn'); return; }
    try {
      const resp = await fetchDataset(url, { signal: (hydrateAbort = new AbortController()).signal });
      await runHydrationFromResponse(resp);
    } catch (e) { log(`Fetch failed: ${e.message}`, 'err'); }
  });
  $('hydrateFile').addEventListener('change', e => {
    const file = e.target.files?.[0];
    if (file) runHydration(file);
  });
  $('hydrateAbort').addEventListener('click', () => hydrateAbort?.abort());
}

// fetchDataset already created an AbortController on hydrateAbort; reuse it.
async function runHydrationFromResponse(resp) {
  const max = +$('hydrateMax').value || Infinity;
  $('hydrateAbort').disabled = false;
  $('hydrateUrlBtn').disabled = true;
  log('Hydrating from URL…');
  try {
    const res = await hydrateStreaming(currentRoomId, resp, {
      max, signal: hydrateAbort?.signal, onProgress: setHydrateProgress,
    });
    log(`Hydration complete: ${res.recorded} records.`, 'ok');
  } catch (e) {
    if (e.name === 'AbortError') log('Hydration stopped.', 'mut');
    else log(`Hydration failed: ${e.message}`, 'err');
  } finally {
    hydrateAbort = null;
    $('hydrateAbort').disabled = true;
    $('hydrateUrlBtn').disabled = false;
  }
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
    if (auto && auto.userId && getClient()) {
      loginStatus('');
      await onAuthed();
      return;
    }
  } catch (e) {
    console.warn('[boot] auto-unlock failed:', e);
  }
  loginStatus('');
}

boot();

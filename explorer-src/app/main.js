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
         invite, getMembers, loadRoomMembers, onMembersChange,
         onTimeline, onDecrypted } from '../src/rooms.js';
import { createSpace, parseSpaceFromUrl, openSpaceFromLink, spaceUrl, setUrlToSpace } from './space.js';

import { NAMESPACE, ROOM_TYPE, ONLY_SPACE_UUID } from './dfr.js';
import { DataStore } from './datastore.js';
import { onDatasetState } from './roomstate.js';
import * as sel from './selectors.js';
import { Scraper } from './scraper.js';
import { DfrMap } from './mapview.js';
import { DepartmentsView } from './departments.js';
import { Swarm } from './swarm.js';
import { Activity, act, Term } from './activity.js';
import { loadACS, loadTractGeom, acsLabel, overflownTracts, contrast, choroplethColor } from './census.js';
import { exportFlights } from './export.js';

const $ = (id) => document.getElementById(id);
let deptsView = null, swarm = null;

let store = null, scraper = null, dfrMap = null;
let currentRoomId = null, unsubDatasetState = null, unsubMembers = null, unsubTimeline = null;
let currentSpace = null;   // { roomId, uuid, url } for the active space
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

// ── Terminal view (mirrors `python3 dfr.py` output) ──
function renderTerminal() {
  const el = $('termBody');
  if (!el) return;
  el.textContent = Term.lines.join('\n');
  if ($('termFollow')?.checked) el.scrollTop = el.scrollHeight;
}

// ── Room Events view (diagnostic: what's actually in the Matrix timeline) ──
function renderEvents() {
  const el = $('eventsBody'); if (!el || !store) return;
  const evs = store.roomEvents(800);
  const flightEvents = evs.filter(e => /flight/.test(e.summary)).length;
  $('eventsCount').textContent = `${evs.length} events · ${flightEvents} flight · ${store.unrolledCount()} loose · ${store.flights.length.toLocaleString()} in set`;
  el.innerHTML = evs.map(e => {
    const t = e.ts ? new Date(e.ts).toISOString().slice(5, 16).replace('T', ' ') : '';
    return `<div class="ev-row${e.redacted ? ' redacted' : ''}"><span class="t">${t}</span><span class="ty">${esc(e.type)}</span><span class="s">${esc(e.summary)}</span></div>`;
  }).join('') || '<div class="empty">No room events in the loaded timeline.</div>';
}

// ── Demographics view ──
let demoData = null;   // { year, byGeoid, feats, overflown, metric }
async function guessCountyFips() {
  // Use the densest flight start as the probe point; reverse-geocode to FIPS via
  // the Census geographies service.
  const fl = store?.flights || [];
  const pt = fl.find(f => f.start_coords)?.start_coords;
  if (!pt) return '';
  const url = `https://geocoding.geo.census.gov/geocoder/geographies/coordinates?x=${pt[0]}&y=${pt[1]}` +
              `&benchmark=Public_AR_Current&vintage=Current_Current&layers=Counties&format=json`;
  try {
    const proxy = $('proxy').value.trim();
    const r = await import('./dfr.js').then(m => m.feedFetch(url, proxy));
    const c = r?.result?.geographies?.Counties?.[0];
    if (c) return `${c.STATE}${c.COUNTY}`;
  } catch {}
  return '';
}

async function loadDemographics() {
  const m = $('demoMetric').value;
  let fips = $('demoFips').value.trim().replace(/[^0-9]/g, '');
  if (!fips) { fips = await guessCountyFips(); if (fips) $('demoFips').value = fips; }
  if (fips.length < 4) { $('demoBody').innerHTML = '<div class="empty">Enter a 5-digit county FIPS (state+county), e.g. 47037.</div>'; return; }
  const stateFips = fips.slice(0, 2), countyFips = fips.slice(2);
  const proxy = $('proxy').value.trim();
  $('demoBody').innerHTML = '<div class="empty">Loading ACS + tract geometry…</div>';
  try {
    const [{ year, byGeoid }, feats] = await Promise.all([
      loadACS(stateFips, countyFips, proxy),
      loadTractGeom(stateFips, countyFips, proxy),
    ]);
    const over = overflownTracts(feats, store?.flights || []);
    demoData = { year, byGeoid, feats, overflown: over, metric: m };
    renderDemographics();
    // Shade the tracts on the map too.
    if (dfrMap) dfrMap.renderTracts(feats, (geoid) => choroplethColor(byGeoid[geoid]?.[m], m), over);
    act.info(`Loaded ${Object.keys(byGeoid).length} tracts (${acsLabel(year)}); ${over.size} overflown`);
  } catch (e) {
    $('demoBody').innerHTML = `<div class="empty">Failed: ${esc(e.message)}</div>`;
  }
}

// Optional tract layer on the Map tab. Reuses the Demographics data if loaded;
// otherwise loads tracts for the county under the map center.
let tractsOn = false;
async function toggleTracts(on) {
  tractsOn = on;
  const m = ensureMap();
  if (!m) return;
  if (!on) { m.clearTracts(); return; }
  setTab('map');
  if (demoData?.feats) {
    m.renderTracts(demoData.feats, (g) => choroplethColor(demoData.byGeoid[g]?.[demoData.metric || 'pct_poverty'], demoData.metric || 'pct_poverty'), demoData.overflown);
    return;
  }
  // No demographics loaded yet — fetch tracts for the county under the center.
  try {
    const fips = await guessCountyFips();
    if (!fips || fips.length < 4) { log('Load Demographics (county FIPS) to shade tracts.', 'warn'); $('tractToggle').checked = false; tractsOn = false; return; }
    const proxy = $('proxy').value.trim();
    log('Loading census tracts…', 'mut');
    const feats = await loadTractGeom(fips.slice(0, 2), fips.slice(2), proxy);
    const over = overflownTracts(feats, store?.flights || []);
    m.renderTracts(feats, () => 'rgba(43,103,119,0.18)', over);
    log(`Tracts on: ${feats.length} (${over.size} overflown).`, 'ok');
  } catch (e) { log(`Tracts failed: ${e.message}`, 'err'); $('tractToggle').checked = false; tractsOn = false; }
}

const DEMO_ROWS = [
  ['population', 'Population', (v) => v?.toLocaleString() ?? '—', false],
  ['pct_black', '% Black', (v) => v != null ? v + '%' : '—', true],
  ['pct_hispanic', '% Hispanic', (v) => v != null ? v + '%' : '—', true],
  ['pct_white', '% White', (v) => v != null ? v + '%' : '—', false],
  ['pct_poverty', '% in poverty', (v) => v != null ? v + '%' : '—', true],
  ['unemployment_rate', 'Unemployment', (v) => v != null ? v + '%' : '—', true],
  ['median_household_income', 'Median income', (v) => v != null ? '$' + v.toLocaleString() : '—', false],
];
function renderDemographics() {
  if (!demoData) { $('demoBody').innerHTML = '<div class="empty">Load demographics to compare.</div>'; return; }
  const c = contrast(demoData.byGeoid, demoData.overflown);
  const fmtRow = ([k, label, fmt, higherIsWorse]) => {
    const o = c.overflown?.[k], r = c.rest?.[k];
    let delta = '';
    if (typeof o === 'number' && typeof r === 'number' && r !== 0) {
      const d = o - r; const cls = (d > 0) === !!higherIsWorse ? 'up' : 'down';
      delta = `<span class="delta ${cls}">${d > 0 ? '+' : ''}${(+d.toFixed(1)).toLocaleString()}</span>`;
    }
    return `<tr><td>${label}</td><td class="over">${fmt(o)}</td><td>${fmt(r)}</td><td>${delta}</td></tr>`;
  };
  $('demoBody').innerHTML = `
    <table class="demo-cmp"><thead><tr>
      <th>Metric</th><th>Overflown tracts</th><th>Rest of county</th><th>Δ</th>
    </tr></thead><tbody>${DEMO_ROWS.map(fmtRow).join('')}</tbody></table>
    <div class="demo-note">${c.nOverflown} of ${c.nTotal} census tracts intersect a drone flight ·
      ${esc(acsLabel(demoData.year))} · race/ethnicity from B03002. "Overflown" = any sampled flight-path
      point falls inside the tract. Δ compares overflown vs. the rest of the county (red = higher where that
      typically signals disadvantage). Tracts are shaded on the Map tab by the selected metric.</div>`;
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
  // On phones the side panel is an off-canvas drawer — start it closed. On
  // desktop, honor the saved collapse preference.
  const isMobile = window.matchMedia('(max-width:760px)').matches;
  let collapsed = false;
  try { collapsed = isMobile || localStorage.getItem('dfr.sideHidden') === '1'; } catch { collapsed = isMobile; }
  $('mainGrid').classList.toggle('side-hidden', collapsed);

  store = new DataStore({ log });
  store.onChange = scheduleRender;
  store.onBusy = showLoading;
  scraper = new Scraper({ store, log, term: (line) => Term.write(line) });
  scraper.onChange = renderScraper;
  swarm = new Swarm({ getRoomId: () => currentRoomId, log, onPeersChange: () => {} });
  $('interval').value = scraper.intervalMin;
  $('proxy').value = scraper.proxy;

  installLeaveGuard();

  // Single-space lock: this app only ever opens the canonical DFR space. Hide
  // the room selector + "+ Space", force the deep link to that UUID, and open it.
  if (ONLY_SPACE_UUID) {
    $('roomSel')?.classList.add('hidden');
    $('newSpace')?.classList.add('hidden');
    const homeserver = getClient()?.getUserId()?.split(':').slice(1).join(':');
    log('Opening the DFR space…', 'mut');
    const roomId = await openSpaceFromLink({ uuid: ONLY_SPACE_UUID, server: homeserver });
    if (roomId) { setUrlToSpace(ONLY_SPACE_UUID); await openRoom(roomId); }
    else log('Could not open the DFR space — you may need an invite to it.', 'warn');
    return;
  }

  onRoomChanges(() => refreshRooms());
  // Deep link: if the URL points at a space (#/s/<uuid>:<server>), open it
  // directly (joining if invited) instead of the default room list.
  const link = parseSpaceFromUrl();
  if (link) {
    log(`Opening shared space ${link.uuid.slice(0, 8)}…`, 'mut');
    const roomId = await openSpaceFromLink(link);
    if (roomId) { await refreshRooms(); await openRoom(roomId); return; }
    log('Could not open that space link — you may need an invite from its owner.', 'warn');
  }
  await refreshRooms();
}

// Don't lose scraped flights when the user leaves: push unpublished data to the
// room as soon as the tab is hidden (the reliable "leaving" signal — a full
// async media upload can't complete during beforeunload), and warn if they try
// to close with data still pending / mid-publish.
let _leaveGuardInstalled = false;
function installLeaveGuard() {
  if (_leaveGuardInstalled) return;
  _leaveGuardInstalled = true;

  const flush = (why) => {
    if (!store || store.dirty <= 0) return;
    log(`Flushing ${store.dirty} unpublished flight(s) to the room (${why})…`, 'mut');
    // Fire-and-forget: visibilitychange/pagehide still allow async work to run
    // while the tab is backgrounded, which is when this fires.
    store.flushNow().catch(e => log(`Flush failed: ${e.message}`, 'err'));
  };

  // Primary trigger: tab hidden (switching away / closing on mobile & desktop).
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden') flush('tab hidden'); });
  // Secondary: page being unloaded (best-effort).
  window.addEventListener('pagehide', () => flush('page hide'));

  // Last-ditch warning if there's still unpublished data (or a publish racing).
  window.addEventListener('beforeunload', (e) => {
    if (store && (store.dirty > 0 || store.publishing)) {
      e.preventDefault();
      e.returnValue = 'New flights are still syncing to the room — leave anyway?';
      return e.returnValue;
    }
  });
}

async function doLogout() {
  try { if (store?.dirty > 0) await store.flushNow(); } catch {}
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

async function createNewSpace() {
  const name = prompt('Name this new DFR space:', 'Nashville DFR');
  if (!name) return;
  $('newSpace').disabled = true;
  try {
    const { roomId, uuid, url } = await createSpace(name);
    currentSpace = { roomId, uuid, url };
    log(`Created space "${name}".`, 'ok');
    await refreshRooms();
    await openRoom(roomId);
    setUrlToSpace(uuid);                         // put the deep link in the address bar
    try { await navigator.clipboard?.writeText(url); } catch {}
    log(`Share link (copied): ${url}`, 'ok');
    prompt('Space created — link copied. Invite people in the Members panel, then send them this URL; once invited they open it and see the data:', url);
  } catch (e) { log(`Create failed: ${e.message}`, 'err'); }
  finally { $('newSpace').disabled = false; }
}

let _openingRoom = null;
async function openRoom(roomId) {
  // Idempotent / re-entrancy guard: never open the same room twice (the deep
  // link + refreshRooms + onRoomChanges all raced openRoom, and the second
  // open clobbered the freshly-loaded working set in OPFS).
  if (roomId === currentRoomId || roomId === _openingRoom) { $('roomSel').value = roomId; return; }
  _openingRoom = roomId;
  if (unsubDatasetState) unsubDatasetState();
  if (unsubMembers) unsubMembers();
  if (unsubTimeline) unsubTimeline();
  if (swarm) { swarm.lowerHand(); swarm.stop(); }
  currentRoomId = roomId;
  $('roomSel').value = roomId;
  dfrMap && (dfrMap._fitDone = false);
  agenciesDrawn = false;
  // Reflect this space's UUID in the address bar so the URL is shareable.
  try {
    const meta = getClient()?.getRoom(roomId)?.currentState.getStateEvents('org.dfr.explorer.meta', '');
    const sid = meta?.getContent()?.space_uuid;
    if (sid) { currentSpace = { roomId, uuid: sid, url: spaceUrl(sid) }; setUrlToSpace(sid); }
  } catch {}
  log('Opening dataset…');
  const { hydrated } = await store.open(roomId);
  _openingRoom = null;   // open completed; allow future (different) opens
  render();
  // React to snapshots published by peers (intelligent, version-gated sync).
  unsubDatasetState = onDatasetState(roomId, async () => {
    log('Dataset pointer changed — syncing…', 'mut');
    await store.sync(); render();
  });
  // Live flight events (from this device or peers) fold into the working set as
  // they arrive — durable the moment they're sent, no waiting for a block.
  const onFlightEvents = async () => { if (await store.mergeLooseEvents()) scheduleRender(); };
  const u1 = onTimeline(roomId, onFlightEvents);
  const u2 = onDecrypted(roomId, onFlightEvents);
  unsubTimeline = () => { u1(); u2(); };
  // Member list + live updates (joins, invites, power-level changes).
  unsubMembers = onMembersChange(roomId, () => renderMembers());
  renderMembers();
  if (swarm) swarm.start();
  if (!hydrated) openGate('hydrate');
  else log('Dataset ready.', 'ok');
  // Auto-start background checking whenever a dataset is open — no manual "Start"
  // needed, hydrated or not. Honors a saved opt-out (a prior manual Stop).
  if (scraper && !scraper.running && scraper.autoStart !== false) {
    scraper.configure({ intervalMin: $('interval').value, proxy: $('proxy').value });
    scraper.start();
  }
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
  // In lazy (sharded) mode the working set only holds loaded departments; show
  // the dataset's TRUE total from the manifest, with loaded shown alongside.
  const lazyTotal = store?.isLazy() ? (store.deptManifest?.total ?? null) : null;
  $('sFlights').textContent = lazyTotal != null
    ? (lazyTotal.toLocaleString() + (flights.length ? ` (${flights.length.toLocaleString()} loaded)` : ''))
    : s.flights.toLocaleString();
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

  // Keep the departments aggregate in sync with the working set even when the
  // Departments tab isn't visible (so its counts never lag the map). The view's
  // own _sig guard makes this cheap when nothing changed.
  if (deptsView) deptsView.refresh();
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
  dfrMap.onCount = (shown, total, capped, inViewAllTime) => {
    if (!total) return setFocusHint('');
    // shown = in viewport AND inside the time window; inViewAllTime = in
    // viewport regardless of time. Surface the time-filtered hidden count so a
    // viewport vs. department mismatch is explained by the cursor, not a bug.
    const hidden = (inViewAllTime ?? shown) - shown;
    setFocusHint(`${shown.toLocaleString()} flights here` +
      (hidden > 0 ? ` (${hidden} outside the time window)` : '') +
      (capped ? ' · capped, zoom in' : ''));
  };
  dfrMap.onFlight = (f) => showFlight(f);
  // The time window filter (applied per-marker in the map's viewport render).
  dfrMap.timeFilter = (f) => inWindow(f);
  return dfrMap;
}

// ── flight details panel ──
function deptLabelFor(orgId) {
  const a = (store?.agencies || []).find(x => x.id === orgId);
  return a ? (a.name || [a.city, a.county, a.state].filter(Boolean).join(', ') || orgId) : (orgId || '—');
}
function showFlight(f) {
  const panel = $('flightPanel');
  $('fpTitle').textContent = f.flight_purpose || 'DFR flight';
  const fmt = (ms) => ms ? new Date(ms).toISOString().slice(0, 16).replace('T', ' ') + ' UTC' : '—';
  const dept = deptLabelFor(f.organization_id);
  const rows = [
    ['Purpose', `<span class="fp-purpose">${esc(f.flight_purpose || 'unspecified')}</span>`, true],
    ['Department', `<a class="fp-dept" id="fpDept">${esc(dept)}</a>`, true],
    ['Flight ID', esc(f.flight_id || '—')],
    ['Case / ext', esc(f.external_id || '—')],
    ['Takeoff', fmt(f.takeoff)],
    ['Landing', fmt(f.landing)],
    ['Duration', f.duration_min != null ? f.duration_min + ' min' : '—'],
    ['Path points', f.num_points != null ? f.num_points.toLocaleString() : '—'],
    ['Start', f.start_coords ? f.start_coords.map(n => n.toFixed(5)).join(', ') : '—'],
    ['End', f.end_coords ? f.end_coords.map(n => n.toFixed(5)).join(', ') : '—'],
    ['Org UUID', esc(f.organization_id || '—')],
  ];
  // Other flights from the SAME department — a quick picker to jump between them.
  const sibs = (store?.flights || [])
    .filter(x => x.organization_id === f.organization_id && x !== f)
    .sort((a, b) => (b.takeoff || 0) - (a.takeoff || 0))
    .slice(0, 200);
  const sibList = sibs.length ? `
    <div class="fp-sibs">
      <div class="fp-sibs-h">${sibs.length}＋ flights from ${esc(dept)} — pick one</div>
      ${sibs.map((s, i) => `<button class="fp-sib" data-i="${i}">
        <span class="fp-sib-p">${esc(s.flight_purpose || 'flight')}</span>
        <span class="fp-sib-t">${s.takeoff ? new Date(s.takeoff).toISOString().slice(0, 10) : ''}</span>
      </button>`).join('')}
    </div>` : '';

  $('fpBody').innerHTML = rows.map(([k, v, raw]) =>
    `<dl class="fp-row"><dt>${k}</dt><dd>${raw ? v : esc(v)}</dd></dl>`).join('') +
    (f.geometry ? '' : '<div class="hint">No path geometry in the index for this flight.</div>') +
    sibList;
  panel.classList.remove('hidden');

  // Clicking a sibling flight selects it (draws its path + re-opens the panel).
  $('fpBody').querySelectorAll('.fp-sib').forEach(btn => btn.onclick = () => {
    const s = sibs[+btn.getAttribute('data-i')];
    if (s) { dfrMap?.drawPath(s); showFlight(s); }
  });
  // Clicking the department name jumps to its detail in the Departments tab.
  const dEl = $('fpDept');
  if (dEl && f.organization_id) dEl.onclick = () => {
    setTab('depts');
    const dv = ensureDepts();
    dv.selected = f.organization_id; dv.page = 0;
    dv.renderSidebar(); dv.renderMain();
  };
}
function hideFlight() { $('flightPanel').classList.add('hidden'); }
let agenciesDrawn = false;
// Time scrubber: a draggable WINDOW [fromFrac, toFrac] over the dataset's FIXED
// full time span. The span is computed once from the whole dataset (not on every
// pan — that's what felt broken), so a handle position always means the same
// date. Showing flights whose takeoff falls inside the window.
let timeSpan = null;       // { min, max } in ms over ALL flights (fixed slider scale)
let fromFrac = 0, toFrac = 1;
let handleHeld = false;    // user is dragging a handle → don't auto-move the window

/** Compute the fixed full-dataset span (slider scale) when flights change. */
function computeFullSpan(flights) {
  let min = Infinity, max = 0;
  for (const f of flights) if (f.takeoff) { if (f.takeoff < min) min = f.takeoff; if (f.takeoff > max) max = f.takeoff; }
  timeSpan = (min === Infinity) ? null : (min === max ? { min, max: min + 1 } : { min, max });
}

/**
 * Set the window to [earliest in-view flight → now]. Called on initial render
 * and whenever the map is panned/zoomed (unless the user is holding a handle),
 * so the left edge always tracks the earliest flight actually visible.
 */
function windowToViewport() {
  if (!timeSpan || handleHeld) return;
  let inViewMin = Infinity;
  const bb = dfrMap ? dfrMap.bbox() : null;
  for (const f of (store?.flights || [])) {
    if (!f.takeoff) continue;
    const c = f.start_coords;
    if (bb && !(c && c.length >= 2 && c[0] >= bb[0] && c[0] <= bb[2] && c[1] >= bb[1] && c[1] <= bb[3])) continue;
    if (f.takeoff < inViewMin) inViewMin = f.takeoff;
  }
  const start = inViewMin === Infinity ? timeSpan.min : inViewMin;
  const span = timeSpan.max - timeSpan.min;
  fromFrac = span > 0 ? Math.max(0, Math.min(1, (start - timeSpan.min) / span)) : 0;
  toFrac = 1;
  syncTimeInputs();
  updateTimeLabel();
}

const fracToTs = (fr) => timeSpan ? timeSpan.min + (timeSpan.max - timeSpan.min) * fr : 0;

/** The map's per-flight filter: inside the [from,to] window. */
function inWindow(f) {
  if (!timeSpan) return true;
  if (fromFrac <= 0 && toFrac >= 1) return true;   // full range → show all
  if (!f.takeoff) return false;
  return f.takeoff >= fracToTs(fromFrac) && f.takeoff <= fracToTs(toFrac);
}

function updateTimeLabel() {
  const lbl = $('timeLabel'); if (!lbl) return;
  if (!timeSpan) { lbl.textContent = 'no dated flights'; return; }
  const d = (ms) => new Date(ms).toISOString().slice(0, 10);
  const atNow = toFrac >= 0.999;
  lbl.textContent = (fromFrac <= 0 && toFrac >= 1)
    ? `all · ${d(timeSpan.min)} → ${d(timeSpan.max)}`
    : `${d(fracToTs(fromFrac))} → ${atNow ? 'now' : d(fracToTs(toFrac))}`;
  const fill = $('timeFill');
  if (fill) { fill.style.left = (fromFrac * 100) + '%'; fill.style.width = ((toFrac - fromFrac) * 100) + '%'; }
}

/** Sync the two range inputs from state. */
function syncTimeInputs() {
  $('timeFrom').value = String(Math.round(fromFrac * 1000));
  $('timeTo').value = String(Math.round(toFrac * 1000));
}

let playTimer = null;
function togglePlay() {
  const btn = $('playBtn');
  if (playTimer) { clearInterval(playTimer); playTimer = null; btn.textContent = '▶'; return; }
  if (!timeSpan) return;
  btn.textContent = '⏸';
  // Sweep a fixed-width window across the timeline, so you watch flights appear
  // over time. Window width = current selection, or 10% if at full range.
  let w = (toFrac - fromFrac); if (w >= 1) w = 0.1;
  fromFrac = 0; toFrac = w;
  playTimer = setInterval(() => {
    fromFrac = Math.min(1 - w, fromFrac + 0.02); toFrac = fromFrac + w;
    syncTimeInputs(); updateTimeLabel();
    if (dfrMap) dfrMap.refresh();
    if (toFrac >= 1) { clearInterval(playTimer); playTimer = null; btn.textContent = '▶'; }
  }, 180);
}

function renderMap(flights) {
  const m = ensureMap();
  if (!m) return;
  computeFullSpan(flights);          // fixed span over the whole dataset
  m.render(flights);                 // map filters by viewport + timeFilter
  updateTimeLabel();
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

// Pause the background scraper for the duration of `fn` so a big import isn't
// held up competing for the network / event loop. Always resumes.
async function withImport(fn) {
  try { scraper?.pause(); return await fn(); }
  finally { scraper?.resume(); }
}

async function gateLoad(source) {
  const format = $('gateFormat').value;
  const isFile = typeof source.slice === 'function';
  const raw = format === 'chunked-raw' || (format === 'auto' && isFile && source.size > LARGE_FILE);
  gateAbort = gateAbort || new AbortController();
  $('gateLoad').disabled = true; $('gateStop').disabled = false;
  gateStatus(raw ? 'Uploading as chained blocks…' : 'Loading…');
  scraper?.pause();
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
    scraper?.resume();
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
  for (const [id, name] of [['tabDepts', 'depts'], ['tabMap', 'map'], ['tabActivity', 'activity'], ['tabDemo', 'demo'], ['tabTerm', 'term'], ['tabEvents', 'events']])
    $(id).setAttribute('aria-selected', t === name);
  $('deptsView').classList.toggle('hidden', t !== 'depts');
  $('mapView').classList.toggle('hidden', t !== 'map');
  $('activityView').classList.toggle('hidden', t !== 'activity');
  $('demoView').classList.toggle('hidden', t !== 'demo');
  $('termView').classList.toggle('hidden', t !== 'term');
  $('eventsView').classList.toggle('hidden', t !== 'events');
  if (t === 'map') { renderMap(store?.flights || []); dfrMap?.invalidate(); }
  else if (t === 'depts') ensureDepts().refresh();
  else if (t === 'activity') renderActivity();
  else if (t === 'demo') renderDemographics();
  else if (t === 'term') renderTerminal();
  else if (t === 'events') renderEvents();
}

function ensureDepts() {
  if (deptsView) return deptsView;
  deptsView = new DepartmentsView({
    sidebar: $('deptList'), main: $('deptMain'),
    getData: () => ({ flights: store?.flights || [], agencies: store?.agencies || [] }),
    // In lazy (sharded) mode, the manifest supplies per-department counts before
    // any block is fetched; opening a department pulls just its block.
    deptIndex: () => (store?.isLazy() ? store.deptIndex() : null),
    onSelectDept: async (org) => {
      if (store?.isLazy()) { await store.loadDepartment(org); deptsView.refresh(true); }
      // Live-refresh this department against its ArcGIS feed so its count is
      // current (fixes "stored 45 but the feed has 47").
      try {
        const r = await store.refreshDepartment(org, $('proxy').value.trim());
        if (r.added) { log(`${org.slice(0, 8)}: pulled ${r.added} new from live feed (${r.have}→${r.cnt}).`, 'ok'); deptsView.refresh(true); }
      } catch (e) { /* feed unreachable — keep stored count */ }
    },
    onSyncDept: async (org) => {
      try {
        const r = await store.refreshDepartment(org, $('proxy').value.trim());
        log(r.added ? `${org.slice(0, 8)}: +${r.added} from live feed (${r.have}→${r.cnt}).` : `${org.slice(0, 8)}: up to date (${r.have ?? '?'}).`, 'ok');
      } catch (e) { log(`Sync failed: ${e.message}`, 'err'); }
    },
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
  const setSide = (hidden) => {
    $('mainGrid').classList.toggle('side-hidden', hidden);
    try { localStorage.setItem('dfr.sideHidden', hidden ? '1' : '0'); } catch {}
    if (tab === 'map') dfrMap?.invalidate();   // map reclaims the space
  };
  $('sideToggle').addEventListener('click', () => setSide(!$('mainGrid').classList.contains('side-hidden')));
  // Tapping the dimmed backdrop closes the mobile drawer.
  $('sideScrim').addEventListener('click', () => setSide(true));
  $('newSpace').addEventListener('click', createNewSpace);
  $('copyLinkBtn').addEventListener('click', async () => {
    const url = currentSpace?.url;
    if (!url) { log('Open a space first (or create one).', 'warn'); return; }
    try { await navigator.clipboard?.writeText(url); log(`Share link copied: ${url}`, 'ok'); }
    catch { prompt('Copy this space link:', url); }
  });
  $('redactBtn').addEventListener('click', async () => {
    if (!currentRoomId) { log('Open a room first.', 'warn'); return; }
    if (!confirm('Redact ALL data in this room and reset it to empty? This cannot be undone (the dataset pointer and all flight events are cleared).')) return;
    $('redactBtn').disabled = true;
    try { const r = await store.redactAllData(); log(`Redacted ${r.redacted} events; room is now empty.`, 'ok'); render(); }
    catch (e) { log(`Redact failed: ${e.message}`, 'err'); }
    finally { $('redactBtn').disabled = false; }
  });
  $('inviteBtn').addEventListener('click', doInvite);
  $('inviteId').addEventListener('keydown', e => { if (e.key === 'Enter') doInvite(); });
  $('roomSel').addEventListener('change', e => openRoom(e.target.value));
  $('tabDepts').addEventListener('click', () => setTab('depts'));
  $('tabMap').addEventListener('click', () => setTab('map'));
  $('tabActivity').addEventListener('click', () => setTab('activity'));
  $('tabDemo').addEventListener('click', () => setTab('demo'));
  $('tabTerm').addEventListener('click', () => setTab('term'));
  $('tabEvents').addEventListener('click', () => setTab('events'));
  $('eventsRefresh').addEventListener('click', renderEvents);
  $('demoLoad').addEventListener('click', () => loadDemographics());
  $('demoMetric').addEventListener('change', () => {
    if (!demoData) return;
    demoData.metric = $('demoMetric').value;
    if (dfrMap) dfrMap.renderTracts(demoData.feats, (g) => choroplethColor(demoData.byGeoid[g]?.[demoData.metric], demoData.metric), demoData.overflown);
    renderDemographics();
  });
  $('fpClose').addEventListener('click', hideFlight);
  $('actClear').addEventListener('click', () => { Activity.clear(); renderActivity(); });
  $('termClear').addEventListener('click', () => { Term.clear(); renderTerminal(); });
  // Live-update Activity + Terminal views (cheap repaint only when visible).
  Activity.subscribe(() => { if (tab === 'activity') scheduleActRender(); });
  Term.subscribe(() => { if (tab === 'term') renderTerminal(); });

  // Time scrubber.
  const onWindow = () => {
    let a = (+$('timeFrom').value) / 1000, b = (+$('timeTo').value) / 1000;
    if (a > b) { const t = a; a = b; b = t; }   // keep from ≤ to
    fromFrac = a; toFrac = b;
    updateTimeLabel();
    if (dfrMap) dfrMap.refresh();
  };
  $('timeFrom').addEventListener('input', onWindow);
  $('timeTo').addEventListener('input', onWindow);
  $('timeReset').addEventListener('click', () => {
    fromFrac = 0; toFrac = 1; syncTimeInputs(); updateTimeLabel(); if (dfrMap) dfrMap.refresh();
  });
  $('playBtn').addEventListener('click', togglePlay);
  $('fitBtn').addEventListener('click', () => dfrMap?.fitFlights(true));
  $('exportBtn').addEventListener('click', () => {
    try {
      const flights = store?.flights || [];
      exportFlights(flights, $('exportFmt').value, currentSpace?.uuid ? `dfr-${currentSpace.uuid.slice(0,8)}` : 'dfr-flights');
      log(`Exported ${flights.length.toLocaleString()} flights as ${$('exportFmt').value.toUpperCase()}.`, 'ok');
    } catch (e) { log(`Export failed: ${e.message}`, 'err'); }
  });
  $('tractToggle').addEventListener('change', e => toggleTracts(e.target.checked));
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
    try { const r = await withImport(() => store.buildIndexFromArchive()); log(`Built index: ${r.flights} flights.`, 'ok'); render(); }
    catch (e) { log(`Build index failed: ${e.message}`, 'err'); }
    finally { $('buildIndexBtn').disabled = false; }
  });
  $('reshardBtn').addEventListener('click', async () => {
    if (!confirm('Re-shard the dataset into per-department blocks? Clients will then load only the departments they open. The original raw archive is dropped.')) return;
    $('reshardBtn').disabled = true;
    try { const r = await withImport(() => store.reshardByDepartment()); log(`Re-sharded (v${r.version}, ${r.mode}).`, 'ok'); render(); }
    catch (e) { log(`Re-shard failed: ${e.message}`, 'err'); }
    finally { $('reshardBtn').disabled = false; }
  });
  $('purgeListBtn').addEventListener('click', () => {
    const uris = store?.purgeableMedia() || [];
    if (!uris.length) { log('No orphaned media to purge (re-shard first).', 'warn'); return; }
    // A ready-to-run Synapse admin purge: one DELETE per mxc. Hand to the
    // homeserver admin to reclaim the space the old raw archive occupies.
    const base = '<HOMESERVER_BASE_URL>';
    const lines = [
      '# Orphaned DFR media after re-shard — purge to reclaim space.',
      '# Synapse admin API (needs an admin token):',
      ...uris.map(mxc => {
        const m = /^mxc:\/\/([^/]+)\/(.+)$/.exec(mxc) || [];
        return `curl -X DELETE -H "Authorization: Bearer $ADMIN_TOKEN" "${base}/_synapse/admin/v1/media/${m[1]||'SERVER'}/${m[2]||''}"`;
      }),
      '', '# Raw mxc list:', ...uris,
    ].join('\n');
    const blob = new Blob([lines], { type: 'text/plain' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob); a.download = 'dfr-media-purge.txt'; a.click();
    URL.revokeObjectURL(a.href);
    log(`Purge list downloaded: ${uris.length} media URIs.`, 'ok');
  });

  // Agencies: pick a local NDJSON/JSON file and load it as its own layer.
  $('agenciesBtn').addEventListener('click', () => $('agenciesFile').click());
  $('agenciesFile').addEventListener('change', async e => {
    const file = e.target.files?.[0];
    if (!file) return;
    if (!currentRoomId) { log('Open or create a dataset first.', 'warn'); return; }
    log(`Loading agencies from ${file.name}…`);
    try {
      const r = await withImport(() => store.hydrateAgencies(file, { onProgress: p => log(`…${p.kept} agencies`, 'mut') }));
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

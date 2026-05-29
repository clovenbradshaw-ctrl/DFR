/**
 * memory.js — Memory budget governor
 *
 * Keeps the running tab under a configurable heap ceiling (default 500 MB).
 *
 * A browser tab cannot be given a *hard* allocation limit from inside the
 * page, so this module enforces the budget two ways that work together:
 *
 *   1. Structural caps (deterministic, the real guarantee).
 *      The bridge keeps only a small LRU of rooms hydrated in memory and
 *      drops the matrix-js-sdk timeline for closed rooms. Steady-state
 *      footprint is therefore bounded by `MAX_OPEN_ROOMS × per-room size`
 *      regardless of how many rooms the user visits.
 *
 *   2. Adaptive shedding (best-effort, catches the rest).
 *      When the platform exposes a heap reading, this samples it on an
 *      interval. Crossing the soft threshold runs registered evictors
 *      (close inactive rooms, trim logs, …) before the budget is reached;
 *      crossing the critical threshold runs the aggressive ones too.
 *
 * Heap readings come from `performance.measureUserAgentSpecificMemory()`
 * (accurate, but only in cross-origin-isolated contexts) or the legacy
 * Chromium `performance.memory.usedJSHeapSize`. When neither exists the
 * governor is inert and the structural caps carry the budget alone.
 */

const MB = 1024 * 1024;
const DEFAULT_BUDGET_BYTES = 500 * MB;
const SOFT_FRACTION = 0.80;      // begin shedding here (~400 MB at default)
const CRITICAL_FRACTION = 0.92;  // shed aggressively here (~460 MB)
const SAMPLE_INTERVAL_MS = 10_000;

const LOG_COOLDOWN_MS = 30_000; // throttle pressure logging/listeners (not evictors)

let budgetBytes = DEFAULT_BUDGET_BYTES;
let timer = null;
let evicting = false;
let lastLogAt = 0;
let lastSample = { bytes: 0, source: 'none', at: 0 };

// Evictor: { name, priority (higher sheds first), level: 'soft' | 'critical', fn }
// fn(level) may be async; return a truthy value if it freed something.
const evictors = [];
const pressureListeners = new Set();

export function setBudget(bytes) {
  if (typeof bytes === 'number' && bytes > 0) budgetBytes = bytes;
}
export function getBudget() { return budgetBytes; }

/**
 * Register a function to call under memory pressure. `level` decides when
 * it fires: 'soft' evictors run at the soft threshold (and above), while
 * 'critical' evictors only run once the critical threshold is crossed —
 * use 'critical' for shedding that hurts UX (dropping the active view's
 * caches) and 'soft' for cheap wins (inactive rooms, logs).
 *
 * Returns an unregister function.
 */
export function registerEvictor(name, fn, { priority = 0, level = 'soft' } = {}) {
  const entry = { name, fn, priority, level };
  evictors.push(entry);
  return () => {
    const i = evictors.indexOf(entry);
    if (i >= 0) evictors.splice(i, 1);
  };
}

export function onPressure(fn) {
  pressureListeners.add(fn);
  return () => pressureListeners.delete(fn);
}

/** Best-effort heap reading. Resolves to the last sample on failure. */
export async function sample() {
  try {
    if (typeof performance.measureUserAgentSpecificMemory === 'function'
        && (typeof crossOriginIsolated === 'undefined' || crossOriginIsolated)) {
      const r = await performance.measureUserAgentSpecificMemory();
      lastSample = { bytes: r.bytes, source: 'measureUserAgentSpecificMemory', at: Date.now() };
      return lastSample;
    }
  } catch { /* fall through to the legacy API */ }

  const m = performance.memory;
  if (m && typeof m.usedJSHeapSize === 'number') {
    lastSample = { bytes: m.usedJSHeapSize, source: 'performance.memory', at: Date.now() };
    return lastSample;
  }

  lastSample = { bytes: 0, source: 'unavailable', at: Date.now() };
  return lastSample;
}

export function getStats() {
  return {
    bytes: lastSample.bytes,
    source: lastSample.source,
    at: lastSample.at,
    budgetBytes,
    softBytes: Math.round(budgetBytes * SOFT_FRACTION),
    criticalBytes: Math.round(budgetBytes * CRITICAL_FRACTION),
    fractionUsed: lastSample.bytes ? lastSample.bytes / budgetBytes : null,
  };
}

async function runEvictors(level) {
  const wanted = level === 'critical' ? ['soft', 'critical'] : ['soft'];
  const list = evictors
    .filter(e => wanted.includes(e.level))
    .sort((a, b) => b.priority - a.priority);
  let freed = false;
  for (const e of list) {
    try {
      if (await e.fn(level)) freed = true;
    } catch (err) {
      console.warn('[memory] evictor failed:', e.name, err);
    }
  }
  return freed;
}

/**
 * Sample the heap and shed if over threshold. Safe to call as often as
 * you like — re-entrancy is guarded and it no-ops without a heap signal.
 */
export async function checkPressure() {
  if (evicting) return;
  const s = await sample();
  if (!s.bytes) return; // no signal — structural caps carry the budget

  const frac = s.bytes / budgetBytes;
  let level = null;
  if (frac >= CRITICAL_FRACTION) level = 'critical';
  else if (frac >= SOFT_FRACTION) level = 'soft';
  if (!level) return;

  evicting = true;
  try {
    // Run evictors every interval — the cheap ones (releasing the SDK
    // timeline this app doesn't render from) should run often; the
    // expensive/disruptive ones self-throttle internally. But only *log*
    // and fire pressure listeners once per cooldown, so a heap that's
    // pinned above budget doesn't flood the console every interval.
    await runEvictors(level);
    const now = Date.now();
    if (now - lastLogAt >= LOG_COOLDOWN_MS) {
      lastLogAt = now;
      for (const fn of pressureListeners) {
        try { fn(level, s); } catch { /* listener errors are non-fatal */ }
      }
      console.warn(`[memory] ${level} pressure at ${(s.bytes / MB).toFixed(0)}MB / ${(budgetBytes / MB).toFixed(0)}MB — shedding`);
    }
  } finally {
    evicting = false;
  }
}

export function start(opts = {}) {
  if (opts.budgetBytes) setBudget(opts.budgetBytes);
  if (timer) return; // idempotent
  timer = setInterval(() => { checkPressure(); }, opts.intervalMs || SAMPLE_INTERVAL_MS);
  sample(); // prime lastSample so getStats() has something immediately
}

export function stop() {
  if (timer) { clearInterval(timer); timer = null; }
}

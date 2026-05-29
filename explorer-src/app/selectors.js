/**
 * selectors.js — memo-free projections of fold state into DFR views.
 *
 * Per BUILDING.md §7: never cache a second source of truth. Every view reads
 * derived data from the fold `state` through these pure selectors.
 */

import { entitiesOfType } from '../src/fold.js';
import { ENTITY } from './dfr.js';

export function flights(state) {
  return entitiesOfType(state, ENTITY.FLIGHT)
    .sort((a, b) => (b.takeoff || 0) - (a.takeoff || 0));
}

export function sites(state) {
  return entitiesOfType(state, ENTITY.SITE);
}

export function snapshots(state) {
  return entitiesOfType(state, ENTITY.SNAPSHOT)
    .sort((a, b) => (b._created || 0) - (a._created || 0));
}

export function datasets(state) {
  return entitiesOfType(state, ENTITY.DATASET);
}

/** Set of flight identities already recorded — the scraper's dedup key. */
export function knownFlightKeys(state) {
  const keys = new Set();
  for (const f of entitiesOfType(state, ENTITY.FLIGHT)) {
    if (f.flight_id) keys.add(f.flight_id);
    if (f.object_id != null) keys.add('oid_' + f.object_id);
  }
  return keys;
}

export function stats(state) {
  const fl = flights(state);
  const purposes = {};
  let withGeometry = 0;
  let earliest = Infinity, latest = 0;
  for (const f of fl) {
    const p = f.flight_purpose || '(unspecified)';
    purposes[p] = (purposes[p] || 0) + 1;
    if (f.geometry && f.geometry.__media) withGeometry++;
    if (f.takeoff) { earliest = Math.min(earliest, f.takeoff); latest = Math.max(latest, f.takeoff); }
  }
  return {
    flights: fl.length,
    sites: sites(state).length,
    withGeometry,
    purposes,
    snapshots: snapshots(state).length,
    earliest: earliest === Infinity ? null : earliest,
    latest: latest || null,
    undecryptable: state._undecryptable || 0,
    violations: (state._violations || []).length,
  };
}

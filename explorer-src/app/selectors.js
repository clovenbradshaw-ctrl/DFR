/**
 * selectors.js — pure projections over the in-memory flights array.
 *
 * The dataset is no longer a fold of timeline events; it is the working set
 * held by DataStore. These selectors derive views from `flights[]`.
 */

export function stats(flights) {
  const purposes = {};
  let withGeometry = 0;
  let earliest = Infinity, latest = 0;
  for (const f of flights) {
    const p = f.flight_purpose || '(unspecified)';
    purposes[p] = (purposes[p] || 0) + 1;
    if (f.geometry && f.geometry.coordinates) withGeometry++;
    if (f.takeoff) { earliest = Math.min(earliest, f.takeoff); latest = Math.max(latest, f.takeoff); }
  }
  return {
    flights: flights.length,
    withGeometry,
    purposes,
    earliest: earliest === Infinity ? null : earliest,
    latest: latest || null,
  };
}

export function sortedByTakeoff(flights) {
  return [...flights].sort((a, b) => (b.takeoff || 0) - (a.takeoff || 0));
}

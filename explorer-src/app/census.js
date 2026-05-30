/**
 * census.js — U.S. Census ACS demographics + tract geometry, and the contrast
 * between drone-overflown tracts and the rest of their county/city.
 *
 * Mirrors the proven pipeline in the original DFR index.html:
 *   • Race/ethnicity from detailed table B03002 (real, non-overlapping shares),
 *     plus income / poverty / rent / age tables.
 *   • Tract geometry from Census TIGERweb (ArcGIS), as GeoJSON.
 *   • ACS 5-Year via the Census API; vintage probed newest-first.
 *
 * Contrast model: tracts whose polygon intersects any drone flight (overflown)
 * vs. all other tracts in the same county — so you can see whether the drones
 * concentrate over demographically distinct areas.
 */

import { feedFetch } from './dfr.js';

// Newest-first; loadACS takes the first vintage the API actually serves.
const ACS_YEARS = [2023, 2022, 2021, 2020];

// Same variable set as the original tool (B03002 race + income/poverty/rent/age).
export const ACS_VARS = [
  'B03002_001E', 'B03002_003E', 'B03002_004E', 'B03002_006E', 'B03002_009E', 'B03002_012E',
  'B01003_001E', 'B01002_001E', 'B09001_001E',
  'B19013_001E', 'B19301_001E',
  'B17001_001E', 'B17001_002E',
  'B23025_003E', 'B23025_005E',
  'B25077_001E', 'B25064_001E',
  'B25070_001E', 'B25070_008E', 'B25070_009E', 'B25070_010E', 'B25070_011E',
];

const cNum = (v) => { const n = +v; return Number.isFinite(n) && v != null && v !== '' ? n : null; };
const cPct = (a, b) => (a != null && b) ? +(a / b * 100).toFixed(1) : null;
const cSum = (o, ks) => ks.reduce((s, k) => s + (cNum(o[k]) || 0), 0);

/** One tract's ACS row → readable demographic fields (matches the original). */
export function tractVals(o) {
  const totRace = cNum(o.B03002_001E), pop = cNum(o.B01003_001E);
  const rentTot = cNum(o.B25070_001E), rentNC = cNum(o.B25070_011E);
  const rentDen = (rentTot != null) ? (rentTot - (rentNC || 0)) : null;
  return {
    population: pop,
    median_age: cNum(o.B01002_001E),
    pct_white: cPct(cNum(o.B03002_003E), totRace),
    pct_black: cPct(cNum(o.B03002_004E), totRace),
    pct_asian: cPct(cNum(o.B03002_006E), totRace),
    pct_two_or_more: cPct(cNum(o.B03002_009E), totRace),
    pct_hispanic: cPct(cNum(o.B03002_012E), totRace),
    pct_under_18: cPct(cNum(o.B09001_001E), pop),
    median_household_income: cNum(o.B19013_001E),
    per_capita_income: cNum(o.B19301_001E),
    pct_poverty: cPct(cNum(o.B17001_002E), cNum(o.B17001_001E)),
    median_owner_value: cNum(o.B25077_001E),
    median_monthly_rent: cNum(o.B25064_001E),
    pct_renter_cost_burdened: cPct(cSum(o, ['B25070_008E', 'B25070_009E', 'B25070_010E']), rentDen),
    unemployment_rate: cPct(cNum(o.B23025_005E), cNum(o.B23025_003E)),
    _raw: o,
  };
}

/**
 * Load ACS 5-year tract data for a county (FIPS state+county), newest vintage
 * that answers. Returns { year, byGeoid: { geoid: tractVals } }.
 */
export async function loadACS(stateFips, countyFips, proxy) {
  for (const year of ACS_YEARS) {
    const url = `https://api.census.gov/data/${year}/acs/acs5?get=${ACS_VARS.join(',')}` +
                `&for=tract:*&in=state:${stateFips}&in=county:${countyFips}`;
    try {
      const rows = await feedFetch(url, proxy, { preferProxy: true });
      if (!Array.isArray(rows) || rows.length < 2) continue;
      const hdr = rows[0];
      const byGeoid = {};
      for (let i = 1; i < rows.length; i++) {
        const o = {}; hdr.forEach((h, j) => o[h] = rows[i][j]);
        const geoid = `${o.state}${o.county}${o.tract}`;
        byGeoid[geoid] = tractVals(o);
      }
      return { year, byGeoid };
    } catch { /* try older vintage */ }
  }
  throw new Error('No ACS vintage answered for ' + stateFips + countyFips);
}

export function acsLabel(year) { return `ACS ${year - 4}–${year} 5-Year Estimates`; }

/**
 * Tract polygons for a county from TIGERweb (GeoJSON). geoid = state+county+tract.
 */
export async function loadTractGeom(stateFips, countyFips, proxy) {
  const base = 'https://tigerweb.geo.census.gov/arcgis/rest/services/TIGERweb/Tracts_Blocks/MapServer';
  // Layer 0 is census tracts (current). Filter by state+county.
  const where = `STATE='${stateFips}' AND COUNTY='${countyFips}'`;
  const url = `${base}/0/query?where=${encodeURIComponent(where)}&outFields=GEOID,STATE,COUNTY,TRACT,BASENAME` +
              `&returnGeometry=true&outSR=4326&f=geojson`;
  const gj = await feedFetch(url, proxy, { preferProxy: true });
  const feats = (gj && gj.features) || [];
  for (const f of feats) {
    const p = f.properties || {};
    p.geoid = p.GEOID || `${p.STATE}${p.COUNTY}${p.TRACT}`;
  }
  return feats;
}

// ── spatial: does a flight path touch a tract polygon? ──────────────────────

/** Ray-cast point-in-polygon over a GeoJSON Polygon/MultiPolygon's rings. */
function pointInFeature(lng, lat, geom) {
  if (!geom) return false;
  const polys = geom.type === 'MultiPolygon' ? geom.coordinates : geom.type === 'Polygon' ? [geom.coordinates] : [];
  for (const rings of polys) {
    let inside = false;
    for (const ring of rings) {
      for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
        const xi = ring[i][0], yi = ring[i][1], xj = ring[j][0], yj = ring[j][1];
        if (((yi > lat) !== (yj > lat)) && (lng < (xj - xi) * (lat - yi) / (yj - yi) + xi)) inside = !inside;
      }
    }
    if (inside) return true; // even-odd across the polygon's rings (holes handled by toggle)
  }
  return false;
}

/** bbox [w,s,e,n] of a tract feature for a cheap pre-filter. */
function featBbox(geom) {
  let w = Infinity, s = Infinity, e = -Infinity, n = -Infinity;
  const polys = geom.type === 'MultiPolygon' ? geom.coordinates : [geom.coordinates];
  for (const rings of polys) for (const ring of rings) for (const [x, y] of ring) {
    if (x < w) w = x; if (x > e) e = x; if (y < s) s = y; if (y > n) n = y;
  }
  return [w, s, e, n];
}

/**
 * Mark which tracts are "overflown": any sampled point of any flight path falls
 * inside the tract. Samples every Nth vertex for speed. Returns a Set of geoids.
 */
export function overflownTracts(tractFeats, flights, { sample = 4 } = {}) {
  const boxes = tractFeats.map(f => ({ f, bb: featBbox(f.geometry), geoid: f.properties.geoid }));
  const hit = new Set();
  for (const fl of flights) {
    const g = fl.geometry;
    if (!g || !g.coordinates) continue;
    const segs = g.type === 'MultiLineString' ? g.coordinates : [g.coordinates];
    for (const seg of segs) {
      for (let i = 0; i < seg.length; i += sample) {
        const [lng, lat] = seg[i];
        for (const t of boxes) {
          if (hit.has(t.geoid)) continue;
          if (lng < t.bb[0] || lng > t.bb[2] || lat < t.bb[1] || lat > t.bb[3]) continue;
          if (pointInFeature(lng, lat, t.f.geometry)) hit.add(t.geoid);
        }
      }
    }
  }
  return hit;
}

// ── contrast: overflown tracts vs. the rest of the county ───────────────────

const SUM_NUM = {
  pct_white: ['B03002_003E', 'B03002_001E'], pct_black: ['B03002_004E', 'B03002_001E'],
  pct_asian: ['B03002_006E', 'B03002_001E'], pct_hispanic: ['B03002_012E', 'B03002_001E'],
  pct_poverty: ['B17001_002E', 'B17001_001E'],
  unemployment_rate: ['B23025_005E', 'B23025_003E'],
};
const POP_WEIGHTED = ['median_household_income', 'per_capita_income', 'median_owner_value', 'median_monthly_rent', 'median_age'];

/** Aggregate a set of tract rows into county-style rates (num/den summed; medians pop-weighted). */
function aggregate(rows) {
  if (!rows.length) return null;
  const out = { _tracts: rows.length, population: 0 };
  let popSum = 0;
  for (const r of rows) popSum += (r.population || 0);
  out.population = Math.round(popSum);
  for (const [k, [num, den]] of Object.entries(SUM_NUM)) {
    let a = 0, b = 0;
    for (const r of rows) { a += cNum(r._raw[num]) || 0; b += cNum(r._raw[den]) || 0; }
    out[k] = cPct(a, b);
  }
  for (const k of POP_WEIGHTED) {
    let acc = 0, w = 0;
    for (const r of rows) { const v = r[k], p = r.population || 0; if (v != null && p > 0) { acc += v * p; w += p; } }
    out[k] = w > 0 ? Math.round(acc / w) : null;
  }
  return out;
}

/**
 * Compare overflown tracts to the rest of the county.
 * @returns { overflown, rest, year, nOverflown, nTotal }
 */
export function contrast(byGeoid, overflownSet) {
  const over = [], rest = [];
  for (const [geoid, vals] of Object.entries(byGeoid)) {
    (overflownSet.has(geoid) ? over : rest).push(vals);
  }
  return { overflown: aggregate(over), rest: aggregate(rest), nOverflown: over.length, nTotal: Object.keys(byGeoid).length };
}

/** Color a tract by a metric for the choropleth (sequential blue). */
export function choroplethColor(value, metric) {
  if (value == null) return 'rgba(150,150,150,0.15)';
  // Normalize common metrics to 0..1.
  const scales = {
    pct_poverty: [0, 50], pct_black: [0, 100], pct_hispanic: [0, 100], pct_white: [0, 100],
    unemployment_rate: [0, 20], median_household_income: [20000, 150000],
  };
  const [lo, hi] = scales[metric] || [0, 100];
  let t = Math.max(0, Math.min(1, (value - lo) / (hi - lo)));
  if (metric === 'median_household_income') t = 1 - t; // invert: lower income = darker
  const a = 0.15 + t * 0.55;
  return `rgba(43,103,119,${a.toFixed(2)})`;
}

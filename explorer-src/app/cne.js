/**
 * cne.js — Metro Nashville "Community Needs Evaluation 2025–2026" demographics,
 * offered as an alternative to the live Census ACS pull in census.js.
 *
 * Where census.js works at the census-tract level (and contrasts drone-overflown
 * tracts against the rest of the county), this source is published by Metro
 * Social Services at the *Metro Council District* level for Davidson County. The
 * figures below are transcribed verbatim from the report's "Race and Ethnicity"
 * table (page 7), whose own source is the American Community Survey 2023 5-year
 * estimates, table DP05. Percentages are of total population; "Hispanic or
 * Latino" is reported "of any race" and therefore overlaps the race rows.
 *
 * To keep the equity lens of the Demographics view — "do the drones concentrate
 * over distinct populations?" — we can resolve which council districts a flight
 * crosses (best-effort, from Metro's ArcGIS council-district polygons) and then
 * contrast overflown districts against the rest, exactly as census.js does for
 * tracts.
 */

import { feedFetch } from './dfr.js';

export const CNE_META = {
  title: 'Community Needs Evaluation 2025–2026',
  publisher: 'Metro Social Services (MSS), "Know Your Community"',
  source: 'American Community Survey 2023, 5-year estimates, DP05',
  geography: 'Davidson County, by Metro Council District',
  url: 'https://www.nashville.gov/sites/default/files/2026-04/Community-Needs-Evaluation-2025-2026.pdf',
};

// Race & ethnicity by Metro Council District (percent of total population).
// district 0 is the countywide "Davidson" baseline row from the report.
// Columns: pop, White, Black, AmInd/AKNative, Asian, NHPI, Some other, Two+, Hispanic.
const R = (district, population, w, b, ai, as, pi, so, tw, hi) => ({
  district, population,
  pct_white: w, pct_black: b, pct_native: ai, pct_asian: as, pct_pacific: pi,
  pct_other_race: so, pct_two_or_more: tw, pct_hispanic: hi,
});

export const CNE_BASELINE = R('Davidson', 709846, 57.1, 25.2, 0.3, 3.4, 0.0, 4.8, 9.1, 13.6);

export const CNE_DISTRICTS = [
  R(1, 18174, 37.8, 52.2, 0.0, 1.3, 0.0, 2.7, 6.0, 4.1),
  R(2, 20723, 16.0, 65.8, 0.2, 0.1, 0.2, 7.6, 10.1, 11.9),
  R(3, 19121, 30.8, 56.2, 0.0, 1.5, 0.2, 4.8, 6.6, 9.6),
  R(4, 21395, 74.7, 14.2, 0.2, 4.2, 0.0, 1.0, 5.7, 4.4),
  R(5, 17804, 51.1, 37.4, 0.3, 0.5, 0.0, 3.5, 7.2, 10.3),
  R(6, 19634, 62.7, 26.8, 0.4, 1.5, 0.1, 1.3, 7.3, 4.3),
  R(7, 21120, 65.0, 18.8, 0.0, 3.3, 0.0, 3.9, 9.0, 11.0),
  R(8, 18460, 48.9, 23.2, 0.3, 3.8, 0.0, 10.6, 13.3, 20.3),
  R(9, 20109, 35.2, 35.8, 0.6, 1.6, 0.1, 14.3, 12.5, 27.0),
  R(10, 18739, 50.4, 33.8, 0.2, 1.0, 0.0, 6.8, 7.9, 14.2),
  R(11, 18880, 69.2, 18.8, 0.1, 1.7, 0.0, 3.6, 6.6, 8.3),
  R(12, 18452, 64.2, 22.9, 0.0, 1.9, 0.0, 2.7, 8.2, 7.0),
  R(13, 18471, 53.3, 32.4, 0.2, 2.3, 0.0, 5.8, 5.9, 20.8),
  R(14, 22184, 60.8, 22.1, 0.3, 3.1, 0.0, 5.0, 8.7, 12.3),
  R(15, 18868, 62.7, 12.1, 0.0, 1.6, 0.0, 4.9, 18.7, 20.5),
  R(16, 18276, 57.5, 12.2, 0.5, 3.6, 0.0, 11.3, 14.8, 29.8),
  R(17, 21029, 62.3, 24.8, 0.1, 4.5, 0.0, 2.0, 6.3, 7.6),
  R(18, 16452, 75.7, 9.4, 0.1, 8.7, 0.0, 1.2, 4.9, 3.6),
  R(19, 27111, 63.4, 26.1, 0.1, 3.0, 0.3, 1.9, 5.3, 7.2),
  R(20, 17591, 68.5, 10.5, 0.5, 5.2, 0.2, 7.3, 7.7, 14.4),
  R(21, 20201, 31.5, 57.7, 0.0, 5.2, 0.0, 1.5, 4.0, 2.8),
  R(22, 21302, 70.1, 15.7, 0.0, 6.4, 0.0, 2.7, 5.1, 6.9),
  R(23, 18498, 88.3, 4.1, 0.1, 2.1, 0.0, 0.9, 4.5, 2.8),
  R(24, 18406, 89.3, 2.9, 0.0, 3.2, 0.1, 0.6, 4.0, 3.0),
  R(25, 20898, 83.5, 5.3, 0.1, 5.1, 0.0, 0.4, 5.6, 2.1),
  R(26, 17893, 61.5, 18.1, 0.0, 4.4, 0.0, 4.9, 11.1, 21.1),
  R(27, 19177, 57.3, 12.4, 0.0, 4.8, 0.2, 7.4, 17.8, 22.1),
  R(28, 21769, 41.5, 31.0, 0.0, 2.8, 0.0, 10.5, 14.3, 40.8),
  R(29, 20963, 45.8, 32.5, 0.0, 2.1, 0.0, 3.5, 16.1, 21.5),
  R(30, 18284, 34.9, 15.7, 1.3, 7.2, 0.0, 20.7, 20.1, 48.6),
  R(31, 28592, 60.2, 21.0, 0.7, 6.0, 0.0, 4.0, 8.1, 14.6),
  R(32, 26010, 31.1, 48.1, 0.5, 4.7, 0.0, 5.3, 10.3, 13.1),
  R(33, 28207, 38.5, 36.2, 3.3, 3.8, 0.1, 4.3, 13.8, 17.9),
  R(34, 17977, 88.6, 3.0, 0.1, 2.5, 0.0, 1.1, 4.7, 5.9),
  R(35, 19076, 85.4, 3.7, 0.1, 2.8, 0.0, 1.8, 6.3, 3.6),
];

// Metrics this source actually carries (the report's race/ethnicity table).
export const CNE_METRICS = [
  ['pct_black', '% Black', true],
  ['pct_hispanic', '% Hispanic', true],
  ['pct_white', '% White', false],
  ['pct_asian', '% Asian', false],
  ['pct_two_or_more', '% Two or more races', false],
  ['pct_other_race', '% Some other race', false],
  ['pct_native', '% Am. Indian/AK Native', false],
  ['population', 'Population', false],
];

const PCT_KEYS = ['pct_white', 'pct_black', 'pct_native', 'pct_asian', 'pct_pacific', 'pct_other_race', 'pct_two_or_more', 'pct_hispanic'];

/** Population-weighted aggregate of a set of district rows into one CNE-style row. */
export function aggregateDistricts(rows) {
  if (!rows.length) return null;
  let pop = 0;
  for (const r of rows) pop += (r.population || 0);
  const out = { _districts: rows.length, population: Math.round(pop) };
  for (const k of PCT_KEYS) {
    let acc = 0, w = 0;
    for (const r of rows) { const v = r[k], p = r.population || 0; if (v != null && p > 0) { acc += v * p; w += p; } }
    out[k] = w > 0 ? +(acc / w).toFixed(1) : null;
  }
  return out;
}

/**
 * Contrast overflown districts against the rest of the county using the CNE
 * figures. `overflownSet` holds council-district ids (numbers or numeric strings).
 * @returns { overflown, rest, nOverflown, nTotal }
 */
export function contrastDistricts(overflownSet) {
  const ids = new Set([...overflownSet].map(Number));
  const over = [], rest = [];
  for (const r of CNE_DISTRICTS) (ids.has(Number(r.district)) ? over : rest).push(r);
  return {
    overflown: aggregateDistricts(over),
    rest: aggregateDistricts(rest),
    nOverflown: over.length,
    nTotal: CNE_DISTRICTS.length,
  };
}

// ── council-district geometry (best-effort, runtime, via the CORS proxy) ─────

// Metro Nashville's ArcGIS publishes council districts under PoliticalDistricts.
const POLITICAL_DISTRICTS = 'https://maps.nashville.gov/arcgis/rest/services/Elections/PoliticalDistricts/MapServer';

/** Pick the council-district id out of an ArcGIS feature's properties. */
function districtIdFrom(props) {
  for (const k of Object.keys(props || {})) {
    if (/council|district|^cd$|^dist$/i.test(k)) {
      const n = parseInt(props[k], 10);
      if (Number.isFinite(n) && n >= 1 && n <= 35) return String(n);
    }
  }
  return null;
}

/**
 * Load Metro Council district polygons as GeoJSON features tagged with
 * `properties.geoid` = district number, so census.js's overflownTracts() can be
 * reused unchanged. Returns [] (not throws) if the service can't be reached.
 */
export async function loadCouncilDistricts(proxy) {
  try {
    // Find the layer whose name mentions "council".
    const meta = await feedFetch(`${POLITICAL_DISTRICTS}?f=json`, proxy, { preferProxy: true });
    const layers = (meta && meta.layers) || [];
    const layer = layers.find(l => /council/i.test(l.name || '')) || layers[0];
    if (!layer) return [];
    const url = `${POLITICAL_DISTRICTS}/${layer.id}/query?where=1=1&outFields=*` +
                `&returnGeometry=true&outSR=4326&f=geojson`;
    const gj = await feedFetch(url, proxy, { preferProxy: true });
    const feats = (gj && gj.features) || [];
    const out = [];
    for (const f of feats) {
      const id = districtIdFrom(f.properties);
      if (!id) continue;
      f.properties.geoid = id;
      out.push(f);
    }
    return out;
  } catch {
    return [];
  }
}

/** Color a council district by a CNE metric for the choropleth (matches census.js palette). */
export function cneColor(value, metric) {
  if (value == null) return 'rgba(150,150,150,0.15)';
  const scales = {
    pct_black: [0, 100], pct_hispanic: [0, 60], pct_white: [0, 100], pct_asian: [0, 15],
    pct_two_or_more: [0, 25], pct_other_race: [0, 25], pct_native: [0, 5], population: [16000, 29000],
  };
  const [lo, hi] = scales[metric] || [0, 100];
  const t = Math.max(0, Math.min(1, (value - lo) / (hi - lo)));
  const a = 0.15 + t * 0.55;
  return `rgba(43,103,119,${a.toFixed(2)})`;
}

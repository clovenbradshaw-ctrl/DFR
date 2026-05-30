/**
 * export.js — download the current dataset in a few research-friendly formats.
 * Pure functions over the in-memory flight records (full precise geometry).
 */

function dl(filename, text, mime) {
  const blob = new Blob([text], { type: mime });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 2000);
}

/** NDJSON — one canonical flight record per line (full geometry). */
export function exportNdjson(flights, name = 'dfr-flights') {
  dl(`${name}.ndjson`, flights.map(f => JSON.stringify(f)).join('\n'), 'application/x-ndjson');
}

/** GeoJSON FeatureCollection — geometry + properties, for GIS tools. */
export function exportGeojson(flights, name = 'dfr-flights') {
  const features = flights.map(f => {
    const { geometry, ...props } = f;
    return { type: 'Feature', geometry: geometry || null, properties: props };
  });
  dl(`${name}.geojson`, JSON.stringify({ type: 'FeatureCollection', features }), 'application/geo+json');
}

/** CSV — flat metadata (no geometry), one row per flight. */
export function exportCsv(flights, name = 'dfr-flights') {
  const cols = ['flight_id', 'external_id', 'flight_purpose', 'organization_id',
    'takeoff', 'landing', 'duration_min', 'num_points', 'geometry_type'];
  const esc = (v) => {
    const s = v == null ? '' : String(v);
    return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  };
  const lines = [cols.join(',')];
  for (const f of flights) {
    lines.push(cols.map(c => {
      if (c === 'takeoff' || c === 'landing') return f[c] ? new Date(f[c]).toISOString() : '';
      return esc(f[c]);
    }).join(','));
  }
  dl(`${name}.csv`, lines.join('\n'), 'text/csv');
}

export function exportFlights(flights, format, name) {
  if (!flights || !flights.length) throw new Error('Nothing to export.');
  if (format === 'geojson') return exportGeojson(flights, name);
  if (format === 'csv') return exportCsv(flights, name);
  return exportNdjson(flights, name);
}

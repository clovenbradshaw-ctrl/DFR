/**
 * dfr.js — DFR domain layer (the interop contract)
 *
 * This is the *only* app-specific knowledge layered on top of the mirrored
 * bare-metal foundation (auth + event-sourced database). Per BUILDING.md §3,
 * two clients interoperate iff they agree on: namespace, entity-type taxonomy,
 * field paths under DEF, and the schema-as-log convention. All four live here.
 *
 *   Namespace      : org.dfr.explorer
 *   Entity types   : flight · site · snapshot · dataset
 *   Field paths    : documented per type below
 *
 * A DFR "room" is one dataset table. Its append-only timeline is the audit
 * trail; current state is always fold(timeline). Large geometry never rides
 * inline in an event — it is uploaded as an encrypted Matrix media *block* and
 * referenced by a DEF on `geometry`. Small per-flight metadata rides as INS/DEF
 * *in-room events*. That is the "blocks to matrix media OR in-room events"
 * split the explorer records updates under.
 */

export const NAMESPACE = 'org.dfr.explorer';
export const ROOM_TYPE = 'dfr.dataset';

export const ENTITY = {
  FLIGHT: 'flight',     // a single DFR drone flight
  SITE: 'site',         // a sensitive site (school/childcare/playground/worship)
  SNAPSHOT: 'snapshot', // one background-scraper poll (provenance)
  DATASET: 'dataset',   // a hydration source descriptor (+ raw blob as media)
};

// Field paths (DEF) we read/write. Treat as a public schema.
export const FIELD = {
  GEOMETRY: 'geometry',           // media ref → GeoJSON geometry of the flight
  COUNCIL_DISTRICTS: 'council_districts',
  STATUS: 'status',
};

// ── Live feed (Skydio ArcGIS FeatureServer — same source as dfr_scraper.py) ──

export const FEATURE_SERVICE =
  'https://services7.arcgis.com/mnhQTdIYDA7UoY2l/arcgis/rest/services/' +
  '678dee26-6aa8-4d60-bf1c-30c7b0f6b517-production/FeatureServer/0';

export function feedQueryUrl() {
  return `${FEATURE_SERVICE}/query?where=1%3D1&outFields=*` +
         `&returnGeometry=true&outSR=4326&f=geojson`;
}

/**
 * Apply an optional CORS proxy. The live ArcGIS service may not send
 * Access-Control-Allow-Origin for browser callers; the existing DFR
 * index.html routes some feeds through an n8n proxy for exactly this.
 * `proxy` is a prefix the target URL is appended to (encoded).
 */
export function proxied(url, proxy) {
  if (!proxy) return url;
  return proxy + encodeURIComponent(url);
}

// ── Feature → record ─────────────────────────────────────────────────────────

/** First / last coordinate of a (Multi)LineString, as [lng, lat]. */
function endpoints(geom) {
  if (!geom) return { start: null, end: null, npts: 0 };
  const t = geom.type, c = geom.coordinates || [];
  if (t === 'LineString') {
    return { start: c[0] || null, end: c[c.length - 1] || null, npts: c.length };
  }
  if (t === 'MultiLineString') {
    const first = c[0] || [];
    const last = c[c.length - 1] || [];
    return {
      start: first[0] || null,
      end: last[last.length - 1] || null,
      npts: c.reduce((n, seg) => n + (seg ? seg.length : 0), 0),
    };
  }
  return { start: null, end: null, npts: 0 };
}

/**
 * Split a raw GeoJSON flight feature into the lean metadata that becomes an
 * INS payload, and the geometry object that becomes an encrypted media block.
 * Mirrors flight_to_log_entry() in dfr_scraper.py so a row here lines up with
 * a row in the existing plain-text log.
 */
export function splitFeature(feature) {
  const p = feature.properties || {};
  const geom = feature.geometry || null;
  // Recompute endpoints from geometry when present; otherwise trust any
  // endpoint fields already on the record (re-importing our own NDJSON).
  const ep = geom ? endpoints(geom)
                  : { start: p.start_coords ?? null, end: p.end_coords ?? null, npts: p.num_points ?? 0 };
  const takeoff = p.takeoff ?? null;
  const landing = p.landing ?? null;
  const meta = {
    flight_id: p.flight_id || '',
    external_id: p.external_id || '',
    flight_purpose: p.flight_purpose || '',
    takeoff,
    landing,
    duration_min: (takeoff && landing) ? +((landing - takeoff) / 60000).toFixed(1) : (p.duration_min ?? null),
    object_id: p.ObjectId ?? p.object_id ?? null,
    organization_id: p.organization_id || '',
    shape_length: p.Shape__Length ?? p.shape_length ?? null,
    geometry_type: geom ? geom.type : (p.geometry_type || ''),
    num_points: ep.npts,
    start_coords: ep.start, // [lng, lat]
    end_coords: ep.end,
  };
  return { meta, geometry: geom };
}

/**
 * Normalise a GeoJSON Feature *or* an already-flat row/record into the canonical
 * flight record (metadata + inline geometry). Idempotent: re-importing a record
 * this function produced yields the same record.
 */
export function toRecord(el) {
  const feature = el && el.type === 'Feature'
    ? el
    : { properties: (el && el.properties) || el, geometry: (el && el.geometry) || null };
  const { meta, geometry } = splitFeature(feature);
  return { ...meta, geometry: geometry || null };
}

/** Stable identity for a flight feature (used for dedup against fold state). */
export function flightKey(feature) {
  const p = feature.properties || {};
  return p.flight_id || (p.ObjectId != null ? 'oid_' + p.ObjectId : null);
}

// ── Agencies ─────────────────────────────────────────────────────────────────

/**
 * Normalise one agency record (NDJSON: u, city, county, state, address,
 * centroid/…) into a lean, mappable shape. `centr*` is treated as a centroid:
 * accepts [lng,lat], {lat,lng}, or "lat,lng" strings. Tolerant of empty fields.
 */
export function toAgency(el) {
  const o = el || {};
  let lat = num(o.lat ?? o.latitude), lng = num(o.lng ?? o.lon ?? o.longitude);
  const c = o.centroid ?? o.center ?? o.centre ?? o.centr ?? o.geo ?? null;
  if ((lat == null || lng == null) && c != null) {
    if (Array.isArray(c) && c.length >= 2) { lng = num(c[0]); lat = num(c[1]); }
    else if (typeof c === 'object') { lat = num(c.lat ?? c.latitude ?? c[1]); lng = num(c.lng ?? c.lon ?? c.longitude ?? c[0]); }
    else if (typeof c === 'string' && c.includes(',')) {
      const [a, b] = c.split(',').map(s => num(s.trim()));
      // "lat,lng" is the common convention for a centroid string.
      lat = a; lng = b;
    }
  }
  return {
    id: o.u || o.id || o.uuid || null,
    city: o.city || '', county: o.county || '', state: o.state || '',
    address: o.address || '',
    name: o.name || o.agency || agencyLabel(o),
    lat, lng,
  };
}

function agencyLabel(o) {
  return [o.city, o.county, o.state].filter(Boolean).join(', ') || (o.address || 'Agency');
}
function num(v) { if (v == null || v === '') return null; const n = Number(v); return Number.isFinite(n) ? n : null; }

export function agencyKey(a) { return a.id || (a.lat != null ? `${a.lat},${a.lng}` : a.name); }

// ── Schema-as-log (written once at room creation, read by any fresh client) ──

export const SCHEMA = {
  version: 1,
  tables: {
    flight: {
      label: 'DFR flights',
      fields: {
        flight_id: { type: 'text' },
        external_id: { type: 'text' },
        flight_purpose: { type: 'text' },
        takeoff: { type: 'number' },
        landing: { type: 'number' },
        duration_min: { type: 'number' },
        geometry_type: { type: 'text' },
        num_points: { type: 'number' },
        geometry: { type: 'media', note: 'GeoJSON geometry, hoisted to an encrypted block' },
      },
    },
    site: {
      label: 'Sensitive sites',
      fields: {
        name: { type: 'text' },
        kind: { type: 'text' },
        lat: { type: 'number' },
        lng: { type: 'number' },
      },
    },
  },
};

// Map / styling constants (Nashville / Madison precinct DFR trial).
export const NASHVILLE = { lat: 36.1627, lng: -86.7816, zoom: 11 };

export const SITE_COLORS = {
  school: '#f5a623',
  childcare: '#4d8df5',
  playground: '#3ecf8e',
  worship: '#b06ef5',
  default: '#9aa0a6',
};

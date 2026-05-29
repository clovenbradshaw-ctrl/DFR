/**
 * recorder.js — how a flight enters the dataset.
 *
 * One flight becomes:
 *   1. an encrypted Matrix media *block*  — its GeoJSON geometry (the bulky
 *      part: a path can be thousands of vertices), uploaded via the
 *      foundation's media layer so the homeserver only ever sees ciphertext;
 *   2. two in-room *events* — INS (mint the flight entity with its lean
 *      metadata) and DEF (point `geometry` at the media block).
 *
 * This is the literal "recording updates as either blocks to matrix media or
 * in-room events" requirement. Small data → events; large data → media block.
 */

import { ins, def } from '../src/operators.js';
import { uploadEncrypted } from '../src/media.js';
import { ENTITY, FIELD, splitFeature } from './dfr.js';

const encoder = new TextEncoder();

// Geometry small enough to ride inline stays inline; anything larger is
// hoisted to a media block. media.js hoists string fields ≥16KB anyway, but
// doing it explicitly keeps `geometry` a clean media ref rather than an inline
// object that might or might not get hoisted.
const INLINE_GEOMETRY_LIMIT = 8 * 1024;

/**
 * Record one raw GeoJSON flight feature into `roomId`.
 * Returns the new flight's anchor, or null if it had no usable id.
 *
 * @param {string} roomId
 * @param {object} feature           GeoJSON Feature
 * @param {object} [opts]
 * @param {boolean} [opts.geometryAsBlock=true]  upload geometry as media
 */
export async function recordFlight(roomId, feature, { geometryAsBlock = true } = {}) {
  const { meta, geometry } = splitFeature(feature);
  if (!meta.flight_id && meta.object_id == null) return null;

  // 1. INS — mint the entity from lean metadata (one in-room event).
  const anchor = await ins(roomId, ENTITY.FLIGHT, meta);

  // 2. Geometry → media block (or inline DEF when tiny / absent).
  if (geometry) {
    const json = JSON.stringify(geometry);
    if (geometryAsBlock && encoder.encode(json).length > INLINE_GEOMETRY_LIMIT) {
      const ref = await uploadEncrypted(encoder.encode(json), {
        mime: 'application/geo+json',
        name: (meta.flight_id || 'flight') + '.geometry.json',
      });
      await def(roomId, anchor, FIELD.GEOMETRY, ref);     // DEF points at the block
    } else {
      await def(roomId, anchor, FIELD.GEOMETRY, geometry); // small enough inline
    }
  }
  return anchor;
}

/** Record a sensitive site (small — always an inline INS event). */
export async function recordSite(roomId, site) {
  return ins(roomId, ENTITY.SITE, {
    name: site.name || '',
    kind: (site.kind || site.type || '').toLowerCase(),
    lat: site.lat ?? site.latitude ?? null,
    lng: site.lng ?? site.lon ?? site.longitude ?? null,
  });
}

/** Record a scraper poll for provenance (an in-room event, no media). */
export async function recordSnapshot(roomId, { featureCount, newCount, source }) {
  return ins(roomId, ENTITY.SNAPSHOT, {
    fetched_at: Date.now(),
    feature_count: featureCount,
    new_count: newCount,
    source: source || 'arcgis',
  });
}

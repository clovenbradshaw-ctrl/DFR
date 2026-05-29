/**
 * mapview.js — Leaflet rendering of the folded DFR state.
 *
 * Leaflet is loaded globally (CDN <script> in index.html) as `L`, matching the
 * existing DFR index.html. Tiles: ESRI world imagery + Carto dark labels.
 *
 * Flights render as start-point markers from their inline metadata (cheap,
 * no media fetch). The full path is a media block, fetched lazily only when a
 * flight is selected — so a dataset with thousands of paths doesn't pull
 * thousands of geometry blobs up front.
 */

import { getMediaBytes } from '../src/media.js';
import { NASHVILLE, SITE_COLORS } from './dfr.js';

const decoder = new TextDecoder();

export class DfrMap {
  constructor(el) {
    this.map = L.map(el, { zoomControl: true, attributionControl: false })
      .setView([NASHVILLE.lat, NASHVILLE.lng], NASHVILLE.zoom);
    L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}',
      { maxZoom: 19, maxNativeZoom: 19 }).addTo(this.map);
    L.tileLayer('https://{s}.basemaps.cartocdn.com/dark_only_labels/{z}/{x}/{y}{r}.png',
      { maxZoom: 19, subdomains: 'abcd' }).addTo(this.map);

    this.flightLayer = L.layerGroup().addTo(this.map);
    this.siteLayer = L.layerGroup().addTo(this.map);
    this.pathLayer = L.layerGroup().addTo(this.map);
    this.onSelect = null;
    this._fitDone = false;
  }

  renderSites(sites) {
    this.siteLayer.clearLayers();
    for (const s of sites) {
      if (s.lat == null || s.lng == null) continue;
      const color = SITE_COLORS[s.kind] || SITE_COLORS.default;
      L.circleMarker([s.lat, s.lng], {
        radius: 3, color, weight: 1, fillColor: color, fillOpacity: 0.7,
      }).bindPopup(`<b>${escapeHtml(s.name)}</b><br>${escapeHtml(s.kind || '')}`)
        .addTo(this.siteLayer);
    }
  }

  renderFlights(flights) {
    this.flightLayer.clearLayers();
    const pts = [];
    for (const f of flights) {
      const c = f.start_coords; // [lng, lat]
      if (!c || c.length < 2) continue;
      const latlng = [c[1], c[0]];
      pts.push(latlng);
      const m = L.circleMarker(latlng, {
        radius: 4, color: '#ff4d4d', weight: 1, fillColor: '#ff6b6b', fillOpacity: 0.85,
      });
      m.bindPopup(flightPopup(f));
      m.on('click', () => { this.selectFlight(f); if (this.onSelect) this.onSelect(f); });
      m.addTo(this.flightLayer);
    }
    if (!this._fitDone && pts.length) {
      try { this.map.fitBounds(L.latLngBounds(pts).pad(0.15), { maxZoom: 14 }); this._fitDone = true; } catch {}
    }
  }

  /** Fetch + draw the full path geometry for one flight (lazy). */
  async selectFlight(f) {
    this.pathLayer.clearLayers();
    let geom = f.geometry;
    if (geom && geom.__media) {
      const bytes = await getMediaBytes(geom);
      if (!bytes) return;
      try { geom = JSON.parse(decoder.decode(bytes)); } catch { return; }
    }
    if (!geom || !geom.coordinates) return;
    const toLatLng = (seg) => seg.map(([lng, lat]) => [lat, lng]);
    const lines = geom.type === 'MultiLineString'
      ? geom.coordinates.map(toLatLng)
      : [toLatLng(geom.coordinates)];
    for (const line of lines) {
      L.polyline(line, { color: '#ffd24d', weight: 2, opacity: 0.9 }).addTo(this.pathLayer);
    }
    try { this.map.fitBounds(L.polyline(lines.flat()).getBounds().pad(0.2), { maxZoom: 16 }); } catch {}
  }

  invalidate() { setTimeout(() => this.map.invalidateSize(), 50); }
}

function flightPopup(f) {
  const t = f.takeoff ? new Date(f.takeoff).toLocaleString() : '—';
  return `<b>${escapeHtml(f.flight_purpose || 'DFR flight')}</b><br>` +
         `<span style="opacity:.7">${escapeHtml(f.external_id || f.flight_id || '')}</span><br>` +
         `Takeoff: ${t}<br>` +
         `${f.duration_min != null ? f.duration_min + ' min · ' : ''}${f.num_points || 0} pts` +
         `${f.geometry ? '<br><i>click to draw path</i>' : ''}`;
}

function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
}

/**
 * mapview.js — Leaflet rendering of the in-memory dataset.
 *
 * Geometry is inline in each record (it travels in the binary blob, not the
 * timeline), so paths draw directly with no per-flight media fetch. Start
 * points render as markers; clicking a flight draws its full path.
 */

import { NASHVILLE } from './dfr.js';

// At tens of thousands of flights, one SVG marker each freezes the tab. Draw on
// a shared canvas renderer, render only what's in view, and cap how many.
const MAX_MARKERS = 4000;
const PATH_ZOOM = 12;       // at/above this zoom (≈ city), draw movement lines
const MAX_PATHS = 600;      // cap auto-drawn paths so a dense city stays smooth

export class DfrMap {
  constructor(el) {
    this.map = L.map(el, { zoomControl: true, attributionControl: false, preferCanvas: true })
      .setView([NASHVILLE.lat, NASHVILLE.lng], NASHVILLE.zoom);
    // Light, legible basemap (Carto Voyager) — clearer than dark matter and a
    // neutral ground for the demographic choropleth. Flat raster, cheap to draw.
    L.tileLayer('https://{s}.basemaps.cartocdn.com/rastertiles/voyager/{z}/{x}/{y}{r}.png',
      { maxZoom: 20, subdomains: 'abcd' }).addTo(this.map);
    // Tract choropleth sits above the basemap but below flight dots/paths.
    this.tractLayer = L.layerGroup().addTo(this.map);
    this._canvas = L.canvas({ padding: 0.5 });   // one canvas for all flight dots
    this.flightLayer = L.layerGroup().addTo(this.map);
    this.pathLayer = L.layerGroup().addTo(this.map);
    this.agencyLayer = L.layerGroup().addTo(this.map);
    this._flights = [];
    this._fitDone = false;
    // Re-render the viewport subset as the user pans/zooms (cheap: only what's visible).
    this.map.on('moveend', () => { if (this.onMove) this.onMove(); this._renderViewport(); });
    this.onCount = null;     // (shown, total) → UI
    this.onFlight = null;    // (flight) → open the details panel
    this.onMove = null;      // () → recompute viewport-relative state (e.g. time span)
    this.timeFilter = null;  // (flight) => boolean — cursor filter, applied per-marker
  }

  renderAgencies(agencies, onPick) {
    this.agencyLayer.clearLayers();
    for (const a of agencies) {
      if (a.lat == null || a.lng == null) continue;
      const mk = L.circleMarker([a.lat, a.lng], {
        renderer: this._canvas, radius: 4, color: '#b06ef5', weight: 1, fillColor: '#c79bff', fillOpacity: 0.7,
      }).bindPopup(`<b>${esc(a.name || 'Agency')}</b><br>` +
          `<span style="opacity:.75">${esc([a.city, a.county, a.state].filter(Boolean).join(', '))}</span>` +
          `${a.address ? '<br>' + esc(a.address) : ''}` +
          `${onPick ? '<br><i>pulling recent flights…</i>' : ''}`);
      if (onPick) mk.on('click', () => onPick(a));
      mk.addTo(this.agencyLayer);
    }
  }

  /** Recenter on an agency at a zoom that triggers a focus fetch. */
  focusOn(a, zoom = 13) {
    if (a.lat == null || a.lng == null) return;
    this.map.setView([a.lat, a.lng], Math.max(this.map.getZoom(), zoom));
  }

  toggleAgencies(show) {
    if (show) this.agencyLayer.addTo(this.map);
    else this.map.removeLayer(this.agencyLayer);
  }

  /** Current viewport as [west, south, east, north] (WGS84). */
  bbox() {
    const b = this.map.getBounds();
    return [b.getWest(), b.getSouth(), b.getEast(), b.getNorth()];
  }

  zoom() { return this.map.getZoom(); }

  /** Fire `cb(bbox, zoom)` after the user stops panning/zooming. */
  onFocusChange(cb) {
    const handler = () => cb(this.bbox(), this.map.getZoom());
    this.map.on('moveend', handler);
    return () => this.map.off('moveend', handler);
  }

  render(flights) {
    this._flights = flights || [];
    // Fit to the data once, then render only the viewport subset.
    if (!this._fitDone) {
      const pts = [];
      for (const f of this._flights) {
        const c = f.start_coords;
        if (c && c.length >= 2) pts.push([c[1], c[0]]);
        if (pts.length >= 5000) break;
      }
      if (pts.length) { try { this.map.fitBounds(L.latLngBounds(pts).pad(0.15), { maxZoom: 12 }); this._fitDone = true; } catch {} }
    }
    this._renderViewport();
  }

  /** Re-apply the viewport + time filter without recomputing fit (cheap; for the scrubber). */
  refresh() { this._renderViewport(); }

  /** Draw the flights in the current viewport; at city zoom, draw movement lines too. */
  _renderViewport() {
    this.flightLayer.clearLayers();
    this.pathLayer.clearLayers();
    if (!this._flights.length) { if (this.onCount) this.onCount(0, 0); return; }
    const b = this.map.getBounds();
    const drawPaths = this.map.getZoom() >= PATH_ZOOM;   // city-level → show movements
    let shown = 0, inView = 0, paths = 0;
    for (const f of this._flights) {
      const c = f.start_coords;
      if (!c || c.length < 2) continue;
      if (!b.contains([c[1], c[0]])) continue;
      if (this.timeFilter && !this.timeFilter(f)) continue;   // time scrubber cutoff
      inView++;
      if (shown >= MAX_MARKERS) continue;
      const m = L.circleMarker([c[1], c[0]], {
        renderer: this._canvas, radius: 3.5, color: '#ff4d4d', weight: 1,
        fillColor: '#ff6b6b', fillOpacity: 0.85,
      });
      m.on('click', () => { this.drawPath(f); if (this.onFlight) this.onFlight(f); });
      m.addTo(this.flightLayer);
      shown++;
      // Movement lines for in-view flights when zoomed into a city, capped.
      if (drawPaths && paths < MAX_PATHS && f.geometry) { this._addPath(f.geometry, false); paths++; }
    }
    if (this.onCount) this.onCount(Math.min(inView, MAX_MARKERS), this._flights.length, inView > MAX_MARKERS);
  }

  _addPath(geom, fit) {
    if (!geom || !geom.coordinates) return;
    // Full geometry stays in memory; for the bulk (non-clicked) movement lines
    // we draw a downsampled copy so 600 paths × thousands of points doesn't choke
    // the canvas. The clicked path (fit=true) draws at full resolution.
    const cap = fit ? Infinity : 60;
    const reduce = (seg) => {
      if (seg.length <= cap) return seg;
      const step = (seg.length - 1) / (cap - 1), out = [];
      for (let i = 0; i < cap; i++) out.push(seg[Math.round(i * step)]);
      return out;
    };
    const toLatLng = (seg) => reduce(seg).map(([lng, lat]) => [lat, lng]);
    const lines = geom.type === 'MultiLineString' ? geom.coordinates.map(toLatLng) : [toLatLng(geom.coordinates)];
    for (const line of lines) {
      L.polyline(line, { renderer: this._canvas, color: fit ? '#ffd24d' : '#ff8c4d',
        weight: fit ? 2 : 1, opacity: fit ? 0.95 : 0.5 }).addTo(this.pathLayer);
    }
    if (fit) { try { this.map.fitBounds(L.polyline(lines.flat()).getBounds().pad(0.2), { maxZoom: 16 }); } catch {} }
  }

  drawPath(f) {
    this._addPath(f.geometry, true);   // highlighted + fit to this flight
  }

  invalidate() { setTimeout(() => this.map.invalidateSize(), 50); }
}

function esc(s) {
  return String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
}

/**
 * mapview.js — Leaflet rendering of the in-memory dataset.
 *
 * Geometry is inline in each record (it travels in the binary blob, not the
 * timeline), so paths draw directly with no per-flight media fetch. Start
 * points render as markers; clicking a flight draws its full path.
 */

import { NASHVILLE } from './dfr.js';

export class DfrMap {
  constructor(el) {
    this.map = L.map(el, { zoomControl: true, attributionControl: false })
      .setView([NASHVILLE.lat, NASHVILLE.lng], NASHVILLE.zoom);
    L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}',
      { maxZoom: 19, maxNativeZoom: 19 }).addTo(this.map);
    L.tileLayer('https://{s}.basemaps.cartocdn.com/dark_only_labels/{z}/{x}/{y}{r}.png',
      { maxZoom: 19, subdomains: 'abcd' }).addTo(this.map);
    this.flightLayer = L.layerGroup().addTo(this.map);
    this.pathLayer = L.layerGroup().addTo(this.map);
    this._fitDone = false;
  }

  render(flights) {
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
      m.bindPopup(popup(f));
      m.on('click', () => this.drawPath(f));
      m.addTo(this.flightLayer);
    }
    if (!this._fitDone && pts.length) {
      try { this.map.fitBounds(L.latLngBounds(pts).pad(0.15), { maxZoom: 14 }); this._fitDone = true; } catch {}
    }
  }

  drawPath(f) {
    this.pathLayer.clearLayers();
    const geom = f.geometry;
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

function popup(f) {
  const t = f.takeoff ? new Date(f.takeoff).toLocaleString() : '—';
  return `<b>${esc(f.flight_purpose || 'DFR flight')}</b><br>` +
         `<span style="opacity:.7">${esc(f.external_id || f.flight_id || '')}</span><br>` +
         `Takeoff: ${t}<br>` +
         `${f.duration_min != null ? f.duration_min + ' min · ' : ''}${f.num_points || 0} pts` +
         `${f.geometry ? '<br><i>click to draw path</i>' : ''}`;
}

function esc(s) {
  return String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
}

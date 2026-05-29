#!/usr/bin/env python3
"""
MNPD DFR Scraper → n8n → GitHub
=================================
Polls Skydio's ArcGIS feature service for drone flight data,
checks GitHub for what's already stored, pushes new data.

Stores on GitHub (clovenbradshaw-ctrl/plain-text):
  dfr/flight_paths.geojson   — full GeoJSON with geometry (overwrite)
  dfr/flight_log.jsonl       — append-only log, one line per flight
  dfr/flights.csv            — human-readable CSV (overwrite)

Usage:
  python dfr_scraper.py                # single pull
  python dfr_scraper.py --loop         # every 30 min
  python dfr_scraper.py --loop 15      # every 15 min

Requires: pip install requests
"""

import argparse, csv, io, json, sys, time, traceback
from datetime import datetime, timezone
from pathlib import Path

import requests

# ── Config ──────────────────────────────────────────────────────────────
FEATURE_SERVICE = (
    "https://services7.arcgis.com/mnhQTdIYDA7UoY2l/arcgis/rest/services/"
    "678dee26-6aa8-4d60-bf1c-30c7b0f6b517-production/FeatureServer/0"
)
QUERY_URL = (
    f"{FEATURE_SERVICE}/query?where=1%3D1&outFields=*"
    f"&returnGeometry=true&outSR=4326&f=geojson"
)

WEBHOOK_URL = ""
WEBHOOK_HEADERS = {
    "Content-Type": "application/json",
    "Authorization": "",
}

# Read existing data from GitHub raw
GH_RAW_BASE = ""

DATA_DIR = Path("dfr_data")


# ── Helpers ─────────────────────────────────────────────────────────────
def ensure_dirs():
    DATA_DIR.mkdir(parents=True, exist_ok=True)


def gh_read_jsonl(filename):
    """Read existing JSONL from GitHub, return set of flight_ids."""
    url = f"{GH_RAW_BASE}/{filename}"
    try:
        r = requests.get(url, timeout=15)
        if r.status_code == 200:
            ids = set()
            for line in r.text.strip().split("\n"):
                if line.strip():
                    try:
                        entry = json.loads(line)
                        fid = entry.get("flight_id", "")
                        if fid:
                            ids.add(fid)
                    except json.JSONDecodeError:
                        pass
            return ids
        elif r.status_code == 404:
            return set()  # file doesn't exist yet
    except Exception as e:
        print(f"  ⚠ Could not read {filename} from GitHub: {e}")
    return set()


def gh_push(payload):
    """POST to n8n webhook, wait for completion."""
    try:
        r = requests.post(WEBHOOK_URL, json=payload, headers=WEBHOOK_HEADERS, timeout=60)
        return r.ok, r.status_code
    except Exception as e:
        return False, str(e)


def gh_overwrite(filename, content, commit_msg):
    """Overwrite a file on GitHub via n8n webhook."""
    payload = {
        "filename": filename,
        "mode": "overwrite",
        "content": content,
        "commit_message": commit_msg,
    }
    ok, status = gh_push(payload)
    print(f"  📤 {'✓' if ok else '✗ '+str(status)} overwrite → {filename}")
    return ok


def gh_append(filename, entries, commit_msg):
    """Append JSONL records to a file on GitHub via n8n webhook."""
    payload = {
        "filename": filename,
        "entries": entries,
        "commit_message": commit_msg,
    }
    ok, status = gh_push(payload)
    print(f"  📤 {'✓' if ok else '✗ '+str(status)} append {len(entries)} → {filename}")
    return ok


def flight_to_row(feat):
    """Convert a GeoJSON feature to a flat dict for CSV."""
    props = feat.get("properties", {})
    geom = feat.get("geometry", {})
    gtype = geom.get("type", "") if geom else ""
    coords = geom.get("coordinates", []) if geom else []

    # Count points and extract start/end
    if gtype == "LineString":
        npts = len(coords)
        start = coords[0] if coords else []
        end = coords[-1] if coords else []
    elif gtype == "MultiLineString":
        npts = sum(len(c) for c in coords)
        start = coords[0][0] if coords and coords[0] else []
        end = coords[-1][-1] if coords and coords[-1] else []
    else:
        npts = 0
        start = end = []

    # Convert epoch ms to readable
    takeoff_str = landing_str = duration_min = ""
    if props.get("takeoff"):
        dt = datetime.fromtimestamp(props["takeoff"] / 1000, tz=timezone.utc)
        takeoff_str = dt.strftime("%Y-%m-%d %H:%M:%S UTC")
    if props.get("landing"):
        dt = datetime.fromtimestamp(props["landing"] / 1000, tz=timezone.utc)
        landing_str = dt.strftime("%Y-%m-%d %H:%M:%S UTC")
    if props.get("takeoff") and props.get("landing"):
        duration_min = f"{(props['landing'] - props['takeoff']) / 60000:.1f}"

    return {
        "flight_id": props.get("flight_id", ""),
        "case_id": props.get("external_id", ""),
        "flight_purpose": props.get("flight_purpose", ""),
        "takeoff": takeoff_str,
        "landing": landing_str,
        "duration_min": duration_min,
        "geometry_type": gtype,
        "num_points": npts,
        "start_lat": f"{start[1]:.6f}" if len(start) >= 2 else "",
        "start_lon": f"{start[0]:.6f}" if len(start) >= 2 else "",
        "end_lat": f"{end[1]:.6f}" if len(end) >= 2 else "",
        "end_lon": f"{end[0]:.6f}" if len(end) >= 2 else "",
        "shape_length": props.get("Shape__Length", ""),
    }


def flight_to_log_entry(feat):
    """Convert a GeoJSON feature to a lean JSONL entry."""
    props = feat.get("properties", {})
    geom = feat.get("geometry", {})
    gtype = geom.get("type", "") if geom else ""
    coords = geom.get("coordinates", []) if geom else []

    if gtype == "LineString":
        npts = len(coords)
        start = coords[0] if coords else None
        end = coords[-1] if coords else None
    elif gtype == "MultiLineString":
        npts = sum(len(c) for c in coords)
        start = coords[0][0] if coords and coords[0] else None
        end = coords[-1][-1] if coords and coords[-1] else None
    else:
        npts = 0
        start = end = None

    return {
        "flight_id": props.get("flight_id", ""),
        "external_id": props.get("external_id", ""),
        "flight_purpose": props.get("flight_purpose", ""),
        "takeoff": props.get("takeoff"),
        "landing": props.get("landing"),
        "ObjectId": props.get("ObjectId"),
        "organization_id": props.get("organization_id", ""),
        "Shape__Length": props.get("Shape__Length"),
        "geometry_type": gtype,
        "num_points": npts,
        "start_coords": start,
        "end_coords": end,
    }


# ── Main Scraper ────────────────────────────────────────────────────────
def scrape():
    ts = datetime.now(timezone.utc)
    run_ts = ts.isoformat()

    print(f"\n{'='*60}")
    print(f"[{run_ts}] Querying feature service...")

    # ── 1. Fetch flights from ArcGIS ────────────────────────────
    try:
        resp = requests.get(QUERY_URL, timeout=30)
        resp.raise_for_status()
        geojson = resp.json()
    except Exception as e:
        print(f"  ✗ Query failed: {e}")
        return

    features = geojson.get("features", [])
    print(f"  ✓ {len(features)} flights from ArcGIS")

    if not features:
        print("  (no flights)")
        return

    for i, feat in enumerate(features):
        props = feat.get("properties", {})
        geom = feat.get("geometry", {})
        gtype = geom.get("type", "none") if geom else "none"
        takeoff_s = ""
        if props.get("takeoff"):
            dt = datetime.fromtimestamp(props["takeoff"] / 1000, tz=timezone.utc)
            takeoff_s = dt.strftime("%H:%M:%S")
        print(f"  [{i+1}] {props.get('flight_purpose','?')} | "
              f"{props.get('external_id','?')} | {takeoff_s} | {gtype}")

    # ── 2. Check GitHub for existing data ───────────────────────
    print(f"\n  Checking GitHub for existing flights...")
    existing_ids = gh_read_jsonl("dfr/flight_log.jsonl")
    print(f"  📋 {len(existing_ids)} flights already on GitHub")

    # ── 3. Find new flights ─────────────────────────────────────
    new_features = []
    for feat in features:
        fid = feat.get("properties", {}).get("flight_id", "")
        if fid and fid not in existing_ids:
            new_features.append(feat)

    if new_features:
        print(f"  🆕 {len(new_features)} new flight(s) to push")
    else:
        print(f"  ✓ All {len(features)} flights already on GitHub")

    # ── 4. Push GeoJSON (always overwrite with current state) ───
    print(f"\n  Pushing to GitHub...")
    gh_overwrite(
        "dfr/flight_paths.geojson",
        geojson,
        f"dfr: {len(features)} flights as of {ts.strftime('%Y-%m-%d %H:%M UTC')}",
    )

    # Wait for GitHub commit to settle before next push
    time.sleep(3)

    # ── 5. Append new flights to JSONL log ──────────────────────
    if new_features:
        entries = [flight_to_log_entry(f) for f in new_features]
        gh_append(
            "dfr/flight_log.jsonl",
            entries,
            f"dfr: +{len(entries)} flight(s)",
        )
        time.sleep(3)

    # ── 6. Push CSV (always overwrite) ──────────────────────────
    rows = [flight_to_row(f) for f in features]
    buf = io.StringIO()
    fieldnames = list(rows[0].keys())
    writer = csv.DictWriter(buf, fieldnames=fieldnames)
    writer.writeheader()
    writer.writerows(rows)
    csv_content = buf.getvalue()

    gh_overwrite(
        "dfr/flights.csv",
        csv_content,
        f"dfr: CSV update {ts.strftime('%Y-%m-%d %H:%M UTC')}",
    )

    # ── 7. Save locally too ─────────────────────────────────────
    with open(DATA_DIR / "flight_paths.geojson", "w") as f:
        json.dump(geojson, f, indent=2)
    with open(DATA_DIR / "flights.csv", "w") as f:
        f.write(csv_content)

    print(f"\n  ✓ Done. {len(features)} total, {len(new_features)} new.")


# ── Entry point ─────────────────────────────────────────────────────────
def main():
    ap = argparse.ArgumentParser(description="MNPD DFR Scraper")
    ap.add_argument("--loop", nargs="?", const=30, type=int, metavar="MIN")
    args = ap.parse_args()
    ensure_dirs()

    if args.loop:
        print(f"Polling every {args.loop} min. Ctrl+C to stop.")
        while True:
            try:
                scrape()
            except KeyboardInterrupt:
                print("\nStopped."); sys.exit(0)
            except Exception as e:
                print(f"\n✗ {e}"); traceback.print_exc()
            print(f"\n⏳ Next in {args.loop} min...")
            try:
                time.sleep(args.loop * 60)
            except KeyboardInterrupt:
                print("\nStopped."); sys.exit(0)
    else:
        scrape()


if __name__ == "__main__":
    main()

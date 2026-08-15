#!/usr/bin/env python3
"""DFR flight-behavior profile: build the master flight table, then run the
two location-level tests from dfr-behavior-profile.md.

Depends on link_dfr_flights.py having already produced
analysis/linkage/dfr-flight-links.json (or equivalent per-flight verdicts) --
this script re-derives the flight-level table itself so it can be run
standalone against a fresh dfr-flights.geojson pull.

Two location-level tests, run in the order this project arrived at them:

  1. Naive location-recurrence, against a CORRECTLY specified shuffle null
     (each flight independently draws a destination from the dataset's own
     measured popularity distribution). This is deliberately weak -- see the
     docstring on shuffle_null_location() for why it comes back non-significant
     even for the two ground-truth-confirmed repeat locations, and why that is
     an honest result, not a failure.

  2. The referent-centered follow-up: for flights that DO settle at a known
     repeat location, is their SHAPE (loiter density, turning) different from
     flights that settle elsewhere at a comparable distance from the dock?
     Distance-matching is required first -- duration and real path length are
     almost entirely explained by dock distance and will look "different"
     for any location that merely happens to be far from the dock, which is
     not a behavioral finding.

Usage:
    python3 dfr_behavior_profile.py
Writes: dfr-flights-master.{csv,json}, dfr-location-shuffle-null.json,
        dfr-behavior-by-location.json into the current directory.
"""
import json, csv, math, random, statistics, collections, datetime, re
import urllib.request, urllib.parse, time

DOCK = (36.273, -86.691)
CFS = ("https://services2.arcgis.com/HdTo6HJqh92wn4D8/arcgis/rest/services/"
       "Metro_Nashville_Police_Department_Calls_for_Service_view/FeatureServer/0/query")
random.seed(20260815)  # fixed for reproducibility -- do not tune to change results


def km(la1, lo1, la2, lo2):
    R = 6371.0
    dl = math.radians(la2 - la1); dn = math.radians(lo2 - lo1)
    a = math.sin(dl/2)**2 + math.cos(math.radians(la1))*math.cos(math.radians(la2))*math.sin(dn/2)**2
    return 2 * R * math.asin(math.sqrt(a))


def bearing(la1, lo1, la2, lo2):
    dlon = math.radians(lo2 - lo1)
    y = math.sin(dlon) * math.cos(math.radians(la2))
    x = math.cos(math.radians(la1))*math.sin(math.radians(la2)) - math.sin(math.radians(la1))*math.cos(math.radians(la2))*math.cos(dlon)
    return math.degrees(math.atan2(y, x))


def ang_diff(a, b):
    return (b - a + 180) % 360 - 180


def flatten(g):
    if not g:
        return []
    t, c = g.get("type"), g.get("coordinates")
    if t == "LineString":
        return c
    if t == "MultiLineString":
        return [pt for part in c for pt in part]
    return []


def api(where, fields, extra=None, count_only=False):
    p = {"where": where, "returnGeometry": "false", "f": "json"}
    if count_only:
        p["returnCountOnly"] = "true"
    else:
        p["outFields"] = fields
    if extra:
        p.update(extra)
    for a in range(4):
        try:
            d = json.load(urllib.request.urlopen(CFS + "?" + urllib.parse.urlencode(p), timeout=180))
            if "error" in d:
                raise RuntimeError(d["error"].get("message", "arcgis error"))
            return d
        except Exception:
            if a == 3:
                raise
            time.sleep(3)


def load_flights(path="dfr-flights.geojson"):
    """Dedup by flight_id -- the upstream feed double-logs some rows (see
    §0.1 of dfr-behavior-profile.md)."""
    raw = json.load(open(path))["features"]
    seen, out = set(), []
    for f in raw:
        fid = f["properties"]["flight_id"]
        if fid in seen:
            continue
        seen.add(fid)
        out.append(f)
    return out


def build_master(flights, calls_by_event):
    """One row per flight: linkage verdict + shape features. Reuses the same
    typed collapsed/plural/void scheme as the Flock linkage work."""
    rows = []
    for f in flights:
        p = f["properties"]
        fid = p["flight_id"]
        pd_ids = re.findall(r"\bPD20\d{2}\d{8}\b", p.get("external_id", "") or "")
        g = f.get("geometry")
        parts = (g["coordinates"] if g and g["type"] == "MultiLineString" else [g["coordinates"]]) if g else []

        real_len = total_turn = turn_len = 0.0
        n_vert = 0
        for part in parts:
            pts = [(lat, lon) for lon, lat in part if km(lat, lon, DOCK[0], DOCK[1]) > 0.1]
            if len(pts) >= 2:
                real_len += sum(km(pts[i][0], pts[i][1], pts[i+1][0], pts[i+1][1]) for i in range(len(pts)-1))
            if len(pts) >= 4:
                seglen = sum(km(pts[i][0], pts[i][1], pts[i+1][0], pts[i+1][1]) for i in range(len(pts)-1))
                if seglen >= 0.02:
                    bearings = [bearing(pts[i][0], pts[i][1], pts[i+1][0], pts[i+1][1]) for i in range(len(pts)-1)]
                    turns = [abs(ang_diff(bearings[i], bearings[i+1])) for i in range(len(bearings)-1)]
                    total_turn += sum(turns)
                    turn_len += seglen
            n_vert += len(pts)

        non_dock = [(lat, lon) for lon, lat in flatten(g) if km(lat, lon, DOCK[0], DOCK[1]) > 0.15]
        density = 0.0
        dest_lat = dest_lon = None
        if non_dock:
            CELL = 0.0004
            cc = collections.Counter((round(lat/CELL), round(lon/CELL)) for lat, lon in non_dock)
            best_cell, n = cc.most_common(1)[0]
            density = n / len(non_dock)
            dest_lat, dest_lon = best_cell[0]*CELL, best_cell[1]*CELL

        best = None
        for i in pd_ids:
            if i not in calls_by_event:
                continue
            a = calls_by_event[i][0]
            to = datetime.datetime.fromtimestamp(p["takeoff"]/1000, datetime.UTC)
            cr = datetime.datetime.fromtimestamp(a["Call_Received"]/1000, datetime.UTC) if a.get("Call_Received") else None
            dt = (to - cr).total_seconds()/60.0 if cr else None
            d_km = None
            if a.get("Latitude") and non_dock:
                d_km = min(km(a["Latitude"], a["Longitude"], lat, lon) for lat, lon in non_dock)
            rank = 0 if (dt is not None and abs(dt) <= 15 and d_km is not None and d_km <= 0.25) else 1
            if best is None or rank < best[0]:
                best = (rank, i, dt, d_km, a)

        verdict = "void" if pd_ids and best is None else ("collapsed" if best and best[0] == 0 else ("plural" if best else "no_citation"))

        to = datetime.datetime.fromtimestamp(p["takeoff"]/1000, datetime.UTC)
        rows.append({
            "flight_id": fid, "external_id_raw": p.get("external_id"),
            "flight_purpose": (p.get("flight_purpose") or "").strip(),
            "takeoff_utc": to.isoformat(),
            "duration_min": round((p["landing"]-p["takeoff"])/60000.0, 2),
            "verdict": verdict,
            "linked_event_number": best[1] if best else None,
            "linked_dt_minutes": round(best[2], 1) if best and best[2] is not None else None,
            "linked_nearest_km": round(best[3], 3) if best and best[3] is not None else None,
            "real_path_km": round(real_len, 3),
            "turn_deg_per_km": round(total_turn/turn_len, 1) if turn_len > 0 else None,
            "loiter_density": round(density, 3),
            "dest_lat": round(dest_lat, 4) if dest_lat else None,
            "dest_lon": round(dest_lon, 4) if dest_lon else None,
            "dest_dist_from_dock_km": round(km(dest_lat, dest_lon, DOCK[0], DOCK[1]), 2) if dest_lat else None,
        })
    return rows


def shuffle_null_location(rows, n_shuffle=2000):
    """The correctly-specified null (see dfr-behavior-profile.md §2b history):
    each flight independently draws ONE destination from the dataset's own
    real popularity distribution -- NOT a permutation of flight-ID labels
    over already-fixed positions (that null is structurally guaranteed to
    reproduce the real cluster sizes, since it never touches geography at
    all -- a bug found and documented here on purpose).

    This tests: "if there were no repeat-targeting beyond ordinary place
    popularity, how big would the biggest incidental cluster be?" Answer, in
    Nashville's May-Aug 2026 trial: median 18 flights, purely by chance --
    which is why raw recurrence counts (including the two ground-truth
    confirmed properties) do not clear significance here. Report that
    honestly; do not tune n_shuffle or the cell size to make anything clear."""
    with_dest = [r for r in rows if r.get("dest_lat")]
    dest_pool = [(r["dest_lat"], r["dest_lon"]) for r in with_dest]
    CELL = 0.0013

    def capped_clusters(dest_list):
        cellcount = collections.defaultdict(list)
        for i, (lat, lon) in enumerate(dest_list):
            cellcount[(round(lat/CELL), round(lon/CELL))].append(i)
        cells = sorted(cellcount.keys())
        used, sizes = set(), []
        for c in cells:
            if c in used:
                continue
            group = [c2 for c2 in cells if c2 not in used and abs(c2[0]-c[0]) <= 1 and abs(c2[1]-c[1]) <= 1]
            for g in group:
                used.add(g)
            sizes.append(sum(len(cellcount[g]) for g in group))
        return sizes

    null_max = []
    for _ in range(n_shuffle):
        draw = random.choices(dest_pool, k=len(dest_pool))
        null_max.append(max(capped_clusters(draw), default=0))
    null_max.sort()

    observed = capped_clusters(dest_pool)
    observed.sort(reverse=True)

    def pval(n):
        return sum(1 for x in null_max if x >= n) / len(null_max)

    return {"n_shuffles": n_shuffle, "null_distribution": null_max,
            "null_median": null_max[len(null_max)//2],
            "observed_top_clusters": observed[:10],
            "top_cluster_pvalue": pval(observed[0]) if observed else None}


def behavior_by_distance_band(rows, known_locations, band_km=0.5):
    """For each known repeat-location (name -> (lat, lon, radius_km)),
    compare loiter_density/turning of flights settling there against flights
    settling elsewhere at the SAME distance from the dock (+/- band_km) --
    distance alone explains duration and real_path_km differences, so those
    are not tested here; only distance-independent shape features are."""
    out = {}
    for name, (lat, lon, r) in known_locations.items():
        here = [row for row in rows if row.get("dest_lat") and km(row["dest_lat"], row["dest_lon"], lat, lon) < r]
        if not here:
            continue
        d = here[0]["dest_dist_from_dock_km"]
        band = [row for row in rows if row.get("dest_dist_from_dock_km") is not None
                and abs(row["dest_dist_from_dock_km"] - d) <= band_km]
        here_ids = {row["flight_id"] for row in here}
        other = [row for row in band if row["flight_id"] not in here_ids]

        def med(field, subset):
            vals = [row[field] for row in subset if row.get(field) is not None]
            return statistics.median(vals) if vals else None

        # permutation test on loiter_density specifically -- the feature that
        # survives distance-matching; duration/real_path_km are reported for
        # transparency but are expected to match once distance-controlled
        a = [row["loiter_density"] for row in here if row.get("loiter_density") is not None]
        b = [row["loiter_density"] for row in other if row.get("loiter_density") is not None]
        pval = None
        if a and b:
            obs = statistics.median(a) - statistics.median(b)
            pool = a + b
            diffs = []
            for _ in range(5000):
                random.shuffle(pool)
                diffs.append(statistics.median(pool[:len(a)]) - statistics.median(pool[len(a):]))
            pval = sum(1 for x in diffs if abs(x) >= abs(obs)) / len(diffs)

        out[name] = {
            "n_here": len(here), "n_distance_matched_other": len(other),
            "dest_dist_from_dock_km": d,
            "duration_min": {"here": med("duration_min", here), "other": med("duration_min", other)},
            "real_path_km": {"here": med("real_path_km", here), "other": med("real_path_km", other)},
            "loiter_density": {"here": med("loiter_density", here), "other": med("loiter_density", other),
                               "permutation_p_value": pval},
        }
    return out


if __name__ == "__main__":
    flights = load_flights()
    pd_ids = sorted({i for f in flights for i in re.findall(r"\bPD20\d{2}\d{8}\b", f["properties"].get("external_id","") or "")})
    CF = "Event_Number,Complaint_Number,Tencode_Description,Disposition_Description,Latitude,Longitude,Call_Received"
    calls = {}
    for i in range(0, len(pd_ids), 25):
        d = api("Event_Number IN (" + ",".join(f"'{x}'" for x in pd_ids[i:i+25]) + ")", CF)
        for ft in d.get("features", []):
            calls.setdefault(ft["attributes"]["Event_Number"], []).append(ft["attributes"])

    rows = build_master(flights, calls)
    json.dump(rows, open("dfr-flights-master.json", "w"), indent=1)
    with open("dfr-flights-master.csv", "w", newline="") as fcsv:
        w = csv.DictWriter(fcsv, fieldnames=list(rows[0].keys()))
        w.writeheader()
        for r in rows:
            w.writerow(r)
    print(f"wrote {len(rows)} rows -> dfr-flights-master.{{csv,json}}")

    null_result = shuffle_null_location(rows)
    json.dump(null_result, open("dfr-location-shuffle-null.json", "w"), indent=1)
    print(f"shuffle null: median largest-cluster-by-chance = {null_result['null_median']} flights")
    print(f"  observed top real cluster: {null_result['observed_top_clusters'][0]} flights, "
          f"p={null_result['top_cluster_pvalue']:.4f}")

    KNOWN = {
        "Churchill Crossing": (36.3013, -86.6912, 0.20),
        "Robinson Rowhouses": (36.2668, -86.6648, 0.20),
    }
    behavior = behavior_by_distance_band(rows, KNOWN)
    json.dump(behavior, open("dfr-behavior-by-location.json", "w"), indent=1)
    for name, r in behavior.items():
        print(f"\n{name}: n={r['n_here']} vs {r['n_distance_matched_other']} distance-matched (dock dist {r['dest_dist_from_dock_km']}km)")
        print(f"  loiter_density: here={r['loiter_density']['here']:.2f} other={r['loiter_density']['other']:.2f} "
              f"p={r['loiter_density']['permutation_p_value']:.4f}")

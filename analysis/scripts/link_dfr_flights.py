#!/usr/bin/env python3
"""DFR flight -> MNPD call-for-service -> incident report, three nulls.

Corrects the first attempt: PD########## is a CAD *event* number, not an
incident number. It matches Calls_for_Service.Event_Number as an exact string.
The chain is flight -> call -> (sometimes) incident report.
"""
import json, math, random, collections, datetime, statistics
import urllib.request, urllib.parse, time

CFS = ("https://services2.arcgis.com/HdTo6HJqh92wn4D8/arcgis/rest/services/"
       "Metro_Nashville_Police_Department_Calls_for_Service_view/FeatureServer/0/query")
random.seed(20260814)


def api(url, where, fields, extra=None, count_only=False):
    p = {"where": where, "returnGeometry": "false", "f": "json"}
    if count_only:
        p["returnCountOnly"] = "true"
    else:
        p["outFields"] = fields
    if extra:
        p.update(extra)
    for a in range(4):
        try:
            d = json.load(urllib.request.urlopen(url + "?" + urllib.parse.urlencode(p), timeout=180))
            # An ArcGIS error envelope is a 200 with an "error" key and no
            # features. Swallowing it silently drops whole chunks and looks
            # exactly like "no match" -- fail loudly instead.
            if "error" in d:
                raise RuntimeError(d["error"].get("message", "arcgis error"))
            return d
        except Exception:
            if a == 3:
                raise
            time.sleep(3)


import re

def flatten_coords(geom):
    """Every vertex of a flight path as [lon, lat] pairs.

    The feed returns 370 of 409 paths as MultiLineString and only 39 as
    LineString. Accepting LineString alone silently dropped 90% of flights and
    read downstream as "no geometry" rather than as a parse gap.
    """
    if not geom:
        return None
    t, c = geom.get("type"), geom.get("coordinates")
    if not c:
        return None
    if t == "LineString":
        return c
    if t == "MultiLineString":
        return [pt for part in c for pt in part]
    return None


FLIGHTS = json.load(open("dfr-flights.geojson"))["features"]
raw_count = len(FLIGHTS)
# The upstream Skydio feed double-logs some rows -- the DFR repo's own README
# says so ("Flights are deduplicated by flight_id because the upstream feed
# double-logs some rows"). Do the same here before anything downstream counts
# flights, or every count is inflated by the dupes.
seen_fid = set()
FLIGHTS_DEDUPED = []
for f in FLIGHTS:
    fid = f["properties"]["flight_id"]
    if fid in seen_fid:
        continue
    seen_fid.add(fid)
    FLIGHTS_DEDUPED.append(f)
print(f"raw source rows: {raw_count} | distinct flight_id: {len(FLIGHTS_DEDUPED)} "
      f"| duplicate rows dropped: {raw_count - len(FLIGHTS_DEDUPED)}")

recs = []
for f in FLIGHTS_DEDUPED:
    pr = f["properties"]
    ids = re.findall(r"\b(?:PD|FD)20\d{2}\d{8}\b", pr.get("external_id", "") or "")
    c = flatten_coords(f.get("geometry"))
    recs.append({"flight_id": pr["flight_id"], "ids": ids, "coords": c,
                 "purpose": (pr.get("flight_purpose") or "").strip(),
                 "takeoff": pr["takeoff"], "landing": pr["landing"],
                 "external_id": pr.get("external_id")})

ev = sorted({i for r in recs for i in r["ids"] if i.startswith("PD")})
print(f"flights {len(recs)} | distinct PD event numbers {len(ev)}")

CF = ("Event_Number,Complaint_Number,Tencode_Description,Tencode_Suffix_Description,"
      "Disposition_Description,Block,Street_Name,Unit_Dispatched,Latitude,Longitude,"
      "ZONE_,Call_Received")
calls = {}
for i in range(0, len(ev), 25):
    chunk = ev[i:i+25]
    w = "Event_Number IN (" + ",".join(f"'{x}'" for x in chunk) + ")"
    d = api(CFS, w, CF)
    for ft in d.get("features", []):
        a = ft["attributes"]
        calls.setdefault(a["Event_Number"], []).append(a)

print(f"resolved to a call-for-service record: {len(calls)}/{len(ev)} = {100*len(calls)/len(ev):.1f}%")

# ---- N1 null: does an arbitrary in-range event number resolve? ----
seqs = sorted(int(e[6:]) for e in ev)
lo, hi = seqs[0], seqs[-1]
probe = sorted({f"PD2026{random.randint(lo, hi):08d}" for _ in range(len(ev) * 4)})
ph = 0
for i in range(0, len(probe), 25):
    w = "Event_Number IN (" + ",".join(f"'{x}'" for x in probe[i:i+25]) + ")"
    d = api(CFS, w, "Event_Number")
    ph += len({ft["attributes"]["Event_Number"] for ft in d.get("features", [])})
p_dens = ph / len(probe)


def binom_tail(k, n, p):
    if p <= 0:
        return 0.0 if k > 0 else 1.0
    return min(1.0, sum(math.comb(n, i) * p**i * (1-p)**(n-i) for i in range(k, n+1)))


p1 = binom_tail(len(calls), len(ev), p_dens)
print(f"N1 null (arbitrary in-range event number resolves): {ph}/{len(probe)} = {100*p_dens:.1f}%")
print(f"N1 p = {p1:.3g}  cleared: {p1 < 0.05}")
print()

# ---- geocode coverage on the matched calls ----
geo = sum(1 for v in calls.values() if v[0].get("Latitude"))
print(f"matched calls carrying coordinates: {geo}/{len(calls)} = {100*geo/len(calls):.0f}%")
cn = sum(1 for v in calls.values() if v[0].get("Complaint_Number"))
print(f"matched calls carrying a Complaint_Number (-> incident report): {cn}/{len(calls)} = {100*cn/len(calls):.0f}%")
print()

# ---- null reference pool: calls during the DFR trial window ----
pool = []
for off in range(0, 30000, 2000):
    d = api(CFS, "Call_Received >= TIMESTAMP '2026-05-26 00:00:00' AND "
                 "Call_Received <= TIMESTAMP '2026-08-09 00:00:00' AND Latitude IS NOT NULL",
            "Event_Number,Call_Received,Latitude,Longitude,Tencode_Description",
            extra={"resultOffset": off, "resultRecordCount": 2000})
    fs = d.get("features", [])
    pool += [ft["attributes"] for ft in fs]
    if len(fs) < 2000:
        break
print(f"null reference pool (geocoded calls in the DFR trial window): {len(pool):,}")


def km(la1, lo1, la2, lo2):
    R = 6371.0
    dl = math.radians(la2 - la1); dn = math.radians(lo2 - lo1)
    a = math.sin(dl/2)**2 + math.cos(math.radians(la1))*math.cos(math.radians(la2))*math.sin(dn/2)**2
    return 2 * R * math.asin(math.sqrt(a))


obs_dt, obs_km, null_dt, null_km, links = [], [], [], [], []
for r in recs:
    hits = [i for i in r["ids"] if i in calls]
    if not hits or not r["coords"]:
        continue
    to = datetime.datetime.fromtimestamp(r["takeoff"]/1000, datetime.UTC).replace(tzinfo=None)
    ln = datetime.datetime.fromtimestamp(r["landing"]/1000, datetime.UTC).replace(tzinfo=None)
    elon, elat = r["coords"][-1][0], r["coords"][-1][1]
    slon, slat = r["coords"][0][0], r["coords"][0][1]
    for i in hits:
        a = calls[i][0]
        if not a.get("Call_Received"):
            continue
        cr = datetime.datetime.fromtimestamp(a["Call_Received"]/1000, datetime.UTC).replace(tzinfo=None)
        dt = (to - cr).total_seconds() / 60.0
        obs_dt.append(dt)
        d_km = None
        if a.get("Latitude"):
            # nearest approach of the whole flight path, not just its terminus
            d_km = min(km(a["Latitude"], a["Longitude"], c[1], c[0]) for c in r["coords"])
            obs_km.append(d_km)
        links.append({"flight_id": r["flight_id"], "event": i, "purpose": r["purpose"],
                      "tencode": a.get("Tencode_Description"),
                      "disposition": a.get("Disposition_Description"),
                      "unit": a.get("Unit_Dispatched"),
                      "complaint": a.get("Complaint_Number"),
                      "takeoff": to.isoformat()[:16], "call_received": cr.isoformat()[:16],
                      "dt_min": round(dt, 1), "nearest_km": round(d_km, 3) if d_km is not None else None,
                      "flight_min": round((ln - to).total_seconds()/60, 1),
                      "n_ids": len(r["ids"])})
        for _ in range(5):
            q = random.choice(pool)
            qcr = datetime.datetime.fromtimestamp(q["Call_Received"]/1000, datetime.UTC).replace(tzinfo=None)
            null_dt.append((to - qcr).total_seconds()/60.0)
            null_km.append(min(km(q["Latitude"], q["Longitude"], c[1], c[0]) for c in r["coords"]))

ad = sorted(abs(x) for x in obs_dt); an = sorted(abs(x) for x in null_dt)
print()
print("=== N2 temporal: takeoff minus call-received ===")
print(f"  observed median |dt| {ad[len(ad)//2]:>10,.1f} min   n={len(ad)}")
print(f"  null     median |dt| {an[len(an)//2]:>10,.1f} min   n={len(an)}")
for thr in (5, 15, 60):
    o = sum(1 for x in ad if x <= thr)/len(ad); nn = sum(1 for x in an if x <= thr)/len(an)
    print(f"    within {thr:>3} min: observed {100*o:5.1f}%   null {100*nn:5.2f}%")
nn60 = sum(1 for x in an if x <= 15)/len(an)
p2 = binom_tail(sum(1 for x in ad if x <= 15), len(ad), nn60)
print(f"  N2 p (15-min threshold) = {p2:.3g}  cleared: {p2 < 0.05}")

ak = sorted(obs_km); nk = sorted(null_km)
print()
print("=== N3 spatial: nearest approach of flight path to call location ===")
print(f"  observed median {ak[len(ak)//2]:>8.3f} km   n={len(ak)}")
print(f"  null     median {nk[len(nk)//2]:>8.3f} km   n={len(nk)}")
for thr in (0.1, 0.25, 1.0):
    o = sum(1 for x in ak if x <= thr)/len(ak); nn = sum(1 for x in nk if x <= thr)/len(nk)
    print(f"    within {thr:>5} km: observed {100*o:5.1f}%   null {100*nn:5.2f}%")
nk25 = sum(1 for x in nk if x <= 0.25)/len(nk)
p3 = binom_tail(sum(1 for x in ak if x <= 0.25), len(ak), nk25)
print(f"  N3 p (250 m threshold) = {p3:.3g}  cleared: {p3 < 0.05}")

json.dump({"p1": p1, "p2": p2, "p3": p3, "p_density": p_dens, "links": links},
          open("dfr-flight-links.json", "w"), indent=1)

print()
print("=== joint feature agreement (the golden shape) ===")
both = [l for l in links if l["nearest_km"] is not None]
tight = [l for l in both if abs(l["dt_min"]) <= 15 and l["nearest_km"] <= 0.25]
print(f"  links with both features tight (<=15 min AND <=250 m): {len(tight)}/{len(both)} = {100*len(tight)/len(both):.0f}%")
print(f"  expected under independence of the two nulls: {100*nn60*nk25:.4f}%")
print()
print("=== 12 tightest ===")
for l in sorted(tight, key=lambda x: (abs(x["dt_min"])))[:12]:
    print(f"  {l['purpose'][:24]:24} tencode={str(l['tencode'])[:14]:14} dt={l['dt_min']:>7.1f}m "
          f"d={l['nearest_km']:.3f}km flight={l['flight_min']:.0f}m disp={str(l['disposition'])[:22]}")

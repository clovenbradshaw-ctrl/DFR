#!/usr/bin/env python3
"""
dfr_local_plain.py  —  one command, whole pipeline, on a loop. LOCAL + PLAINTEXT:
nothing is uploaded anywhere, and there is NO password and NO encryption. It just
writes plain JSON files to disk and starts printing immediately.

    python3 dfr_local_plain.py

That's it. Every 30 minutes it will, with no other commands:
  1. DISCOVER  new dashboards from Skydio's ArcGIS org (auto-finds new agencies)
  2. LOCATE    any newly-seen dashboard once, via a public geocoder (incremental)
  3. FETCH     each agency's flights — but only where the flight count changed
               (cheap count check first), paced politely across the window
  4. DEDUPE    by flight_id into an append-only archive, and log any flights that
               DISAPPEARED upstream (a curation/scrub signal)
  5. SAVE      append each new flight (and agency) as one plain JSON line to disk

Other flags (optional, not required):
  --once              run a single cycle and exit
  --interval N        minutes between cycles (default 30)
  --include-staging   also track -staging dashboards
  --full              force a full re-fetch of every agency this cycle

Output (created & grown automatically):
  ./dfr_export/flights.jsonl     one plain JSON flight per line (append-only)
  ./dfr_export/agencies.jsonl    one plain JSON agency per line (append-only)

Internal state (under ./dfr_state):
  locations.json      uuid -> centroid + geocoded address/city/state
  flights.jsonl       raw feature archive (dedup source)
  removals.jsonl      log of flights that vanished upstream
  .saved_data_lines / .saved_agency_uuids.json   incremental write watermarks

Requires: pip install requests
"""

import argparse, json, os, statistics, sys, time
from datetime import datetime, timezone

import requests
from requests.adapters import HTTPAdapter
from urllib3.util.retry import Retry

# ── Config ───────────────────────────────────────────────────────────────
ORG = "mnhQTdIYDA7UoY2l"
DIRECTORY = f"https://services7.arcgis.com/{ORG}/arcgis/rest/services?f=json"
SVC_BASE = f"https://services7.arcgis.com/{ORG}/arcgis/rest/services"
DASH_URL = "https://cloud.skydio.com/dashboard/{uuid}"

# Local export — plain JSON, one record per line, append-only.
OUT = "dfr_export"
DATA_PATH = f"{OUT}/flights.jsonl"     # one plain JSON flight per line
AGENCIES_PATH = f"{OUT}/agencies.jsonl"  # one plain JSON agency per line

CONTACT = "you@example.com"            # real email — required by Nominatim policy
NOMINATIM = "https://nominatim.openstreetmap.org/reverse"

STATE = "dfr_state"
INDEX = f"{STATE}/locations.json"      # the directory (uuid -> location)
FLIGHTS = f"{STATE}/flights.jsonl"     # raw feature archive (dedup source)
REMOVALS = f"{STATE}/removals.jsonl"
SAVED_DATA = f"{STATE}/.saved_data_lines"      # how many archive flights already written out
SAVED_AGENCIES = f"{STATE}/.saved_agency_uuids.json"

INTER_REQ = 0.4                        # polite min gap between ArcGIS calls (s)
GEO_SLEEP = 1.1                        # Nominatim >= 1 req/sec
PAGE = 5000                            # requested page size (capped to server maxRecordCount)
SAMPLE_N = 25                          # samples for centroid
FULL_SWEEP_EVERY = 48                  # cycles between forced full re-fetch (~24h)


def now_iso():
    return datetime.now(timezone.utc).isoformat()


def make_session():
    s = requests.Session()
    s.headers.update({
        "User-Agent": ("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) "
                       "AppleWebKit/537.36 (KHTML, like Gecko) "
                       "Chrome/124.0.0.0 Safari/537.36"),
        "Accept": "application/json,text/plain,*/*", "From": CONTACT,
    })
    retry = Retry(total=5, connect=5, read=5, backoff_factor=1.0,
                  status_forcelist=[429, 500, 502, 503, 504], allowed_methods=["GET"],
                  respect_retry_after_header=True)
    s.mount("https://", HTTPAdapter(max_retries=retry))
    return s


S = make_session()
_last_req = [0.0]


def get(url, **params):
    """Paced GET that returns parsed JSON."""
    dt = time.time() - _last_req[0]
    if dt < INTER_REQ:
        time.sleep(INTER_REQ - dt)
    r = S.get(url, params=params or None, timeout=60)
    _last_req[0] = time.time()
    r.raise_for_status()
    return r.json()


def load_json(path, default):
    if os.path.exists(path):
        try:
            return json.load(open(path, encoding="utf-8"))
        except Exception:
            pass
    return default


def save_json(path, obj):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    json.dump(obj, open(path, "w", encoding="utf-8"), indent=2)


# ── discover / count / fetch / locate ────────────────────────────────────
def discover(include_staging):
    found = {}
    for svc in get(DIRECTORY).get("services", []):
        if svc.get("type") != "FeatureServer":
            continue
        name = svc["name"].split("/")[-1]
        if name.endswith("-production"):
            found[name[:-11]] = ("production", name)
        elif include_staging and name.endswith("-staging"):
            found.setdefault(name[:-8], ("staging", name))
    return found


def flight_count(fs):
    try:
        return get(f"{fs}/0/query", where="1=1", returnCountOnly="true", f="json").get("count")
    except Exception:
        return None


def fetch_all(fs, expect=None):
    """Paginate the ENTIRE layer -> all GeoJSON features (4326). No cap.

    Uses the server's real maxRecordCount as the page size (a request larger than
    the server allows is silently truncated, so we must page by what it actually
    returns), advances by the count returned each page, and keeps going while the
    server flags exceededTransferLimit OR a full page came back. Verifies the final
    tally against the count query and warns on any shortfall."""
    # discover the server's true page size
    page = PAGE
    try:
        meta = get(f"{fs}/0", f="json")
        srv = meta.get("maxRecordCount")
        if srv:
            page = min(PAGE, int(srv))
    except Exception:
        pass

    feats, offset, pages = [], 0, 0
    while True:
        j = get(f"{fs}/0/query", where="1=1", outFields="*", returnGeometry="true",
                outSR="4326", orderByFields="OBJECTID ASC",
                resultOffset=offset, resultRecordCount=page, f="geojson")
        batch = j.get("features", []) or []
        feats.extend(batch)
        pages += 1
        more = bool(j.get("properties", {}).get("exceededTransferLimit")
                    or j.get("exceededTransferLimit")) or len(batch) == page
        if pages > 1 or more:
            print(f"            page {pages}: +{len(batch)} (total {len(feats)})", flush=True)
        if not batch or not more:
            break
        offset += len(batch)

    if expect is not None and len(feats) < expect:
        print(f"            ! WARNING: fetched {len(feats)} but count says {expect} "
              f"-- possible server cap; not all flights retrieved", flush=True)
    return feats


def first_coord(geom):
    if not geom:
        return None
    t, c = geom.get("type"), geom.get("coordinates")
    try:
        if t == "Point":           return (c[0], c[1])
        if t == "LineString":      return (c[0][0], c[0][1])
        if t == "MultiLineString": return (c[0][0][0], c[0][0][1])
        if t == "Polygon":         return (c[0][0][0], c[0][0][1])
    except (IndexError, TypeError):
        return None
    return None


def centroid_from_feats(feats):
    xs, ys = [], []
    for f in feats[:SAMPLE_N]:
        ll = first_coord(f.get("geometry"))
        if ll:
            xs.append(ll[0]); ys.append(ll[1])
    if not xs:
        return None
    return (round(statistics.median(xs), 6), round(statistics.median(ys), 6))


def reverse_geocode(lat, lon):
    try:
        j = get(NOMINATIM, lat=lat, lon=lon, format="jsonv2", zoom="14", addressdetails="1")
        a = j.get("address", {})
        return {"lat": lat, "lon": lon, "geocoded_at": now_iso(),
                "city": a.get("city") or a.get("town") or a.get("village")
                        or a.get("hamlet") or a.get("municipality") or "",
                "county": a.get("county", ""), "state": a.get("state", ""),
                "address": ", ".join(x for x in (a.get("road"),
                           a.get("city") or a.get("town") or a.get("village"),
                           a.get("state"), a.get("postcode")) if x),
                "display_name": j.get("display_name", "")}
    except Exception as e:
        return {"lat": lat, "lon": lon, "geocoded_at": now_iso(),
                "city": "", "county": "", "state": "", "address": "",
                "display_name": f"err:{e}"}


def load_flights():
    """Load the readable JSONL archive -> list of features (file order preserved)."""
    out = []
    if os.path.exists(FLIGHTS):
        with open(FLIGHTS, encoding="utf-8") as f:
            for ln in f:
                ln = ln.strip()
                if ln:
                    try:
                        out.append(json.loads(ln))
                    except Exception:
                        pass
    return out


def load_archive_ids(all_flights):
    """{uuid: set(flight_id)} from the in-memory flight list (dedup + removal check)."""
    by_uuid = {}
    for rec in all_flights:
        fid = (rec.get("properties") or {}).get("flight_id")
        if fid:
            by_uuid.setdefault(rec.get("uuid"), set()).add(fid)
    return by_uuid


def append_flight_lines(records):
    """Append new flights to the readable local JSONL (one per line)."""
    os.makedirs(STATE, exist_ok=True)
    with open(FLIGHTS, "a", encoding="utf-8") as f:
        for rec in records:
            f.write(json.dumps(rec, separators=(",", ":")) + "\n")


def merge_archive(uuid, fetched, seen_ids, all_flights):
    """Add new flights to the in-memory list AND append them to the readable JSONL;
    log upstream removals. Returns (added, removed, total, new_recs).
    new_recs is the list of freshly-added features (in append order) so the caller
    can encrypt + publish them immediately, the moment they exist."""
    fetched_ids, added, new_recs = set(), 0, []
    for f in fetched:
        fid = (f.get("properties") or {}).get("flight_id")
        if not fid:
            continue
        fetched_ids.add(fid)
        if fid not in seen_ids:
            seen_ids.add(fid)
            f["uuid"] = uuid                      # tag each flight with its agency
            all_flights.append(f)
            new_recs.append(f)
            added += 1
    if new_recs:
        append_flight_lines(new_recs)             # readable local JSONL, append-only
    removed = seen_ids - fetched_ids if fetched_ids else set()
    if removed:
        os.makedirs(STATE, exist_ok=True)
        with open(REMOVALS, "a", encoding="utf-8") as r:
            for fid in removed:
                r.write(json.dumps({"uuid": uuid, "flight_id": fid,
                                    "noticed_at": now_iso()}) + "\n")
    return added, len(removed), len(seen_ids), new_recs


# ── flight -> compact record (what gets encrypted, one per line) ──────────
def flight_record(feat):
    """Lean dict per flight for the encrypted line. Coordinates kept as-is (4326);
    geometry stays a list of parts so MultiLineString draws correctly."""
    p = feat.get("properties", {}) or {}
    geom = feat.get("geometry") or {}
    t = geom.get("type"); c = geom.get("coordinates")
    if t == "LineString":
        parts = [c] if c else []
    elif t == "MultiLineString":
        parts = [pp for pp in (c or []) if pp]
    else:
        parts = []
    if not parts:
        return None
    return {
        "u": feat.get("uuid"),                       # agency uuid
        "id": p.get("flight_id", ""),
        "x": p.get("external_id", ""),               # case number
        "p": p.get("flight_purpose", ""),
        "t": int((p.get("takeoff") or 0) // 1000),   # epoch seconds
        "d": int(((p.get("landing") or 0) - (p.get("takeoff") or 0)) // 1000)
             if (p.get("takeoff") and p.get("landing")) else 0,
        "o": p.get("organization_id", ""),
        "g": parts,                                  # [[ [lon,lat],... ], ...]
    }


# ── local save (append-only plain-JSON files under ./dfr_export) ──────────
def _read_watermark():
    """How many archive flights (by append index) have already been written to flights.jsonl."""
    if os.path.exists(SAVED_DATA):
        try:
            return int(open(SAVED_DATA).read().strip())
        except Exception:
            pass
    return 0


def _flight_lines(all_flights, start):
    """Yield (end_idx, lines) batches of plain-JSON flight lines for archive flights [start:].
    `end_idx` is the EXCLUSIVE archive index the batch covers, so the watermark advances
    correctly even past flights with no drawable geometry (which consume an index but emit
    no line). Batched only so the watermark advances incrementally and a crash mid-write
    resumes cleanly with no duplicates."""
    lines, batch_start, i, n = [], start, start, len(all_flights)
    while i < n:
        rec = flight_record(all_flights[i])
        if rec is not None:
            lines.append(json.dumps(rec, separators=(",", ":")))
            if len(lines) >= 2000:
                yield i + 1, lines                  # covers [batch_start, i]
                lines, batch_start = [], i + 1
        i += 1
    if lines:
        yield n, lines                              # final batch covers [batch_start, n)


def save_flight_backlog(all_flights):
    """Append every archive flight above the watermark to dfr_export/flights.jsonl, advancing
    the watermark per batch. Run at cycle start and after each agency merges. The watermark is
    the ledger, so this never re-writes or skips a flight. Returns lines written."""
    os.makedirs(OUT, exist_ok=True)
    start = _read_watermark()
    n_lines = 0
    with open(DATA_PATH, "a", encoding="utf-8") as f:
        for end_idx, lines in _flight_lines(all_flights, start):
            f.writelines(ln + "\n" for ln in lines)
            f.flush()
            open(SAVED_DATA, "w").write(str(end_idx))   # advance per batch
            n_lines += len(lines)
    return n_lines


def save_increment(all_flights, index, uuid, new_recs, saved_ag):
    """Save new data the instant an agency is merged & geocoded. Flights are saved
    WATERMARK-DRIVEN (everything above the last-saved index) via save_flight_backlog, so a
    backlog from an interrupted run is finished automatically on the next call — no gaps,
    no duplicates, resumable across restarts. The agency's directory line is saved once.
    `new_recs` is kept for signature compatibility; the watermark is the real ledger.
    Returns True if anything was written."""
    n_flight_lines = save_flight_backlog(all_flights)

    # ---- agency directory line: once per agency ----
    ent = index.get(uuid, {})
    save_agency = uuid not in saved_ag and ent.get("present")
    n_agency_lines = 0
    if save_agency:
        aline = json.dumps({
            "u": uuid, "city": ent.get("city", ""), "county": ent.get("county", ""),
            "state": ent.get("state", ""), "address": ent.get("address", ""),
            "centroid": ent.get("centroid"), "url": ent.get("dashboard_url", ""),
            "n": ent.get("flight_count")}, separators=(",", ":"))
        os.makedirs(OUT, exist_ok=True)
        with open(AGENCIES_PATH, "a", encoding="utf-8") as f:
            f.write(aline + "\n")
        saved_ag.add(uuid); save_json(SAVED_AGENCIES, list(saved_ag)); n_agency_lines = 1

    if not n_flight_lines and not n_agency_lines:
        return False
    print(f"            ↳ saved: {n_flight_lines} flight, {n_agency_lines} agency line(s)",
          flush=True)
    return True



# ── one cycle ─────────────────────────────────────────────────────────────
def cycle(args, cycle_n):
    os.makedirs(STATE, exist_ok=True)
    # the directory: uuid -> {service, env, counts, seen, location}
    index = load_json(INDEX, {})
    # the combined readable archive (JSON array) + per-agency seen-id sets from it
    all_flights = load_flights()
    archived = load_archive_ids(all_flights)
    full_sweep = args.full or (cycle_n % FULL_SWEEP_EVERY == 0)

    print(f"\n{'='*64}\n[{now_iso()}] cycle {cycle_n}  full_sweep={full_sweep}")
    print("  discovering dashboards from ArcGIS org ...")
    found = discover(args.include_staging)
    new = [u for u in found if u not in index]
    print(f"  {len(found)} dashboards live  ({len(new)} new, {len(found)-len(new)} known)")
    save_json(INDEX, index)   # write the directory now so it exists from the start

    # ── save setup: load what's already saved, finish any backlog ──
    saved_ag = set(load_json(SAVED_AGENCIES, []))
    drained = save_flight_backlog(all_flights)   # finish an interrupted run before sweeping
    if drained:
        print(f"  wrote {drained} backlogged flight line(s) from a previous run")

    N = len(found)
    n_fetched = n_skipped = n_geo = tot_added = tot_removed = n_saved = 0
    for i, (uuid, (env, name)) in enumerate(found.items(), 1):
        fs = f"{SVC_BASE}/{name}/FeatureServer"
        ent = index.get(uuid, {"uuid": uuid, "first_seen": now_iso()})
        prev_count = ent.get("flight_count")
        cnt = flight_count(fs)
        ent.update({"env": env, "dashboard_url": DASH_URL.format(uuid=uuid),
                    "feature_service": fs, "last_seen": now_iso(),
                    "flight_count": cnt, "present": True})
        lbl = (f'{ent.get("city","")}, {ent.get("state","")}'.strip(", ")
               or ent.get("display_name", "")[:24] or uuid[:8])

        seen_ids = archived.setdefault(uuid, set())
        why = ("new" if uuid in new else "full-sweep" if full_sweep
               else "count changed" if cnt != prev_count
               else "no archive" if not seen_ids else None)
        tag = "NEW " if uuid in new else "    "
        head = f"  [{i:>3}/{N}] {tag}{uuid[:8]} {lbl[:30]:<30}"

        if why is None:
            n_skipped += 1
            print(f"{head} cnt={cnt} = unchanged, skip")
            index[uuid] = ent
            save_json(INDEX, index)            # keep directory current every agency
            continue

        print(f"{head} cnt={cnt} (was {prev_count}) -> FETCH [{why}] ...")
        try:
            feats = fetch_all(fs, expect=cnt)
        except Exception as e:
            print(f"            ! fetch failed: {e}")
            index[uuid] = ent
            save_json(INDEX, index)
            continue
        n_fetched += 1
        added, removed, total, new_recs = merge_archive(uuid, feats, seen_ids, all_flights)
        tot_added += added; tot_removed += removed
        ent["archived_count"] = total

        if not ent.get("geocoded_at"):
            c = centroid_from_feats(feats)
            if c:
                print(f"            geocoding {c[1]},{c[0]} ...")
                loc = reverse_geocode(c[1], c[0])
                ent.update({"centroid": [loc["lon"], loc["lat"]], "city": loc["city"],
                            "county": loc["county"], "state": loc["state"],
                            "address": loc["address"], "display_name": loc["display_name"],
                            "geocoded_at": loc["geocoded_at"]})
                n_geo += 1
                lbl = f'{loc["city"]}, {loc["state"]}'.strip(", ") or lbl
                print(f"            -> {lbl}")
                time.sleep(GEO_SLEEP)
        flag = "!" if removed else "+"
        print(f"            {flag} fetched {len(feats)}  added {added}  removed {removed}  "
              f"archived total {total}")
        index[uuid] = ent
        save_json(INDEX, index)                # directory updated in real time

        # save THIS agency's new data right now, while the next ones still fetch
        if save_increment(all_flights, index, uuid, new_recs, saved_ag):
            n_saved += 1

    for uuid, ent in index.items():
        ent["present"] = uuid in found

    save_json(INDEX, index)   # the one directory file
    arch_total = sum(len(s) for s in archived.values())
    print(f"  --- cycle {cycle_n} sweep done: fetched {n_fetched}, skipped {n_skipped}, "
          f"geocoded {n_geo} new | +{tot_added} flights, -{tot_removed} removed | "
          f"archive {arch_total} flights across {len(archived)} agencies")
    print(f"  saved during sweep: {n_saved} agenc(ies)")

    # ── safety net ───────────────────────────────────────────────────────
    # Flights are saved the instant each agency merges (above). The only thing that can
    # be missing is a directory line for a present agency that was only ever skipped
    # (count unchanged every cycle and never written). Write those so the explorer never
    # references an unknown agency.
    leftover = [u for u, e in index.items()
                if e.get("present") and u not in saved_ag]
    if leftover:
        os.makedirs(OUT, exist_ok=True)
        with open(AGENCIES_PATH, "a", encoding="utf-8") as f:
            for u in leftover:
                f.write(json.dumps({
                    "u": u, "city": index[u].get("city", ""),
                    "county": index[u].get("county", ""), "state": index[u].get("state", ""),
                    "address": index[u].get("address", ""), "centroid": index[u].get("centroid"),
                    "url": index[u].get("dashboard_url", ""), "n": index[u].get("flight_count")},
                    separators=(",", ":")) + "\n")
        saved_ag.update(leftover); save_json(SAVED_AGENCIES, list(saved_ag))
        print(f"  backfilled {len(leftover)} agency directory line(s)")


def main():
    try:
        sys.stdout.reconfigure(line_buffering=True)   # flush each line as it prints
    except Exception:
        pass
    ap = argparse.ArgumentParser()
    ap.add_argument("--once", action="store_true")
    ap.add_argument("--interval", type=int, default=30, help="minutes between cycles")
    ap.add_argument("--include-staging", action="store_true")
    ap.add_argument("--full", action="store_true", help="force full re-fetch this cycle")
    args = ap.parse_args()

    n = 0
    while True:
        start = time.time()
        try:
            cycle(args, n)
        except Exception as e:
            print(f"[error] cycle {n}: {e}")
        n += 1
        if args.once:
            break
        wait = max(0, args.interval * 60 - (time.time() - start))
        print(f"[i] next cycle in {wait/60:.1f} min\n")
        time.sleep(wait)


if __name__ == "__main__":
    try:
        main()
    except KeyboardInterrupt:
        print("\n[stopped] state saved; re-run to resume.", file=sys.stderr)

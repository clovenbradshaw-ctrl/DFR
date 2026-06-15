# Nashville DFR Surveillance Footprint

A **citizen-led data project** that maps the actual drone flight paths from the
Metro Nashville Police Department (MNPD) **Drone-as-First-Responder (DFR)** trial,
which launched **May 26, 2026**, and overlays them against the neighborhoods,
schools, childcare centers, playgrounds, and places of worship beneath them.

The goal is to let anyone see *where* the drones fly and *who* lives under the
flight paths — and to verify it independently. This is **not an official
government source**: every layer on the map links back to its origin so the
evidence can be checked at the source.

> Questions: scores.patch.points@proton.me

## What's in this repo

The project has two public web surfaces and two data collectors. There is no
server — the site is static and everything is fetched live in the browser.

| Path | What it is |
|---|---|
| [`index.html`](./index.html) | **The public map.** A single-file, vanilla-JS + Leaflet app (no build step). It fetches DFR flights and demographics live, renders the interactive map, and can export a full data bundle in the browser. Served at the site root `/`. |
| [`explorer/`](./explorer) | **Prebuilt bundle of the DFR Explorer**, committed so GitHub Pages can serve it at `/explorer/` with no build step. Generated from `explorer-src/` — do not edit by hand. |
| [`explorer-src/`](./explorer-src) | **Source for the DFR Explorer**: a login-gated, end-to-end-encrypted data explorer built on Matrix (Vite project). See [`explorer-src/README.md`](./explorer-src/README.md) for its full design. |
| [`dfr_scraper.py`](./dfr_scraper.py) | **The live scraper.** Polls Skydio's ArcGIS feed and pushes new flights to a separate public data repo (`clovenbradshaw-ctrl/plain-text`), which is what the map reads. |
| [`dfr.py`](./dfr.py) | **A standalone, local copy of the collector.** Discovers Skydio DFR agencies, fetches flights, dedupes them, and writes plain JSON to local disk. No uploads, no credentials — for running your own copy of the data. |

## How it works

```
        Skydio ArcGIS FeatureServer  (the live source of DFR flight data)
                       │
        ┌──────────────┴───────────────┐
        │                              │
   dfr_scraper.py                    dfr.py
   (push to GitHub)            (write to local disk)
        │                              │
        ▼                              ▼
  clovenbradshaw-ctrl/plain-text   ./dfr_export/*.jsonl
  (public flight snapshot)         (your own copy)
        │
        ▼
   index.html  ── reads the snapshot, enriches it with the latest live
                  flights, and overlays demographics, council/precinct
                  boundaries, census tracts, and sensitive sites.
        │
        ▼
   explorer/   ── an alternative, private/shareable encrypted view of the
                  same dataset (optional; reachable from the map's "login" link).
```

### The map (`index.html`)

Open it in any browser, or visit the GitHub Pages site. At load it fetches, in
parallel:

- **Drone flight paths** — the snapshot at
  `clovenbradshaw-ctrl/plain-text` (`dfr/flight_paths.geojson`), enriched with
  the newest flights straight from the live Skydio ArcGIS feed.
- **Sensitive sites** — schools, childcare, playgrounds, and places of worship.
- **Council-district demographics** — from a precomputed ACS breakdown.
- **Boundaries** — Metro Nashville council districts and police precincts
  (Metro ArcGIS).
- **Census tracts** — demographics from the U.S. Census ACS 5-year API and
  tract geometry from Census TIGERweb.

All spatial work (point-in-polygon, distances, clipping) is hand-rolled in
vanilla JS — there are no mapping/geometry dependencies beyond Leaflet. Flights
are deduplicated by `flight_id` because the upstream feed double-logs some rows.

The **Export** button builds a downloadable ZIP entirely in the browser:
flight paths, sensitive sites, calls/incidents, tract analysis, district
demographics (CSV + GeoJSON), a `full_dataset.json`, a standalone HTML report,
and a `README.txt` describing the bundle.

### The explorer (`explorer/` + `explorer-src/`)

An optional second app for people who want a private, shareable copy of the
data. It signs in with a Matrix account and stores the dataset as an encrypted,
invite-only room — no backend, no API keys. The committed `explorer/` build is
what GitHub Pages serves; rebuild it from `explorer-src/` after any change
there. Full details are in [`explorer-src/README.md`](./explorer-src/README.md).

## Running it locally

**The map** needs nothing but a browser. Open `index.html` directly, or serve
the folder so the live feeds load cleanly:

```bash
python3 -m http.server 8000   # then open http://localhost:8000/
```

**The collectors** need Python 3 and `requests`:

```bash
pip install requests

python3 dfr.py            # local, plaintext — writes ./dfr_export/*.jsonl
python3 dfr.py --once     # a single cycle instead of looping every 30 min

python3 dfr_scraper.py    # single pull toward the GitHub data repo
python3 dfr_scraper.py --loop      # every 30 minutes
```

`dfr_scraper.py` pushes through a webhook; set `WEBHOOK_URL`/`WEBHOOK_HEADERS`
at the top of the file before using it. `dfr.py` writes only to local disk and
needs no configuration.

**The explorer** is a Vite project:

```bash
cd explorer-src
npm install
npm run dev      # http://localhost:5173/explorer/
npm run build    # regenerates the committed ../explorer bundle
```

## A note on the data

The flight data comes from MNPD's own publicly disclosed DFR dashboard (served
by its vendor, Skydio). This project only collects, mirrors, and visualizes what
is already public. Because the feeds are fetched live, figures reflect whatever
the upstream sources returned at the moment of viewing.

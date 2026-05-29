# DFR Explorer

A login-gated, end-to-end-encrypted **data explorer for the Nashville
Drone-as-First-Responder (DFR) dataset**, with mapping and a background
scraper that runs on the user's own computer.

It is "another HTML page" on the DFR repo — built to `/explorer/` and served by
GitHub Pages **alongside** the existing main site (`/index.html`), which it does
not touch.

```
https://<pages-domain>/            ← existing DFR surveillance-footprint site
https://<pages-domain>/explorer/   ← this app
```

## What it does

- **Sign in with Matrix.** Bring your own homeserver (default `matrix.org`).
  No backend, no API keys — your account *is* the auth, an encrypted room *is*
  the database.
- **Explore the data.** A Leaflet map of flight start points (click a flight to
  lazily fetch + draw its full path) and sensitive sites, plus a sortable table
  and live dataset stats.
- **Run the scraper in the background.** A browser-native port of
  `dfr_scraper.py`: it polls Skydio's ArcGIS FeatureServer on an interval *on
  your machine*, diffs against flights already recorded, and writes each new
  flight into the room.
- **Hydrate from history.** Point it at a large (optionally gzip) GeoJSON /
  NDJSON dataset by URL or local file; it is streamed and decompressed
  in-browser (never fully buffered) and recorded into the room.

## How an update is recorded

Per the requirement, every update is recorded **as either a block to Matrix
media or as in-room events**:

| Part of a flight | Recorded as |
|---|---|
| Path geometry (bulky — thousands of vertices) | an **encrypted Matrix media block** (`uploadEncrypted`), referenced by `DEF geometry = {__media:2,…}` |
| Lean metadata (id, purpose, takeoff/landing, endpoints…) | **in-room events** — `INS flight {…}` |
| Each scraper poll | an in-room `INS snapshot {…}` (provenance) |

State is never stored: it is always `fold(timeline)`. The room timeline is the
audit trail; reloads rehydrate from it, and the scraper's diff resumes where it
left off.

## Architecture

This app **mirrors the bare-metal-eo-matrix-app foundation** — only its basic
Matrix **auth** and event-sourced **database** logic. Those modules are copied
verbatim into [`src/`](./src) and treated as a library (do not fork them; see
`BUILDING.md` in the foundation repo). All DFR-specific code lives in
[`app/`](./app):

| File | Role |
|---|---|
| `app/dfr.js` | The interop contract: namespace `org.dfr.explorer`, entity types (`flight`/`site`/`snapshot`/`dataset`), field paths, schema-as-log, the ArcGIS feed URL, feature↔record split. |
| `app/recorder.js` | The shared write path: geometry → media block, metadata → INS/DEF events. |
| `app/scraper.js` | The background poller (timer-driven, survives reloads via the room). |
| `app/hydrate.js` | Streaming dataset ingestion (gzip-aware), built on `jsonstream.js`. |
| `app/jsonstream.js` | Dependency-free streaming JSON/NDJSON reader (unit-tested). |
| `app/selectors.js` | Pure projections of fold state into views. |
| `app/mapview.js` | Leaflet rendering. |
| `app/main.js` | Bootstrap + UI wiring: auth → room → `fold(timeline)` → render → emit. |

The loop is exactly the foundation's: **`state = fold(timeline); UI =
render(state); action = emit(operator)`.**

## Build & deploy

```bash
npm install
npm run dev      # http://localhost:5173/explorer/
npm run build    # writes the prebuilt bundle to ../explorer  (committed)
```

`vite.config.js` sets `base: '/explorer/'` and `outDir: '../explorer'`. The
built `/explorer/` directory is committed so GitHub Pages **deploy-from-branch**
serves it with no build step and no Action — the main site at `/` is untouched.
After changing anything in `explorer-src/`, re-run `npm run build` and commit the
regenerated `../explorer`.

## The hydration file

The full historical dataset (a multi-GB compressed JSON) is loaded **at
runtime** — paste its URL into the *Hydrate* panel (or pick the local file).
The loader auto-detects gzip and GeoJSON-FeatureCollection / top-level-array /
NDJSON shapes. The in-app **row cap** is a safety valve; raise it to ingest
more. For a file too large to expand into per-row events, `hydrate.js` also
offers `archiveDatasetBlob()` to capture the whole file as a single encrypted
media block for provenance.

> No code change is needed when the link is provided — it is a runtime input.
> If the dataset's shape differs from the auto-detected ones, set the
> `rootKey` / `ndjson` / `classify` options in `hydrateStreaming`.

## Notes

- The live ArcGIS feed may require a **CORS proxy** for browser callers (the
  main DFR `index.html` routes feeds through an n8n proxy for this); a proxy
  prefix field is provided in the scraper panel.
- The "background" scraper runs while the tab is open. Because the dataset is
  the room, closing and reopening loses no recorded data.

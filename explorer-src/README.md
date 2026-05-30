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

The main site links here through a deliberately understated **`login`** link in
its header brand row (`index.html`), so the explorer is reachable without
advertising itself on the landing page.

## What it does

- **Sign in with Matrix.** Bring your own homeserver (default `matrix.org`).
  No backend, no API keys — your account *is* the auth, an encrypted room *is*
  the database.
- **Hydrate once.** On first open, a gate asks for the hydration file (hosted
  elsewhere for now). It accepts **JSONL / GeoJSON** (streamed + gunzipped
  in-browser, never fully buffered) **or a binary `.gz` snapshot**. The data is
  converted to a compact binary, cached in OPFS, and uploaded to Matrix media
  if it fits. The completion status is saved in **room state**, so no client
  asks again. The gate keeps asking until it succeeds.
- **Explore the data.** A Leaflet map of flight start points (click to draw the
  full path), a sortable table, and live stats — all reading the in-memory
  working set, so it's fast.
- **Self-update in the background.** A browser port of `dfr_scraper.py` polls
  Skydio's ArcGIS FeatureServer on your machine, diffs against the working set,
  and appends new flights — **without spamming Matrix** (see below).

## The data model — binary blob, not per-row events

The dataset is **one gzip-NDJSON binary blob** (flight metadata *and* path
geometry, inline). It lives in three places:

| Where | Role |
|---|---|
| **OPFS** (vault-encrypted, one file per room) | the fast local working set — written on every local change, read once on open |
| **Matrix media** | the durable, shareable copy — a **single block** when it fits the server's upload limit, otherwise **chained blocks + a manifest** (see below) |
| **a single room-state event** (`org.dfr.explorer.dataset`) | the pointer: hydration status, version, count, the media/manifest ref / external URL |

### Chained blocks (the media store can't hold GBs natively)

A homeserver caps a single upload (`m.upload.size`), so anything larger — and
the hydration file may be **multiple GB** — is "blockchained" into media:

- The blob is sliced into block-sized pieces; each piece is framed in a small
  binary envelope (`chunks.js`) carrying its index and the **FNV-1a/64 hash of
  the previous block's payload** — a verifiable chain.
- Each framed block is uploaded as its own encrypted media block.
- A **manifest** (itself a media block) lists every block's `mxc` ref + hash in
  order. The room-state pointer references the manifest.
- Reassembly downloads the blocks, **verifies the chain** (contiguous indices,
  each `prev` matching the previous block's hash), concatenates, and parses.

The **hydration file can be uploaded this way directly**: the gate streams a
local file (or URL) straight into chained blocks via `file.slice()` /
stream-reading, so a multi-GB upload never holds more than ~one block in memory
(`DataStore.hydrateRawChunked`). The manifest records the payload's format
(`gzip` / `ndjson` / `geojson` / …); a client small enough to hold the dataset
reassembles and parses it, while a multi-GB archive stays in media and is shown
as metadata only (it can't fit in a browser tab).

This is deliberate. A naïve "one INS event per flight" would flood the timeline
and force a fold over thousands of rows on every open. Instead:

- **Scraped updates** append to the OPFS blob **instantly** (no Matrix write).
- A Matrix **snapshot** (one media upload + one room-state pointer bump) is
  published only when it's worth it — `DataStore`'s threshold/interval throttle
  (default: 25 new flights, or 30 min) — so the room never fills with noise.
- **Peers sync intelligently**: a client downloads a new snapshot only when the
  pointer's `version` is ahead of its own, and `getMediaBytes` serves the OPFS
  mirror first, so an up-to-date client never hits the network.

## Architecture

This app **mirrors the bare-metal-eo-matrix-app foundation** — only its basic
Matrix **auth** and **database/storage** logic (client, vault, rooms, media,
OPFS, binary `pack`). Those modules are copied verbatim into [`src/`](./src) and
treated as a library (do not fork them). All DFR-specific code lives in
[`app/`](./app):

| File | Role |
|---|---|
| `app/dfr.js` | Domain: namespace `org.dfr.explorer`, the ArcGIS feed URL, feature→record normalization (`toRecord`). |
| `app/packset.js` | The dataset codec: flights ⇄ gzip-NDJSON, merge/dedupe, hashing. Unit-tested. |
| `app/chunks.js` | Binary block envelope + hash chain: `chunkBlob`, `frameBlock`, `reassemble`. Unit-tested. |
| `app/chunkstream.js` | Stream a File/Response into fixed-size payloads for multi-GB uploads. |
| `app/parseflights.js` | Parse reassembled raw bytes (gzip / NDJSON / GeoJSON) into records. Unit-tested. |
| `app/opfsbin.js` | Vault-encrypted OPFS persistence of the blob, one file per room. |
| `app/roomstate.js` | The single room-state pointer (status + version + blob ref). |
| `app/datastore.js` | Orchestrates working set ↔ OPFS ↔ media ↔ pointer; hydration, publish (throttled), intelligent sync. |
| `app/scraper.js` | Background updater → `DataStore.addFlights` + `maybePublish`. |
| `app/jsonstream.js` | Dependency-free streaming JSON/NDJSON reader (gzip-aware). Unit-tested. |
| `app/selectors.js` / `app/mapview.js` | Pure projections + Leaflet rendering of the working set. |
| `app/main.js` | Bootstrap + UI wiring: auth → open room → load OPFS → sync → render. |

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

The full historical dataset is loaded **at runtime** through the first-run gate:
paste its URL (it can be hosted anywhere) or pick a local file. Formats:

- **JSONL / NDJSON** — one JSON record (or GeoJSON feature) per line.
- **GeoJSON / JSON array** — auto-detected (top-level array or `features`).
- **Binary `.gz`** — gzipped NDJSON (e.g. a snapshot this app produced).

Large text inputs are streamed and gunzipped incrementally (never fully
buffered). The result is converted to the binary blob, cached in OPFS, and —
**if within the homeserver's media upload limit** — uploaded to Matrix media;
otherwise it stays in OPFS and the external URL is kept in the pointer as the
source of record. Either way, room state is marked hydrated so no client asks
again.

> No code change is needed when the link is provided — it is a runtime input.
> If a JSON dataset's shape is unusual, the `format` selector (`auto` / `jsonl`
> / `binary`) and `DataStore.hydrateFrom` options cover it.

## Notes

- The live ArcGIS feed may require a **CORS proxy** for browser callers (the
  main DFR `index.html` routes feeds through an n8n proxy for this); a proxy
  prefix field is provided in the scraper panel.
- The "background" scraper runs while the tab is open. Because the dataset is
  the room, closing and reopening loses no recorded data.

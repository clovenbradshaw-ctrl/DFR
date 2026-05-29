# Nashville DFR Bundle — Codebase Audit

**Auditor scope:** the *generating code* in this repository
(`clovenbradshaw-ctrl/dfr`). **Audit date:** 2026-05-29.
**Commit audited:** `8c820e9` ("Add files via upload"), branch
`claude/trusting-rubin-U2DY6`.

---

## Step 0 — Source location and versioning

**0.1 / 0.2 — What produced the bundle.** This repository contains the
generator, not the `data/` outputs. Two pieces:

| File | Role |
|---|---|
| `index.html` | A **browser-native tool** (vanilla JS + Leaflet). It fetches data *live* at page load and builds every `data/*` file *in the browser* on download. There is no Node/Python build step and no committed `data/` folder. |
| `dfr_scraper.py` | A Python poller that copies Skydio's ArcGIS FeatureServer response into the **separate** `clovenbradshaw-ctrl/plain-text` repo (`dfr/flight_paths.geojson`, `dfr/flight_log.jsonl`, `dfr/flights.csv`). It does **no** spatial work, demographics, or deduplication. |

Consequences for the audit:

- The `data/full_dataset.json`, `data/flight_paths.geojson`,
  `data/tract_analysis.csv`, etc. named in the instructions are **emitted at
  download time** by `index.html` (`buildBundle()`, `index.html:1578`). They
  are not version-controlled here, so a "commit that produced them" does not
  exist — each download reflects whatever the upstream feeds returned at that
  moment. **The `Generated` timestamp in every output is `new Date()` at
  download** (e.g. `index.html:1305,1364,1495`), so it can never be reconciled
  against a commit; it only marks when a reader pressed the button.
- The flight paths themselves come from
  `plain-text/dfr/flight_paths.geojson` (`index.html:587`), which is the
  scraper's overwrite of the raw ArcGIS response. **Provenance of the log
  therefore lives in `plain-text`, not here.** Output-level checks (the
  Python snippets in the instructions) must be run against a *downloaded*
  bundle or against `plain-text`; they cannot be run in this repo.

**0.3 — Spatial libraries.** None. All geometry is hand-rolled in
`index.html`: ray-cast point-in-polygon (`inPoly` `:1779`, `pip` `:678`),
haversine distance (`gdist` `:661`), geodesic point-offset (`offPt` `:1745`),
Sutherland–Hodgman clip (`:1767`). No Turf.js/Shapely/GeoPandas, so there is
no library-version sensitivity — but also no third-party-tested PIP. The
ray-cast routines are standard and look correct; `findDist` (`:679`) does not
honor polygon holes (it returns on the first ring hit), whereas
`insideDistrict` (`:687`) and `pointTractGeoid` (`:2292`) use even-odd and do.

**0.4 — Single run vs assembled.** A single page load assembles everything,
but from **heterogeneous live sources fetched in parallel** (`Promise.all`,
`index.html:2354-2360`): sites + flights + district demographics from
`plain-text`, council/precinct boundaries from Metro ArcGIS, and tract
demographics from the **Census API** (`loadACSProfiles` `:2149`), tract
geometry from **TIGERweb** (`loadTractGeom` `:2168`). The bundle header's
single timestamp therefore **masks** that demographics, geometry, and flights
were fetched from different services with different vintages (see F-09).

---

## Findings

### F-01 — Flights are never deduplicated on `flight_id`
- **LAYER:** Given-Log / Computed
- **FILE/FUNCTION:** `index.html:2397` (`allFlights = res[1].features.filter(... takeoff && landing)`); consumed by `computeTractTallies` `:2299`, `computeFlightsByDistrict`/`flightDistrictsOf` `:758-760`, `flightsPerDistrict` `:1290`, `flightsGeoJSON` `:1300`, `flightLayers` `:2398`.
- **DESCRIPTION:** Flights are loaded with a single filter (must have `takeoff` and `landing`). There is **no dedup on `flight_id`** anywhere in the codebase. Every downstream tally iterates `allFlights` directly.
- **EXPECTED:** The known duplicate (`flight_id 9a7b3519-…`, features 28 & 29, identical geometry) should be collapsed to one before any count.
- **DIFFERENCE:** The duplicate is counted **twice** in: per-tract drone deployments, per-district flight counts, the `council_districts` export (it appears as two features), the address-panel "N flights recorded here", and the district-report "County average" row, which prints `allFlights.length` directly (`index.html:1430`).
- **IMPACT ON PUBLISHED CLAIMS:** Inflates every tract and district the duplicated flight crosses by 1, and inflates the published flight total (38 vs 37 unique). The "109 drone deployments" sum is built on the non-deduplicated set.
- **RESOLUTION:** **Blocks publication** until fixed or quantified. Fix is a one-line dedup keyed on `props.flight_id` at `:2397`. Quantify impact by re-running the per-tract tally on the deduplicated set.

### F-02 — Per-tract "drone deployments" is any-path-point-in-tract (transit), summed into a multi-count
- **LAYER:** Computed / Assertion
- **FILE/FUNCTION:** `computeTractTallies` `index.html:2296-2306`; reported sum `totD` `:1502`, header stat `:1531`.
- **DESCRIPTION:** For each flight, the code samples every other vertex (`i+=2`, `:2301`), finds the tract each sampled point falls in (`pointTractGeoid`), and credits the tract once per flight (`seen[g]` dedup *within* a flight). This is exactly **"any point on the path crosses the tract"** — not a centroid, takeoff, or dispatched-to test.
- **EXPECTED:** A reader sees "drone deployments" and assumes a discrete deployment *to* that tract.
- **DIFFERENCE:** A single long transit flight credits every tract it overflies. The header/CSV total ("109") is the **sum of (flight, tract) intersection pairs**, not flights. 109 pairs ≠ 38 flights ≠ 37 unique flights.
- **IMPACT ON PUBLISHED CLAIMS:** Any "109 drone deployments" claim, and any per-tract count, conflates transit with service. The methodology string (`TRACT_METHOD` `:1475`, report sub `:1530`) does say "distinct DFR flights crossing the tract," which is honest *per tract*, but the **aggregate stat labeled "drone deployments" (`:1531`) is presented without noting it is a cross-tract multi-count.**
- **RESOLUTION:** **Documented in code per-tract; the aggregate needs a caveat.** Wherever the summed number appears, add "(flight-tract crossings across 38 flights / 37 unique)". Consider the dispatched-to measure in F-03.

### F-03 — No dispatched-to (external_id → call) attribution exists
- **LAYER:** Computed
- **FILE/FUNCTION:** absent. `external_id` is carried through `flightsGeoJSON` (`:1301` copies all props) but is **never joined** to `calls_for_service`.
- **DESCRIPTION:** The stricter "count a flight against a tract only if its dispatched call falls in that tract" measure is not implemented. Calls and flights are tallied into tracts independently (`:2303-2304`) and never linked by `external_id`/`Event_Number`.
- **EXPECTED (per audit 2.1):** A flight-to-call match rate and a transit-vs-dispatch split.
- **DIFFERENCE:** The bundle cannot distinguish "drone was dispatched here" from "drone flew over here." Tests E and F cannot be satisfied from this code without adding the join.
- **IMPACT:** Limits any claim that per-tract counts reflect *service* rather than *overflight*.
- **RESOLUTION:** **Documented / feature gap.** Recommend adding an `external_id`↔`Event_Number` join to report match rate.

### F-04 — Redacted operator/vehicle fields pass through silently
- **LAYER:** Given-Log / Assertion
- **FILE/FUNCTION:** `flightsGeoJSON` `:1300-1304` (copies every source property verbatim); `dfr_scraper.py:180-192` (`flight_to_log_entry` does not capture serials/email).
- **DESCRIPTION:** `vehicle_serial`, `dock_serial`, `user_email` are `null` upstream. The code neither asserts nor documents that individual traceability is impossible.
- **EXPECTED:** An explicit note that the record cannot establish which drone/dock/operator.
- **DIFFERENCE:** Nothing in the generator claims individual accountability, but nothing flags the limitation either.
- **IMPACT:** Any accountability framing in the essay implying individual traceability is unsupported.
- **RESOLUTION:** **Accept with caveat** — add a one-line note to the flights export metadata.

### F-05 — `flight_purpose` is collected but never surfaced or summarized
- **LAYER:** Given-Log / Assertion
- **FILE/FUNCTION:** captured in `dfr_scraper.py:146,182`; present in upstream GeoJSON; in `index.html` it is **copied into the flight export** (`:1301`) but **never displayed, summarized, or used** in any tract/district view.
- **DESCRIPTION:** The single most direct "what were the drones responding to" field is invisible in the explorer.
- **EXPECTED (F-PURPOSE):** A frequency table of `flight_purpose`, and a check for null/empty values.
- **DIFFERENCE:** Readers get demographics and geography but not call types.
- **IMPACT:** Any published description of *what* drones responded to is unsupported by anything the explorer shows.
- **RESOLUTION:** **Documented / feature gap.** Run `Counter(flight_purpose)` against the downloaded `flight_paths.geojson`; surface it.

### F-06 — `council_districts` on flights is any-path-point (transit included); District 7 can appear
- **LAYER:** Computed / Assertion
- **FILE/FUNCTION:** `flightDistricts` `index.html:1284-1288` (and the live-map twin `flightDistrictsOf` `:753`), via `findDist` `:679`.
- **DESCRIPTION:** A flight is tagged with **every** district any path vertex falls in — transit districts included. The export's `DISTRICT_DERIVATION` string (`:1244`) honestly says "point-in-polygon," but does not say "any point, including transit."
- **EXPECTED (F-D7 / Test D):** Determine whether any flight carries a district outside the named five (`3,9,10,11,15`, `TRIAL_DISTRICTS` `:598`).
- **DIFFERENCE:** Because attribution is any-point, a flight *will* carry District 7 (or others) if its path clips that polygon. The codebase **does** independently recognize this: calls/incidents inside District 7 are flagged `segment:'d7_carveout'` (`:2004-2005`) — "in the radius but excluded from the trial." So the discrepancy between the named five and actual coverage **is** computed for calls, but the **flight** `council_districts` field has no such flag.
- **IMPACT:** If any flight's `council_districts` includes `7` (or 2/4/etc.), that is a factual finding sourced to the boundary join and should be reported as "flew over," not "deployed in."
- **RESOLUTION:** **Documented; needs output run.** Run the Test-D snippet against a downloaded `flight_paths.geojson` and record any flight whose `council_districts` exits the five.

### F-07 — ACS variable→label mapping is correct (B03002 detailed tables)
- **LAYER:** Given-Log
- **FILE/FUNCTION:** `ACS_VARS` `index.html:2080-2089`, `tractVals` `:2090-2111`.
- **DESCRIPTION:** Race/ethnicity uses non-overlapping B03002 shares over `B03002_001E`: White `_003E`, Black `_004E`, Asian `_006E`, Two+ `_009E`, Hispanic `_012E`. Poverty = `B17001_002E/_001E`; child poverty = `B17020` (under-6/6-11/12-17 below ÷ all children); income `B19013/B19301`; rent burden 35%+ = `B25070_008E+_009E+_010E` ÷ (total − not-computed); rent `B25064`, value `B25077`; unemployment `B23025_005E/_003E`; under-18 `B09001_001E`; 65+ summed from `B01001` male/female 65+ bands.
- **EXPECTED:** Codes match labels; race columns sum to ~100.
- **DIFFERENCE:** None in the code. **Note:** race sum *intentionally* excludes AIAN (`_005E`), NHPI (`_007E`), and Other-alone NH (`_008E`), so a correct sum lands slightly **below** 100 (well within the audit's [85, 110] band). This is expected, not a defect.
- **IMPACT:** F-RACE clears at the code level.
- **RESOLUTION:** **Cleared in code.** Output-level confirmation (Test B) still recommended against a downloaded `tract_analysis.csv`.

### F-08 — ACS vintage is pinned to 2017–2021, but the label is honest and dynamic
- **LAYER:** Given-Log / Assertion
- **FILE/FUNCTION:** `loadACSProfiles` `:2149-2162` (`years=[2021,2022,2020]`), `CENSUS_YEAR` `:2045`, `acsYearLabel` `:2076`.
- **DESCRIPTION:** The Census pull **tries 2021 first** (ACS 2017–2021) and only falls back to 2022/2020 if 2021 fails. `acsYearLabel()` then renders the label *from whichever year actually answered*, so the displayed vintage always matches the data fetched (`SRC_TRACTS` `:1474`, export metadata `:1495`).
- **EXPECTED:** Every demographic figure carries its year range; the current vintage (2020–2024) was not used.
- **DIFFERENCE:** Choosing 2021 in 2026 imposes a ~5-year lag. This is an accepted choice, not a bug, and it is labeled — but it is **hardcoded to prefer 2021**, not "latest available."
- **IMPACT:** F-VINTAGE clears for *tract* demographics (label is attached everywhere). See F-09 for the district file.
- **RESOLUTION:** **Accept with caveat.** Optionally reorder `years` to prefer the newest vintage.

### F-09 — District demographics use a *different, static, older* source than tract demographics
- **LAYER:** Given-Log
- **FILE/FUNCTION:** `DEMO_URL` `:588` → `plain-text/nashville_council_district_demographics.json`; cited at `:541` as "ACS 2017–2021 5-Year Estimates, compiled by Metropolitan Social Services, Know Your Community 2023."
- **DESCRIPTION:** Council-district demographics come from a **prebuilt static file** (Metro Social Services KYC 2023), while **tract** demographics come from the **live Census API** (F-08). Two different pipelines and potentially two different ACS vintages feed the same page under one "Generated" timestamp.
- **EXPECTED:** A reader assumes one consistent demographic basis.
- **DIFFERENCE:** District vs tract figures are not guaranteed comparable; the district file's vintage is whatever KYC 2023 used.
- **IMPACT:** Any cross-comparison of district-level and tract-level demographic figures needs the two-source caveat.
- **RESOLUTION:** **Documented.** Surface both vintages explicitly.

### F-10 — 2-mile buffer is geodesic (accurate); center is the flight-endpoint cluster, not the precinct building
- **LAYER:** Computed / Assertion
- **FILE/FUNCTION:** `radiusCenter = launchPoint() || [PRECINCT.lat,PRECINCT.lng]` `:2036`; `launchPoint` `:1752`; `gdist` (haversine, meters) `:661`; `offPt` (geodesic offset) `:1745`; `circleRing` `:1762`; in-radius tests `:1997` (calls/incidents) and `tractTouchesRadius` `:2201`.
- **DESCRIPTION:** The radius is computed in **meters via haversine/geodesic offset**, not a degrees buffer — so F-PROJ's degree-error concern does **not** apply. The same `radiusCenter` filters calls, incidents, and tracts, so the spatial basis is **internally consistent**. **However,** the center is the **densest cluster of flight takeoff/landing endpoints** (`launchPoint`), with the Madison Precinct rooftop (`PRECINCT` `:1928`) only as a fallback.
- **EXPECTED (audit 2.5):** README says "two-mile radius of the precinct building (400 Myatt Drive)."
- **DIFFERENCE:** Published framing ("precinct building") ≠ implemented center (flight-endpoint centroid). They are close but not identical; the circle, and therefore which tracts/calls are "in radius," shifts with the flight cluster.
- **IMPACT:** Minor geographic discrepancy; affects edge tracts/calls near the 2-mile boundary.
- **RESOLUTION:** **Accept with caveat / documented.** State that the center is the empirical launch cluster, not the building address. Projection concern is **cleared**.

### F-11 — drones_per_100_x: division-by-zero handled, but denominators are near-zero
- **LAYER:** Computed / Assertion
- **FILE/FUNCTION:** `:1481-1482` (`ca ? +(dr/ca*100).toFixed(1) : null`), display `:970,2218`, full_dataset `:1393`.
- **DESCRIPTION:** When a denominator is 0, the ratio is set to **`null`** (genuine "undefined"), not coerced to 0 or a large number. Tables render `—` for null (`:1508`). No silent error coercion.
- **EXPECTED:** null = undefined; no fabricated rates.
- **DIFFERENCE:** None in handling. The risk is **interpretive**: over a ~3-day window most tracts have calls counts of 0/1/2, so the ratio is statistically unstable. Nothing in the output labels these as small-sample.
- **IMPACT:** Ratios are not publishable as stable tract-level rates without a small-window caveat.
- **RESOLUTION:** **Accept with caveat.** Add a "n is tiny per tract; 3-day window" note wherever the ratio is shown or sorted on (it is the **default sort**, `:1530`).

### F-12 — "Sensitive sites": editorial label; source named but criteria/date not in this repo
- **LAYER:** Given-Log / Assertion
- **FILE/FUNCTION:** `SITES_URL` `:586` → `plain-text/dfr/sensitive_sites.json`; `SRC_SITES` `:1241` ("compiled from Metro Nashville GIS & OpenStreetMap"); cited `:542`; consumed `:2368-2394`.
- **DESCRIPTION:** The generator **labels** these sites "sensitive" (`:531,542`) — an editorial/normative category introduced by this project. The underlying source is named (Metro GIS + OSM amenity data, types school/childcare/playground/worship), but the **inclusion criteria, query/tag filters, and fetch date are not in this repo** — they live in the prebuilt `sensitive_sites.json` in `plain-text`. The code does no normalization (it plots `s.name` verbatim, so upstream typos like "Shwab School" pass straight through, `:2383,2390`).
- **EXPECTED (F-SITES / Test G):** Source URL, fetch date, and filters documented; completeness sufficient for count claims.
- **DIFFERENCE:** Source *type* is documented; **completeness, criteria, and date are not verifiable from this repo.** An incomplete OSM extract would undercount silently. "Sensitive" is this codebase's framing, not a government category.
- **IMPACT:** Any "X sensitive sites under the flight corridor" claim needs the source/completeness caveat and ownership of the "sensitive" label.
- **RESOLUTION:** **Blocks count-based claims** until `sensitive_sites.json`'s build provenance (in `plain-text`) is documented; otherwise treat as unverified.

### F-13 — Temporal filter floors at 12:00 AM Central (correct), but calls and incidents use different date fields
- **LAYER:** Given-Log / Computed
- **FILE/FUNCTION:** `PILOT_START_TS` `:1930` (`Date.parse('2026-05-26T00:00:00-05:00')`), `PILOT_START_SQL` `:1931` (`'2026-05-26 05:00:00'` = same instant in UTC), applied server-side `:1972` and re-checked client-side `:1999`; date-field selection `datePats` `:1940` (calls) and `:1944` (incidents).
- **DESCRIPTION:** The hard floor is **midnight CDT (UTC-5) May 26**, applied both as the ArcGIS `WHERE … >= TIMESTAMP '2026-05-26 05:00:00'` and as a client-side `ts < PILOT_START_TS` drop. So Test C (no May-25-Central calls admitted) **passes by construction**. **But** calls are filtered on a *"call received"* field while incidents are filtered on *"incident occurred"* (`:1940` vs `:1944`) — different temporal semantics under the same floor.
- **EXPECTED:** A single consistent cutoff; awareness of which timestamp it applies to.
- **DIFFERENCE:** The CT floor is correct and double-enforced. The cross-layer field mismatch (received vs occurred) is a documentation point, not an error.
- **IMPACT:** Rate denominators are anchored to midnight CT (good). Note the received-vs-occurred distinction when comparing calls and incidents.
- **RESOLUTION:** **Cleared with note.**

### F-14 — Call/incident tract attribution is derived from coordinates (correct), not passed through
- **LAYER:** Given-Log / Computed
- **FILE/FUNCTION:** `computeTractTallies` `:2303-2304` (`pointTractGeoid(c.lat,c.lng)`), `findDist` `:2003` for district.
- **DESCRIPTION:** Each call/incident's tract and district are computed **in-browser from its own coordinate**, not read from any source field. So no stale pre-2020-redistricting attribution leaks in.
- **IMPACT:** Audit 1.2 "verify attribution follows from coordinate" — **clears**.
- **RESOLUTION:** **Cleared.**

---

## Pre-Publication Clearance Checklist

| ID | Item | Status |
|---|---|---|
| **F-DUPL** | Duplicate `flight_id` deduplicated, per-tract counts recomputed | ☐ **BLOCKS** — code has no dedup (`:2397`); see F-01. Fix + recompute required. |
| **F-109** | "109 drone deployments" carries a "(flight-tract crossings across 38/37 flights)" caveat | ☐ **BLOCKS** — aggregate stat (`:1531`) unqualified; see F-02. |
| **F-TRANSIT** | PIP confirmed as any-path-point; transit-vs-dispatch noted | ☑ confirmed any-point (`:2296`); ☐ caveat + dispatch measure pending (F-02/F-03). |
| **F-RACE** | Race columns sum ~100 via corrected B03002 | ☑ **cleared in code** (F-07); output spot-check (Test B) recommended. |
| **F-VINTAGE** | Every demographic figure labeled with its ACS year range | ☑ tracts labeled dynamically (F-08); ☐ district-file vintage co-stated (F-09). |
| **F-SITES** | Sensitive-sites source/criteria/date documented & complete | ☐ **BLOCKS count claims** — provenance lives in `plain-text`, not verifiable here (F-12). |
| **F-D7** | `council_districts` checked for District 7 on any flight | ☐ run Test D on a downloaded `flight_paths.geojson` (F-06); attribution is any-point so D7 is possible. |
| **F-PROJ** | 2-mile buffer in a projected/geodesic CRS or error documented | ☑ **cleared** — geodesic meters (F-10); note center = launch cluster, not building. |
| **F-PURPOSE** | `flight_purpose` summarized in any published description | ☐ field collected but never surfaced (F-05). |

**Blocking before publication:** F-01 (F-DUPL), F-02 (F-109 caveat),
F-12 (F-SITES count claims). **Run against a downloaded bundle / `plain-text`:**
Tests A–H, especially D (District 7) and the `flight_purpose` frequency table —
these need the actual output, which this repo does not contain.

---

## Notes on what could NOT be audited here

This repository holds the generator, not the generated `data/`. The
instruction snippets (duplicate check, race-sum, transit count, District-7
scan, match rate) operate on output files that `index.html` builds in the
browser at download time. To complete Tests A–H, download a bundle from the
running tool (or read `clovenbradshaw-ctrl/plain-text/dfr/`) and run them
there. Every code-level finding above is grounded in `index.html` /
`dfr_scraper.py` line numbers and stands independent of a specific run.

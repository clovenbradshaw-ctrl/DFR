# DFR flights: provenance and linkage theory

Everything in this document is about MNPD's Drone-as-First-Responder (DFR)
program only. It answers three questions: how many flights exist and where do
they come from, exactly how to re-fetch them yourself, and what theory of
evidence justifies saying a given flight was launched for a given 911 call.

**Collection is already documented at
[github.com/clovenbradshaw-ctrl/DFR](https://github.com/clovenbradshaw-ctrl/DFR)**
— that repo's own README is the primary source for how the flight feed is
gathered and mirrored (`dfr_scraper.py`/`dfr.py` polling Skydio's ArcGIS feed,
pushed to `clovenbradshaw-ctrl/plain-text`, read by `index.html` and the
Matrix-backed `explorer/` app). §1 below restates only the parts needed to
re-derive the exact 409-flight count and re-fetch the source directly; §§2–4
are new — the Calls-for-Service linkage, the null-testing theory, and the
verification/bug-fix trail — none of which exist in that repo yet.

## 1. How many flights, and where they come from

**409 raw rows, 395 distinct flights.** The upstream Skydio feed double-logs
some rows — the DFR repo's own README already says so ("Flights are
deduplicated by `flight_id` because the upstream feed double-logs some rows").
14 rows across 13 `flight_id`s are exact duplicates (verified 2026-08-15 against
a fresh pull); every count in this document is post-dedup. 2026-05-26 (trial
launch) → 2026-08-08 (date of the pull this document is built from). The feed
is live and grows continuously — a re-pull today will return more.

### Chain of custody

```
Skydio ArcGIS FeatureServer  (source of record — MNPD's drone vendor)
        │  live, public, no auth required
        ▼
clovenbradshaw-ctrl/DFR   (github.com/clovenbradshaw-ctrl/DFR)
        │  dfr_scraper.py / dfr.py mirror the feed, no transformation
        ▼
this repo: analysis/linkage/dfr-flights.geojson   (pulled 2026-08-14)
```

MNPD did not build or publish this feed as a dataset — it is the vendor's own
operational ArcGIS layer, exposed because MNPD's public DFR dashboard embeds it.
Nothing about the URL below is secret or access-controlled; it was found by
inspecting what the public dashboard loads.

**Checked directly (2026-08-15): DFR flights are not on `data.nashville.gov`.**
MNPD's own open-data ArcGIS organization (`services2.arcgis.com/HdTo6HJqh92wn4D8`
— the org behind both Incidents and Calls for Service, confirmed against the
portal's own catalog: Calls for Service item `f8b1bdf0-6126-47cf-b9c9-ccce31ac411a`
= 316,456 rows, Incidents item `d747436-2-43e9-439e-968f-ce056545016a` =
920,367 rows, both matching this project's own counts exactly) hosts 371
services total, none named drone/DFR/Skydio/UAS/flight. Searching the wider
Nashville Hub catalog for "drone" and "DFR" turns up nothing from MNPD's org —
the only "Drone as First Responder Program" hit is an unrelated national map
published by AIRT/DroneResponders. The flight data lives only where the public
DFR dashboard sources it: Skydio's own vendor ArcGIS org, documented below. If
MNPD later publishes flights on the open-data portal directly, prefer that
source over this one — it would carry the same provenance guarantee the other
two datasets do.

### Exact source

```
Feature service:  https://services7.arcgis.com/mnhQTdIYDA7UoY2l/arcgis/rest/services/
                   678dee26-6aa8-4d60-bf1c-30c7b0f6b517-production/FeatureServer/0
Layer name:        Operation
Geometry:          Polyline (flight path)
Organization ID:   678dee26-6aa8-4d60-bf1c-30c7b0f6b517  (single MNPD org; every
                    one of the 409 rows carries this same organization_id)
```

**To re-fetch every flight yourself, right now:**

```bash
curl -s 'https://services7.arcgis.com/mnhQTdIYDA7UoY2l/arcgis/rest/services/678dee26-6aa8-4d60-bf1c-30c7b0f6b517-production/FeatureServer/0/query?where=1%3D1&outFields=*&returnGeometry=true&outSR=4326&f=geojson' -o dfr-flights.geojson
```

**To check the current total without downloading anything:**

```bash
curl -s 'https://services7.arcgis.com/mnhQTdIYDA7UoY2l/arcgis/rest/services/678dee26-6aa8-4d60-bf1c-30c7b0f6b517-production/FeatureServer/0/query?where=1%3D1&returnCountOnly=true&f=json'
```

The mirrored copy this analysis runs against is at
[`analysis/linkage/dfr-flights.geojson`](./linkage/dfr-flights.geojson) (18.9 MB,
pulled 2026-08-14). It is not overwritten automatically — re-run the `curl`
above and replace it to refresh.

### What's on each flight record

| Field | Coverage | What it is |
|---|---|---|
| `flight_id` | 100% | Unique ID for this flight |
| `takeoff` / `landing` | 100% | Millisecond epoch timestamps |
| `external_id` | 100% (408/409 parse) | The CAD call number this flight was dispatched to — see §3 |
| `flight_purpose` | 100% | The call-type category (`DISORDERLY PERSON`, `BURGLARY - NON-RESIDENCE`, etc.) |
| geometry | 100% | The full flight path — 370 flights as `MultiLineString`, 39 as `LineString` (see the bug note in §4) |
| `description` | 3% | Free-text note, mostly blank |
| `user_email`, `vehicle_serial`, `dock_serial`, `operation_id` | **0%** | Withheld at source — pilot identity and specific hardware are never exposed |

### Flight-purpose distribution (all 409)

```
100  DISORDERLY PERSON                 15  BURGLARY - RESIDENCE
 45  DOMESTIC DISTURBANCE               11  HOLDUP / ROBBERY
 35  VEHICLE ACCIDENT - PROPERTY DAMAGE  8  SAFETY HAZARD
 33  BURGLARY - NON-RESIDENCE            8  SHOTS FIRED
 27  PERSON WITH WEAPON                  7  FIRE
 26  VEHICLE ACCIDENT-PERSONAL INJURY    6  SUICIDAL PERSON
 25  SUSPICIOUS PERSON                   5  PERSON INDECENTLY EXPOSED
 25  FIGHT / ASSAULT                     2  KIDNAPPING, ITEM/VEHICLE STOLEN,
 19  THEFT                                  MISSING PERSON, WANT OFFICER FOR
                                            INVESTIGATION, INTOXICATED PERSON,
                                            CUTTING/STABBING (2 each)
                                          1  VEHICLE BLOCKING ROW, Explosion
```

`flight_purpose` is self-reported at dispatch, before anyone knows what the
drone will actually find. It is descriptive context, not verified evidence —
treated that way throughout.

---

## 2. What "linked" means, and against what

A flight is *linked* when its dispatch call number (`external_id`) matches a
record in a second, independent Nashville Open Data dataset: **Calls for
Service**.

```
Layer:  https://services2.arcgis.com/HdTo6HJqh92wn4D8/arcgis/rest/services/
        Metro_Nashville_Police_Department_Calls_for_Service_view/FeatureServer/0
Rows:   316,456 (current rolling window; 2025-12-31 -> 2026-08-13, covers the
        entire DFR trial period)
Fields used: Event_Number, Complaint_Number, Tencode_Description,
             Disposition_Description, Call_Received, Latitude, Longitude
```

Calls for Service is MNPD's own CAD (computer-aided dispatch) export, published
independently of the DFR program and of Skydio. It is not the same dataset as
MNPD Incidents (the report-writing system) — see §4 for why keeping the two
separate is what makes the causal test possible.

A downstream chain exists past Calls for Service, for the minority of calls that
generate a written report:

```
Calls for Service          Complaint_Number         Incidents dataset
Event_Number = external_id ───────────────────────► Incident_Number
(the CAD dispatch record)   (report was written)     (the finished report)
```

---

## 3. The theory of linking — why a match means something

The naive approach — "the drone's `external_id` says `PD202600390493`, a call
with that number exists, therefore linked" — is not enough on its own, and this
project does not use it alone. `external_id` is drawn from a **dense** number
sequence: roughly half of all *arbitrary* numbers in the plausible range also
happen to belong to a real call, just because MNPD dispatches so many calls.
A bare string match at that density is barely better than a coin flip.

The fix is the same discipline used everywhere else in this project: **never
score, always null-test.** A link only counts as established evidence if the
observed configuration is unlikely to have happened by chance — measured
against an actual random baseline, not assumed.

Three independent tests, each against its own measured null:

### N1 — Resolution: does the call number exist at all?

*Question:* of the CAD numbers a flight cites, how many correspond to a real,
published call?

*Null:* draw random numbers from the same numeric range and see how often
*they* resolve. This is the actual base rate of "an arbitrary number in this
range happens to be a real call" — not an assumption, a measurement.

*Result:* 63.8% of cited numbers resolve, against a measured null of 52.6%
(p = 1.67e-05). It clears — barely, and that's expected: this feature alone was
never meant to carry the argument. It just says the flight cited *something*
real more often than chance would predict.

### N2 — Temporal proximity: was the drone airborne when the call happened?

*Question:* how close is the flight's takeoff time to the matched call's
received time?

*Null:* pair each flight against a *random* call instead of its matched one,
and measure that gap.

*Result:* observed median gap **1.8 minutes**. Null median gap: **36,095
minutes** (25 days) — because most calls in the reference pool happened nowhere
near a given flight's actual takeoff. 87.8% of real matches land within 15
minutes; essentially none of the random pairings do (0.00%). This is the test
that says the drone actually went up *because of* this specific call, not
merely near some call in general.

### N3 — Spatial proximity: did the drone actually go there?

*Question:* how close does the flight path's nearest point pass to the matched
call's location?

*Null:* same flight, paired against a random call's coordinates instead.

*Result:* observed median distance **89 metres**. Null median: **14.75 km**
(p = 2.99e-183 — the strongest signal of the three, because Nashville is large
enough that a random pairing is almost never close). 79.8% of real matches land
within 250 metres; 0.15% of random pairings do.

### Why three, and why independence is the point

None of these three tests share a failure mode. A coincidental number match
(N1) doesn't imply the timing lines up (N2). A drone that happened to fly near
some unrelated call at some unrelated time (a chance N2 or N3 alone) doesn't
imply the CAD number matches. For a flight to pass all three by accident, three
unrelated coincidences would have to stack — which is exactly what "independent
under the null" is built to catch, and exactly why it doesn't happen: joint
tight agreement (≤15 min **and** ≤250 m) occurs in **64 of 89** testable links
(72%), where the two nulls multiplied together predict roughly 0.0000%.

That joint agreement — not any single feature — is what this project calls a
**collapse**: a link where independent evidence lets you rule out "this could
be anything" and settle on "this specific flight, this specific call." A flight
that only clears N1, or only N2, stays typed as unresolved-but-plausible, never
silently promoted.

---

## 4. Full numbers, and three corrections made in the course of checking them

```
395  distinct DFR flights (post-dedup)
391  carry a parseable PD event number  (3 cite an FD/fire number instead,
                                          1 has a garbled non-numeric external_id)
257  match a published call-for-service record             (65.7% of the 391)
224  ...agree in time (<=15 min)
 85  ...call is geocoded, so space is even testable
 60  ...agree on BOTH time and space -- collapse-grade evidence, verdict=collapsed
 62  ...produced a written incident report
134  cite a PD number that does not exist in the call log at all -- verdict=void
197  matched a call but did not clear both nulls -- verdict=plural
```

Of the 46 distinct report numbers attached to linked calls, **44 (95.7%)** are
published as full MNPD incident reports; the 2 that are not are both real,
recently-dated complaints (received 2026-06-03 and 2026-06-10) most likely still
moving through report processing, not evidence of anything withheld. Verified
against the complete linked set, not a sample — see
[`dfr-report-resolution-check.json`](./linkage/dfr-report-resolution-check.json).

Of the 134 event numbers that don't resolve to any call record at all, a random
sample of 10 was individually re-queried (not batch-queried, to rule out a
batching artifact) and all 10 came back genuinely absent. Resolution rate is
stable across the trial's four months (60–69%), so this isn't a lag artifact
either — it's a real ~34% of dispatch numbers that Calls for Service simply
doesn't carry.

**Three bugs were found and fixed while producing these numbers, all worth
naming because they're the failure mode this whole methodology exists to
avoid: a parse gap that reads downstream as an honest negative result.**

1. **Geometry type.** 370 of 409 raw flight paths are GeoJSON `MultiLineString`;
   only 39 are plain `LineString`. Code that accepted only `LineString` silently
   treated 90% of flights as having no path at all — which reads exactly like a
   legitimate "no match," not like a bug, unless you go looking for why the
   denominator is suspiciously small.
2. **Silent API error swallowing.** A failed ArcGIS query returns HTTP 200 with
   an `{"error": ...}` body and no `features` key. Code that did
   `d.get("features", [])` turned failed chunks into clean empty results,
   again indistinguishable from an honest zero.
3. **Duplicate rows.** 14 of the raw 409 rows share a `flight_id` with another
   row (verified 2026-08-15) — see §1. Every flight-level count in this document
   is now computed post-dedup; earlier drafts of this document (and this
   project's chat record) reported 409/62.8%/89/64 before this fix, all
   slightly inflated.

All three are fixed in
[`scripts/linkage/link_dfr_flights.py`](../scripts/linkage/link_dfr_flights.py).
The corrected run is what every number in this document reflects.

---

## 4a. Two further findings from checking whether the matches "make sense"

Both found by directly interrogating the linked data — not by running
`induceKinds()` or any heavier induction machinery. Given how clean and
complete-coverage both are (a flat zero across an entire calendar bucket; a
recurring exact coordinate across hundreds of flights), neither needed a
permutation-null clustering pass to trust, and eoreader6 was not invoked.

### Finding 1 — the DFR program has no weekend or overnight coverage

Checked against the full calendar of the trial (2026-05-26 → 2026-08-07, 30
distinct flight-days), not just raw flight counts, in local Nashville time
(`America/Chicago`, DST-aware — a naive UTC read misclassifies late-evening
flights into the wrong weekday):

```
Mon:  1 of 10 calendar Mondays had any flight at all
Tue:  7 of 11
Wed:  8 of 11
Thu:  7 of 11
Fri:  7 of 11
Sat:  0 of 10  -- zero, the entire trial
Sun:  0 of 10  -- zero, the entire trial
```

Hour-of-day (local) shows a matching gap: flights cluster roughly 6am–11pm,
with **zero flights between 11pm and 6am** across the whole trial. A program
named "first responder" is, so far, a weekday daytime/evening program — 911
calls do not stop on Saturdays, so this reflects staffing/scheduling, not
demand. Worth stating plainly to anyone reading the collapsed-link rate as "how
often does DFR respond": it can only respond during the hours it flies at all.

### Finding 2 — flight-path geometry cannot be trusted at face value; corrected here

Chasing a hunch that flight paths might "behave in surprising ways" turned up a
real data-structure artifact, not drone behavior. GeoJSON `MultiLineString`
parts are not guaranteed to arrive in flight-chronological order — that's an
Esri serialization property, not a promise this feed makes. Naively
concatenating parts in array order to compute path length manufactures phantom
jumps: **356 of 357 multi-part flights** show a gap of more than 50 m between
consecutive parts, with a strong cluster of exact repeat gap sizes and one
dominant coordinate — `36.273, -86.691` — appearing as the jump point 192+101
times across unrelated flights, matching that specific flight's own takeoff
point in 219 of 337 cases. That coordinate is almost certainly the physical
dock. The naive path was routing back through the dock mid-flight and
re-launching, on paper, for the majority of flights in the dataset.

Corrected by summing only *within-part* segments (median within-part step is
11.7 m — genuinely continuous telemetry) and discarding between-part jumps
entirely:

```
                    naive (buggy)     corrected
median path length     8.52 km          5.31 km
```

The corrected figure is the trustworthy one; roughly 3.2 km of the naive
median was phantom dock-transit distance. This does **not** affect §3's N3
spatial-linkage test — that test measures nearest-point-in-the-cloud against a
call's coordinates, which is order-independent by construction — but it would
have corrupted any duration/speed/path-shape analysis run on top of the naive
concatenation. After correction, no flight sits outside a standard outlier
fence (Q3+3×IQR) on either duration or real path length, and within-purpose
z-score outliers are modest (|z| < 2.7, expected under routine variation across
this many purpose categories) — no confirmed anomalous individual flight
survives the correction.

Also checked and ruled out as an anomaly source: how many flights ever cite the
*same* CAD number. Distribution is unremarkable — 300 numbers cited by exactly
one flight, 40 by two, 6 by three, and one ceiling case (`PD202600415672`) cited
by four flights across under 3 hours, already covered in §4's duplicate-number
discussion above. Nothing approaches a pattern worth calling anomalous.

---

## 5. Reproducing this from scratch

```bash
# 1. pull the live flight feed
curl -s 'https://services7.arcgis.com/mnhQTdIYDA7UoY2l/arcgis/rest/services/678dee26-6aa8-4d60-bf1c-30c7b0f6b517-production/FeatureServer/0/query?where=1%3D1&outFields=*&returnGeometry=true&outSR=4326&f=geojson' \
  -o analysis/linkage/dfr-flights.geojson

# 2. run the linker (resolves against Calls for Service, runs N1/N2/N3, writes
#    analysis/linkage/dfr-flight-links.json)
python3 scripts/linkage/link_dfr_flights.py
```

No credentials, no rate-limit key, nothing private. Every URL in this document
is fetchable by anyone with a browser.

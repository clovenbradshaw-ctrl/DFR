# DFR flight-behavior profile — normal response vs. anomalous, portable across cities

Built 2026-08-15 from the Nashville MNPD DFR trial (395 flights, 2026-05-26 →
2026-08-08), by working outward from one confirmed observation ("it kept going
back to an apartment complex") to a general, reproducible method. Every
threshold below is *measured from this dataset*, not assumed — re-measure them
locally before applying this profile to another city's DFR program; the
**method** travels, the **numbers** don't automatically.

This is a classification scheme, not a scoring system, on purpose — consistent
with the null-testing discipline used throughout this project. A flight is
placed into exactly one typed bucket per dimension below; nothing is
blended into a single "anomaly score." A bucket assignment is a starting point
for a human to look at, never a finished conclusion by itself.

## 0. Prerequisites — get these wrong and every downstream number is wrong

These are not optional cleanup steps; three separate silent-failure bugs were
found and fixed doing this analysis, and each one would have quietly produced
a false "no anomaly" reading if left in place.

1. **Deduplicate by `flight_id`.** Upstream feeds (at least Skydio's) double-log
   some rows. Check `len(raw_rows) != len(set(flight_ids))` before anything else.
2. **Never trust cross-part path order.** GeoJSON `MultiLineString` parts are
   not guaranteed to arrive in flight-chronological order (an Esri
   serialization property, not a promise of this feed specifically). Concatenating
   parts in array order manufactures phantom jumps — in this dataset, through
   the dock coordinate, in 356 of 357 multi-part flights. Only sum distances
   and compute bearings **within** a part; treat the sequence of parts as an
   unordered bag of position samples for anything spatial (density, clustering,
   nearest-point tests), and never for anything directional (path order, turn
   sequence, "did it go A→B→C").
3. **CAD event numbers and incident/report numbers are different, differently-
   dense sequences.** Confusing them silently resolves at *below the random
   null* (an event number can share the same digit format as an incident
   number but mean something completely different). Measure the resolution
   rate of a random in-range number for each sequence you match against
   *before* trusting any single hit — this dataset's event-number sequence
   resolves at 52.6% by chance; its incident-number sequence resolves at 15.4%
   by chance. A different city's sequences will have different densities.
4. **Location-recurrence needs a capped cluster radius, not transitive
   cell-chaining.** Merging any two adjacent grid cells that are each
   adjacent to a third re-creates a transit-corridor artifact at a coarser
   scale — in an early pass here it produced "111 flights, 34 dates" at one
   "location" that was actually the road out of the dock's own limited
   coverage circle. Cap a cluster at a fixed radius around a single seed cell
   (≈450m, one property's footprint, in this dataset); never let it grow by
   chaining.

## 1. NORMAL CALL RESPONSE — the baseline signature

A flight showing all of these is doing exactly what a DFR program is supposed
to do. Each feature is independently measured against its own null — a single
feature clearing its null is weak evidence; several clearing together is what
license a `collapsed` (confirmed) response classification.

| Feature | Null | This dataset's result |
|---|---|---|
| **Resolution** — cited CAD number exists in Calls for Service | resolution rate of a random in-range number | observed 63.8% vs null 52.6%, p=1.67e-05 |
| **Temporal proximity** — takeoff within X min of call-received | gap to a *random* call instead of the matched one | observed median 1.8 min vs null median 36,729 min; 87.3% within 15 min vs 0.08% null |
| **Spatial proximity** — flight path passes within Y m of the call's location | distance to a random call's coordinates | observed median 92m vs null median 14.65km; 78.8% within 250m vs 0.00% null |
| **Duration bounded by battery, tight distribution** | n/a — physical constraint, not a null-tested feature | median 14.9 min, max 25.8 min, essentially no outliers (battery-limited by construction) |
| **Settles predominantly at ONE location per flight** | n/a — descriptive | median loiter-density (fraction of a flight's points in its single busiest ~45m cell) = 0.32 |
| **Turning concentrated near that one point** (orbit-to-observe, not search) | n/a — descriptive, see §2 for the anomalous contrast | median 3,388 deg/km cumulative turning — high everywhere, because orbiting a fixed subject is the *expected* pattern, not the anomaly |

**Typed verdict for the linkage half of this** (reuses the collapsed/plural/void
scheme from this project's Flock-linkage work — see
[`linkage-findings.md`](./linkage-findings.md)):

- `collapsed` — resolves, AND clears both time (≤15 min) and space (≤250m) nulls.
- `plural` — resolves but doesn't clear one or both nulls, OR resolves to more
  than one plausible call.
- `void` — the cited number does not exist in Calls for Service at all.

In this dataset: 60 collapsed / 197 plural / 134 void / 4 flights with no
usable citation at all (391 total citing flights of 395).

## 2. ANOMALOUS / NOTABLE — five independently-typed categories

None of these should be blended into "the flight is anomalous" as a single
judgment. A flight can land in more than one category; each is reported
separately, because they mean different things and need different follow-up.

### 2a. SEARCH-PATTERN (wide-area sweep, not point-orbit)

*Feature:* real path length (within-part only, §0.2) exceeds 1.0 km **and**
cumulative turning-per-km exceeds a 3×IQR fence over the whole population.

*Why both conditions:* turning-per-km alone is dominated by a math artifact —
a flight with only 70m of real travel gets a huge angle/km ratio from a tiny
denominator, not from doing anything unusual. Requiring real distance first
removes that.

*This dataset:* 7 of 395 flights (1.8%) — SHOTS FIRED, PERSON WITH WEAPON ×2,
DOMESTIC DISTURBANCE, DISORDERLY PERSON ×2, VEHICLE BLOCKING RIGHT OF WAY.
Consistent with active-search behavior over an area rather than travel-to-a-
point-and-hover. Full list:
[`dfr-profile-fulldataset-results.json`](./linkage/dfr-profile-fulldataset-results.json).

### 2b. REPEAT-LOCATION — what raw recurrence can and cannot establish

*Feature:* a flight's densest settling point (≥8 points AND ≥15% of the
flight's non-dock points in one ~150m cell) falls within a capped, non-chained
cluster (§0.4) visited by **N distinct flights on N distinct dates**, each
citing a **distinct, independently-resolved CAD number** (not the same call
re-cited by a relaunch — see §2c for that separate, expected pattern).

*Ground-truth check is mandatory before reporting anything.* Raw recurrence
alone is not sufficient — a busy retail corridor produces the identical
statistical signature as a genuinely repeated destination. In this dataset,
two shopping malls and a grocery-store plaza out-ranked the real apartment
complexes on flight-count alone before satellite verification. Two locations
were confirmed this way:

- **Churchill Crossing apartments** — 18 flights, 13 dates, 18 distinct CAD
  numbers, May 28 → Aug 6. A real multi-building apartment property with its
  own on-site management office.
- **Robinson Rowhouses** — 5 flights, 5 dates, 5 distinct CAD numbers. A named
  multi-unit residential property confirmed by satellite.

**But raw recurrence, even at ground-truth-confirmed locations, does not
clear a properly-specified chance null at this dataset's scale — and getting
that null right took three attempts, worth documenting because the first two
failure modes are easy to repeat.**

1. *Broken null #1 — label-shuffle over fixed positions.* Permuted which
   flight-ID was attached to each of the real settling positions, holding the
   position set itself fixed. Cluster membership depends only on geographic
   adjacency, which never changed, so this null reproduced the real cluster
   sizes almost exactly and looked "significant" for the wrong reason — it
   wasn't testing anything.
2. *Broken null #2 — resampling from raw telemetry points.* Fixed for #1 by
   resampling *positions*, but drew from every logged point rather than one
   representative point per flight. A flight merely transiting a corridor
   logs hundreds of points along it, so this null over-weighted corridors
   even more than reality does, making every real cluster look artificially
   small by comparison.
3. *Correct null — one destination draw per flight, from the real popularity
   distribution.* Each of 373 flights independently draws one settling
   location from the empirical distribution of where flights in this dataset
   actually go (with replacement), preserving real geographic unevenness
   without re-using fixed positions or over-weighting transit. Over 2,000
   draws, the **median largest incidental cluster is ~18-20 flights** — purely
   from Nashville's own uneven call geography, no repeat-targeting required.
   Against this null, Churchill Crossing's 18 flights and Robinson
   Rowhouses' 5 both come back at **p≈1.0 — not significant.**

That is an honest result, not a null finding of "nothing here": it means a
single city's ~2.5-month trial (395 flights) does not have the statistical
power to separate "this property gets genuinely disproportionate attention"
from "this city's police-call geography is naturally uneven, and busy places
get visited more." Reproduce this test yourself before trusting a location
finding — see `shuffle_null_location()` in
[`dfr_behavior_profile.py`](../scripts/linkage/dfr_behavior_profile.py).

#### The fix: treat the PLACE as the referent being affected, not the flight

Raw recurrence asks "is this place visited more than average" — trivially yes
for any busy place. The question that actually matters is whether a place is
affected *beyond its own baseline need for a police response*, which requires
an independent baseline: real call volume at that specific place, measured
without reference to whether a drone was ever sent.

**This project could not finish that exact test cleanly, and says so rather
than force a number.** Two attempts:

- *Geocoded proximity:* only ~36% of Calls for Service in this window carry
  coordinates, so most real calls at any specific property — including,
  plausibly, several that generated the very flights being tested — never
  enter a coordinate-radius search at all. Both confirmed locations' local
  call counts (7 and 2) were implausibly low relative to their real flight
  counts, which is the signature of an undercounted denominator, not a real
  finding.
- *Street-name text matching* (71.7% field coverage, better than geocoding):
  still failed for both properties specifically — Churchill Crossing's own
  internal road doesn't appear in Calls for Service's `Street_Name` field at
  all (only 2 calls on the adjacent public road), and Robinson Rd is a whole
  street spanning many other properties, not just the rowhouses, so it
  overcounts in the other direction.

**A per-place call-volume baseline needs a real address-to-parcel match this
dataset's fields can't cleanly support — flag as unresolved, not as a null
result, for anyone with better geocoding to pick up.**

#### What DID clear a real null: behavior, not location count

Reframed again: if a place gets more attention, does the attention it gets
look different in shape? This is answerable without solving the address
problem, using only the DFR data's own shape features (§0) — and it requires
controlling for an obvious confound first: both confirmed properties sit
farther from the dock (2.7–3.1km) than a typical destination, and distance
alone predicts longer duration and more real travel distance. Comparing
against *only* other flights settling at the same distance from the dock
(±0.5km band) isolates that:

```
                      Churchill Crossing (n=17)   Robinson Rowhouses (n=3)   distance-matched other
duration (min)        no longer different          n too small to test        —
real_path_km           no longer different          n too small to test        —
loiter_density                0.40                         0.32                      0.28
  permutation p-value          0.085                        0.87
```

Duration and real path length, once distance is controlled for, are
statistically indistinguishable from any other flight traveling that far —
that part of the earlier raw comparison was pure geometry. **Loiter density —
how tightly a flight concentrates on one exact spot rather than spreading
out — does not clear significance for either location tested individually.**
Pooling both locations together (n=23 vs. 120 distance-matched others)
produces p=0.048, technically under 0.05 — but report that pooled figure with
real caution: it depends on treating two different properties as one group,
which is a modeling choice that mechanically increases sample size and
lowers the bar, and Robinson Rowhouses alone (n=3) is far too small to
support any individual conclusion. **The honest summary is "a marginal,
not-yet-robust signal," not "confirmed."**

*What none of this shows:* nothing here establishes that a specific unit,
resident, or individual was targeted. Loiter density is a property of the
whole flight relative to a fixed area, not evidence about who or what was in
frame. And a `REPEAT-LOCATION` finding — confirmed or not — is not evidence of
policing intent; large residential complexes generate more calls than
single-family homes independent of any surveillance choice. Flag, verify,
report the pattern, and report the null test's own result alongside it —
don't let a location list stand without its significance test attached.

### 2f. THE PLACE ITSELF as the referent — what demographics say, and don't

A further reframing, prompted directly during this analysis: treat the
*place*, not the flight, as the thing potentially affected, and ask what
differs about places that receive more attention — independent of anything
about the drone or the observation event itself.

**Get the geography right first.** Nashville's 35 Metro Council districts
(~20,000 people each) are too coarse — an early pass at district level showed
Churchill Crossing's district (10) and Robinson Rowhouses' district (11)
*higher*-income and *whiter* than the dock's own district (9), which would
have been a real, reportable, counter-intuitive finding. It didn't survive
finer geography. Tract level (~174 tracts in Davidson County, ~4,000–6,000
people each — via the Census Planning Database's keyless bulk CSV,
`www2.census.gov/adrm/PDB/2023/pdb2023tr.csv`, since the live ACS API requires
a registered key this project didn't have) tells a different, more accurate
story:

```
                              tract      pop   med_hh_income  %white  %black  %hisp  %poverty  %renter
Churchill Crossing (+ dock)  010401    4,927        $46,536    39.9    34.3   20.3      11.7     73.5
Robinson Rowhouses           010501    5,989        $60,026    74.9    14.0    4.7       7.6     38.3
ruled-out commercial cluster 010701    4,357        $53,575    36.5    34.5   24.4      11.2     63.5
Davidson County baseline       —     708,490        $72,908    55.7    26.4   10.4      14.3      —
```

Every tract checked sits below the county median income — the two confirmed
repeat-locations are not outliers on that axis. But the two confirmed
locations differ sharply *from each other*: Churchill Crossing sits in the
same tract as the dock itself, a majority-renter (73.5%), lower-income,
racially mixed tract; Robinson Rowhouses sits in a distinctly whiter,
higher-income, majority-owner-occupied tract nearby. There is no single
demographic direction here — one confirmed repeat-location looks like the
neighborhood immediately around the dock, the other looks different from it
in nearly every dimension measured.

**Read this as a methodology demonstration, not a finding, for one
overriding reason: n=2.** Two confirmed locations cannot establish a
demographic pattern in either direction — not "targets poorer areas," not
"targets whiter areas." Reporting anything stronger than "here is how to run
this check" from two data points would be exactly the overclaiming this whole
project's discipline exists to prevent. A second, real risk sits underneath
even a larger sample: tract-level demographics describe the *area*, not the
specific 200m-radius property inside it — an apartment complex's own resident
population can differ substantially from its surrounding tract's average,
so any conclusion drawn at tract resolution about a single named property is
an ecological-fallacy risk that needs to be named every time this is reused.

**To do this properly at scale:** run it against every ground-truth-confirmed
repeat-location this profile eventually accumulates (more months of one city,
or several cities — see §3), and prefer parcel- or property-level data
(housing type, subsidized vs. market-rate status) over area averages wherever
it's available, since that is the resolution an equity question actually
needs. For applying this in another city, Esri's ACS-based demographic layers
(https://doc.arcgis.com/en/esri-demographics/latest/esri-demographics/acs.htm)
are worth checking as a possibly more convenient source than a fresh Planning
Database download each time, since much of this project's other geography
already runs through ArcGIS services without needing separate credentials.

### 2c. RELAUNCH (same call, multiple flights) — expected, not anomalous

*Feature:* the same CAD number cited by 2+ flights within a short window
(median 16 min apart in this dataset).

*Why this is its own category, separate from 2b:* it looks identical to a
data error at first glance and must not be reported as one. 38 of 47
multi-flight CAD numbers in this dataset show every citing flight agreeing on
call type — battery swap or backup drone on the same live incident. The other
9 disagree on purpose across citations of the same number (e.g., SUSPICIOUS →
SUICIDAL PERSON 17 minutes later) — plausibly genuine escalation as officers
arrived, or a mis-logged relaunch purpose; the data can't distinguish those two
explanations and shouldn't be forced to.

### 2d. UNEXPLAINED TELEMETRY (data-quality flag, not behavior)

*Feature:* a flight's start and end point are identical to machine precision
(directness = 0.000) despite several km of real logged path length.

*This dataset:* 8 flights, all from the trial's first day and a half
(2026-05-26 to 2026-05-27). Clustering entirely at deployment start points
toward an early-telemetry quirk rather than a real flight pattern, but this is
not resolved either way — report as a data-quality flag, not a behavioral
finding, until it recurs (or doesn't) later in the same program or in another
city's data.

### 2e. SCHEDULE GAP (program-level, not per-flight)

*Feature:* compare the full calendar of the trial period (not just flight
timestamps) against days/hours with zero flights, in **local time**
(UTC misclassifies late-evening flights into the wrong calendar day — this
cost a full day of the analysis before being caught).

*This dataset:* 0 of 10 Saturdays, 0 of 10 Sundays had any flight across the
entire trial; 1 of 10 Mondays did. Overnight gap roughly 11pm–6am local. This
is a program-level fact (staffing/scheduling), not a per-flight anomaly, but
it should travel with any collapsed/void rate reported from this data — a
`void` verdict can only ever be measured against the hours the program
actually flies.

## 3. How to re-run this against a new dataset (this city, fresh pull, or another city)

1. Pull the flight feed, dedup by `flight_id` (§0.1).
2. Pull the local CAD/calls-for-service dataset and measure its own resolution
   null (§0.3) — do not reuse this document's 52.6%/15.4% figures for a
   different city or a different number sequence.
3. Compute per-flight: resolution / temporal-null / spatial-null (§1);
   real path length and turning-per-km using within-part segments only (§0.2);
   loiter-density and settling cell (§2b).
4. Run the capped-cluster location sweep (§0.4, §2b) city-wide — not just on
   whatever locations a human happened to notice first.
5. **Ground-truth every repeat-location candidate before reporting it.** This
   is not optional; it is the step that separated two real apartment
   complexes from five shopping malls in this pass.
6. Report every category (2a–2e) separately, typed, with its own evidence —
   never collapsed into one "anomaly score."

## 4. What this profile deliberately does not claim

- It does not identify individuals. Nothing here uses or infers identity.
- A `void` verdict is not "unjustified" — most of this dataset's void rate
  reflects calls that never generated a report, not withheld evidence (see
  [`linkage-findings.md`](./linkage-findings.md) §4c for the measured
  publication-density argument this reuses).
- A REPEAT-LOCATION finding is not a claim about surveillance intent. It is an
  observable pattern in public dispatch and flight data, worth verifying and
  reporting as exactly that.
- Every number above is Nashville-specific and dated 2026-08-15. Re-measure,
  don't reuse, when applying this elsewhere.

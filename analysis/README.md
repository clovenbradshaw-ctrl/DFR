# DFR flight analysis

Independent linkage and behavior analysis of the flight feed in this repo,
run against MNPD's public Calls for Service / Incidents datasets. Not part of
the map or explorer apps — this is investigative-analysis material, kept
alongside the data it analyzes.

Start here: **[`dfr-flights-provenance.md`](./dfr-flights-provenance.md)**
(where the data comes from, exactly how to re-fetch it, and the three-null
theory used to link a flight to a specific 911 call) and
**[`dfr-behavior-profile.md`](./dfr-behavior-profile.md)** (what normal
call-response looks like vs. genuinely notable patterns, including the full
trail of null-testing mistakes made and corrected along the way — worth
reading before extending this to a fresh pull or another city).
[`dfr-repeat-locations.md`](./dfr-repeat-locations.md) documents the two
ground-truth-confirmed repeat-visited properties in detail.

## Reproducing this

```bash
cd analysis/output
curl -s 'https://services7.arcgis.com/mnhQTdIYDA7UoY2l/arcgis/rest/services/678dee26-6aa8-4d60-bf1c-30c7b0f6b517-production/FeatureServer/0/query?where=1%3D1&outFields=*&returnGeometry=true&outSR=4326&f=geojson' \
  -o dfr-flights.geojson

python3 ../scripts/link_dfr_flights.py        # per-flight linkage vs. Calls for Service
python3 ../scripts/dfr_behavior_profile.py    # master table + location/behavior null tests
```

`dfr-flights.geojson` itself isn't committed here (18MB+ and grows with every
flight; this repo's own convention keeps data separate from code, per the
top-level README) — the commands above regenerate it and everything derived
from it.

## What's in `output/`

Committed as a point-in-time snapshot (2026-08-15) so findings in the `.md`
docs are checkable without re-running anything:

| File | What it is |
|---|---|
| `dfr-flights-master.{csv,json}` | One row per flight: linkage verdict, shape features (real path length, turning, loiter density) |
| `dfr-flight-links.json` | Raw per-flight linkage output from `link_dfr_flights.py` |
| `dfr-location-shuffle-null.json` | The correctly-specified permutation null for location-recurrence significance (see the profile doc's §2b for two earlier, broken attempts and why they failed) |
| `dfr-behavior-by-location.json` | Distance-controlled behavior comparison at the two confirmed repeat-locations |
| `dfr-tract-demographics.json` | Census tract-level ACS demographics (Planning Database, keyless) for confirmed/candidate/ruled-out locations |
| `dfr-location-tracts.json`, `dfr-location-districts.json` | Geography lookups backing the demographic comparison |
| `dfr-report-resolution-check.json` | Verification that DFR-linked calls resolve to published incident reports |
| `dfr-dwell-clusters.json` | Order-independent density clustering of each flight's point cloud |
| `dfr-full-map*.png` | Full point-cloud visualizations, all flights, colored by call type |

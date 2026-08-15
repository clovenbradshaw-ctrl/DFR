# DFR repeat-visit locations — observations to follow up on

Started 2026-08-15 from a direct prompt: "I saw one where it kept going back to
an apartment complex." This document tracks what's been checked, confirmed, and
ruled out. Everything here is a *location pattern*, not a claim about
surveilling a specific person — position data alone can't establish intent or
identity, and that line is not crossed anywhere below.

Method: cluster each flight's densest non-dock point concentration (a real
proxy for where it settled/hovered, since GPS samples accumulate while
stationary) at ~150–200m resolution (building scale), rank by how many
*distinct* flights and *distinct dates* settle in the same place, then verify
each candidate against satellite imagery — grid-cell recurrence alone doesn't
distinguish "returns to watch one property" from "flies through the same
retail corridor every agency call happens to be near." Several early
candidates were the latter; two, so far, are confirmed the former.

## Confirmed: CHURCHILL CROSSING apartments (36.3013, -86.6912)

**18 flights, 13 distinct dates, 18 distinct PD/CAD numbers** — genuinely
separate dispatches, not one call re-cited. Spans May 28 → Aug 6, nearly the
entire trial. Several flights spent 80–90% of their total airtime hovering at
this one property.

| Date | Purpose | PD number |
|---|---|---|
| 2026-05-28 20:51 | VEHICLE ACCIDENT - PROPERTY DAMAGE | PD202600396287 |
| 2026-05-28 21:04 | PERSON INDECENTLY EXPOSED | PD202600396334 |
| 2026-06-02 20:11 | SUSPICIOUS PERSON | PD202600409586 |
| 2026-06-03 13:23 | THEFT | PD202600411470 |
| 2026-06-03 14:55 | FIRE | PD202600411738 |
| 2026-06-10 14:13 | PERSON INDECENTLY EXPOSED | PD202600430136 |
| 2026-07-08 03:21 | HOLDUP / ROBBERY | PD202600502483 |
| 2026-07-15 15:07 | DISORDERLY PERSON | PD202600520947 |
| 2026-07-16 20:06 | FIGHT / ASSAULT | PD202600523965 |
| 2026-07-17 00:12 & 00:25 | CUTTING / STABBING (2 flights, same call) | PD202600524500 |
| 2026-07-17 14:12 | VEHICLE ACCIDENT - PROPERTY DAMAGE | PD202600525859 / 525874 |
| 2026-07-24 20:02 | DISORDERLY PERSON | PD202600542797 |
| 2026-07-24 23:11 | DISORDERLY PERSON | PD202600543153 |
| 2026-07-28 16:13 | DISORDERLY PERSON | PD202600551491 |
| 2026-07-30 21:50 | SUICIDAL PERSON | PD202600557375 |
| 2026-08-05 22:55 | VEHICLE ACCIDENT-PERSONAL INJURY | PD202600571958 |
| 2026-08-06 13:11 | VEHICLE ACCIDENT - PROPERTY DAMAGE | PD202600573261 |

Verified on satellite imagery: a real multi-building apartment property with
its own on-site "Management Association" office, off Twin Hills Dr / Churchill
Crossing, Nashville 37115.

## Confirmed: ROBINSON ROWHOUSES (36.2668, -86.6648)

**5 flights, 5 distinct dates, 5 distinct PD numbers.** Smaller than Churchill
Crossing but real — one flight (the robbery call) spent 84% of its total
airtime hovering here.

| Date | Purpose | PD number |
|---|---|---|
| 2026-06-03 12:12 | BURGLARY - NON-RESIDENCE | PD202600411277 |
| 2026-07-14 19:31 | HOLDUP / ROBBERY | PD202600518840 |
| 2026-08-06 12:29 | DOMESTIC DISTURBANCE | PD202600573158 |
| 2026-08-07 01:08 | DISORDERLY PERSON | PD202600574797 |
| 2026-08-08 03:05 | BURGLARY - NON-RESIDENCE | PD202600577403 |

Verified on satellite imagery: named "Robinson Rowhouses" on Robinson Rd, a
multi-unit residential property, adjacent to a boat dealer and light-industrial
buildings. Two additional flights (KIDNAPPING 2026-08-04, VEHICLE
ACCIDENT-PERSONAL INJURY 2026-06-03) have points in the same general grid cell
but fall outside a clean 200m/10%-of-flight radius around the rowhouses
specifically — plausibly settled at the boat dealer or a neighboring property
instead. Not folded into the count above; flagged here for a closer look if
this location gets revisited.

## Checked and ruled out (commercial, not residential)

The naive "many flights touch this cell" ranking surfaces retail corridors
just as strongly as real repeat-destinations, because they generate their own
steady stream of unrelated calls. Each of these was confirmed commercial via
satellite before being excluded:

| Location | What it actually is | Call mix that made it rank highly |
|---|---|---|
| (36.2544,-86.7172) | **Madison Town Center** — shopping mall, Gallatin Pike | weapon, robbery, disorderly, fight, suspicious person |
| (36.2622,-86.7132) | **Kroger plaza** — grocery/retail strip | fight, disorderly, weapon, burglary |
| (36.2557,-86.7152) | Retail plaza (restaurants, churches) near Madison Square | vehicle accident, weapon, domestic, fire |
| (36.2947,-86.6983) | Retail strip (Olive Garden, Anytime Fitness, thrift store) | disorderly, vehicle accident, theft |
| (36.2921,-86.7022) | **Rivergate Station** — shopping mall | vehicle accident, disorderly, theft |
| (36.2661,-86.7100) | Mixed commercial/residential strip, Duling Ave | item/vehicle stolen, disorderly |
| (36.2700,-86.68xx / -86.69xx) | Ordinary single-family neighborhoods near the dock | mixed, low signal — likely dock-proximity artifact rather than a real destination |

## Broader observations from this pass

- **The location-recurrence check itself required getting the spatial scale
  right.** A 45m grid (individual-building precision) undercounted real
  clusters by splitting one property across adjacent cells; a ~150–200m grid
  (property-scale) is what actually surfaced both confirmed complexes. Anyone
  extending this should start at that resolution, not finer.
- **Raw "many distinct flights visited this cell" is not sufficient on its
  own** — it has to be crossed with ground-truth (satellite imagery, in this
  pass) because busy commercial corridors produce the same statistical
  signature as a genuinely repeated destination. Every one of the ruled-out
  locations above would have looked identical to Churchill Crossing on the
  numbers alone.
- **Position data alone cannot distinguish "this property generates a lot of
  legitimate calls" from anything more targeted.** Both confirmed locations
  show a *diverse* mix of call types across *many different, independently
  verified* CAD dispatch numbers spread over weeks to months — that pattern is
  consistent with a high-call-volume property (which large apartment
  complexes and rowhouse developments often are, independent of any policing
  choice) and is not, by itself, evidence of anything beyond ordinary
  responsive dispatch. Flagging it here is about documenting an observable
  pattern for further reporting, not asserting a conclusion the data doesn't
  support.
- Full point-cloud maps (both the raw and the within-part-corrected version,
  see [`dfr-flights-provenance.md`](./dfr-flights-provenance.md) §4a for the
  correction) are in
  [`analysis/linkage/dfr-full-map.png`](./linkage/dfr-full-map.png) and
  [`dfr-full-map-clean.png`](./linkage/dfr-full-map-clean.png) — worth a look
  for anyone continuing this pass; several other colored clusters in those
  images haven't been checked yet.

## Not yet checked (visible in the map, not yet run down)

- A dense purple (BURGLARY) loop cluster around (36.283, -86.717) and (36.271,
  -86.722) — could be genuine multi-pass perimeter-check behavior around a
  single property, or could be two separate ordinary burglary responses that
  happen to be geographically close. Not yet cross-referenced against distinct
  PD numbers or satellite imagery.
- 8 flights, all from 2026-05-26 to 2026-05-27 (the trial's first day and a
  half), showing exact-zero directness (start/end point identical to machine
  precision despite 4–7km of real path length) — flagged in the provenance doc
  as an unexplained pattern, possibly an early-deployment telemetry quirk,
  possibly something else. Not resolved either way.

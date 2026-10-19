# Estimated Rail Connections (mapped railway infrastructure)

An opt-in explorer that shows **railway track that physically connects two places**, with an **estimated** travel-time
range. It is labelled everywhere as **"Estimated rail connection — not a scheduled train"**.

It is technically separate from scheduled trains (`backend/transit/rail`, still off until a permitted timetable exists).
It has its own endpoint (`GET /api/v2/rail-explorer`), its own data (`rail-network.json`) and its own UI section. It is
never mixed into, counted with or ranked against `/api/v2/plan` journeys. The separation is enforced by a test.

## What is real and what is assumed

| Shown | Status |
|---|---|
| Stations, names, codes (`ref`) | Real: OpenStreetMap |
| Track, junctions, connectivity, alternative corridors | Real: mapped OSM track; connected only where ways share a node |
| Rail distance | Real: measured along the mapped track geometry |
| Stations along the line | Real: stations mapped within 300 m of the path's track |
| Travel-time range | **Assumed model** (below); not a timetable |
| A passenger train runs on the corridor | **Unknown**: physical track is not service |
| Train numbers, departure/arrival times, running days, fares, seats, live status | **Never produced** |

## Data, licence and attribution

- Source: OpenStreetMap, fetched with ONE Overpass API request per update (`railway=rail` ways, `railway=station|halt`,
  `railway=railway_crossing`) for the configured admin_level=4 regions. This respects Overpass fair use (≈10,000
  requests / 1 GB per day); nothing is queried per user search.
- Licence: **ODbL 1.0**. Attribution "© OpenStreetMap contributors" (linked to https://www.openstreetmap.org/copyright)
  is shown under every corridor map and on the Data & policies page. `rail-network.json` is a derived database: if it
  is ever distributed, it must be under ODbL too. By default it is generated on the server and git-ignored.
- OpenRailwayMap renders the same OSM data; RouteConnect uses OSM directly and needs no OpenRailwayMap tiles or API.

## Pipeline

1. `npm run rail:network:extract`: Overpass → `osm-railways.raw.json` (~7 MB).
2. `npm run rail:network:build`: raw → `rail-network.json` (~3 MB). Offline and deterministic. Steps:
   - **Exclude:** `usage=industrial|military|freight|tourism|test`, `service=siding|spur|sand_drag|safety_siding`,
     non-1676 mm gauge, and metro stations. Abandoned, disused, proposed and construction track is never fetched.
   - **Connect** ways only through shared OSM nodes. At diamond crossings (`railway=railway_crossing`) the tracks stay
     unconnected.
   - **Attach** each station to the nearest usable track within 500 m by projection. The attachment distance is recorded,
     and stations further away are reported as unattached.
   - **Compute** connected components.
3. **Routing:** edge-based shortest path with a turn restriction (no bend sharper than 60° through a node). Turning back
   is allowed only at a station, costing 20 min. One alternative corridor is offered only if it is ≤ 1.35× as long and
   ≤ 60% of it lies within 400 m of the best corridor (so parallel up/down tracks are not "alternatives").
4. **Estimate** (`estimateRailTime.js`): a range between two scenarios. All values are env-configurable and round, not
   fitted to any timetable:
   - faster: 65 km/h on main/unknown track, 50 km/h on branch lines, a 3-min stop every 60 km;
   - slower: 45 km/h main, 35 km/h branch, 1.5 min at every station passed;
   - plus 20 min per reversal. Results are rounded to 5 min.

## Coverage (extract of 2026-10-19, regions Andhra Pradesh + Telangana)

- 10,494 km of usable track (6,478 ways; 2,053 excluded).
- 786 stations attached (771 of the 869 mapped stations carry codes); 80 excluded (metro etc.); 3 unattached.
- 338 connected components. The main network is 9,748 km and holds almost all stations. The rest are fragments
  (new lines still being built, isolated yard pieces), and stations on them only connect locally.
- Gaps: track outside AP/Telangana is not loaded, so corridors leaving the region (e.g. towards Chennai or Bengaluru)
  are cut at the border. New lines tagged `usage=main` (e.g. Krishnapatnam port lines) may be freight-heavy; OSM has
  no passenger-service information.

## Manual validation (city centres, 2026-10-19 extract)

| Trip | Stations | Corridor | Distance | Estimate | Real timetabled trains, for comparison* |
|---|---|---|---|---|---|
| Vijayawada → Guntur | KCC → GNT | direct | 27 km | 25–40 min | 45 min–1 h 45 min (BZA–GNT) |
| Guntur → Tenali | GNT → TEL | direct | 26 km | 25–40 min | 25 min–1 h 15 min |
| Vijayawada → Hyderabad | KCC → HYB | via Guntur, Nadikudi | 318 km | 5 h 10 min–8 h 25 min | |
| | | alt. via Dornakal, Kazipet | 364 km | 5 h 55 min–9 h 25 min | 12713 BZA–SC 6 h 15 min |
| Vijayawada → Visakhapatnam | BZA → VSKP | via Nidadavolu, Samalkot | 350 km | 5 h 40 min–9 h 15 min | 6 h 20 min (12718)–7 h 50 min (17239) |
| Kurnool → Hyderabad | KRNT → KCG | direct | 237 km | 3 h 45 min–6 h 15 min | 4 h 20 min–5 h 55 min |
| Tenali → Hyderabad | TEL → HYB | via Guntur, Nadikudi (+ alt. via Kazipet) | 316 / 391 km | 5 h 5 min–8 h 20 min | |

\* Comparison durations were taken from the earlier timetable investigation and eRail. They are used only to check that
the ranges are plausible, not to set the model parameters.

## How people reach it

The preference dialog offers **No preference · Bus · Estimated rail · Scheduled train (Coming soon)**.
- **Estimated rail**: the search calls only `/api/v2/rail-explorer`, under the normal discovery animation, and the results
  page shows estimated corridors as the main result (`?view=estimated-rail`). No bus search is made. The searched
  date and time are not presented as applying to it.
- **No preference**: bus journeys ("Available bus journeys"), and estimated corridors in their own section below
  ("Estimated railway connections"). They are never ranked against each other.
- **Bus**: no estimated rail.
- If the network is not ready, the choice is shown disabled with the server's reason (preparing / not set up / failed).

## Deployment

- **At server start** the graph is prepared automatically when missing. It is built from the saved extract if one
  exists; otherwise ONE Overpass extract is fetched, unless `ROUTECONNECT_RAIL_NETWORK_AUTO_EXTRACT=false`. Until it
  is ready, `/api/v2/capabilities` reports `estimatedRail.state` as `preparing`, `missing` or `failed`.

- `render:build` runs `rail:network:ensure`: it builds if the graph is missing and extracts (one Overpass request) only if
  there is no raw extract yet. Set `ROUTECONNECT_RAIL_NETWORK_DIR=/var/data/railNetwork` on a persistent disk so redeploys
  reuse it instead of querying Overpass again. Storage: about 10 MB.
- Refresh with `npm run rail:network:update` every few months; status reports `needsRefresh` after 180 days.
- `ROUTECONNECT_RAIL_NETWORK_ENABLED=false` turns the explorer off; the capability then reports it unavailable and the
  option disappears from the preference dialog.

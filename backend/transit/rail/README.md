# Railway timetable (train search)

Provider-independent railway timetable layer for RouteConnect: import → dedicated `rail.db` → in-memory search → multimodal
planner (`/api/v2/plan`). Separate from the APSRTC bus database, so train numbers and station codes never mix with bus
route or stop identifiers.

> **Status: OFF unless `ROUTECONNECT_RAIL_ENABLED=true`.** The only current, usable source has no stated licence (see
> below). Turning trains on for a public deployment is an owner decision, not a default.

## What is genuine, estimated, unavailable

| Field | Status | Where it comes from |
|---|---|---|
| Train number, train name | Genuine (source) | GTFS `routes.route_short_name` / `route_long_name`, copied verbatim |
| Station codes, names | Genuine (source) | GTFS `stops` (Indian Railways station codes) |
| Station coordinates | Genuine (source), validated | GTFS `stops`; outside an India bounding box → dropped, never corrected |
| Stop order, scheduled arrival/departure | Genuine (source) | GTFS `stop_times` (NTES public-timetable times, minute precision) |
| Journey day of each stop | Derived exactly | times ≥ 24:00 in the source |
| Running days, validity dates | Genuine (source) | GTFS `calendar` (first-station dates); expired calendars are never stretched |
| Boarding-station running days | Derived exactly | origin running days shifted by the stop's journey day |
| Station/platform buffers (20 min before, 10 min after), 45-min minimum change | Estimated (policy) | `compose.js`, `railConfig.js` |
| Walk / local ride to and from stations | Estimated | existing access/egress model |
| Bus to/from a station | Genuine bus timetable | existing GTFS bus planner, unchanged |
| Fares | **Unavailable** | not in the source; shown as "Fare unavailable", never ₹0 |
| Live running status, platforms, seats, booking | **Unavailable** | not implemented; nothing claims to be live |
| Hypothetical corridors | **Not implemented** | intentionally (see below) |

## Sources evaluated (October 2026)

| Source | Verdict | Why |
|---|---|---|
| Mobility Database `mdb-2867` | Same file as Neo2308 | Byte-identical (SHA-256 `a0347d04…7be8`); MDB labels it "Unofficial data", "Community Feed"; no licence shown |
| `Neo2308/indianrailways-gtfs` | **Used (opt-in only)** | Current (snapshot 2026-08-30, calendars to 2027-08-30), good coverage, validated against eRail. **No licence file.** Built by calling the CRIS NTES API through the UMANG gateway with an extracted API key |
| `prasenjit-27/Indian-Railway-Data` | Rejected | MIT label but no provenance or date; timings 10–35 min off current schedules (e.g. 12713 BZA 06:10→SC 11:45 vs current 06:25→12:40); corrupt orders (12603 listed starting at GNT before MAS) |
| data.gov.in "Indian Railways Train Time Table" | Rejected for search | GODL-India licence (good) but published 2015, last updated 2018-01-24: predates the 2021–22 renumbering |
| RailRadar API | Optional verification adapter | Crowd-powered, unaffiliated with IR/NTES; free sandbox 100 requests/month; key needed (none configured) |
| NTES / Indian Railways enquiry | Manual checks only | CAPTCHA-protected; not automated |

## Validation of the chosen feed (snapshot 2026-08-30, imported 2026-10-19)

- 10,594 trips in source → **10,380 trains imported**, **8,550 stations** (all with coordinates), 204,037 stops.
- Refused at import: 205 trains whose `service_id` is missing from `calendar.txt` (includes Vande Bharat 20707/20708/20704),
  9 with missing endpoint times, 1 calendar ending before it starts. Same two errors as the MobilityData validator 8.0.1.
- Coordinates cross-checked against an independent dataset for 183 AP/Telangana stations: median 46 m, p90 120 m apart.
- **eRail cross-check (data marked `DATASOURCE_IR`), Tuesday 2026-10-20, 7 pairs:** 100 trains returned; 97 exactly
  match departure and arrival; 3 differ by 2–10 min (12805 BZA 12:12 vs 12:10; 17044 SC arrival 08:50 vs 08:40); 0 trains
  returned that eRail says do not run that day.
- **Known gap:** trains re-issued in IR's mid-October revision are missing. Their snapshot calendars end 2026-10-14
  (e.g. 11019 Konark, 12704 Falaknuma, 17016 Visakha, 18464 Prashanthi). BZA→VSKP returns 20 of 35 trains running on
  2026-10-20. As of 2026-10-19, 798 imported trains have expired calendars. Refreshing the snapshot is the only fix.

Re-run the checks: `npm run rail:search -- --from BZA --to GNT --date 2026-10-20 --direct --all --window 1439`.

## Freshness policy

- Snapshot date = feed_version date (2026-08-30). `feed_end_date` (2026-09-30) is set by the publisher's tool to
  "retrieval + 1 month" and is not a validity statement; per-train calendars govern which days a train runs.
- Older than 45 days (`ROUTECONNECT_RAIL_STALE_WARNING_DAYS`): schedules labelled *inferred* and one notice per search.
- Older than 120 days (`ROUTECONNECT_RAIL_MAX_SNAPSHOT_AGE_DAYS`): train search switches off and the Train option locks.

## Commands

```bash
npm run rail:download   # fetch ROUTECONNECT_RAIL_GTFS_URL into the feeds folder
npm run rail:import     # validate + import into rail.db (replaces the previous snapshot of that source)
npm run rail:update     # download a fresh copy, then import (run after each upstream update)
npm run rail:ensure     # deploy builds: import once when enabled and rail.db is missing
npm run rail:status     # provenance, freshness, coverage, import issues
npm run rail:search -- --from BZA --to SC --date 2026-10-20 --time 06:00 [--window 360] [--direct] [--all]
```

## Deployment

- Express serves `dist/` and `/api` from one origin (`npm start`), so the Vite dev proxy is not involved in production.
- `rail.db` is ~11 MB; the archive ~4 MB. On Render, put both on the persistent disk:
  `ROUTECONNECT_RAIL_DATABASE_PATH=/var/data/rail.db` (the archive goes to `/var/data/feeds/` automatically).
- `render:build` runs `rail:ensure`, which does nothing unless `ROUTECONNECT_RAIL_ENABLED=true`. At start-up the server
  imports once if enabled and missing; any failure only disables trains (buses keep working).
- Rail data and reports are git-ignored (`backend/transit/data/`, `backend/transit/reports/`). Never commit them.
- RailRadar (optional): `RAILRADAR_API_KEY` server-side only; `GET /api/v2/rail/verify?train=&from=&to=&date=&departure=&arrival=`
  (503 without a key, 20 requests/hour in-process limit, 100/month budget).

## Bus + Train journeys (RailRadar)

Scheduled trains are combined with timetable buses into door-to-door journeys (Bus → Train, Train → Bus,
Bus → Train → Bus, and Train → Train / Train → Bus → Train when the budget allows):

Stations come from the **nationwide** reference (`railNetwork/seed/india-stations.json.gz`, OpenStreetMap, ~9,200
stations), searched with a spatial index; the Andhra Pradesh / Telangana railway graph only adds a track-based station
size signal there. Typed places outside the bus timetable (Mumbai, "MAS") resolve to coordinates from the same reference.

1. **Stage A - anchor pair**: the main station near each end (the largest within 8 km, preferring the station named
   after the place: Chennai Central, Hyderabad Deccan). In a multi-terminal city (OSM `place=city` + 3 stations within
   10 km) whose anchor is not clearly its main station, the first question is RailRadar's documented `byCity=true`
   (every station of both cities in one request). One request, cached 6 h. No station within 40 km: one look to 60 km
   on long trips, reported as `stations.origin|destination = expanded|none`.
   **Stage B - other terminals**: when the plain anchor question was not enough, ONE `byCity` question.
   **Stage D - two trains**: when no direct train exists, a change at a large junction / city station (both legs `byCity`
   in a city, so the change may be between two of its stations; the connection is validated in compose.js). Tried
   before Stage C when neither end is inside the bus timetable.
2. **Stage C - transfer hubs** (`multimodal/railHubs.js`) - only when the anchor has too few trains in the window, or a hub promises
   an arrival at least 45 min earlier. Candidates are large stations (mapped track + "Junction") with a bus stand
   nearby; origin-side hubs must be reachable by timetable bus (one RAPTOR run, real arrival times). Pairs that cannot
   come close to the best bus, or are another terminal in the same two towns while the anchor has trains, are not asked.
3. **Composition** (`multimodal/compose.js`, `busFeeder.js`) - the latest bus that still reaches the station 20 min before
   departure; the first bus after the 10-min station exit; every connection is checked on absolute date-times. A
   ride-only connection is offered up to 40 km to the nearest station, 15 km to a bus-reached hub; never longer.
4. **Ranking** - bus + train is its own kind for diversity (never promoted): one that a simpler journey matches on the
   clock is dropped. Train fares are unknown, so such totals are partial and rank after complete fares under "cost".

Request budget (RailRadar free tier ≈ 100 requests/month per key):

| Variable | Default | Meaning |
|---|---|---|
| `RAILRADAR_MAX_REQUESTS_PER_SEARCH` | `4` | new (uncached) requests one search may make; never more than a tenth of what is left this month; `1` = direct trains only |
| `RAILRADAR_MONTHLY_REQUEST_BUDGET` | `100` | per credential; at ≤ 20 left, searches ask about direct trains only |
| `ROUTECONNECT_RAIL_CITY_SEARCH` | on | `false` disables `byCity` questions for multi-terminal cities |
| `RAILRADAR_CACHE_TTL_HOURS` | `6` | how long a station-pair answer is reused |
| `ROUTECONNECT_RAIL_HUB_SEARCH` | on | `false` disables transfer hubs |
| `ROUTECONNECT_MULTIMODAL_MAX_TRANSFERS` | `2` | most public-transport changes in a bus + train journey |

Each response carries `railSearch` (pairs asked, cached / new requests, skipped and why, `limitedBy`) and
`searchCoverage`; the server logs one `[Rail search] ...: N RailRadar request(s), M cached` line per search. When the
budget or the deadline (12 s) stops the search early, the results say so (`RAIL_SEARCH_LIMITED`) instead of "no route".
The cache is in memory: on Render's free tier it is lost when the service sleeps, so the first search after a wake-up
pays its requests again.

## Hypothetical corridors

Not implemented. With source-backed trains available it would add risk (look-alike results) for little planning value.
If trains are switched off, train search stays transparently unavailable rather than showing assumed paths.

## Coverage regression

`npm run rail:coverage` runs 111 origin-destination pairs across India through the planner against a SYNTHETIC
timetable (`backend/transit/eval/railFixture.js`: real station codes and corridors, fake trains) and reports discovery,
false "no train" answers, validity of every train leg, terminal choice, requests per search and latency. Add
`--root <checkout>` to run another version of the planner on the same inputs. It never calls RailRadar.

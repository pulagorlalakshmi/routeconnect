# Railway network seed

`rail-network.json.gz` is the built railway graph (`rail-network.json`) for Andhra Pradesh and Telangana, gzipped.
The server installs it at start-up when no graph or raw extract exists, so a host with an ephemeral disk (Render free
tier) does not send an Overpass request on every boot. It also gives the scheduled-train source (RailRadar) station
locations when the Estimated Rail explorer is off or failed to prepare.

- **Source:** OpenStreetMap, one Overpass API extract (see `../overpassExtract.js`); the snapshot date is in `meta`
  (`osmBaseTimestamp`, `retrievedAt`, `builtAt`).
- **Licence:** this file is a derived database of OpenStreetMap data and is made available under the
  [Open Database License (ODbL) 1.0](https://opendatacommons.org/licenses/odbl/1-0/).
  Attribution: **© OpenStreetMap contributors** (https://www.openstreetmap.org/copyright).
- **Contents:** mapped railway infrastructure only (track geometry, junctions, stations). No timetables, train numbers,
  fares or schedules.

Refresh every few months:

```sh
npm run rail:network:update   # ONE Overpass extract + build
npm run rail:network:seed     # write the new graph here, then commit it
```

# Nationwide station and place reference

`india-stations.json.gz` (~260 KB) lists railway stations and halts across India with their official codes, names and
aliases, plus cities and towns (for typed place names). The scheduled-train search uses it to choose boarding and
alighting stations anywhere in India; it says nothing about which trains run (that comes from RailRadar per search).

- **Source:** OpenStreetMap, ONE Overpass extract for India (`railway=station|halt` with `ref` / `railway:ref`,
  `place=city|town`); metro / light-rail stations are excluded. Snapshot date in `meta.osmBaseTimestamp`.
- **Licence:** derived database of OpenStreetMap data, made available under the
  [Open Database License (ODbL) 1.0](https://opendatacommons.org/licenses/odbl/1-0/).
  Attribution: **© OpenStreetMap contributors** (https://www.openstreetmap.org/copyright).
- **Known gaps** (OSM data, October 2026 snapshot): stations mapped without a code are not included (e.g. Mysuru,
  Katpadi); some colloquial names are not aliases in OSM (e.g. "Trichy" — "Tiruchirappalli" works).

Refresh a few times a year:

```sh
npm run rail:stations:update   # ONE Overpass request (fair use), then commit the new seed
npm run rail:stations:status   # counts and snapshot date
```

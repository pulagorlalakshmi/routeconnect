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

# NYC Live: Data Sources

The machine-readable registry is [`config/sources.yaml`](../config/sources.yaml). This page explains
each source. Re-verify any time with `uv run nyclive probe`.

**Last full probe:** 2026-11-14. 19 of 21 sources returned HTTP 200 with the expected content
without a key. The other 2 were skipped because they need free keys. `mta_subway_stations` (the
22nd) was added and checked by hand the same day. Report:
`data/probe/2026-11-14.json` (local only).

## Phase 1 sources (all keyless)

### Cameras
**NYC DOT traffic cameras** (`dot_cameras`, `dot_camera_image`)
- List: `https://webcams.nyctmc.org/api/cameras`. 974 cameras (874 online): Manhattan 376,
  Queens 213, Brooklyn 206, Staten Island 98, Bronx 81.
- Frame: `…/api/cameras/{id}/image`. JPEG **352×240**, about 17 KB, `Cache-Control: no-store`. A
  new frame arrived on each of three requests 2 s apart.
- Quirks: the API is undocumented; `isOnline` is a string. Grainy, high-angle frames make it
  better suited to counting than tracking (ADR-008).
- Use: entities refreshed daily. Frames are loaded on demand in the UI and polled for the CV
  watchlist only.

### Transit & mobility
**Citi Bike GBFS** (`citibike_gbfs`, `citibike_station_status`)
- Manifest: `https://gbfs.citibikenyc.com/gbfs/2.3/gbfs.json`, which points to
  `gbfs.lyft.com/gbfs/2.3/bkn/en/*.json`. Discover URLs from it rather than hard-coding.
- `station_status`: 2,519 stations, about 1 MB, `ttl` 60 s. `station_information` provides names,
  locations and capacity.
- Quirks: inactive stations report `last_reported: 86400` (a sentinel, i.e. 1970-01-02).
  Treat it as unknown.

**MTA subway alerts** (`mta_subway_alerts`)
- `https://api-endpoint.mta.info/Dataservice/mtagtfsfeeds/camsys%2Fsubway-alerts.json`. GTFS-rt
  as JSON, about 1 MB. No key needed as of 2026-11-14.
- Alerts carry `active_period` and `informed_entity` (route/stop). Dedupe by id plus hash.

**MTA elevator & escalator outages** (`mta_elevator_outages`)
- `…/mtagtfsfeeds/nyct%2Fnyct_ene.json`. Fields: station, trainno, equipment,
  equipmenttype (EL/ES), serving, ADA, outagedate, estimatedreturntoservice.
- Quirks: dates are local-time strings like `12/16/2026 10:00:00 PM`, and the feed includes
  **planned future** outages. Records have no station id and an empty `borough`; join
  `equipment` → `equipmentno` in `nyct%2Fnyct_ene_equipments.json` (`elevatorsgtfsstopid`,
  `stationcomplexid`), then to `mta_subway_stations`. The `Content-Type` header is broken
  (`${header.s3FileType}`), so never branch on it. `estimatedreturntoservice` is an estimate,
  not an end time.

**MTA subway stations** (`mta_subway_stations`)
- data.ny.gov `39hk-dx4f`: `gtfs_stop_id`, `complex_id`, `stop_name`, `gtfs_latitude/longitude`,
  `borough` as `M/Bk/Q/Bx/SI`. Daily refresh is plenty. Pins alerts and outages to stations.

**MTA subway realtime** (`mta_subway_realtime`, Phase 5)
- Protobuf feeds per line group: `nyct%2Fgtfs` (1–7, S), `-ace`, `-bdfm`, `-g`, `-jz`, `-nqrw`,
  `-l`, `-si`. Parse with `gtfs-realtime-bindings`, and use static GTFS for stop locations.

**DOT real-time traffic speeds** (`dot_traffic_speeds`)
- Socrata dataset `i4gi-tjb9`. Fields: `speed`, `travel_time`, `encoded_poly_line`,
  `link_points`, `data_as_of`, `link_id`, borough.
- Build geometry from `encoded_poly_line` (Google polyline). `link_points` is **truncated**
  mid-coordinate. `data_as_of` is New York local with no offset.
- The polyline is published with every `|` escaped as two backslashes + `|`; undo that before
  decoding (otherwise ~1 in 4 links decodes outside NYC). Some polylines are themselves truncated.
- Publish batches overlap by minutes across links, so the cursor re-reads 15 min behind (a strict
  `>` lost 8–21% of readings live).
- Rows with a negative `status` (seen: -101) carry speed 0 / travel time 0 = no reading; they
  produce no observations. The feed lags ~2 h, so the first-run lookback is 4 h.
- Quirk: the newest row was about 2 h old at probe time, so label it "near-live".

### Water & weather
**FloodNet** (`floodnet_sensors`, `floodnet_events`, `floodnet_live`)
- About 400 ultrasonic street-flood sensors run by NYU, CUNY and NYC
  ([NYU news](https://engineering.nyu.edu/news/floodnet-nyc-reaches-400-sensors-providing-citywide-view-street-level-flooding)).
- Sensors: Open Data `kb2e-tjy3`. Location, borough, NTA, `tidally_influenced`,
  `lowest_point_height_delta_inches`.
- Events: Open Data `aq7i-eu5q`. One row per flood with `max_depth_inches`, onset, drain and
  duration times, and `flood_profile_depth_inches`. **Last updated 2026-11-02**, so it runs about 2
  weeks behind.
- Live: the dashboard at `dataviz.floodnet.nyc` uses the **FieldKit** API (`api.fieldkit.org`).
  Project list is public (NYC FloodNet = project **174**). The JS references `/sensors/data`,
  `/sensors/data/recently`, `/sensors/data/tail` and `/stations`, all undocumented.
  **Phase 1 spike:** confirm public read access and polling etiquette, ideally by contacting the
  FloodNet team. If no, the map shows events with a "data as of" label.
- **Event times are UTC**, not New York local like other Socrata data (verified 2026-11-15:
  tidal-sensor flood peaks land 29–61 min after NOAA Rockaway Inlet high tides when read as
  UTC). The `$where` cursor literal is UTC too. Some sensors have `date_removed`.

**NOAA tide gauge, The Battery** (`noaa_tide_battery`)
- CO-OPS datagetter, station `8518750`, `product=water_level` (6-min) plus `product=predictions`
  daily. Surge equals observed minus predicted. Datum MLLW, feet.

**NWS alerts** (`nws_alerts`)
- `https://api.weather.gov/alerts/active?area=NY` (GeoJSON). Filter by `geocode.SAME` ∈
  {036005, 036047, 036061, 036081, 036085}.
- NWS asks for a User-Agent with contact info. The default UA carries the repo URL;
  `NYCLIVE_USER_AGENT` overrides it.
- Expiration statements (VTEC EXP) arrive after the event, so `onset` > `ends`; they are skipped.
  The original alert then leaves the active feed and the pipeline closes it.
- Active alerts can be empty (221 bytes at probe time). Capture alert fixtures from
  `/alerts?area=NY` (recent, including expired) so tests have real features.

**Open-Meteo** (`openmeteo_current`)
- `api.open-meteo.com/v1/forecast` with comma-separated lat/lon for 5 borough points;
  `current=temperature_2m,precipitation,rain,wind_speed_10m&timeformat=unixtime`. Free for
  non-commercial use, no key.

### City services & safety (NYC Open Data / Socrata)
Base: `https://data.cityofnewyork.us/resource/<id>.json`, with SoQL params `$where`, `$order`,
`$limit`, `$offset`. An optional free `SOCRATA_APP_TOKEN` header (`X-App-Token`) raises limits.
Timestamps without an offset are **New York local**. Always send `$select`, a first-run lookback
and a page cap; each dataset's cursor column is in its registry notes.

| id | Dataset | Key field | Lag observed | Notes |
|---|---|---|---|---|
| `nyc_311` | `erm2-nwe9` 311 Service Requests | `unique_key` | 1–2 days, daily refresh | Don't cursor on `:updated_at` (bulk-rewritten). Two queries: new by `created_date` (re-read 1 h behind the cursor for ties/DST), closures by `closed_date` (up to 10 pages; the window held 28k rows live). Poll every 6 h. Known gap: ~0.15% of rows are inserted weeks after their `created_date` and are only caught if they close within the closed window |
| `nyc_collisions` | `h9gi-nx95` Motor Vehicle Collisions | `collision_id` | ~3 days | Some rows have no lat/lon. `crash_date` + `crash_time` are separate local fields |
| `dot_traffic_speeds` | `i4gi-tjb9` | `link_id` + `data_as_of` | ~2 h | See above |

## Phase 5 extras
| id | Endpoint | Auth | Status |
|---|---|---|---|
| `kalshi_nyc_high` | `api.elections.kalshi.com/trade-api/v2/markets?series_ticker=KXHIGHNY` | none | ✅ open markets returned (e.g. NOV15) |
| `opensky_nyc` | `opensky-network.org/api/states/all?lamin=40.4&lomin=-74.3&lamax=41.0&lomax=-73.6` | none (limited anon credits) | ✅ planes near EWR/LGA returned |
| `openaq_nyc` | `api.openaq.org/v3/...` | free key | ❌ 401 without key |
| `mta_bus_time` | Bus Time GTFS-rt | free key | not yet tested |
| `basemap_openfreemap` | `tiles.openfreemap.org/styles/positron` | none | ✅ |

## Candidates (not yet in registry; verify dataset ids first)
- NYC Open Data: **street closures** for construction, **permitted events**, **film permits**
  (explain empty or blocked cams), **restaurant inspections**, **DOB permits**, **rat sightings**
  (a 311 subset).
- **NYC flood hazard maps** (stormwater and coastal) as a static context layer.
- **Borough and NTA boundaries** (static GeoJSON).
- **USGS stream gauges** near NYC (Bronx River).

## Etiquette & terms (summary)
- Never poll faster than the registry cadence or a feed's TTL. Requests to the same host run one
  at a time.
- Attribute every source in the UI. Link to DOT camera images rather than rehosting archives
  publicly.
- Non-commercial use only (Open-Meteo, OpenSky, FloodNet expectations). Re-check terms before
  making the public demo.

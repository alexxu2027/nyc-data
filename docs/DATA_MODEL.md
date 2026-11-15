# NYC Live: Data Model

All times are **UTC** (`timestamp[us, tz=UTC]`). Coordinates are WGS84 `lat`, `lon`. Lines use
WKT `LINESTRING(lon lat, …)`. Everything source-specific that doesn't fit a column goes in
`props` (a JSON string).

## Shapes

### Entity: a located thing that persists
| column | type | notes |
|---|---|---|
| `source` | str | registry id, e.g. `citibike_station_status` → entity source is `citibike` (see ids below) |
| `entity_id` | str | stable id from the publisher |
| `kind` | str | `camera`, `bike_station`, `flood_sensor`, `tide_gauge`, `road_segment`, `subway_station`, `weather_point`, `elevator` |
| `name` | str | display name |
| `lat`, `lon` | float | point location (for lines, a midpoint) |
| `geometry_wkt` | str? | lines/polygons only |
| `borough` | str? | `MN`, `BK`, `QN`, `BX`, `SI` (normalized) |
| `props` | json | e.g. capacity, `tidally_influenced`, `isOnline` |
| `first_seen`, `last_seen` | ts | maintained by the collector |
**Key:** (`kind`, `entity_id`)

### Observation: a measurement of an entity at a time
| column | type | notes |
|---|---|---|
| `kind`, `entity_id` | str | FK to entity |
| `metric` | str | e.g. `bikes_available`, `ebikes_available`, `docks_available`, `water_level_ft`, `predicted_ft`, `speed_mph`, `temp_c`, `precip_mm`, `depth_in`, `count_car`, `count_person` |
| `observed_at` | ts | publisher's timestamp when available, else `fetched_at` |
| `value` | float | |
| `fetched_at` | ts | when we got it |
| `source` | str | registry id |
**Key:** (`kind`, `entity_id`, `metric`, `observed_at`). Written only when `value` changed (change-only).

### Event: something that happens, with a start and maybe an end
| column | type | notes |
|---|---|---|
| `source` | str | registry id |
| `event_id` | str | publisher id (311 `unique_key`, alert id, collision `collision_id`, FloodNet sensor+start) |
| `category` | str | `service_alert`, `elevator_outage`, `weather_alert`, `complaint_311`, `collision`, `flood` |
| `subtype` | str? | e.g. 311 `complaint_type`, NWS `event` ("Flash Flood Warning"), outage `equipmenttype` |
| `starts_at` | ts | |
| `ends_at` | ts? | null = ongoing/unknown |
| `lat`, `lon` | float? | some events have none (e.g. citywide alerts); then `geometry_wkt` or `entity_ref` |
| `geometry_wkt` | str? | NWS alert polygons |
| `entity_ref` | str? | `kind:entity_id`, e.g. `subway_station:A27` |
| `severity` | int 0–3 | normalized: 0 info · 1 minor · 2 moderate · 3 severe |
| `title` | str | one line for the feed |
| `props` | json | full original fields worth keeping |
| `payload_hash` | str | skip rewrite if unchanged |
| `updated_at` | ts | when we last changed it |
**Key:** (`source`, `event_id`). Upsert.

## Per-source mapping (Phase 1)
| Registry id | Writes | Entity kind / Event category | Main metrics / fields |
|---|---|---|---|
| `dot_cameras` | entities | `camera` | props: `isOnline`, `imageUrl` |
| `citibike_gbfs` (+ station_information) | entities | `bike_station` | props: capacity, region |
| `citibike_station_status` | observations | `bike_station` | `bikes_available`, `ebikes_available`, `docks_available`, `is_renting` |
| `mta_subway_alerts` | events | `service_alert` | subtype = alert type; `entity_ref` to routes/stops |
| `mta_elevator_outages` | events + entities | `elevator_outage` / `elevator` | `starts_at`=outagedate, `ends_at`=estimatedreturntoservice |
| `noaa_tide_battery` | entity + observations | `tide_gauge` | `water_level_ft`, `predicted_ft` (surge derived in queries) |
| `openmeteo_current` | entities + observations | `weather_point` (one per borough) | `temp_c`, `precip_mm`, `rain_mm`, `wind_kmh` |
| `nws_alerts` | events | `weather_alert` | subtype = event name; polygons; severity map |
| `floodnet_sensors` | entities | `flood_sensor` | props: `tidally_influenced`, `nta` |
| `floodnet_events` | events | `flood` | props: `max_depth_inches`, `duration_mins`, profile |
| `floodnet_live` | observations | `flood_sensor` | `depth_in` (if spike succeeds) |
| `nyc_311` | events | `complaint_311` | subtype = `complaint_type`; ends_at = `closed_date` |
| `nyc_collisions` | events | `collision` | severity from injured/killed counts |
| `dot_traffic_speeds` | entities + observations | `road_segment` | `speed_mph`, `travel_time_s` |

## Borough normalization
| Inputs seen | Code |
|---|---|
| `Manhattan`, `MANHATTAN`, `New York`, SAME `036061` | `MN` |
| `Brooklyn`, `BROOKLYN`, `Kings`, SAME `036047` | `BK` |
| `Queens`, `QUEENS`, SAME `036081` | `QN` |
| `Bronx`, `BRONX`, SAME `036005` | `BX` |
| `Staten Island`, `STATEN ISLAND`, `Richmond`, SAME `036085` | `SI` |
If no borough is given, derive it from lat/lon with a point-in-polygon against the NYC borough
boundaries (cached GeoJSON in `config/`).

## SQLite `state.db` tables
- `entities`: same columns as Entity. PK (`kind`, `entity_id`).
- `latest`: (`kind`, `entity_id`, `metric`) → `value`, `observed_at`.
- `events_open`: events with `ends_at IS NULL OR ends_at > now() - 1 day`, plus the last 7 days of
  311 and collisions for fast map queries.
- `source_health`: `source`, `last_attempt`, `last_success`, `last_error`,
  `consecutive_failures`, `rows_last_run`, `lag_s`.

## Archive layout
```
data/archive/source=<registry id>/table=<entities|observations|events>/date=YYYY-MM-DD/part-HHMMSS.parquet
data/archive/.../date=YYYY-MM-DD/compacted.parquet     (after nightly compaction)
```
Example DuckDB query (state of Citi Bike at 8:30 AM ET on a day):
```sql
SELECT entity_id, metric, value
FROM read_parquet('data/archive/source=citibike_station_status/table=observations/date=2026-11-17/*.parquet')
WHERE observed_at <= TIMESTAMPTZ '2026-11-17 13:30:00+00'
QUALIFY row_number() OVER (PARTITION BY entity_id, metric ORDER BY observed_at DESC) = 1;
```
(As-of queries near midnight UTC also read the previous day's partition.)

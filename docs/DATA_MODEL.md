# NYC Live: Data Model

All times are **UTC** (`timestamp[us, tz=UTC]`). Coordinates are WGS84 `lat`, `lon`. Lines use
WKT `LINESTRING(lon lat, …)`. Everything source-specific that doesn't fit a column goes in
`props` (a JSON string).

## Shapes

### Entity: a located thing that persists
| column | type | notes |
|---|---|---|
| `source` | str | registry id of the source that writes the entity |
| `entity_id` | str | stable id from the publisher |
| `kind` | str | `camera`, `bike_station`, `flood_sensor`, `tide_gauge`, `road_segment`, `subway_station`, `weather_point`, `elevator` |
| `name` | str | display name |
| `lat`, `lon` | float? | point location (for lines, a midpoint); null if the publisher gives none |
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
**Key:** (`kind`, `entity_id`, `metric`, `observed_at`). Written only when `value` changed (change-only), plus a daily keyframe (ADR-011).

### Event: something that happens, with a start and maybe an end
| column | type | notes |
|---|---|---|
| `source` | str | registry id |
| `event_id` | str | publisher id (311 `unique_key`, alert id, collision `collision_id`, FloodNet sensor+start) |
| `category` | str | `service_alert`, `elevator_outage`, `weather_alert`, `complaint_311`, `collision`, `flood` |
| `subtype` | str? | e.g. 311 `complaint_type`, NWS `event` ("Flash Flood Warning"), outage `equipmenttype` |
| `starts_at` | ts | |
| `ends_at` | ts? | null = ongoing/unknown |
| `lat`, `lon` | float? | some events have none (e.g. citywide alerts); then `geometry_wkt` or `entity_refs` |
| `geometry_wkt` | str? | NWS alert polygons |
| `entity_refs` | list[str] | `kind:entity_id` items, e.g. `subway_station:A27` (alerts can name many) |
| `borough` | str? | `MN`…`SI`; null = citywide or unknown, and passes every borough filter |
| `severity` | int 0–3 | normalized: 0 info · 1 minor · 2 moderate · 3 severe |
| `title` | str | one line for the feed |
| `props` | json | full original fields worth keeping |
| `payload_hash` | str | skip rewrite if unchanged |
| `updated_at` | ts | when we last changed it |
**Key:** (`source`, `event_id`). Upserted in `state.db`; in the archive, events are a version log
(one row per `payload_hash`), see ADR-011.

## Per-source mapping (Phase 1)
| Registry id | Writes | Entity kind / Event category | Main metrics / fields |
|---|---|---|---|
| `dot_cameras` | entities | `camera` | props: `isOnline`, `imageUrl` |
| `citibike_gbfs` (+ station_information) | entities | `bike_station` | props: capacity, region |
| `citibike_station_status` | observations | `bike_station` | `bikes_available`, `ebikes_available`, `docks_available`, `is_renting` |
| `mta_subway_stations` | entities | `subway_station` | `gtfs_stop_id`, `complex_id`, lat/lon, borough |
| `mta_subway_alerts` | events | `service_alert` | subtype = alert type; `entity_refs` to routes/stops |
| `mta_elevator_outages` | events + entities | `elevator_outage` / `elevator` | `starts_at`=outagedate; `ends_at` stays null while listed; `props.est_return` = estimatedreturntoservice; `props.upcoming` from `isupcomingoutage`. Join to stations via the equipments feed |
| `noaa_tide_battery` | entity + observations | `tide_gauge` | `water_level_ft`, `predicted_ft` (surge derived in queries) |
| `openmeteo_current` | entities + observations | `weather_point` (one per borough) | `temp_c`, `precip_mm`, `rain_mm`, `wind_kmh` |
| `nws_alerts` | events | `weather_alert` | subtype = event name; polygons; severity map |
| `floodnet_sensors` | entities | `flood_sensor` | props: `tidally_influenced`, `nta` |
| `floodnet_events` | events | `flood` | props: `max_depth_inches`, `duration_mins`, profile |
| `floodnet_live` | observations | `flood_sensor` | `depth_in` (if spike succeeds) |
| `nyc_311` | events | `complaint_311` | subtype = `complaint_type`; ends_at = `closed_date` |
| `nyc_collisions` | events | `collision` | instant event, `ends_at = starts_at`; severity from injured/killed counts; `crash_date` + `crash_time` are NY local |
| `dot_traffic_speeds` | entities + observations | `road_segment` | `speed_mph`, `travel_time_s`; geometry from `encoded_poly_line` (`link_points` is truncated) |

## Borough normalization
| Inputs seen | Code |
|---|---|
| `Manhattan`, `MANHATTAN`, `New York`, `M`, SAME `036061` | `MN` |
| `Brooklyn`, `BROOKLYN`, `Kings`, `Bk`, SAME `036047` | `BK` |
| `Queens`, `QUEENS`, `Q`, SAME `036081` | `QN` |
| `Bronx`, `BRONX`, `Bx`, SAME `036005` | `BX` |
| `Staten Island`, `STATEN ISLAND`, `Richmond`, SAME `036085` | `SI` |
Adapters set borough only through `model.borough_code()`. If none is given, the pipeline (not
the adapter) derives it from lat/lon with a point-in-polygon against the NYC borough
boundaries (cached GeoJSON in `config/`).

## SQLite `state.db` tables
- `entities`: same columns as Entity. PK (`kind`, `entity_id`).
- `latest`: (`kind`, `entity_id`, `metric`) → `value`, `observed_at`.
- `events_open`: events with `ends_at IS NULL OR ends_at > now() - 1 day`, plus the last 7 days of
  311 and collisions for fast map queries.
- `source_health`: `source`, `last_attempt`, `last_success`, `last_error`,
  `consecutive_failures`, `rows_last_run`, `lag_s`.
- `runs`: one row per job run: `source`, `started_at`, `finished_at`, `ok`, `bytes`,
  `rows_written`, `error`. Also archived under `source=_collector/table=runs`. Replay gaps come
  from this table (ADR-011).

## Archive layout
```
data/archive/source=<registry id>/table=<entities|observations|events>/date=YYYY-MM-DD/part-HHMMSS-<run id>.parquet
data/archive/.../date=YYYY-MM-DD/compacted.parquet     (after nightly compaction)
```
Example DuckDB query (state of Citi Bike at 8:30 AM ET on a day):
```sql
SELECT entity_id, metric, value
FROM read_parquet('data/archive/source=citibike_station_status/table=observations/date=2026-11-17/*.parquet')
WHERE observed_at <= TIMESTAMPTZ '2026-11-17 13:30:00+00'
QUALIFY row_number() OVER (PARTITION BY entity_id, metric ORDER BY observed_at DESC) = 1;
```
Write semantics (partition date, daily keyframes, event versions, crash safety, schema evolution)
are fixed by ADR-011 in DECISIONS.md. Because each source writes a keyframe on its first run of
each UTC day, an as-of query reads `date(t)` and `date(t)+1` (late data) and dedupes on the
natural key. It never needs earlier days.

## Adapter contract v1
Frozen at Gate A (ROADMAP 1A). Builders in 1B code against this verbatim; only the conductor
changes it.

```python
# sources/base.py
@dataclass(frozen=True)
class RawPart:
    name: str              # "body", "station_status", "page-000"
    url: str
    content: bytes         # exact response body
    fetched_at: datetime   # tz-aware UTC

@dataclass(frozen=True)
class RawPayload:
    source_id: str
    parts: tuple[RawPart, ...]
    cursor: str | None = None              # cursor this fetch started from
    def part(self, name: str = "body") -> RawPart: ...
    def json(self, name: str = "body") -> Any: ...
    @property
    def fetched_at(self) -> datetime: ...  # newest part
    def save(self, case_dir: Path) -> None: ...
    @classmethod
    def load(cls, case_dir: Path) -> "RawPayload": ...

@dataclass(frozen=True)
class FetchContext:
    source: Source         # registry entry
    http: Http             # the only way an adapter touches the network
    cursor: str | None     # last committed cursor, None on first run
    now: datetime          # injected UTC; adapters never call datetime.now()

@dataclass
class Batch:
    entities: list[Entity] = field(default_factory=list)
    observations: list[Observation] = field(default_factory=list)
    events: list[Event] = field(default_factory=list)
    cursor: str | None = None               # committed only after the batch is stored
    complete: frozenset[str] = frozenset()  # subset of {"entities", "events"}: payload is the full current set

# each adapter module
SOURCE_IDS: tuple[str, ...]
def fetch(ctx: FetchContext) -> RawPayload: ...   # network only; may page; builds no records
def parse(raw: RawPayload) -> Batch: ...          # pure, deterministic; dispatch on raw.source_id

# http.py
class Http:
    def get(self, url: str, *, params: Mapping[str, str] | None = None,
            headers: Mapping[str, str] | None = None) -> httpx.Response: ...
    # raises HttpError after retries; 2 s gap per host (thread-safe); honors Retry-After; sets the UA
```

**Records** (adapter-facing; storage adds `first_seen`, `last_seen`, `payload_hash`, `updated_at`):
```python
@dataclass(frozen=True)
class Entity:
    source: str; kind: str; entity_id: str; name: str
    lat: float | None; lon: float | None
    geometry_wkt: str | None = None; borough: str | None = None
    props: Mapping[str, Any] = field(default_factory=dict)

@dataclass(frozen=True)
class Observation:
    source: str; kind: str; entity_id: str; metric: str
    observed_at: datetime; value: float; fetched_at: datetime

@dataclass(frozen=True)
class Event:
    source: str; event_id: str; category: str; title: str
    starts_at: datetime; ends_at: datetime | None = None
    subtype: str | None = None; severity: int = 0
    lat: float | None = None; lon: float | None = None
    geometry_wkt: str | None = None; borough: str | None = None
    entity_refs: tuple[str, ...] = ()
    props: Mapping[str, Any] = field(default_factory=dict)
```

**Record rules**
- Datetimes are tz-aware UTC, built only through `nyclive.timeutil`: `parse_iso_utc`,
  `from_epoch`, `local_to_utc(s, fmt)` (America/New_York; an ambiguous time takes the first
  occurrence).
- `value` is a finite float. Booleans are 0.0/1.0. A missing value means no row.
- `kind`, `metric`, `category` come from `model.KINDS` / `METRICS` / `CATEGORIES`. Builders propose
  additions in their handback; only the conductor edits `model.py`.
- `props` is JSON-serializable, about 2 KB at most per record. Adapters never compute hashes.
- Severity defaults: NWS Extreme/Severe 3, Moderate 2, Minor 1, Unknown 0; collisions killed 3,
  injured 2, else 1; 311 is 0.
- Adapters may import only stdlib, `nyclive.model`, `nyclive.timeutil`, `nyclive.sources.base`,
  `nyclive.sources._socrata`. No httpx, storage or settings.

**Fixtures and tests**
```
tests/fixtures/<registry id>/<case>/meta.json    # source_id, captured_at, cursor, parts[{name, url, file}], note
tests/fixtures/<registry id>/<case>/<part>.json  # exact bytes
tests/sources/test_<module>.py
tests/helpers.py                                 # load_fixture(source_id, case="real") -> RawPayload
                                                 # assert_valid_batch(batch, source_id)
tests/test_adapters_conformance.py               # conductor-owned; iterates the registry
```
- Cases are `real` (from `nyclive capture`) and `edge_<what>` (hand-derived; the change is
  described in `meta.note`). Each case is ≤ 256 KB: trim arrays, keep the envelope.
- `assert_valid_batch` checks enums, UTC awareness, borough codes, coordinates inside an NYC
  bounding box or None, unique keys within the batch, serializable props, and that parsing twice
  gives equal output.

**Registry:** `Source` gains `adapter: str | None` and optional `max_lag_s` (dataclass first, then
yaml, or loading fails). `adapter` is null for `dot_camera_image`, `basemap_openfreemap`,
`floodnet_live` (until the spike) and all Phase 5 sources. "Collected source" means `adapter` is set.

**Module → registry ids**
| Module | Registry ids | Package |
|---|---|---|
| `noaa_tides` | `noaa_tide_battery` | 1A reference |
| `citibike` | `citibike_gbfs`, `citibike_station_status` | 1A reference |
| `openmeteo` | `openmeteo_current` | B1 |
| `nws_alerts` | `nws_alerts` | B1 |
| `dot_cameras` | `dot_cameras` | B2 |
| `mta_stations` | `mta_subway_stations` | B3 |
| `mta_alerts` | `mta_subway_alerts` | B3 |
| `mta_elevators` | `mta_elevator_outages` | B3 |
| `floodnet` | `floodnet_sensors`, `floodnet_events` | B4 |
| `nyc_311` | `nyc_311` | B5 |
| `nyc_collisions` | `nyc_collisions` | B5 |
| `dot_speeds` | `dot_traffic_speeds` | B6 |

**Fan-out rules:** builders touch only their module(s), fixture dirs and test file. They never
edit `model.py`, `base.py`, `cli.py`, `sources.yaml` or the docs; proposed changes go in the
handback. The conductor captures all `real` fixtures before fan-out, so builders make no network
calls.

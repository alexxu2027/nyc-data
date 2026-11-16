# NYC Live: Architecture Decision Records

Format: context → decision → consequences. Add new ADRs at the bottom. Mark superseded ones
rather than deleting them.

## ADR-001: Separate project from Tandem (2026-11-14)
**Context:** Tandem (Citi Bike prediction) overlaps on data, but it is a separate class group
project with its own stack and constraints.
**Decision:** NYC Live is its own repo, `~/nyc-live`. It may share *data files* with Tandem later,
never code dependencies.
**Consequences:** freedom to use a heavier stack here without burdening teammates.

## ADR-002: Python backend, uv, Python 3.12 (x64 build) (2026-11-14)
**Context:** The laptop is Windows on ARM (Snapdragon X Elite). uv has Python 3.12 x86_64
installed, which runs emulated. Native ARM64 Python is faster, but the CV wheels (OpenCV,
sometimes PyTorch) are less reliable there.
**Decision:** use uv with Python 3.12 (currently the x64 build) for everything. Revisit native
ARM64 when Phase 4 starts if CPU inference is too slow.
**Consequences:** maximum wheel compatibility. Some CPU performance lost to emulation, which
matters only for CV.

## ADR-003: SQLite (WAL) for latest state (2026-11-14)
**Context:** the live map needs fast "current value" reads while collectors write. Postgres/PostGIS
would need Docker on Windows ARM.
**Decision:** SQLite in WAL mode: one writer (collector/CV via storage module), many readers (API).
Spatial filtering is done in Python (bbox) or with simple lat/lon indexes.
**Consequences:** zero ops. If spatial queries get heavy, move to DuckDB spatial or PostGIS later.

## ADR-004: Parquet archive plus DuckDB for history (2026-11-14)
**Context:** history is append-only, large, and queried by time range (replay and analysis).
**Decision:** hive-partitioned Parquet (`source=/table=/date=`), small part files per run, nightly
compaction. Query with DuckDB in-process. Write semantics are pinned in ADR-011.
**Consequences:** cheap storage, easy to copy or share. The same files open in pandas, notebooks
or Tableau. No database server.

## ADR-005: React + Vite + TS + MapLibre (2026-11-14)
**Context:** a portfolio UI needs a polished map with many toggleable layers and no paid keys.
**Decision:** MapLibre GL JS with an OpenFreeMap basemap (keyless, verified). Use native MapLibre
layers first, and add deck.gl only for heavy layers (trains, heatmaps, replay animation). Zustand
for state.
**Consequences:** no Mapbox token or billing. A standard, recognizable stack for reviewers.

## ADR-006: Polling, not WebSockets, for live updates (2026-11-14)
**Context:** source cadences are 60 s to 24 h. Real push adds complexity.
**Decision:** the frontend polls each visible layer at max(its cadence, 30 s) with ETags.
**Consequences:** simple and cacheable. SSE can be added later without changing the data model.

## ADR-007: The MVP must be keyless (2026-11-14)
**Context:** the portfolio demo should be reproducible by anyone, and the probe showed all
Phase 1–4 sources work without keys.
**Decision:** Phases 1–4 use keyless sources only (enforced by a test). Keys (OpenAQ, Bus Time,
Socrata token) are optional extras loaded from `.env`.
**Consequences:** `git clone && uv sync && nyclive collect` works for anyone.

## ADR-008: Count per frame; don't track (2026-11-14)
**Context:** DOT frames are 352×240 at roughly 1 frame per 2 s. Objects move too far between
frames for trackers like ByteTrack.
**Decision:** CV produces per-frame class counts inside an ROI, sampled every 30 s. Trends come
from aggregating many samples.
**Consequences:** no speeds, trajectories or line-crossing counts from DOT cams. Those would need a
higher-FPS source such as YouTube intersection streams (possible later add-on).

## ADR-009: Hosting (open, decide in Phase 3)
**Options:** (a) RTX 3050 PC always on, plus Cloudflare Tunnel for the API, with the frontend on
Cloudflare Pages. Free, and the GPU is available for CV, but home uptime and power are risks.
(b) A small VPS (about $5/mo) for collectors and API. Reliable, but CPU-only CV.
(c) Hybrid: VPS collects 24/7, the PC runs CV.
**Leaning:** (a) to start, adding (b) if uptime under 95%.

## ADR-010: FloodNet live data (decided 2026-11-15 after the Phase 1 spike)
**Context:** Open Data events lag about 2 weeks. The live dashboard uses the undocumented FieldKit
API (project 174, public project list).
**Criteria set in Phase 0:** use FieldKit only if public read is confirmed and polling at 5 min is
acceptable (ideally confirmed with the FloodNet team). Otherwise use events only, labeled "as of".
**Spike findings (25 min, keyless):**
- Public read works with no key. `GET api.fieldkit.org/projects/174/stations` lists 496 stations
  (1.1 MB); 422 had updated in the last day.
- `GET /sensors/data/tail?stations=<ids>` returns readings per station: `time` (epoch ms),
  `sensorId`, `avg/min/max/last`. Sensor 44 = `wh.floodnet.depth` (inches, per `GET /sensors`).
  The newest reading was ~5 min old.
- Each response always carries the last 48 h (`bucketSize` 172800). 50 stations per request =
  1.3 MB in 15 s, so all stations take ~10 requests and ~13 MB.
- `/sensors/data/recently` returned empty windows.
- At a 5 min cadence that is ~3.7 GB/day from an undocumented API run by a research project.
**Decision:** don't poll FieldKit for now. The map shows Open Data flood events labeled "data as
of". `floodnet_live` stays without an adapter.
**Revisit if** the FloodNet team says polling is fine. Ready design: batches of 50 stations every
30 min (the 48 h window means nothing is lost), depth only, change-only writes. That is ~600 MB
a day of transfer, but small to store.
**Consequences:** flood sensors show live locations and status, but depth arrives about 2 weeks
late until the team agrees. The owner may email the FloodNet team.
**Update 2026-11-16: the FloodNet team OK'd polling** (the owner emailed them). The revisit
condition is met. The plan is the "ready design" above: batches of 50 stations every 30 min,
depth only, change-only writes, as a `floodnet_live` adapter. It is not built yet.

## ADR-011: Archive write semantics (2026-11-14)
**Context:** Parquet is append-only, but observations are change-only and events are "upserted".
Replay needs state as of t from one or two day partitions, and needs to know when collectors were
down. Feeds like MTA alerts and elevator outages drop items when they end instead of closing them.
**Decision:**
1. The partition `date` is the UTC date of `fetched_at`. A closed day is never appended to again.
2. Observations are change-only plus a **daily keyframe**: the first successful run of a source
   each UTC day writes every current (kind, entity_id, metric), changed or not. As-of t reads
   date(t) and date(t)+1 (late data), keeps `observed_at <= t`, and takes the newest row per key.
3. Archived events are a version log: one row per (source, event_id, payload_hash). "Upsert"
   applies to `state.db` only, which holds the current version.
4. When a batch is marked complete for events, the pipeline closes any open event of that source
   that is missing from it (`ends_at = fetched_at`, `props.closed_reason = "left_feed"`) and writes
   a new version.
5. Every job run appends a row to `runs` in `state.db`: source, started_at, finished_at, ok,
   bytes, rows_written, error. `compact` exports each closed day to the archive as
   `source=_collector/table=runs` (one file per day, not one per run). Replay gaps come from this
   table. *(Amended 2026-11-14 while building step 6: per-run runs files would have added ~1,440
   tiny files per source per day.)*
6. Write order per run: Parquet part (temp file, then rename to `part-HHMMSS-<run id>.parquet`),
   then one SQLite transaction (state, cursor, health, run). A crash in between can leave duplicate
   rows, so archive reads always dedupe on the natural key and `compact` rewrites a day deduped.
   Compaction is idempotent and tolerates files it can't delete yet (Windows file locks). A day
   counts as closed 1 h after UTC midnight, so runs that started before midnight have finished.
   The collector also compacts the open day hourly (measured: as-of over 1,440 one-minute parts
   took 2.9 s, over one compacted file 0.3 s); new parts keep landing beside `compacted.parquet`
   and the next compaction merges them.
7. New columns must be nullable. Never rename or retype. Readers use `union_by_name`. Files use
   zstd.
**Consequences:** keys are unique within a date partition after compaction, not across days.
Keyframes cost about one full snapshot per source per day, which is small next to the change rows.

## ADR-012: Layer catalog and style contract (2026-11-15)
**Context:** Phase 2 adds 14 map layers. The API, the layer panel, the legends, the filters and
the map renderer all need the same facts about each layer, and three builders worked on them in
parallel. Spreading those facts across Python and TypeScript would let them drift.
**Decision:**
1. `config/layers.yaml` (schema `version: 1`) is the single source of truth for what the UI shows:
   basemaps, initial view, boroughs, groups, and per layer `id`, `label`, `short`, `group`,
   `kind`, `sources`, `default`, `poll_s`, `z`, `borough_filter`, `list`, `detail`,
   `attribution`, `lag_note`, `empty_text`, `filters`, `style`, `legend`.
2. The API validates it at startup (`api/catalog.py`, problems name the layer and key) and serves
   it at `/api/layers` with defaults filled in. `classify` (server-side bucketing rules) is
   stripped from the response.
3. Styles are declarative, not MapLibre JSON: a value is `{value}`, `{prop, scale:
   interpolate|step|match, stops, base?, default?}` or `{zoom: [[z, w], …]}`, and colours are
   `#rrggbb` or the theme tokens `ink | paper | muted`. The web app turns them into MapLibre
   expressions (`web/src/map/styleToPaint.ts`) and resolves tokens per theme, so a theme swap
   needs no catalog change. Ramps are colour-blind safe (Okabe-Ito, viridis, ColorBrewer RdYlBu).
4. Filters are `enum | select | toggle`, applied `client` (on feature properties) or `server`
   (sent as `f.<key>=`, validated against the declared options). The URL carries them (ADR-005
   URL state).
5. Every layer must have an attribution and a legend; the catalog loader rejects one without.
6. The TypeScript shape is frozen in `web/src/types.ts`. Adding a key means adding it to the
   loader, `types.ts` and this ADR together; never rename or retype a key within `version: 1`.
**Consequences:** a new layer is mostly YAML plus one API builder (`api/layers/`) and one map
renderer. Map styling is limited to what the declarative scales express; anything richer (pulses,
clusters, halos, icons) lives in the per-layer renderer, keyed by layer id.

## ADR-013: Phase 2.5 liveness: trains, radar, flood depth, changes (2026-11-16)
**Context:** Phase 2.5 makes live data visible: FloodNet depth, rain radar, moving subway trains
and a "what changed" feed. The frozen contracts (adapter v1, catalog v1) must carry them without
a rewrite, and the archive must stay small (about 48 MB/day measured before trains).
**Decision:**
1. **Trains are per-trip events.** The `mta_trains` adapter emits one event per trip
   (`start_date:trip_id`, category `train`) whose props (`route`, `dir`, `stop`) change only when
   a train passes a stop, so change-only archiving costs about 20–26 MB/day (a test in U2 gates
   this). The API builds positions; the client animates between polls. Track geometry lives in
   the committed `config/subway_static.json`, built by `scripts/build_subway_static.py`.
2. **Stdlib GTFS-rt decoder.** `nyclive.sources._gtfsrt` is a small protobuf wire decoder (feed,
   trip update, vehicle position, NYCT extension 1001), so there is no new dependency and
   adapters stay pure. DATA_MODEL allows importing it.
3. **Raster layers.** Catalog `kind: raster` carries a `raster` block `{index_url, tiles, frames,
   tile_size, max_zoom, opacity, stale_s}`. Raster layers have no sources, no builder and no
   `/api/layers/{id}` (404); the client polls the frame index and loads tiles directly. Style is
   optional, filters are empty.
4. **`changes` key.** A point or cluster layer may declare `changes: {props: [str], new: bool}`.
   On each 200 poll the client diffs the listed props per feature id (and, if `new`, counts new
   ids) to give `changedIds`, which drive the change pulse. First load yields none.
5. **Feed endpoint.** `GET /api/changes?hours=&limit=` lists recent changes from the events of
   NWS alerts, unplanned subway alerts, elevator outages and FloodNet episodes, ordered by
   `events.first_seen`, with ETag and 304.
6. **Hooks.** Renderers may return `live(ctx)` for per-frame work (trains, radar); the
   controller calls `update(features, visible)` and `destroy()`.
7. Catalog schema stays `version: 1`: new keys (`raster`, `changes`) default to `null`, and
   `types.ts`, the loader and this ADR changed together (ADR-012 item 6).
**Consequences:** subway trains rely on a built static file (the layer says "STATIC GTFS NOT
BUILT" without it). The pipeline loads every open trip row each 30 s; if that is slow it needs a
pipeline change after the soak. Radar is coarse at street zoom. FloodNet depth lags up to 45 min.

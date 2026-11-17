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

## ADR-014: Close grace for complete feeds; quiet train lines are valid (2026-11-16)
**Context:** review findings #8 and #10 (`.orchestrate/p25/review.md`).
- A complete feed closes every open event missing from a run. For trains that meant a trip
  dropping out of one 30 s poll was closed and reopened: 2 archive rows, and the dot jumped back.
- The trains adapter rejected a line-group feed with no vehicles. That happens legitimately
  during a weekend shutdown, so one quiet line failed every run and took all lines off the map.

**Decision:**
1. A registry field `close_grace_s` (default None, meaning close at once). The pipeline keeps a
   missing event open while `fetched_at - last_seen < close_grace_s`. Once missing for longer, it
   closes once with `ends_at = last_seen` (when it really left), not the fetch that noticed.
   `mta_subway_realtime` uses 75 s (2.5 polls).
2. `mta_trains` accepts a quiet feed whose header is fresh: that line has no trips. A missing
   feed and a stale or absent header are still rejected. The grace keeps one glitchy empty
   poll from closing a line's trips.

**Consequences:** a vanished trip stays drawn for up to 75 s, within the trains layer's 120 s
window anyway. Other complete feeds are unchanged until they opt in. The old `bad_empty_feed`
fixture is now `edge_quiet_line`. The cancel-before-start trip test now closes on its 4th
poll. Archive semantics (ADR-011) are otherwise unchanged.

## ADR-015: Notify NYC alerts as a city alert layer (2026-11-16)
**Context:** the city publishes some layers days late (research:
`docs/research/late-data-alternatives.md`). Notify NYC (NYC Emergency Management) publishes its
live alerts as a keyless CAP RSS. It's the official, near real time "Citizen-style" source.
Plan: `.orchestrate/notify/plan.md`.

**Decision:**
1. Source `notify_nyc`: the RSS (only the alerts active now, one item per language) plus each
   **English** item's CAP 1.2 file. It's a complete set every 2 min, and an empty channel is
   normal. Category `city_alert`.
2. Geometry:
   - A CAP polygon or circle becomes WKT.
   - **Citywide** alerts (a polygon covering ≥ 60% of the city bbox) get none: a city-sized
     shape would hide every other layer. The areaDesc doesn't decide it (amended 2026-11-16,
     see Findings).
   - **No geocoding:** places named only in text stay off the map. GeoSearch, the keyless
     option, can't resolve intersections.
   - Never a borough outline for a street-level incident (unlike NWS, whose alerts really
     are county-wide).
3. API layer `city_alerts` (Streets & safety), drawn with the NWS polygon renderer and severity
   colours. Alerts that can't be drawn count as `unlocated` and are in the list.
4. CHANGES gets a new kind **`notice`** (label CITY), amending ADR-013's frozen
   `ChangeItem['kind']` union. A Cancel isn't listed. An item points at its own polygon or
   nowhere.
5. A Cancel ends when it was sent. An Update is its own event (the alert it replaces leaves the
   feed and is closed), with `references` kept.

**Findings from real captures** (amended 2026-11-16, first watcher capture, `edge_five_counties`):
- A GWB crash ("Traffic Delays - George Washington Bridge") came with **no polygon** and an
  areaDesc naming **all five counties**. So "all five counties" is how Notify NYC addresses
  everything, not a sign of a citywide alert. Now: citywide only by polygon size, and a
  title tag like "(BX)" beats a five-county areaDesc for the borough.
- It was a SAME "Civil Emergency Message" at severity **Extreme**, as was the Jul 14 air-quality
  alert (Severe). CAP's event and severity carry no signal here. For generic CEM alerts the type
  comes from the headline ("Traffic Delays"), and the severity is a flat 2. CAP's own severity
  stays in props.

**Status:** adapter, API pieces and frontend are built and tested on fixtures (3 real: 2 from the
Wayback Machine, 1 watcher capture; the rest synthetic).
- **Go-live switch:** registry `adapter: notify_nyc`, the `city_alerts` catalog entry and its
  `BUILDERS` line, all together at a collector restart.
- **Waiting on:** more watcher captures (1 so far, with no polygon), to record here how many
  alerts carry a local polygon.

**Consequences:** if most real alerts turn out to be text-only, the layer is mainly a list and
CHANGES source. Geocoding would need a key (ADR-007), so that's a separate decision.

## ADR-017: 3D buildings, the sun and computed shadows (2026-11-17)
**Context:** Alex asked for 3D buildings, the sun's place in the sky and the shadows it casts.
Plan and research: `docs/research/3d-sun-shadows.md`.

**Decision:**
1. **No new data:** building heights come from the basemap tiles we already load
   (OpenMapTiles `building`: `render_height`, `render_min_height`, `hide_3d`). The sun is
   computed (NOAA formulas, `web/src/core/sun.ts`). Keyless, so ADR-007 holds.
2. **3D follows the tilt; SUN is a view mode** (amended 2026-11-17, after Alex found a 3D
   button awkward):
   - As in Apple Maps on a phone, tilting past 8° fades the buildings in (solid by 25°), and
     flattening fades them out. There is no button.
   - SUN is a map control (URL `sun=1`). Neither is a catalog layer.
   - **Gestures**, after Apple Maps (twist rotates, Option + arrows) and Google Maps (Ctrl+drag):
     - drag pans; scroll or pinch zooms;
     - Ctrl + two-finger scroll tilts (Ctrl must be physically held: a trackpad pinch also
       sets ctrlKey, and stays zoom), as do Alt/Option + scroll and two fingers up on touch;
     - Shift + scroll or Option + ←/→ rotates, and so does a twist on touch and in Safari
       (Chrome, Edge and Firefox don't report a trackpad twist; a sideways-swipe stand-in was
       tried and dropped because it made scrolling janky);
     - right- or Ctrl-drag does both;
     - N sets north up and flat. The map always opens top-down: tilt and rotation aren't
       kept in links (2026-11-17).

     Browsers don't expose a trackpad tilt gesture, so tilt needs a modifier (`map/gestures.ts`).
3. **The style light follows the sun** when SUN is on.
4. **Shadows are computed in the browser and rasterised:** each visible building's footprint
   is swept away from the sun by height × cot(altitude), drawn on one canvas (so overlaps
   merge), and shown as a raster under the extrusions and data. MapLibre has no cast shadows,
   and the libraries that do are keyed or heavy (research note).

5. **Lighting follows the sun: theme AUTO** (amended 2026-11-17):
   - The theme control cycles LIGHT → DARK → AUTO (URL `theme=auto`). AUTO shows light by day
     and dark at night, from the sun at the map centre: dark below −4°, light above −2°, and
     in between it keeps the current theme so it can't flicker. It also turns SUN on.
   - Switches fade. The page's colour tokens are registered `@property` colours, so they
     transition over 1.2 s (after the first paint, never with reduced motion). The basemap
     swap crossfades under a snapshot of the old map (`map/xfade.ts`). Map tokens are fixed
     per theme, not read from the mid-fade CSS.
   - Dark mode draws the sunlit ground as a faint warm glow; shadows darker than the dark map
     didn't show.
   - Light mode dims every basemap colour toward a warm off-white (`basemap.dimColor`).

**Consequences:** shadows are an estimate (OSM heights, no trees or terrain, ground and lower
roofs only). They cost a recompute per settled move and per minute at z ≥ 15. Phase 3 replay
can drive the sun from its time bar.

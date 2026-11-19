# NYC Live: Roadmap

Each phase has a goal, tasks, and **acceptance criteria**. A phase is done only when every
criterion is met. Keep the scope inside the phase, and put new ideas in the "Later" list at the
bottom.

---

## Phase 0: Foundations ✅ (2026-11-14)
- [x] PRD, architecture, data model, data sources, decisions, dev setup docs
- [x] Source registry `config/sources.yaml` (21 sources; 22 with `mta_subway_stations`, added in the 2026-11-14 plan review)
- [x] `nyclive sources`, `nyclive probe` with JSON report
- [x] Registry tests (offline) plus a live probe test (`-m live`)
- [x] Probe: 19 of 21 healthy, 2 skipped because they need keys

**Accepted:** `uv sync && uv run pytest && uv run nyclive probe` all succeed.

---

## Phase 1: Collectors & archive ✅ (2026-11-17)
**Goal:** every Phase 1 source is polled on schedule, normalized and archived, so history starts
accumulating.

Phase 1 has three stages. 1A builds one thin path end to end, so the adapter contract is tested
on real data before it is copied 11 times. 1B fans out the remaining adapters. 1C is hardening;
the soak test is wall-clock time, so Phase 2 scaffolding may start while it runs.

### 1A. Walking skeleton (sequential; ends with collectors running)
1. ✅ Housekeeping (2026-11-14): `.python-version` (3.12), `.gitattributes` (LF, fixtures binary),
   pyarrow / duckdb / apscheduler (<4) / tzdata moved into core deps, keyless test covers Phases 1–4,
   MIT LICENSE, public repo.
2. ✅ (2026-11-14) `settings.py`, `timeutil.py` (`parse_iso_utc`, `parse_naive_utc`, `from_epoch`,
   `local_to_utc`), `http.py`
   (tests use `httpx.MockTransport`).
3. ✅ (2026-11-14) `model.py` (records, `KINDS` / `METRICS` / `CATEGORIES`, `borough_code`, Arrow schemas) and
   `sources/base.py`, exactly as DATA_MODEL "Adapter contract v1".
4. ✅ (2026-11-14) `nyclive capture <source> [--part name=url ...] [--case real]` and `tests/helpers.py`
   (`load_fixture`, `assert_valid_batch`).
5. ✅ (2026-11-14) Reference adapters, written by hand: `noaa_tides` (cursor, entity + observations) and
   `citibike` (multi-part, change-only, sentinel).
6. ✅ (2026-11-14) `storage/state.py`, `storage/archive.py`, `collect/pipeline.py` (`run_once`: fetch → parse →
   write, per ADR-011).
7. ✅ (2026-11-14) `collect/scheduler.py`, `nyclive collect [--only ids] [--once] [--keep-awake]`, `nyclive status`.

**Gate A ✅ passed 2026-11-15 03:04 UTC** (`scripts/gate_a.py`: 77/77 runs, 1.27 h, 2,519
stations as-of in 0.27 s, keys unique after a real kill/restart). Criteria: `nyclive collect --only noaa_tide_battery citibike_gbfs citibike_station_status` runs
1 h, the restart test passes, and an as-of DuckDB query returns ≥ 2,000 Citi Bike stations for a
chosen minute. Leave it running from here. The adapter contract is now frozen as v1.

### 1B. Remaining adapters (parallel-safe; builders work offline)
8. ✅ (2026-11-15) Conductor: `sources/_socrata.py` (paging, `$select`, lookback, page cap); capture `real` fixtures for every remaining source.
9. ✅ (2026-11-15) Packages, each owning only its module(s), `tests/fixtures/<id>/` and
   `tests/sources/test_<module>.py`:
   - B1 `openmeteo`, `nws_alerts`
   - B2 `dot_cameras`
   - B3 `mta_stations`, `mta_alerts`, `mta_elevators`
   - B4 `floodnet` (sensors, events)
   - B5 `nyc_311`, `nyc_collisions`
   - B6 `dot_speeds`

   Run B1 alone first as a pilot of the workflow (`/orchestrate` Tier 2), then the rest in parallel.
10. ✅ (2026-11-15) Conductor: set `adapter:` in the registry, extend enums from builder handbacks, run
    `nyclive collect --once --only <id>` live for each, update DATA_SOURCES.

**Gate B ✅ passed 2026-11-15 03:39 UTC** (42/42 conformance checks for 14 sources; all 14 in the
running collector, live runs ok). Criteria: the conformance test is green for every source with an adapter, and all of them are in
the running collector.

### 1C. Hardening
11. ✅ (2026-11-15) `nyclive compact` (idempotent; runs at startup and daily for closed days; the
    collector also compacts the open day hourly).
12. ✅ (2026-11-15) **Spike (time-boxed to 2 h):** FloodNet live via FieldKit project 174.
    Outcome in ADR-010: public read works, but full polling is too heavy for an undocumented API
    without the FloodNet team's OK, so it is not adopted for now.
13. ⏳ (running since 2026-11-15 01:48 UTC) Soak test (see criteria). `scripts/soak_report.py`
    checks it and measures storage and CPU; the final numbers replace ARCHITECTURE §5.

**Acceptance criteria**
- [x] (2026-11-15: 42/42 for 14 sources, `tests/test_adapters_conformance.py`) Conformance test: every registry source with `adapter` set has `tests/fixtures/<id>/real/`
  and at least one `edge_*` case (edge cases may be hand-derived from a real capture, noted in
  `meta.json`), and `parse()` passes `assert_valid_batch`.
- [x] (`test_restart_after_crash_leaves_no_duplicates_after_compact`; also a real kill/restart
  at Gate A) Restart test: run the pipeline on a fixture, crash after the archive write and before the
  state commit, rerun, compact. Zero duplicate natural keys through archive reads and in the
  compacted file.
- [x] (`test_failing_source_degrades_and_backs_off_others_keep_writing`) Isolation test: a fake adapter that always raises goes `degraded`; the other sources keep
  writing.
- [x] (PASS 2026-11-17 01:56 UTC: 48.1 h in one unbroken span crossing two midnights, all
  sources ≥ 95% ok, no gaps; `scripts/soak_report.py`) Soak: 48 h of `nyclive collect --keep-awake` in total, including at least one unbroken 24 h
  run (it must cross a UTC midnight). From `runs`, every source has ≥ 95% successful scheduled runs
  while the collector was up, and the process never exits on its own.
- [x] `nyclive status` prints last success, consecutive failures, rows in last run and data lag per
  source.
- [x] (soak: 3.3 MB on the first full ordinary day, 7.6 MB on the day with the 311 backfill;
  one file per closed partition; CPU 0.05% of the machine) Measured archive growth ≤ 150 MB/day after compaction, one file per closed day partition, and
  collector CPU < 5% average. Measured numbers replace the estimates in ARCHITECTURE §5.
- [x] (Gate A: 2,519 stations in 0.27 s) As-of smoke: Citi Bike state at a chosen minute comes from one day partition, ≥ 2,000
  stations, < 2 s.

---

## Phase 2: Live map (MVP) ✅ (2026-11-16)
**Goal:** a reviewer opens the app and sees a live, filterable NYC map.

Tasks:
1. `config/layers.yaml`: layer catalog (group, kind, style, legend, filters, attribution).
2. FastAPI `serve`: `/api/health`, `/api/layers`, `/api/layers/{id}`, `/api/entities/...`,
   `/api/events`. GeoJSON builder and bbox/borough filters. Tests with TestClient on fixtures.
3. `web/`: Vite + React + TS scaffold, MapLibre with an OpenFreeMap basemap, dark theme.
4. Layer panel with toggles, freshness dots, counts, filter sections. URL state.
5. Layers: cameras, Citi Bike, FloodNet sensors + events, tide gauge, weather points, NWS alerts,
   subway alerts, elevator outages, 311, collisions, road speeds.
6. Detail drawer: camera frame (refresh 3 s), station bikes sparkline, sensor info, alert text.
7. Health panel and About/attribution panel.
8. Static borough/NTA boundaries for filtering and the neighborhood outline.

**Acceptance criteria** (verified 2026-11-15 in the browser on `nyclive serve` + built app, live data)
- [x] ≥ 10 layers toggleable. Each has a legend and attribution; the borough filter counts as a
  filter, and layers with many features have at least one more. *(14 layers; extra filters on
  Citi Bike, cameras, 311, collisions, flood sensors, subway stations and more.)*
- [x] Borough filter applies to all layers. URL reproduces the view exactly. *(MN: bikes
  2,519 → 690, NJ gone; a URL with layers, borough, filter, camera, bearing, pitch and theme
  reloads byte-identical.)*
- [x] First useful render < 3 s locally. Layer refresh polling doesn't flash or jank. *(first
  paint 0.52 s, first layers 0.6 s; ETag polling, `setData` only on change.)*
- [x] Clicking a camera shows its live frame. Bulk thumbnails are never loaded. *(frames 3.0 s
  apart for the selected camera only; none after closing.)*
- [x] Works at phone width (layer panel collapses to a sheet). *(375 × 812: two sheets with three
  detents, no horizontal scroll.)*
- Task 8: borough boundaries shipped; NTA outlines deferred to Phase 5 (plan default).

---

## Phase 2.5: Liveness (added 2026-11-16) ✅ (2026-11-17)
**Goal:** make it obvious, within seconds of opening the map, that the city is moving.

Tasks (in priority order):
1. **FloodNet live depth** (ADR-010 ready design; the FloodNet team OK'd polling): a
   `floodnet_live` adapter (50 stations per batch every 30 min, depth only, change-only). Sensors
   light up within minutes of flooding.
2. **Rain radar overlay:** RainViewer tiles (keyless), with an opacity control and a frame time
   label, as a toggleable layer.
3. **Live subway trains:** MTA GTFS-realtime (keyless): train positions interpolated along the
   track shapes between updates, coloured by route.
4. **"What changed" feed + change pulse:** a short live list of notable new events (alerts, flood
   trips, new outages, NWS) that flies to each one; dots that changed on the last poll flash
   briefly (still under reduced motion).

Follow-up (keyless, plan in `.orchestrate/notify/plan.md`):
5. ✅ (live 2026-11-17, ADR-015) **Notify NYC alerts:** a `notify_nyc` adapter for the city's official CAP RSS (traffic and
   transit disruptions, fires, outages, police/FDNY activity) as an alert layer that also feeds
   CHANGES. The closest official match to a "Citizen"-style live layer.
   Research: `docs/research/late-data-alternatives.md`.

Train polish (after go-live; only if the scheduled-time animation looks off during delays):
6. **Dwell at the platform:** use GTFS-rt `current_status` (STOPPED_AT vs IN_TRANSIT_TO, already
   decoded) to park a dwelling train at its stop instead of sliding it on. Small: 3 values,
   rarely changes the stored event.
7. **Predicted arrivals as `t1`:** use the trip updates' predicted arrival at the next stop
   instead of the scheduled run time, so delayed trains slow and wait realistically. This is
   the closest public stand-in for block tracking: MTA doesn't publish track-circuit data, and
   its predictions are derived from it. Predictions change almost every poll, so they must stay
   **out of the change-only archive** (a small live-only value). That's a design change and
   needs an ADR.

Later (needs weeks of archive, so with or after Phase 3):
- "Unusual right now": hour-of-week baselines for 311 by type and area, road speeds and empty
  bike docks, flagging large deviations.
- A "normal for now" band behind drawer charts (same baselines).
- Citi Bike empty/full nowcast (30 min).
- Flood risk shade (surge + rain + FloodNet).
- NYC Ferry positions; DOT street closures; presets (Commute, Flood watch, Safety);
  heatmap mode for 311 / collisions; neighbourhood card (needs NTA outlines).
- ✅ (2026-11-18) Keyed sources as optional extras (ADR-018): **live buses** (MTA Bus Time) and
  **air quality** (OpenAQ). They appear only where their keys are in `.env`.

**Acceptance criteria**
- [x] (restarted 2026-11-17 01:57 UTC; `scripts/golive_check.py` all PASS but the 24 h trains
  budget) New adapters pass conformance offline; collector restarted on them only after the Phase 1
  soak passes.
- [x] (Alex, 2026-11-17) Radar, trains and FloodNet live depth each have a legend, an attribution and an honest empty
  or stale state.
- [x] (Alex, 2026-11-17, after the catch-up and tick fixes) Trains move smoothly between updates
  with no jank at city zoom; polling stays ≥ 30 s.
- [x] (Alex, 2026-11-17) The feed shows new items within one poll; clicking one flies to it and
  opens the drawer.

---

## Phase 3: Replay
**Goal:** scrub back in time over everything archived.
Plan: `docs/research/phase3-replay.md` (rebuild state.db as of t from the archive and run the
unchanged builders; replay shows what the map knew at t).
- Move collectors to an always-on box (RTX 3050 PC or VPS; see ADR-009) **before or at the start
  of this phase**.
- `/api/layers/{id}/at?t=` and `/api/timeline` via DuckDB on Parquet.
- Time bar: LIVE ⇄ scrub, play at 60×/600×, activity sparkline, "jump to" interesting moments
  (largest flood depth, most alerts).
- Gap rendering: hatched regions where collectors were down.

**Acceptance:** replay any minute in the last 30 days in < 2 s per layer. Playing 600× is smooth.
Gaps are visibly marked.

---

## Phase 4: Cameras as sensors (CV)
**Goal:** counts of cars, people and bikes on ~20 cameras as a map layer.
- **Spike first (30 min):** benchmark `yolo11n`/`yolo11s` at `imgsz=1280` on the laptop under x64
  emulation. Size the watchlist from the measured frames/s before planning the rest.
- `config/watchlist.yaml`: pick ~20 good cameras (clear view, near FloodNet sensors and busy Citi
  Bike stations), with ROI polygons.
- `cv/detector.py` (Ultralytics, CPU/CUDA switch) and `cv/worker.py` (`nyclive cv`).
- Counts written as observations. Frames kept per retention rules.
- Hand-label 100 frames and measure MAE per class. Tune `imgsz`, conf and ROI.
- UI: camera markers sized by activity, a counts chart in the drawer, "busier than usual" coloring
  (needs ~1 week of history).

**Acceptance:** worker runs 24 h on the laptop CPU at ≤ 2 cores. Vehicle MAE ≤ 2 per frame on the
labeled set. Layer is visible in live and replay.

---

## Phase 5: Modes & extras
- Modes are presets of layers, filters and view: **Storm**, **Commute**, **City pulse**.
- Neighborhood card (NTA polygon click): live summary plus 7-day trends.
- Anomaly flags: robust z-score versus same hour and weekday over the trailing 4 weeks, for bikes,
  cams and speeds.
- Extras: subway trains (GTFS-rt protobuf), OpenSky aircraft, Kalshi NYC-high panel,
  511NY traffic incidents (request form; `ny511_events`). OpenAQ is done (ADR-018).
- **"Ask the map"** (key, optional under ADR-007): a question bar answered by a Claude tool loop
  over our own API, with grounded answers that cite each source's age and highlights on the map.
  Build after Notify NYC is live and Phase 3 replay exists. Design note:
  `docs/research/ask-the-map.md`.
- ✅ (2026-11-17) **3D buildings and the sun:** `3D` and `SUN` map modes. Buildings are
  extruded from the basemap's OSM heights; the light follows the real sun; ground shadows are
  computed in the browser. Plan: `docs/research/3d-sun-shadows.md`, ADR-017. Next: drive the
  sun from the Phase 3 time bar.
- Candidate layers from DATA_SOURCES "Candidates".

**Acceptance:** each mode answers one stated question in one click. At least 2 extras are live.

---

## Phase 6: Ship the portfolio
- Public deployment (frontend static host plus API via tunnel or VPS) with uptime monitoring.
- Frozen demo: export one interesting recorded day (ideally a storm) as a static bundle.
- README: hero GIF, architecture diagram, "how it works", and a "what I learned" section.
- Write-up: one finding, e.g. *"How long after FloodNet sensors trip do 311 flooding complaints
  arrive?"*
- Playwright smoke test and GitHub Actions (lint, tests, nightly probe).

**Acceptance:** public link works for a stranger. Frozen demo works with the backend off. README
explains it in 60 s.

---

## Later / ideas parking lot
- Custom PyTorch classifier on DOT frames: "flooded?", "raining?", "snow-covered?".
- SSE live push instead of polling.
- Fine-tuned detector for DOT angles (needs the 3050 and labeled frames).
- Public dataset release of the archive (check terms first).
- Tandem tie-in: use the Citi Bike plus weather history as extra training data (separate project;
  share data files, not code).

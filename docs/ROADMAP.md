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

## Phase 1: Collectors & archive ⏭ next
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
9. Packages, each owning only its module(s), `tests/fixtures/<id>/` and
   `tests/sources/test_<module>.py`:
   - B1 `openmeteo`, `nws_alerts`
   - B2 `dot_cameras`
   - B3 `mta_stations`, `mta_alerts`, `mta_elevators`
   - B4 `floodnet` (sensors, events)
   - B5 `nyc_311`, `nyc_collisions`
   - B6 `dot_speeds`

   Run B1 alone first as a pilot of the workflow (`/orchestrate` Tier 2), then the rest in parallel.
10. Conductor: set `adapter:` in the registry, extend enums from builder handbacks, run
    `nyclive collect --once --only <id>` live for each, update DATA_SOURCES.

**Gate B:** the conformance test is green for every source with an adapter, and all of them are in
the running collector.

### 1C. Hardening
11. `nyclive compact` (idempotent; runs at startup and daily for closed days).
12. **Spike (time-boxed to 2 h):** FloodNet live via FieldKit project 174 (ADR-010). Any time after
    Gate A. Record the outcome in DECISIONS.md.
13. Soak test (see criteria). Measure storage and CPU per source and replace the estimates in
    ARCHITECTURE §5.

**Acceptance criteria**
- [ ] Conformance test: every registry source with `adapter` set has `tests/fixtures/<id>/real/`
  and at least one `edge_*` case (edge cases may be hand-derived from a real capture, noted in
  `meta.json`), and `parse()` passes `assert_valid_batch`.
- [ ] Restart test: run the pipeline on a fixture, crash after the archive write and before the
  state commit, rerun, compact. Zero duplicate natural keys through archive reads and in the
  compacted file.
- [ ] Isolation test: a fake adapter that always raises goes `degraded`; the other sources keep
  writing.
- [ ] Soak: 48 h of `nyclive collect --keep-awake` in total, including at least one unbroken 24 h
  run (it must cross a UTC midnight). From `runs`, every source has ≥ 95% successful scheduled runs
  while the collector was up, and the process never exits on its own.
- [ ] `nyclive status` prints last success, consecutive failures, rows in last run and data lag per
  source.
- [ ] Measured archive growth ≤ 150 MB/day after compaction, one file per closed day partition, and
  collector CPU < 5% average. Measured numbers replace the estimates in ARCHITECTURE §5.
- [ ] As-of smoke: Citi Bike state at a chosen minute comes from one day partition, ≥ 2,000
  stations, < 2 s.

---

## Phase 2: Live map (MVP)
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

**Acceptance criteria**
- [ ] ≥ 10 layers toggleable. Each has a legend and attribution; the borough filter counts as a
  filter, and layers with many features have at least one more.
- [ ] Borough filter applies to all layers. URL reproduces the view exactly.
- [ ] First useful render < 3 s locally. Layer refresh polling doesn't flash or jank.
- [ ] Clicking a camera shows its live frame. Bulk thumbnails are never loaded.
- [ ] Works at phone width (layer panel collapses to a sheet).

---

## Phase 3: Replay
**Goal:** scrub back in time over everything archived.
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
- Extras: subway trains (GTFS-rt protobuf), OpenSky aircraft, Kalshi NYC-high panel, OpenAQ (key).
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

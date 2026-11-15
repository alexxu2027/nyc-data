# NYC Live: Roadmap

Each phase has a goal, tasks, and **acceptance criteria**. A phase is done only when every
criterion is met. Keep the scope inside the phase, and put new ideas in the "Later" list at the
bottom.

---

## Phase 0: Foundations ✅ (2026-11-14)
- [x] PRD, architecture, data model, data sources, decisions, dev setup docs
- [x] Source registry `config/sources.yaml` (21 sources)
- [x] `nyclive sources`, `nyclive probe` with JSON report
- [x] Registry tests (offline) plus a live probe test (`-m live`)
- [x] Probe: 19 of 21 healthy, 2 skipped because they need keys

**Accepted:** `uv sync && uv run pytest && uv run nyclive probe` all succeed.

---

## Phase 1: Collectors & archive ⏭ next
**Goal:** every Phase 1 source is polled on schedule, normalized and archived, so history starts
accumulating.

Tasks, in order:
1. `settings.py`: data dir, UA, optional tokens, from env.
2. `http.py`: shared client with timeouts, retries, per-host gap, and backoff.
3. `model.py`: Entity, Observation and Event dataclasses plus Arrow schemas.
4. `storage/state.py` (SQLite WAL) and `storage/archive.py` (Parquet append and `compact`).
5. `nyclive capture <source>`: save fixtures. Capture one of each Phase 1 source.
6. Adapters, each with parser tests on fixtures, roughly easiest first:
   `noaa_tide_battery` → `openmeteo_current` → `nws_alerts` → `dot_cameras` → `citibike_*` →
   `mta_elevator_outages` → `mta_subway_alerts` → `floodnet_sensors/events` → `nyc_311` →
   `nyc_collisions` → `dot_traffic_speeds`.
7. `collect/scheduler.py` and `nyclive collect`: jobs from the registry, health rows, change-only
   writes, upserts.
8. `nyclive compact` (nightly) and `nyclive status` (prints source health).
9. **Spike (time-boxed to 2 h):** FloodNet live via FieldKit project 174. Record the outcome in
   DECISIONS.md.
10. Run collectors for 48 h and measure actual storage per source. Update ARCHITECTURE §5.

**Acceptance criteria**
- [ ] `uv run nyclive collect` runs unattended for 24 h with no crash. A source that fails doesn't
  stop the others.
- [ ] Every Phase 1 source has ≥ 1 parser test on a real fixture, including at least one edge case.
- [ ] After killing and restarting `collect`, there are no duplicate keys in the archive (a test
  proves it).
- [ ] `nyclive status` shows last success and lag for every source.
- [ ] Measured storage is ≤ 1 GB/day.

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
- [ ] ≥ 12 layers toggleable. Each has a legend, attribution and at least one filter.
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

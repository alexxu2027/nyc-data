# NYC Live: Architecture

Status: design v1 (2026-11-14). Decisions referenced as ADR-n live in [DECISIONS.md](DECISIONS.md).

## 1. Overview

```
                ┌──────────────────────── external feeds (config/sources.yaml) ─────────────────────────┐
                │ DOT cams · GBFS · MTA GTFS-rt · NOAA · NWS · Open-Meteo · FloodNet · NYC Open Data …   │
                └───────────────┬───────────────────────────────────────────────────────┬───────────────┘
                                │ HTTP (polite polling)                                 │ JPEG frames
                      ┌─────────▼──────────┐                                  ┌─────────▼─────────┐
                      │  collector process │  nyclive collect                 │  CV worker        │  nyclive cv
                      │  scheduler + one   │                                  │  YOLO on watchlist│  (Phase 4)
                      │  adapter per source│                                  │  cams every 30 s  │
                      └──┬──────────────┬──┘                                  └──┬─────────────┬──┘
           latest state  │              │ append-only history          counts    │             │ frames (3-day)
                ┌────────▼───┐   ┌──────▼────────────────────┐ ◄────────────────┘   ┌─────────▼────────┐
                │ state.db   │   │ archive/ (Parquet, by     │                       │ images/          │
                │ (SQLite,   │   │ source/table/date)        │                       │ <cam>/<date>/…   │
                │  WAL)      │   └──────┬────────────────────┘                       └──────────────────┘
                └────────┬───┘          │ DuckDB queries
                         │              │
                      ┌──▼──────────────▼──┐
                      │  API (FastAPI)     │  nyclive serve
                      │  /layers /events   │
                      │  /entities /health │
                      └─────────┬──────────┘
                                │ JSON / GeoJSON (poll 30–60 s)
                      ┌─────────▼──────────┐
                      │  Web app           │  web/  (Vite + React + TS)
                      │  MapLibre map,     │
                      │  layer panel,      │
                      │  time bar, drawer  │
                      └────────────────────┘
```

There are three processes, and each one can be restarted independently:
- Writers are `collect`, `cv` and `compact`, all through the storage module (one SQLite writer
  at a time, `busy_timeout` set).
- `cv` is the only writer to `images/`.
- `serve` is read-only.

## 2. Repository layout (target)

```
nyc-live/
  config/sources.yaml          source registry (truth for ids, cadences, auth)
  config/layers.yaml           layer definitions for the UI (Phase 2)
  config/watchlist.yaml        cameras for CV (Phase 4)
  src/nyclive/
    cli.py                     entry point
    registry.py                load/validate sources.yaml           ✅
    probe.py                   feed health check                    ✅
    settings.py                env + paths (data dir, UA, tokens)
    timeutil.py                parse_iso_utc, from_epoch, local_to_utc (America/New_York)
    http.py                    shared client: timeouts, retries, backoff, per-host rate limit
    model.py                   Entity / Observation / Event, KINDS/METRICS/CATEGORIES, borough_code, Arrow schemas
    storage/
      state.py                 SQLite latest-state store
      archive.py               Parquet append + nightly compaction
      query.py                 DuckDB helpers for history/replay
    sources/                   one adapter module per source id
      base.py                  RawPayload, FetchContext, Batch (DATA_MODEL "Adapter contract v1")
      _socrata.py              shared Socrata paging/$select/lookback helper (conductor-owned)
      dot_cameras.py  citibike.py  noaa_tides.py  openmeteo.py  nws_alerts.py
      mta_stations.py  mta_alerts.py  mta_elevators.py  floodnet.py
      nyc_311.py  nyc_collisions.py  dot_speeds.py
    collect/
      pipeline.py              run_once: fetch → parse → write (ADR-011)
      scheduler.py             APScheduler jobs from the registry; isolation + health rows
    api/
      app.py                   FastAPI app
      routes_*.py              layers, events, entities, timeline, health
      geo.py                   GeoJSON building, bbox & borough filters
    cv/
      worker.py                fetch frame → detect → count → write
      detector.py              Ultralytics wrapper (CPU/CUDA)
  tests/
    fixtures/<id>/<case>/      recorded payloads + meta.json (nyclive capture)
    sources/test_<module>.py   parser tests, offline
    helpers.py                 load_fixture, assert_valid_batch
  web/                         Vite React app (Phase 2)
  data/                        gitignored: state.db, archive/, images/, probe/, logs/
  docs/
```

## 3. Collectors

**Adapter contract:** pinned in [DATA_MODEL.md](DATA_MODEL.md) → "Adapter contract v1". In short,
each module in `sources/` exposes `SOURCE_IDS`, `fetch(ctx) -> RawPayload` (network only, gets
the cursor in `ctx`) and `parse(raw) -> Batch` (pure). A module may serve several registry ids.
- `parse` is a **pure function** of the payload. Tests feed it fixtures, so no network is involved.
- The scheduler builds one job per source from `cadence_s`. APScheduler 3.x with a thread pool
  of 4, `coalesce=True`, `max_instances=1`, and all storage writes behind one lock.
  `--keep-awake` calls `SetThreadExecutionState` so Windows doesn't sleep. stdout is reconfigured
  to UTF-8 (`errors="replace"`) so `status` can't crash on a cp1252 console.
- Each job wraps fetch, parse, write in
  try/except and records a row in `source_health`: last attempt, last success, last error,
  consecutive failures, rows written. Every run also appends to `runs` (ADR-011).
- **Failure policy:** after 3 consecutive failures, back off exponentially (capped at 30 min) and
  mark the source `degraded`. The other sources are unaffected.
- **Politeness:** one shared `httpx.Client`, a 25 s timeout, a 2 s minimum gap per host, honoring
  `ttl`/`Retry-After`, and a User-Agent with the repo URL (override with `NYCLIVE_USER_AGENT`).
  Never branch on `Content-Type` (the MTA elevator feed sends a broken one).
- **Dedupe:** every record has a natural key (see DATA_MODEL). Observations are written only if the
  value changed since the last write for that key, which matters for Citi Bike. Each day also starts with a
  keyframe. Events are upserted on `event_id` in `state.db`; the archive keeps one row per
  version (payload hash), and events that leave a complete feed are closed (ADR-011).
- **Raw capture:** `nyclive capture <source>` saves one raw payload to `tests/fixtures/<id>/<case>/`.
  Nothing else stores raw payloads routinely, because doing so would blow the storage budget.

**Source specifics** that shape adapters (details in DATA_SOURCES.md):
- GBFS: discover URLs from the manifest. `last_reported=86400` is a sentinel for inactive stations.
- MTA alerts are about 1 MB per fetch, so hash-dedupe. Elevator dates are local-time strings, so
  parse them as America/New_York.
- NWS: filter features to NYC SAME codes.
- Socrata: each dataset names its own cursor column in the registry notes. Never cursor on
  `:updated_at` without checking it (311 bulk-rewrites it). Always send `$select`, `$order`,
  `$limit` ≤ 5000, a first-run lookback and a per-run page cap (hitting it logs a warning).
  Re-read a little behind the cursor; change-only writes make the overlap free. Clamp cursors to
  the fetch time. Timestamps with no offset are New York local time (FloodNet events: UTC).
- Complete feeds: an event that leaves the feed is closed even if it had a scheduled end in the
  future; one that leaves before it starts ends at its start. An empty payload from a feed that
  is never empty (MTA) is rejected, so a glitch can't close everything.
- Open-Meteo: request `timeformat=unixtime`.
- FloodNet live: Phase 1 spike against FieldKit project 174. The fallback is daily Open Data events.

## 4. Data model (summary)
Every record is one of three shapes. See [DATA_MODEL.md](DATA_MODEL.md) for columns.
- **Entity:** a thing with a location that persists. Examples: camera, bike station, flood sensor,
  tide gauge, road segment, subway station, weather point.
- **Observation:** a timestamped measurement of an entity. Examples: bikes available, water level,
  speed, temperature, CV counts.
- **Event:** something with a start (and maybe an end) and a location. Examples: alert, 311
  request, crash, flood event, elevator outage.

Keeping only three shapes gives the API and UI three generic renderers instead of 20+ bespoke ones:
- entities with latest observations become point or line layers,
- events become point layers or a list,
- observations become charts.

## 5. Storage
| Store | Tech | Holds | Why |
|---|---|---|---|
| `data/state.db` | SQLite (WAL mode) | Current entities, latest observation per (entity, metric), open events, `source_health` | Fast point reads for the live map. Safe concurrent readers while the collector writes (ADR-003) |
| `data/archive/` | Parquet files, hive-partitioned `source=/table=/date=` | Append-only history of all three shapes | Columnar, compressed, queryable by DuckDB with no server (ADR-004) |
| `data/images/` | JPEG files | Frames for watchlist cams only, 3-day retention, plus 1 frame per 15 min kept as a training set | CV debugging and future PyTorch training |

**Write path:** each job appends a small Parquet file per table per run, e.g.
`archive/source=citibike_station_status/table=observations/date=2026-11-15/part-091200-<run id>.parquet`.
`compact` merges a closed day's parts into one deduped file; it runs at startup and daily, so a
missed night can't leave thousands of part files. Partition dates are the UTC date of
`fetched_at`. Full rules, including crash safety: ADR-011.

**Measured so far** (2026-11-15, `scripts/soak_report.py` at 2.6 h, 14 sources; provisional
until the soak ends): archive 5.3 MB, ≈ 48 MB/day extrapolated. That figure is inflated by the
one-off 311 first-run backfill (4.2 MB of 50k rows); Citi Bike status is ≈ 0.5 MB after 2.6 h.
Collector CPU is 0.10% of the machine (1.1% of one core) under x64 emulation. Final per-day
numbers replace the table below once closed days exist.

**Budget (original estimates):**
| Source | Raw volume | Stored (changed rows, Parquet) |
|---|---|---|
| Citi Bike status | 1 MB/min | ≈ 20–40 MB/day |
| MTA alerts | 1 MB/min | < 5 MB/day after dedupe |
| DOT speeds | small/5 min | ≈ 10 MB/day |
| Everything else | small | < 10 MB/day |
| Watchlist frames (detect every 30 s, save 20 cams × 1/min × 17 KB) | n/a | ≈ 0.5 GB/day, retention 3 days ⇒ ≈ 1.5 GB steady |
| Training frames (20 cams × 1/15 min) | n/a | ≈ 35 MB/day, kept |

Total ≈ 100 MB/day kept plus a rolling ~1.5 GB of frames. Disk is not the constraint (hundreds
of GB free); the Phase 1 soak replaces these estimates with measured numbers.

## 6. API (FastAPI, read-only)
`nyclive serve` runs it (`src/nyclive/api/`). It opens `state.db` read-only (`mode=ro` URI) and
never writes; history comes from the Parquet archive through `storage/query.py`. It also serves
`web/dist` with an `index.html` fallback. OpenAPI docs: `/api/docs`.

| Method & path | Returns |
|---|---|
| `GET /api/health` | Collector state plus per-source status, last success, age/lag, failures, 24 h run counts |
| `GET /api/layers` | Layer catalog from `config/layers.yaml` (ADR-012), defaults filled: groups, legends, filters, styles, attribution, basemaps, view, boroughs |
| `GET /api/layers/{id}?borough=&bbox=&f.<key>=&limit=` | GeoJSON FeatureCollection of **current** state plus `meta` (count, total, truncated, unlocated, data_as_of, updated_at, window, note) |
| `GET /api/entities/{kind}/{id}` | Entity detail: latest values, `derived` per kind, linked events, series descriptors |
| `GET /api/entities/{kind}/{id}/series?metrics=&hours=&ahead=` | Time series for charts (≤ 2,000 points per metric) |
| `GET /api/events?layer=&status=&borough=&limit=&offset=` | Paged events of a `list: true` layer, active first |
| `GET /api/events/{source}/{event_id}` | One event in full, with resolved entities |
| `GET /api/layers/{layer}/at?t=…` | *Phase 3:* state **as of t** (replay) |
| `GET /api/timeline?from=&to=&bucket=1h` | *Phase 3:* activity counts per bucket |

- Entities are keyed by `kind` (the `entities` primary key), not by source. Ids may contain `:`
  and `/` (`{id:path}`).
- **Caching:** `/api/layers`, `/api/layers/{id}` and `/api/health` send a weak ETag (sha1 of the
  body) with `Cache-Control: no-cache`; a matching `If-None-Match` gets 304. Bodies carry no
  generation time, so the ETag changes only when the data does. Layer bodies are cached per
  `(layer, params)` until a source's `(last_success, rows_last_run)` changes or the entry ages
  past `max(30, min(poll_s, 300))` s. Bodies over 1 KB are gzipped.
- Event layers (311, collisions, flood events) use a window anchored at the source's newest
  record (`data_as_of`), not the wall clock, and are labelled "as of". 311 is capped at the newest
  20,000 rows and says so in `meta.truncated`.
- Borough is resolved in the API (stored column, else point-in-polygon, else `XX`); see
  DATA_MODEL "Borough normalization".
- Errors are `{"error": {code, message}}` with 400/404/503/500; a missing `state.db` is 503.
- Live updates use frontend polling at `max(cadence, 30 s)` with `If-None-Match` (ADR-006).
- "State as of t" (Phase 3): for entities, take the last observation ≤ t per (entity, metric), via
  DuckDB `QUALIFY ROW_NUMBER()` over partitions date(t) and date(t)+1 (the daily keyframe makes
  that enough). For events, take the newest version ≤ t per event with
  `starts_at ≤ t < coalesce(ends_at, ∞)`. Gaps come from the `runs` table.
- Camera images: the frontend loads `image_url` from DOT directly and only for the selected camera.
  It never bulk-loads thumbnails.

## 7. Web app
- **Stack:** Vite, React and TypeScript; MapLibre GL JS with OpenFreeMap basemaps (positron light,
  dark; no key); Zustand for state. Charts are hand-drawn SVG (no chart library). deck.gl comes in
  only if needed for heavy layers like trains or heatmaps (ADR-005). Built to `web/dist`, which
  `nyclive serve` hosts; in dev, `npm run dev` proxies `/api` to port 8000.
- **Code layout** (`web/src/`; units talk only through the store):
  `core/` store, URL, API client, polling, filters · `ui/` transcript UI kit (`?gallery=1`) ·
  `shell/` layout and panels · `map/` MapLibre controller and per-layer renderers ·
  `drawer/` detail views and charts · `types.ts` frozen catalog/API types (ADR-012).
- **Layout:**
  - **Top:** title, borough chips (ALL MN BK QN BX SI), `[HEALTH]`, `[ABOUT]`, theme toggle.
  - **Left:** layer panel grouped as *Transit*, *Streets & safety*, *Water & weather*,
    *City services*, *Reference* (from the catalog). Each row: toggle, freshness dot, fixed-width
    count, `[+]` for legend, filters, AS OF, lag note, attribution and `[LIST n]`. Rows state
    loading, error, empty, truncated and unlocated counts honestly.
  - **Right:** detail drawer. A camera shows its live frame (one `<img>`, refreshed every 3 s
    only while open and visible); a bike station, road segment, weather point or the tide gauge
    shows a 24 h chart (tide adds +12 h of prediction and the surge); a flood event shows its
    depth profile; subway stations and alerts show full text. List mode pages a list layer's events.
  - **Bottom:** status line with a **LIVE** pill, ET clock, visible layer and feature totals and
    the next refresh. In Phase 3 it becomes the time bar.
  - **Phone (≤ 680 px):** full-bleed map; the layer panel and the drawer become bottom sheets with
    peek / half / full detents; borough chips scroll sideways.
- **URL state** (written with `replaceState`, debounced; canonical order):
  `?layers=citibike,road_speeds&borough=BK,QN&f.citibike.state=empty,low&c=-73.98570,40.74840&z=12.35&b=15.0&p=30.0&sel=cameras:<id>&theme=dark&panel=health&t=live`.
  `layers`, `c`, `z` are always written; the rest only when not default. `b`/`p` are bearing and
  pitch. `sel` and `list` are mutually exclusive. `t` is reserved for Phase 3 replay.
- **Polling:** each visible layer polls at `max(poll_s, 30 s)` with its stored ETag; a 304 only
  bumps freshness, a 200 replaces the features. The map calls `setData` only when a layer's
  filtered features change identity, so ticks don't flash.
- **Rendering:** chrome follows the transcript look (monospace, ink on paper, 1px rules, stepped
  motion), but the map is a rich data map: data-driven circle colour and size (bike availability),
  speed-banded road lines with zoom widths, clustered 311 points with counts, NWS polygon fills,
  stepped pulses on flooding and unplanned alerts (still under reduced motion), SDF glyph icons,
  hover highlight and a selected-feature halo, a borough mask. Ramps are colour-blind safe;
  legends use colour swatches.
- **Design:** paper (light) theme by default with a dark toggle; a theme swap reloads the basemap
  and reinstalls every data layer and the selection. Every layer has a legend and attribution.

## 8. Computer vision (Phase 4)
- **Input:** DOT JPEG snapshots, 352×240, a new frame roughly every 2 s. They're too sparse for
  tracking, so the worker **counts per frame** and doesn't track (ADR-008).
- **Model:** Ultralytics YOLO (start with `yolo11n`/`yolo11s`, COCO classes car, truck, bus,
  person, bicycle, motorcycle) at `imgsz=1280` upscaled, with a per-camera ROI polygon and class
  confidence thresholds.
- **Loop:**
  1. Every 30 s, for each watchlist camera: fetch frame.
  2. Skip it if its hash matches the last frame.
  3. Detect, then count per class inside the ROI.
  4. Write observations (`metric = count_car`, etc.).
  5. Save the frame per the retention rules.
- **Throughput:** about 20 cams every 30 s is 0.7 frames/s. Whether the laptop CPU keeps up at
  `imgsz=1280` under x64 emulation is unverified; a 30-minute benchmark spike opens Phase 4. On the
  RTX 3050 the watchlist can grow to 100+ cams.
- **Device:** `device="cuda"` if available, else CPU, configured in settings. The code is
  otherwise identical.
- **Quality:** 100 hand-labeled frames give a baseline MAE metric. Fine-tuning and a custom
  PyTorch "flooded street" classifier come later.

## 9. Deployment
| Stage | Where | How |
|---|---|---|
| Phases 1–2 | Laptop | `nyclive collect` + `nyclive serve` + `npm run dev`. Gaps accepted |
| Phase 3+ | RTX 3050 PC (always on) **or** small VPS | Collectors and API run as services. History uninterrupted |
| Public demo | Frontend on Cloudflare Pages / GitHub Pages. API through Cloudflare Tunnel (PC) or the VPS | ADR-009 |
| Frozen demo | Static build plus an exported "recorded day" bundle | Works even when the backend is off (F13) |

## 10. Testing & quality
- **Unit:** each adapter's `parse` against fixtures in `tests/fixtures/<source>/`, including edge
  cases (sentinel times, missing coordinates, empty alert lists).
- **Contract:** `pytest -m live` runs the probe and a fetch-plus-parse smoke test per source.
- **Storage:** round-trip tests for write, then read state, then query as-of.
- **API:** FastAPI TestClient against a temp data dir seeded from fixtures.
- **Web:** Vitest for state/URL helpers, plus a Playwright smoke test (map loads, toggling a
  layer works) in Phase 6.
- **Tooling:** ruff (lint and format), pytest, and later GitHub Actions running lint, unit tests
  and a nightly probe.

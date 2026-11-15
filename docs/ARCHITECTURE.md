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
- `collect` is the only writer to `state.db` and `archive/`.
- `cv` writes counts through the same storage module and is the only writer to `images/`.
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
    http.py                    shared client: timeouts, retries, backoff, per-host rate limit
    model.py                   Entity / Observation / Event dataclasses + Arrow schemas
    storage/
      state.py                 SQLite latest-state store
      archive.py               Parquet append + nightly compaction
      query.py                 DuckDB helpers for history/replay
    sources/                   one adapter module per source id
      base.py                  Adapter protocol: fetch() → raw, parse(raw) → records
      dot_cameras.py  citibike.py  mta_alerts.py  mta_elevators.py  noaa_tides.py
      openmeteo.py  nws_alerts.py  floodnet.py  socrata.py (311, collisions, speeds)
    collect/
      scheduler.py             APScheduler jobs from the registry; isolation + health rows
    api/
      app.py                   FastAPI app
      routes_*.py              layers, events, entities, timeline, health
      geo.py                   GeoJSON building, bbox & borough filters
    cv/
      worker.py                fetch frame → detect → count → write
      detector.py              Ultralytics wrapper (CPU/CUDA)
  tests/
    fixtures/<source>/*.json   recorded payloads (nyclive capture)
    test_<source>.py           parser tests, offline
  web/                         Vite React app (Phase 2)
  data/                        gitignored: state.db, archive/, images/, probe/, logs/
  docs/
```

## 3. Collectors

**Adapter contract** (`sources/base.py`):
```python
class Adapter(Protocol):
    source_id: str
    def fetch(self, client: Http) -> RawPayload: ...                    # network only
    def parse(self, raw: RawPayload, fetched_at: datetime) -> Batch: ...  # pure, unit-tested
# Batch = entities: list[Entity], observations: list[Observation], events: list[Event]
```
- `parse` is a **pure function** of the payload. Tests feed it fixtures, so no network is involved.
- The scheduler builds one job per source from `cadence_s`. Each job wraps fetch, parse, write in
  try/except and records a row in `source_health`: last attempt, last success, last error,
  consecutive failures, rows written.
- **Failure policy:** after 3 consecutive failures, back off exponentially (capped at 30 min) and
  mark the source `degraded`. The other sources are unaffected.
- **Politeness:** one shared `httpx.Client`, a 25 s timeout, a 2 s minimum gap per host, honoring
  `ttl`/`Retry-After`, and a User-Agent from `NYCLIVE_USER_AGENT`.
- **Dedupe:** every record has a natural key (see DATA_MODEL). Observations are written only if the
  value changed since the last write for that key, which matters for Citi Bike. Events are upserted
  on `event_id`, and a payload hash avoids rewriting events that haven't changed.
- **Raw capture:** `nyclive capture <source>` saves one raw payload to `tests/fixtures/<source>/`.
  Nothing else stores raw payloads routinely, because doing so would blow the storage budget.

**Source specifics** that shape adapters (details in DATA_SOURCES.md):
- GBFS: discover URLs from the manifest. `last_reported=86400` is a sentinel for inactive stations.
- MTA alerts are about 1 MB per fetch, so hash-dedupe. Elevator dates are local-time strings, so
  parse them as America/New_York.
- NWS: filter features to NYC SAME codes.
- Socrata: incremental `$where=:updated_at > last_cursor` (or `created_date`), paged with `$limit`
  and `$offset`, upserted on the row key.
- FloodNet live: Phase 1 spike against FieldKit project 174. The fallback is daily Open Data events.

## 4. Data model (summary)
Every record is one of three shapes. See [DATA_MODEL.md](DATA_MODEL.md) for columns.
- **Entity:** a thing with a location that persists. Examples: camera, bike station, flood sensor,
  tide gauge, road segment, subway station, weather point.
- **Observation:** a timestamped measurement of an entity. Examples: bikes available, water level,
  speed, temperature, CV counts.
- **Event:** something with a start (and maybe an end) and a location. Examples: alert, 311
  request, crash, flood event, elevator outage.

Keeping only three shapes gives the API and UI three generic renderers instead of 21 bespoke ones:
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
`archive/source=citibike_station_status/table=observations/date=2026-11-15/part-0912.parquet`.
A nightly `compact` job merges a day's parts into one file. Times are always UTC, and partition
dates are UTC dates.

**Budget (estimates, to be measured in Phase 1):**
| Source | Raw volume | Stored (changed rows, Parquet) |
|---|---|---|
| Citi Bike status | 1 MB/min | ≈ 20–40 MB/day |
| MTA alerts | 1 MB/min | < 5 MB/day after dedupe |
| DOT speeds | small/5 min | ≈ 10 MB/day |
| Everything else | small | < 10 MB/day |
| Watchlist frames (20 cams × 1/min × 17 KB) | n/a | ≈ 0.5 GB/day, retention 3 days ⇒ ≈ 1.5 GB steady |
| Training frames (20 cams × 1/15 min) | n/a | ≈ 35 MB/day, kept |

Total ≈ 100 MB/day kept plus a rolling ~1.5 GB of frames. That's fine on the laptop for months.

## 6. API (FastAPI, read-only)
| Method & path | Returns |
|---|---|
| `GET /api/health` | Per-source status, last success, lag seconds, consecutive failures |
| `GET /api/layers` | Layer catalog from `config/layers.yaml`: id, group, kind, legend, filters, default visibility, attribution |
| `GET /api/layers/{layer}?bbox=&borough=&f.<filter>=` | GeoJSON FeatureCollection of **current** state |
| `GET /api/layers/{layer}/at?t=ISO8601&bbox=…` | GeoJSON state **as of t** (replay, Phase 3) |
| `GET /api/entities/{source}/{id}` | Entity detail, latest observations, recent events nearby |
| `GET /api/entities/{source}/{id}/series?metric=&from=&to=&bucket=5m` | Time series for charts |
| `GET /api/events?layers=&from=&to=&bbox=&borough=` | Paged events list (alerts feed) |
| `GET /api/timeline?from=&to=&bucket=1h` | Activity counts per bucket for the slider sparkline |

- Live updates use frontend polling every 30–60 s with `ETag`/`If-None-Match` (ADR-006).
  Server-sent events (SSE) may come later.
- "State as of t": for entities, take the last observation ≤ t per (entity, metric), via DuckDB
  `QUALIFY ROW_NUMBER()` over the day partition(s). For events, take those with
  `starts_at ≤ t < coalesce(ends_at, ∞)`.
- Camera images: the frontend loads `imageUrl` from DOT directly and only when a camera is
  selected. It never bulk-loads thumbnails.

## 7. Web app
- **Stack:** Vite, React and TypeScript; MapLibre GL JS with an OpenFreeMap basemap (no key);
  Zustand for state; a small chart library (uPlot or Recharts) for series. deck.gl comes in only if
  needed for heavy layers like trains or heatmaps (ADR-005).
- **Layout:**
  - **Left:** layer panel grouped as *Transit*, *Water & Weather*, *Cameras*, *City services*,
    *Safety*. Each row has a toggle, a freshness dot, a count, and an expandable filter section.
  - **Top:** search or geocode, borough chips, a mode presets menu, and the About and Health links.
  - **Right:** detail drawer for the selected item. A camera shows its frame (refreshing every 3 s)
    and counts chart. A station shows its bikes chart. A sensor shows its depth profile.
  - **Bottom:** time bar with a **LIVE** pill. In Phase 3 it becomes a scrubber with an activity
    sparkline, play/pause, and 60×/600× speeds.
- **URL state:** `?layers=citibike,floodnet&borough=BK&f.citibike=empty&t=live&z=12&c=-73.99,40.68`.
  Every view is shareable.
- **Rendering:** data-driven styles per layer. Points use circles with a color ramp. Road speeds
  are lines colored by speed relative to the speed limit. Alerts get an icon and a pulse.
- **Design:** dark basemap by default with a light theme toggle, color-blind-safe ramps, and a
  legend plus attribution for every layer.

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
- **Throughput:** about 20 cams every 30 s is 0.7 frames/s, comfortable on the laptop CPU. On the
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

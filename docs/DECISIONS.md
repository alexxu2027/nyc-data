# NYC Live: Architecture Decision Records

Format: context → decision → consequences. Add new ADRs at the bottom. Mark superseded ones
rather than deleting them.

## ADR-001: Separate project from Tandem (2026-11-14)
**Context:** Tandem (Citi Bike prediction) overlaps on data but is a class group project with
beginner teammates.
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
compaction. Query with DuckDB in-process.
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

## ADR-010: FloodNet live data (open, Phase 1 spike)
**Context:** Open Data events lag about 2 weeks. The live dashboard uses the undocumented FieldKit
API (project 174, public project list).
**Decision pending:** use FieldKit only if public read is confirmed and polling at 5 min is
acceptable (ideally confirmed with the FloodNet team). Otherwise use events only, labeled "as of".

# HANDOFF: start here

_Last updated: 2026-11-14_

This file is the session-to-session log: where the project stands, what to do next, and gotchas
learned the hard way. Read it first, then `docs/ROADMAP.md`.

## Where things stand
- **Phase 0 (foundations) is done.**
  - Docs: `docs/PRD.md`, `ARCHITECTURE.md`, `DATA_MODEL.md`, `DATA_SOURCES.md`, `ROADMAP.md`,
    `DECISIONS.md`, `DEV_SETUP.md`.
  - Source registry: `config/sources.yaml` (22 sources).
  - CLI: `uv run nyclive sources` and `uv run nyclive probe`.
  - Tests: 115 offline tests pass, lint is clean.
- **Last probe (2026-11-14):** 19 of 21 feeds healthy with no keys. OpenAQ and Bus Time were
  skipped because they need keys. `mta_subway_stations` was added afterwards and checked by hand.
- **Plan review (2026-11-14):** an independent review tightened Phase 1 before any code. Changes:
  - Phase 1 is now 1A walking skeleton → 1B parallel adapters → 1C hardening.
  - Acceptance criteria are testable.
  - ADR-011 pins the archive write semantics.
  - DATA_MODEL "Adapter contract v1" pins the interfaces.
  - The 311 cursor strategy was fixed (verified live).
  - Subway station locations were added as a source.
  - ROADMAP 1A step 1 (housekeeping) is done.
- **1A step 2 done (2026-11-14):** `settings.py` (env + `.env`, data paths, UA, Socrata token as a
  per-host header), `timeutil.py` (the only place times are parsed), `http.py` (`Http.get`: one
  request at a time per host, 2 s gap, retries on network errors/429/5xx with Retry-After, 4xx fail
  fast, raises `HttpError`). Smoke-tested live against NOAA.
- **1A step 3 done (2026-11-14):** `model.py` (Entity/Observation/Event, enums, `borough_code`,
  `record_problems`, Arrow schemas incl. `runs`) and `sources/base.py` (RawPart/RawPayload with
  byte-exact fixture save/load, FetchContext, Batch, `batch_problems`, `load_adapter`). Registry
  `Source` gained `adapter` and `max_lag_s`.
- **1A step 4 done (2026-11-14):** `nyclive capture <id> [--part n=url] [--trim N] [--case edge_x]`
  (`capture.py`), `tests/helpers.py` (`load_fixture`, `assert_valid_batch`, `parse_fixture`), and
  the conductor-owned `tests/test_adapters_conformance.py`. `tests/` is on pytest's pythonpath.
- **1A step 5 done (2026-11-14):** reference adapters `sources/noaa_tides.py` (cursor = newest
  level time, 3-day max backfill, levels + predictions parts) and `sources/citibike.py` (serves
  `citibike_gbfs` entities, complete set, and `citibike_station_status` observations; sentinel
  and future `last_reported` handled). Fixtures: `real` (trimmed to 30) + edge cases from
  `tests/fixtures/make_edges_1a.py`. Live check: 2,519 stations, no contract problems.
- **1A step 6 done (2026-11-14):** `storage/state.py` (SQLite WAL; tables `entities`, `latest`,
  `events`, `source_state`, `runs`), `storage/archive.py` (part write via temp+rename, deduped
  reads, `as_of_observations`, `compact`, `export_runs`), `collect/pipeline.py` (`run_once`:
  change-only + daily keyframe, event version log + closing on complete feeds, invalid records
  dropped not fatal, `WRITE_LOCK`). Restart and isolation acceptance tests live in
  `tests/test_pipeline.py`. Live smoke: 2,519 stations as-of; a repeat Citi Bike run wrote 0 rows.
- **1A step 7 done (2026-11-14):** `collect/scheduler.py` (`Collector`: APScheduler jobs, backoff
  after 3 failures → `degraded`, startup + 01:15 UTC maintenance, `SingleInstance` lock,
  `keep_awake`, UTC rotating log), `status.py`, CLI `collect [--only] [--once] [--keep-awake]`,
  `status`, `compact`. Isolation acceptance test in `tests/test_scheduler.py`.
- **Repo:** public at https://github.com/alexxu2027/nyc-data (working name). MIT license. Ask
  before committing or pushing.
- Research behind the plan: `docs/research/cv-and-video-feeds.md` (hardware limits, DOT cam
  quality, YouTube streams, model menu).

## Scope (fixed)
Portfolio piece. All layers are in scope, replay comes after the live map, and it is a separate
project from Tandem (ADR-001). Hardware: CPU-only Windows-on-ARM laptop now, an RTX 3050 PC later.

## Gate A passed (2026-11-15 03:04 UTC)
`uv run python scripts/gate_a.py` → PASS: noaa 16/16, Citi Bike gbfs 3/3, status 77/77 runs ok over
1.27 h (none missed); an as-of snapshot at 21:59 NY time had all 2,519 stations in 0.27 s; no
duplicate keys after a real kill/restart at 02:19 UTC. Hourly open-day compaction verified live
at 03:07 (77 part files → 1; archive 92 files → 4, 0.3 MB), and the gate still passed after it. Adapter contract v1 is now
**frozen**.

**The collector is still running** (detached, hidden, `--keep-awake`) for the three 1A sources,
so history is accumulating. Log: `data/logs/collect.log`. It does not restart after a reboot;
start it again with `uv run nyclive collect --keep-awake`. To stop it: Task Manager → end the
`python.exe` running `nyclive collect`, or in PowerShell:
`Get-CimInstance Win32_Process | ? CommandLine -like '*nyclive*collect*' | % { Stop-Process -Id $_.ProcessId }`.
Restart it after adding adapters so it picks up new sources.

## ROADMAP 1B in progress (2026-11-15)
- ✅ Step 8 (conductor): `sources/_socrata.py`; `real` fixtures for all 11 remaining sources;
  `parse_fixture(module=)` so builders test before the registry names the adapter.
- ✅ B2 `dot_cameras` (conductor inline; 974 cameras live, no problems).
- ✅ B1 pilot `openmeteo` + `nws_alerts` (Opus builder in a worktree, merged; live OK). NWS
  expiration statements (onset > ends) are skipped by design.
- ⏳ Wave 2 running in parallel worktrees: B3 MTA (stations, alerts, elevators), B4 FloodNet,
  B5 311 + collisions, B6 DOT speeds. Briefs: `.orchestrate/1b/context.md` and `plan.md`
  (gitignored, local only).
- Then step 10 (conductor): merge, set `adapter:` in sources.yaml, `nyclive collect --once --only
  <id>` live for each, restart the collector, update DATA_SOURCES; one Fable review; Gate B.

## Open decisions
- ADR-009 hosting (decide in Phase 3).
- ADR-010 FloodNet live via FieldKit: 2 h spike any time after Gate A. Emailing the FloodNet team
  early would help, since their reply takes time. Until then: events only.
- Soak test: the laptop may not manage 48 h straight, so the criterion is 48 h total including one
  unbroken 24 h run.

## Gotchas found so far
- GBFS `last_reported: 86400` means inactive, not a real time.
- MTA elevator dates are local-time strings and include future planned outages. The feed has no
  station id; join through the equipments feed. Its `Content-Type` header is broken
  (`${header.s3FileType}`), so never branch on content type.
- 311: don't cursor on `:updated_at`; it is bulk-rewritten (571k rows in 2 days, created back to
  2020). See the registry notes for the two-query strategy.
- Socrata timestamps with no offset (`data_as_of`, `created_date`, `crash_date` + `crash_time`)
  are New York local time.
- DOT speeds: `link_points` is truncated mid-coordinate; use `encoded_poly_line`.
- NWS active alerts for NY can be empty; capture fixtures from `/alerts?area=NY`.
- Open-Meteo: request `timeformat=unixtime`.
- NOAA with `time_zone=gmt` returns `"2026-11-15 01:06"`: UTC with no offset. Use
  `timeutil.parse_naive_utc`, never `local_to_utc`.
- DOT speeds are about 2 h behind. FloodNet Open Data events are about 2 weeks behind.
- DOT camera frames are 352×240, a new one every ~2 s: count objects per frame rather than track
  them (ADR-008).
- A new `sources.yaml` field must be added to `registry.Source` first; loading names the unknown
  field otherwise.
- DuckDB is 2.x: use `con.sql(...).to_arrow_table()` (`fetch_arrow_table` is gone). Fetch
  TIMESTAMPTZ as Arrow, not Python objects (that path needs pytz).
- `core.autocrlf` is on; `.gitattributes` keeps fixtures byte-exact. Don't remove it.

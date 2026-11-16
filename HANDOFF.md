# HANDOFF: start here

_Last updated: 2026-11-16_

> **NEXT SESSION:** Phase 2.5 is built, reviewed and fixed (2026-11-16 morning; see "Pre-go-live
> fixes" below). It is NOT live yet. Next, in order:
> 1. When `scripts/soak_report.py` says `SOAK: PASS` (earliest Nov 16 ~8:50 PM ET), close Phase 1.
> 2. Restart the collector (the trains open-events fix is done). Watch the first `floodnet_live`
>    run (~2.3 min, 18 requests): with the #6 fix, its 48 h backfill must NOT fill the feed panel.
>    Watch the trains; after 24 h, measure the trains archive (budget ~6 MB/day).
> 3. Then the Phase 2.5 browser acceptance on live data. While doing it, watch review findings
>    #8 and #10 (below): they need live MTA behaviour to judge.
> Use `uv run --no-sync` while the soak runs. Also restart `nyclive serve` to pick up the API fixes.

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
at 03:07 (77 part files → 1; archive 92 files → 4, 0.3 MB), and the gate still passed after it.
Adapter contract v1 is now **frozen**.

(The Gate A collector covered only the three 1A sources; it now runs on all 14. Start/stop:
see "Collector: start / stop" below.)

## Gate B passed (2026-11-15 03:39 UTC): all 14 Phase 1 sources collected
- Built: `_socrata.py` + fixtures (conductor), B2 `dot_cameras` (conductor), B1 `openmeteo` +
  `nws_alerts` (pilot builder), then B3 MTA, B4 FloodNet, B5 311 + collisions, B6 DOT speeds
  (4 parallel Opus builders in worktrees, merged without conflicts). Conformance: 42/42.
- **The collector runs detached on all 14 sources** (`--keep-awake`), restarted 03:38 UTC on the
  fixed code. Same start/stop instructions as below.
- Fixed after merge (conductor):
  - FloodNet event times are **UTC** (checked against NOAA tides);
  - DOT speeds first-run lookback 1 h → 4 h (the feed lags ~2 h);
  - state v2 `events.last_seen`: prune by last seen, not by `ends_at` (old re-sent collisions and
    FloodNet events were being re-written every run).
- 311's first run hit its page cap (50,000 rows); the cursor catches up at up to 25k new rows per
  6-hour run, well above ~10k complaints/day.
- **Fable review of 1B (2026-11-15): 9 findings, 8 fixed** (232 tests):
  1. DOT speeds lost 8–21% of readings (batches overlap), so it now re-reads 15 min behind.
  2. Superseded or cancelled alerts with a future end were never closed; now they are.
  3. A cancelled planned outage could get ends_at < starts_at; it now ends at its start.
  4. The 311 closed query was already capped; it now gets 10 pages, and any cap logs a warning.
  5. Never-closed 311 requests grew state forever; they are pruned after 45 days unseen.
  6. An empty MTA payload would have closed every open event; it is now rejected (`bad_*`).
  7. and 9. Cursor ties, DST and future-dated rows: overlap and clamping.
  8. (not fixed, documented) ~0.15% of 311 rows are inserted late; see DATA_SOURCES.

## Phase 1: everything built; only the soak's wall-clock time is left
- ✅ 1C compact (hourly open day + daily closed days); ✅ FloodNet live spike → ADR-010 (public
  read works; full polling ≈ 13 MB/poll from an undocumented API, so not adopted until the
  FloodNet team OKs it; email them if you want live depth).
- ✅ Acceptance criteria met: conformance, restart, isolation, status, as-of smoke.
- ⏳ Soak + measured storage/CPU: the collector has run since 2026-11-15 01:48 UTC. At 2.6 h,
  `scripts/soak_report.py` showed every source ≥ 95% ok, ≈ 48 MB/day (incl. the one-off 311
  backfill), CPU 0.10% of the machine. **To close Phase 1:** leave the laptop plugged in and the
  collector running until the report says `SOAK: PASS` (48 h total incl. one unbroken 24 h that
  crosses UTC midnight, so the earliest is about 2026-11-17 01:50 UTC = Nov 16, 8:50 PM NY). Then
  copy its numbers into ARCHITECTURE §5 and tick the last two ROADMAP boxes.
- If the laptop sleeps or reboots, restart the collector; gaps are fine, the total just takes
  longer, but you need one unbroken 24 h stretch.

## Phase 2 (live map) in progress (2026-11-15), via /orchestrate Tier 2
- Plan: one Fable planner call, saved to `.orchestrate/p2/plan.md` (gitignored, local). It has 7
  units and frozen interfaces: §1 `config/layers.yaml`, §2 HTTP API, §3 `web/src/types.ts`,
  §4 store, §5 URL format, §6 UI kit, §7 layout and map styling.
- ✅ Wave 0 (conductor): `config/layers.yaml` (14 layers), `config/boroughs.geojson` (+
  `scripts/build_boroughs.py`), the `web/` scaffold (Vite 8, React 19, TS 6, MapLibre 6, Zustand 5,
  eslint, vitest), frozen `types.ts`, stubs; fastapi/uvicorn in the dev group.
- ✅ Wave 1 merged (2026-11-15). Builders paused at the usage limit and were resumed with their
  context.
  - U1 API: 70 tests; api_smoke on live data passes every threshold (311 2.96 MB, 34 ms warm;
    Citi Bike 304 on revalidate).
  - U2 UI kit: 22 tests; Gallery at `/?gallery=1`.
  - U3 core: 66 tests.
- ✅ Gate W1: `nyclive serve` + the built app show live counts for all 14 layers (borough=BK +
  Citi Bike filter → 180/2,519 stations, 206/974 cameras; health 14 ok).
- ✅ **Wave 2 merged (2026-11-16):** U4 shell (Sonnet), U5 map (Opus), U6 drawer (Sonnet), each
  resumed from its WIP branch. U4 and U6 needed no changes after review. U5 finished the MapLibre
  controller (worker URL fix for MapLibre 6 under Vite, `window.__nlMap` in dev only).
  - Checks on main: typecheck, lint, 165 vitest, build (chunk > 500 kB warning only), 302 pytest,
    ruff all pass.
  - The conductor's 10-item browser check list (plan "Order") passes on `nyclive serve` + build:
    - first paint 0.52 s; MN filter changes every layer and drops NJ;
    - the URL round-trips byte-identical; camera frames come every 3.0 s and stop on close;
    - phone sheets have three detents with no horizontal scroll;
    - the NWS empty state, the tide surge, and health 14/14 all show.
  - Docs done (uncommitted at handoff): ARCHITECTURE §6 and §7, the DATA_MODEL borough note,
    ADR-012 (layer catalog), DEV_SETUP web section, and the ROADMAP Phase 2 acceptance boxes ticked.
  - **Opus review (2026-11-16):** 1 real bug (a feature-state crash during a theme swap), 1 camera
  remount and 1 missing test, all fixed in `352840f`. Untested helpers were left as is. Untested by
  hand: the reduced-motion pulse, keyboard-only traversal, and the flood event / 311 / collision /
  NWS detail views.

### Phase 2 wrap-up: ✅ done (docs committed and pushed, worktrees and wip branches deleted)
- Run it: `cd web && npm run build`, then `uv run --no-sync nyclive serve`, then open
  http://127.0.0.1:8000/. Dev: `nyclive serve` + `cd web && npm run dev` (port 5173).
- Main checkout: use `uv run --no-sync` until the soak ends.

## Phase 2.5 liveness (2026-11-16, /orchestrate Tier 2, no Fable)
- Plan: `.orchestrate/p25/plan.md` (local, gitignored), with conductor notes after each wave.
- Units on main:
  - U0 freeze (Sonnet): catalog, types and stubs, ADR-013.
  - U1 FloodNet live (Sonnet): joins 433/435 active stations by location; batches of 25; the
    drawer has a 48 h depth chart.
  - U2 trains backend (Opus): stdlib GTFS-rt decoder, `mta_trains` adapter,
    `config/subway_static.json`, API segments; 244 trains live in the test run; ~6 MB/day.
  - U3 radar and animated trains (Opus).
  - U4 `/api/changes` feed, ticker, CHANGES panel and change pulse (Opus).
- Checks: 378 pytest, 227 vitest, ruff, typecheck, lint, build all pass. On the main server: the
  feed lists 30 real items, the radar shows; trains and flood sensors say "FEED NOT COLLECTED YET"
  until the collector restarts.
- Known gaps:
  - The change ring is covered only by unit tests.
  - Feed "seen" state isn't kept across reloads.
  - `/api/changes` ETag changes every 30 s (the body has `now`), with no re-render.
  - Radar tiles stop at zoom 7.
  - FloodNet depth lag is up to ~45 min.
- No independent review yet (usage).

### Pre-go-live fixes (2026-11-16 morning, uncommitted until Alex OKs)
Working notes: `.orchestrate/p25/progress.md` and the review in `.orchestrate/p25/review.md`
(both local).
- **Trains load fix:** `StateStore.events_for_run` loads the batch's own ids plus, for
  complete feeds, the still-active events. 60k stored trips: 666 ms → 23 ms per run.
- **Small gaps closed:**
  - The `/api/changes` ETag now covers items only (`etag_basis`), so polls get 304s again.
  - The feed's seen mark is kept in localStorage (`web/src/feed/seen.ts`).
  - The change ring was checked live in a browser: a real Citi Bike poll rang 1 dot over 12
    steps, then cleared.
- **Independent Opus review: 10 findings, 8 fixed with tests** (the tests for #4, #7 and #9 were
  run against the old code and fail there):
  1. A trip that left the feed before its start was re-closed every run. It is now closed once.
  2. After-midnight trips started a day late: NYCT dates them by calendar day. Starts more than
     6 h ahead of the header move back a day.
  3. Ghost trains: 53 of 260 fixture vehicles had positions 30 min to 25 h old. Vehicles more
     than 30 min older than their feed header are dropped.
  4. A merged FloodNet flood came back about 48 h later as a new episode. Runs within
     MAX_DRY_GAP + 1 buckets of the oldest bucket are skipped.
  5. FloodNet episodes could stay open forever. The batch is now complete for events (only when
     some sensor answered).
  6. `/api/changes`: FloodNet items must have started inside the window, so the first run's 48 h
     backfill isn't "new".
  7. A server-filter change rang every dot. The next 200 after a filter change, or after the
     layer comes back on, is treated as a first load.
  9. Under reduced motion, trains never turned hollow when stale. The stale check now still runs.
- **Deferred (PLAUSIBLE; watch on live data after the restart):**
  - #8: one legitimately empty line feed (e.g. a weekend G shutdown) fails the whole trains run.
  - #10: a trip missing for one poll is closed and reopened (2 rows, and its dot jumps back).
- Checks: 386 pytest, 233 vitest, ruff, typecheck, lint, build all pass.

### Transcript motion (2026-11-16, uncommitted until Alex OKs)
Five moments that use the motion kit from `styles/motion.css`. Each has a cause, and under
reduced motion each shows its finished frame.
- **CHANGES list:** the rows marked NEW print when the panel opens, then each poll's arrivals
  print, newest first, staggered 45 ms.
- **Ticker:** a new latest change types out (paced by length, ≤ 650 ms) with a cursor that
  blinks a few times. Not on the first load.
- **Drawer:** a newly opened detail prints its rows top to bottom, including the rows that arrive
  with the first fetch (900 ms window). Live refreshes after that don't replay it.
- **Counts:** `Num deal` drops digits in on a real change (layer rows, FEATURES total, FEEDS OK).
- **Boot log** (`shell/BootLog.tsx`, desktop only): once per visit (sessionStorage), the first
  `/api/health` answer prints a FEED CHECK panel over the map's bottom-right corner. It holds,
  then rolls up into "N OF M FEEDS OK". Skipped under reduced motion, in a hidden tab, or if
  health takes more than 8 s.
- Helpers are in `ui/motion.ts` (`useArrivals`, `usePrintRows`, `useChangeKey`, `typeTiming`).
  `.print-row` uses `backwards` fill and a wide clip on purpose: a resting clip-path cut off the
  gutter line numbers (found in the browser check).
- Checked live in Chrome on the dev server; 244 vitest, typecheck, lint and build pass.

### UI/UX review run (2026-11-16, in progress; plan `.orchestrate/ux/progress.md`, review `.orchestrate/ux/review.md`)
An Opus reviewer checked the live app (desktop, phone in an iframe, dark theme) and found
12 scroll regions to fix, 19 clarity findings and 11 bugs.
- **Step 2, scroll bars ✅:** one treatment for every `.panel-body` and `.bsheet-body`
  (`styles/base.css`): a paper track with a 1px faint rule and a 3px square ink bar (5px on
  hover), no arrows, `scrollbar-gutter: stable`, and the body's right padding giving back the
  gutter so head, body and foot share one right edge. Tokens only, so dark theme and `.screen`
  panels invert. Firefox gets `scrollbar-width/color` in an `@supports` branch (in Chrome,
  setting those turns the webkit rules off). Also: the desktop drawer has one scroller (it had
  two), each phone sheet has exactly one (the layer sheet showed two bars side by side), and the
  phone detail sheet's SOURCE footer stays pinned. Checked in Chrome: desktop light and dark,
  and phone layer and detail sheets.
- **Step 3a, quick clarity wins ✅:**
  - Footer key: `[X] SHOW · [+] KEY & FILTERS`, plus the missing `◌ NO DATA YET`.
  - A feed with no data shows `--` and one `NO DATA COLLECTED YET` line.
  - REFRESH and NEXT are split, so nothing is cut off.
  - Camera drawer drops the misleading AS OF.
  - Map tooltips end with `CLICK FOR DETAIL`.
  - Tide chip shows `=` for steady and `SURGE +0.6`; chips get a title.
  - Station drawer has a `TYPE` row. Weather precipitation is in inches. Citi Bike says `BIKES
    IN 24% OF DOCKS`, and its colour key is numeric (0%…100%).
  - Floods is renamed `Past floods`, with honest pulse copy.
  - CHANGES is 64ch wide, with NEW/ENDED columns and a key line.
  - Borough chips no longer jump (3-column top bar).
  - Phone status reads `6:17 AM ET | 3,795 ON MAP`.
  - Rule lines clip to whole characters.
  - The YAML changes (Past floods, Citi Bike key) show after `nyclive serve` restarts.
- **Step 3b, medium clarity ✅:**
  - ABOUT starts with HOW TO READ THE MAP, and the layer panel shows a one-time `NEW HERE?
    [HOW TO READ THIS MAP]` pointer until ABOUT is opened (localStorage).
  - The count column has an `ON MAP` header.
  - Lagging layers say `DATA FROM 7 D AGO` on the row. Cameras are exempt: their frames are live.
  - Alerts: the key says each dot is a station, and the not-on-map note no longer contradicts the
    filtered list.
  - Phone has `[CHANGES]`; `[DARK]` moves into ABOUT there.
  - List items fold behind `[MORE]` (486 → 206 lines), and MTA `[… icon]` text becomes `[BUS]` etc.
  - The status line says `UPDATED 10 S AGO` instead of a countdown.
  - The phone detail sheet has one header with `[CLOSE]`.

## Collector: start / stop
`uv run nyclive collect --keep-awake` starts it (it doesn't survive a reboot). To stop it: Task
Manager → end the `python.exe` running `nyclive collect`, or in PowerShell:
`Get-CimInstance Win32_Process | ? CommandLine -like '*nyclive*collect*' | % { Stop-Process -Id $_.ProcessId }`.
Restart it after adding or changing adapters. Logs: `data/logs/collect.log`.

## Open decisions
- ADR-009 hosting (decide in Phase 3).
- ADR-010 FloodNet live: **the FloodNet team OK'd polling (2026-11-16).** Building the
  `floodnet_live` adapter (ADR-010 "ready design": 50 stations per batch every 30 min, depth only,
  change-only) is open work. Adding it means restarting the collector, so do it after the soak passes.
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
- MTA GTFS-rt: `start_date` on after-midnight trips (origin code 24:xx+) is the calendar day, not
  the service day. The feeds also keep finished vehicles for hours: check `VehiclePosition.timestamp`.
- `core.autocrlf` is on; `.gitattributes` keeps fixtures byte-exact. Don't remove it.

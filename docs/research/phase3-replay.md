# Phase 3 replay: implementation plan (2026-11-16)

Goal (ROADMAP Phase 3): scrub back in time over everything archived. Acceptance: any minute in the
last 30 days replays in < 2 s per layer, 600× playback is smooth, and gaps are visibly marked.
Not started. This plan slots into what exists: the same layer builders, the same catalog, the same
frontend renderers. Only the source of "current state" changes.

## 1. The one decision: replay shows what the map knew at t
Replay at t shows **what our map would have shown at t**: the newest version of every row
*written* at or before t (archive `updated_at` / `fetched_at` ≤ t). It does **not** show "what
happened at t" by event time.
- That's the honest version of the late feeds. Replaying Monday 5 PM shows 311 as it stood then,
  38 h behind, with the same lag note. Event time would quietly fill in rows we didn't have yet.
- It makes the past immutable. Nothing written later has `updated_at` ≤ t, so a replay frame for
  any t older than a few minutes never changes and can be cached forever.
- Event-time questions ("what was reported for 5 PM yesterday?") remain a filter on `starts_at`.
  They belong to "Ask the map", which gets an `as_of(t)` tool from this phase for free.

To record as **ADR-016** at step 0.

## 2. Backend: rebuild state.db as of t, then run the unchanged builders
Every builder reads `state.db` through `Ctx(conn, now)`. Replay builds an **in-memory SQLite with
the same schema** (`state.SCHEMA`), filled from the Parquet archive as of t, and calls the same
builder with `now = t`. No builder changes. Live and replay can't drift apart, because they're one
code path.

New module `storage/snapshot.py`, `state_at(archive_dir, sources, t) -> sqlite3.Connection`:

| state.db table | Built from the archive as of t |
|---|---|
| `latest` | `as_of_observations` (exists). Change: also read date(t) − 1. A value that changed between midnight and the day's first keyframe is otherwise missing for a t in that gap. |
| `entities` | Newest version per (kind, entity_id) with `last_seen` ≤ t. The daily entity keyframe bounds this to the same partitions as `latest`. |
| `events` | Newest version per (source, event_id) with `updated_at` ≤ t, plus `first_seen` = min(`updated_at`) over that event's versions. The archive has no first_seen column; CHANGES dates items by it. |
| `source_state` | `last_success`, `last_attempt`, `rows_last_run`, `consecutive_failures` from the archived `runs` ≤ t (`source=_collector`), and from `state.db.runs` for today, which isn't exported yet. `lag_s` and `cursor` are null. |
| `runs` | Runs in [t − 24 h, t], for the health panel in replay. |

`last_seen` for events and entities isn't archived. It's set to the source's last ok run ≤ t when
the row is still open then. Complete feeds re-see every open row on each run, so that's exact for
them. The trains builder ("seen in the last 120 s") then works unchanged.

**Event history is the only unbounded read.** Observations and entities have a daily keyframe, so
2–3 partitions are enough. Events don't: an elevator outage opened three weeks before t has its
only version three weeks back. Measured today: newest-version-as-of-t over all of 311's history
(124k rows, 2 days) takes **0.14 s**, and subway alerts and elevator outages take 0.05 s. That
grows with the archive, so:
- **Step 0 spike:** time it on a synthetic 30-day archive (`scripts/bench_replay.py` copies the
  real days forward with shifted dates).
- **If 311 events at 30 days take > 0.7 s**, add a derived **daily open-events file**, written by
  `compact` for each closed day (`table=events_open`): every event open at the day's end, or
  started within the longest layer window (7 d). As of t is then that file for date(t) − 1 plus
  the versions in date(t) and date(t) + 1. The collector pipeline doesn't change, and the file
  can be rebuilt from the archive at any time.

**Snapshot cache:** t is snapped to the minute. Snapshots are cached in a small LRU keyed by
(t, source set). Most layers have one source, so a frame of 6 visible layers is about 6 snapshots.
Build them once per minute frame, not per request.

## 3. API
| Endpoint | Behaviour |
|---|---|
| `GET /api/layers/{id}/at?t=` | Same params and response shape as the live endpoint, plus `meta.replay_t`, and `meta.gap: true` when t falls in a collector gap for any of the layer's sources. A t older than 10 min gets `Cache-Control: public, max-age=31536000, immutable`. |
| `GET /api/timeline?from=&to=&bucket=1h` | Per bucket: new events per layer, active alerts, max flood depth, and per-source gap intervals (no ok run for > 3× the cadence). Cached per closed day. Feeds the sparkline and "jump to". |
| `GET /api/changes?at=` | `change_items(snapshot, now=t)`. Same items as live. |
| `GET /api/entities/{kind}/{id}?at=` and `/series?…&end=` | The drawer in replay: latest values from the snapshot, and the chart window ending at t. |
| `GET /api/health?at=` | From the snapshot's `source_state` and `runs`. |

**Not replayable**, and said so in the UI rather than hidden:
- **Radar:** RainViewer keeps only about 2 h of frames, and we don't archive tiles. The layer is
  greyed out with a "LIVE ONLY" note.
- **Camera images:** no frames are archived until Phase 4 watchlist frames exist. Positions
  replay, and the drawer says "NO PICTURE HISTORY".

## 4. Frontend
- **Store:** `mode: {kind: 'live'} | {kind: 'replay', t, playing, speed}`, mirrored in the URL
  (`?t=2026-11-16T22:00Z`), so a replay moment is a shareable link.
- **Fetching:** in replay, `poll.ts` stops polling and fetches `/at?t=` for visible layers on each
  step, with the next frame prefetched while playing. The existing ETag cache handles repeat
  frames.
- **Time bar** (transcript-ui), one `.l` row at the bottom, plus one row for the sparkline:
  ```
  [LIVE]  ◀  MON 16 NOV  5:00 PM  ▶   [PLAY 60×] [600×]   JUMP: MAX FLOOD · MOST ALERTS
  ▁▁▂▃▅▇▅▃▂▁▁▁////▁▂▃▃▂▁▁▂▅▇▇▅▃▂▁   (activity per hour; //// = collector down)
  ```
  The sparkline is typed block characters, so it sits on the line grid with no chart library.
  Scrubbing steps by whole minutes (`steps()` motion), and gaps are hatched with typed `////`.
- **Playback:** 60× is one 1-min frame per second. 600× is one 5-min frame every 0.5 s, for
  about 12 fetches/s across 6 layers, all cacheable. Trains animate on the replay clock at 60×;
  at 600× they're drawn as stopped dots, since stop-to-stop motion is a blur at that speed.
- **Status line:** `REPLAY · MON 5:00 PM · 2 H AGO`. Lag notes are measured against t, not the
  wall clock. CHANGES shows the items as of t, and NEW / ENDED are relative to the previous
  frame.

## 5. Steps
| # | Unit | Size | Notes |
|---|---|---|---|
| 0 | Spike + ADR-016 | ½ day | `bench_replay.py` on a synthetic 30-day archive; decide on `events_open`; record the semantics. |
| 1 | `storage/snapshot.py` | 1 day | **The key test: replay at the last run's time equals live.** Run the pipeline on fixtures, then compare every builder's output from `state.db` with its output from `state_at(t = last run)`. That catches every reconstruction bug at once. Plus a closed-event test, a pre-keyframe test and a gap test. |
| 2 | API endpoints + caching | 1 day | `/at`, `/timeline`, `?at=` on changes, entities and health; immutable caching; the radar and cameras notes. |
| 3 | Frontend mode, URL, fetching | 1 day | Store mode, URL sync, replay fetch, prefetch, status line. |
| 4 | Time bar | 1 day | Scrub, play, sparkline, gaps, jump-to; reduced-motion still frame; phone layout (a two-line bar). |
| 5 | Per-layer polish + perf check | ½–1 day | Trains clock, 311 lag note at t, drawer in replay; measure < 2 s per layer on the 30-day bench. |

About 5–6 days. Two builders could run in parallel after step 2 fixes the API contract: Opus on
backend steps 1–2, Sonnet on frontend steps 3–4.

## 6. Prerequisites and open questions
- **Always-on collector box (ADR-009)** before *acceptance*. The test needs 30 continuous days,
  and laptop sleeps show up as gaps. The build can start now on the laptop's archive; its real
  gaps will exercise the gap rendering.
- **Retention:** keep the archive indefinitely? At the measured ≈ 5 MB/day (soak numbers pending)
  that's under 2 GB a year, so probably yes. Decide in ADR-016.
- **Public site:** live replay of the last 30 days, or only the Phase 6 frozen demo day? It
  depends on the hosting choice.

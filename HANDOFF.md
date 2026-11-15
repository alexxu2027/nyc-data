# HANDOFF: start here

_Last updated: 2026-11-14_

## Where things stand
- **Phase 0 (foundations) is done.**
  - Docs: `docs/PRD.md`, `ARCHITECTURE.md`, `DATA_MODEL.md`, `DATA_SOURCES.md`, `ROADMAP.md`,
    `DECISIONS.md`, `DEV_SETUP.md`.
  - Source registry: `config/sources.yaml` (21 sources).
  - CLI: `uv run nyclive sources` and `uv run nyclive probe`.
  - Tests: 3 offline tests pass, lint is clean.
- **Last probe (2026-11-14):** 19 of 21 feeds healthy with no keys. OpenAQ and Bus Time were
  skipped because they need keys.
- Git repo initialized, **nothing committed yet** and no remote. Ask Alex before the first
  commit or any push.
- Research behind the plan: `docs/research/cv-and-video-feeds.md` (hardware limits, DOT cam
  quality, YouTube streams, model menu). Non-NYC research (prediction markets, general data
  sources) is kept outside this repo (local `~/research-notes/`).

## How this project came about (context for a fresh session)
Alex wanted to experiment with computer vision on live video, then widened it to "a home for all
the NYC data we can access, combined with the cameras, plus a UI to toggle and filter". Their
answers to the scoping questions: **portfolio piece**, **everything** (all layers), **replay
later**, **separate project from Tandem**. Hardware: CPU-only ARM laptop now, an RTX 3050 PC later.

## Next: Phase 1, collectors & archive
**Suggested execution:** build the shared base (steps 1–4 below) yourself, in order. The ~11
adapters after that are independent, which is a good fit for the user-level `/orchestrate` skill
at Tier 2 (Fable plan → parallel Opus builders → Fable review). The skill exists but hasn't been
tried yet. Offer it, don't assume it.
Follow the task list in `docs/ROADMAP.md` → Phase 1, in order. The first concrete steps:
1. `uv sync --extra collect`
2. Write `settings.py`, `http.py`, `model.py`, then `storage/state.py` and `storage/archive.py`.
3. Add `nyclive capture <source>` and capture fixtures for all Phase 1 sources.
4. First adapter: `noaa_tide_battery` (smallest payload) with a parser test, then work down the list.

## Open decisions
- ADR-009 hosting (decide in Phase 3).
- ADR-010 FloodNet live via FieldKit: Phase 1 spike, time-boxed to 2 h.

## Gotchas found so far
- GBFS `last_reported: 86400` means inactive, not a real time.
- MTA elevator dates are local-time strings and include future planned outages.
- DOT speeds are about 2 h behind. FloodNet Open Data events are about 2 weeks behind.
- DOT camera frames are 352×240, a new one every ~2 s: count objects per frame rather than track
  them (ADR-008).

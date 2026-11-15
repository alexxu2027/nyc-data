# NYC Live: notes for Claude

- Start every session from `HANDOFF.md`, then `docs/ROADMAP.md` for the current phase's tasks and
  acceptance criteria. Update `HANDOFF.md` at the end of a working session.
- Background research lives in `docs/research/`. Read it before Phase 4 (CV) work.
- Ask before committing or pushing.
- `config/sources.yaml` is the source of truth for feeds. Add a source there first, then update
  `docs/DATA_SOURCES.md`, then write the adapter.
- Adapters: `fetch` does network only, and `parse` is pure and tested on fixtures in
  `tests/fixtures/<source>/`. `pytest` must never hit the network unless marked `live`.
- Store times in UTC and render in America/New_York. Normalize boroughs to MN/BK/QN/BX/SI.
- Phases 1–4 must stay keyless (a test enforces it). Never commit `.env` or anything in `data/`.
- Be polite to public APIs: respect cadences and TTLs, and send one request at a time per host.
- CV counts objects only. No face or plate recognition, and no tracking individuals.
- Record significant design choices as a new ADR in `docs/DECISIONS.md`.
- Env: Windows on ARM laptop, uv + Python 3.12 (x64 build), CPU only. An RTX 3050 PC comes later.

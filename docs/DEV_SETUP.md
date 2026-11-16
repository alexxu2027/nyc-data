# NYC Live: Dev Setup

## Laptop (current): Windows 11 on ARM, Snapdragon X Elite, 32 GB, no CUDA
Already installed (checked 2026-11-14): `uv` 0.11 (native ARM64), Node 24, git.

```bash
cd ~/nyc-live
uv venv --python cpython-3.12-windows-x86_64   # x64 build on purpose (ADR-002); .python-version pins 3.12
uv sync                        # core deps include the Phase 1 collector stack
uv run pytest                  # offline tests
uv run pytest -m live          # also hits the real feeds
uv run nyclive probe           # feed health table
uv run ruff check src tests    # lint
```

Collecting:
```bash
uv run nyclive collect --keep-awake      # all sources with an adapter; Ctrl+C stops it
uv run nyclive collect --once --only citibike_station_status   # one run, then exit
uv run nyclive status                    # per-source health (works while collecting)
uv run nyclive compact                   # compact closed days (collect also does this)
```
Logs: `data/logs/collect.log` (UTC, rotated daily, 14 kept). Only one collector can run per data
dir (`data/collect.lock`).

Optional extras get installed when their phase starts:
```bash
uv sync --extra api            # Phase 2: FastAPI, uvicorn
uv sync --extra cv             # Phase 4: ultralytics (pulls PyTorch and OpenCV)
uv sync --extra transit        # Phase 5: GTFS-rt protobuf bindings
```

**Phase 4 note (ARM):** under emulated x64 Python, PyTorch CPU inference works but is slower. If
`yolo11n` can't keep up with about 20 cams every 30 s, try a native ARM64 Python
(`uv python install cpython-3.12-windows-aarch64`). This is **not** drop-in: the lockfile has no
win_arm64 wheels for pyarrow, torch or opencv (duckdb and numpy do), so it would need a separate
CV-only environment. Measure first (ROADMAP Phase 4 benchmark spike).

**Keeping collectors running on the laptop:** Windows will sleep and pause collection. During
Phases 1–2 that's acceptable, and the `runs` table shows the gaps. To reduce them, plug in and run
`nyclive collect --keep-awake`, which blocks sleep while it runs.

## Web app (Phase 2)
Needs Node 24 / npm 11 and the API extra (`uv sync --extra api`).
```bash
cd web && npm install
npm run build            # → web/dist
cd .. && uv run nyclive serve        # API + app at http://127.0.0.1:8000/
```
Dev loop: keep `uv run nyclive serve` running and, in `web/`, run `npm run dev` (port 5173,
proxies `/api` to :8000). Checks in `web/`: `npm run typecheck`, `npm run lint`, `npm run test`.
The UI kit gallery is at `/?gallery=1`.

## RTX 3050 PC (later, always-on box)
1. Install git, uv, Node, and the current NVIDIA driver.
2. `git clone https://github.com/alexxu2027/nyc-data`, then `uv sync --extra api --extra cv`.
3. Install the CUDA build of PyTorch. With uv this needs a `[tool.uv.sources]` entry pointing
   torch at the PyTorch CUDA index (pick the CUDA version from pytorch.org's selector), or
   `uv sync` will put the CPU wheel back. Verify with `uv run python -c "import torch; print(torch.cuda.is_available())"`.
4. Set `NYCLIVE_DATA_DIR` to a big disk. Run `collect`, `serve` and `cv` as startup tasks
   (Task Scheduler or NSSM).
5. Copy `data/archive/` over from the laptop. It's plain Parquet, so history merges by partition.

## Environment variables
See `.env.example`. **None are required for Phases 1–4.**

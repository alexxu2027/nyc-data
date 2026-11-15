# NYC Live: Dev Setup

## Laptop (current): Windows 11 on ARM, Snapdragon X Elite, 32 GB, no CUDA
Already installed (checked 2026-11-14): `uv` 0.11 (native ARM64), Node 24, git.

```bash
cd ~/nyc-live
uv sync --python 3.12          # creates .venv with the x64 Python 3.12 build (ADR-002)
uv run pytest                  # offline tests
uv run pytest -m live          # also hits the real feeds
uv run nyclive probe           # feed health table
uv run ruff check src tests    # lint
```

Optional extras get installed when their phase starts:
```bash
uv sync --extra collect        # Phase 1: APScheduler, pyarrow, duckdb, gtfs-rt bindings
uv sync --extra api            # Phase 2: FastAPI, uvicorn
uv sync --extra cv             # Phase 4: ultralytics (pulls PyTorch), OpenCV headless
```

**Phase 4 note (ARM):** under emulated x64 Python, PyTorch CPU inference works but is slower. If
`yolo11n` can't keep up with about 20 cams every 30 s, try a native ARM64 Python
(`uv python install cpython-3.12-windows-aarch64`). PyTorch publishes Windows ARM64 CPU wheels.
Confirm OpenCV installs before switching.

**Keeping collectors running on the laptop:** Windows will sleep and pause collection. During
Phases 1–2 that's acceptable, and the health panel shows the gaps. To reduce them, plug in and set
"sleep: never" while collecting.

## Web app (Phase 2)
```bash
cd web
npm create vite@latest . -- --template react-ts   # one-time scaffold
npm install maplibre-gl zustand
npm run dev                                       # proxies /api to http://localhost:8000
```

## RTX 3050 PC (later, always-on box)
1. Install git, uv, Node, and the current NVIDIA driver.
2. `git clone` the repo, then `uv sync --extra collect --extra api --extra cv`.
3. Install the CUDA build of PyTorch (pick the CUDA version from pytorch.org's selector), then
   verify with `uv run python -c "import torch; print(torch.cuda.is_available())"`.
4. Set `NYCLIVE_DATA_DIR` to a big disk. Run `collect`, `serve` and `cv` as startup tasks
   (Task Scheduler or NSSM).
5. Copy `data/archive/` over from the laptop. It's plain Parquet, so history merges by partition.

## Environment variables
See `.env.example`. **None are required for Phases 1–4.**

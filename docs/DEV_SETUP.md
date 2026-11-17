# NYC Live: Dev Setup

## Dev laptop (Surface Laptop 7): Windows 11 on ARM, Snapdragon X Elite, 32 GB, no CUDA
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

## Always-on hosting (ADR-009, planned 2026-11-17)
Two home machines, one job each, and **exactly one collector running at any time** (two would
fetch every feed twice, and the archive expects one writer).

| Machine | Role | Runs |
|---|---|---|
| **Surface Laptop 3** (i5, 16 GB, Wi-Fi) | Main server, always on | `collect`, `serve`, Cloudflare Tunnel |
| **Gaming PC** (RTX 3050) | GPU helper + warm standby | Phase 4 `cv` worker (sends counts to the Surface), a live copy of the archive, the takeover script |

The Surface Laptop 7 (Snapdragon, this dev laptop) goes back to being a dev machine only.

### 1. Wipe the Surface Laptop 3
1. Copy off anything you still want from it.
2. Settings → System → Recovery → **Reset this PC** → **Remove everything** → **Cloud
   download** → Change settings → **Clean data: Yes** (slower, but it really erases).
3. Set it up with your Microsoft account (or a local one). Run Windows Update until nothing is
   left, including the Surface firmware updates. Then set **active hours** so updates restart
   only at night.
4. Keep Windows 11 rather than Linux: the SL3's keyboard and touchpad need a custom kernel
   (linux-surface) on Linux, and nothing here needs Linux.

### 2. Make it an always-on box
1. **Battery limit:** power off, hold volume-up while pressing power to open Surface UEFI →
   Boot configuration → **Enable Battery Limit** (charge stays near 50%, so a battery that's
   always plugged in won't swell).
2. Settings → System → Power: when plugged in, **Sleep: Never** (the screen can turn off).
3. Control Panel → Power Options → "Choose what closing the lid does": **Do nothing** (plugged
   in).
4. Device Manager → Network adapters → Wi-Fi → Power Management: untick **"Allow the computer
   to turn off this device"**.
5. Place it with good Wi-Fi signal and airflow (not on a bed or in a drawer). Wi-Fi is enough:
   the collector averages under 1 Mbps (about 6 GB/day), and failed fetches retry and back
   off.

### 3. Install NYC Live
1. Install git, uv and Node (LTS). `git clone https://github.com/alexxu2027/nyc-data`, then
   `uv sync --extra api` and `cd web && npm ci && npm run build`.
2. **Move the data from the dev laptop** (one collector at a time):
   - stop the collector on the dev laptop (see HANDOFF "Collector: start / stop");
   - copy the whole `data/` folder (`state.db` + `archive/`, ~150 MB) to the Surface, by
     USB stick or OneDrive;
   - start the collector on the Surface.

   The gap is a few minutes.
3. **Start on boot, restart on failure:** Task Scheduler tasks for `uv run nyclive collect
   --keep-awake` and `uv run nyclive serve`, triggered "At log on" (auto sign-in) or "At
   startup", with "If the task fails, restart every 1 minute". (A script to create both:
   `scripts/install_tasks.ps1`, written at setup time.)
4. Check: `uv run python scripts/golive_check.py` and `uv run nyclive status`.

### 4. Public site (Cloudflare Tunnel + Vercel)
- On the Surface: install `cloudflared` and create a named tunnel to `http://localhost:8000`.
  It gets a stable `*.cfargotunnel.com` hostname (or a custom domain, about $10/yr). No router
  ports are opened.
- On Vercel: deploy `web/` as a static site, with a rewrite `/api/*` → the tunnel URL, so the
  map stays same-origin and the frontend code doesn't change.
- Cloudflare caches the API responses (they already send ETags), so visitors don't add load
  to the Surface or to the city's feeds. The collector polls on its own schedule.

### 5. Gaming PC: helper and standby
1. Install git, uv, Node and the current NVIDIA driver. Clone, then `uv sync --extra api
   --extra cv`.
2. CUDA PyTorch: add a `[tool.uv.sources]` entry pointing torch at the PyTorch CUDA index (pick
   the version from pytorch.org's selector), or `uv sync` puts the CPU wheel back. Verify with
   `uv run python -c "import torch; print(torch.cuda.is_available())"`.
3. **Backup copy:** install **Syncthing** on both machines and share the Surface's
   `data/archive/` folder (send-only) to the PC (receive-only). Parquet files never change once
   compacted, so the copy is cheap and safe. Copy a nightly `state.db` snapshot too (SQLite
   backup API, `scripts/snapshot_state.py`, written at setup time).
4. **Takeover** (if the Surface dies): `scripts/takeover.ps1` (written at setup time) checks the
   Surface's collector really is stopped, then starts `collect`, `serve` and the tunnel on the
   PC from the synced copy. **Never run it while the Surface is collecting.**
5. Phase 4: the `cv` worker runs here and sends its counts to the Surface over the home
   network. It pauses when a game is running and when the PC is off; the map says "no recent
   counts".

### 6. Spare devices
- **iPhone 13 (unused):**
  - **Phone test device:** real Safari on iOS for the phone layout and the twist-to-rotate
    gesture.
  - **Watchdog:** with the free **ntfy** app subscribed to a private topic, the collector can
    push a notification when a feed degrades or stops (a few lines, added at setup).
  - **Backup internet:** USB tethering to the Surface if home Wi-Fi is down for a long time.

## Environment variables
See `.env.example`. **None are required for Phases 1–4.**

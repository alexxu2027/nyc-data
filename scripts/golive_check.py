"""Go-live check for the Phase 2.5 feeds, run after the post-soak collector restart.

Reads state.db (read-only), the archive folder, the collector log and the running API
(`nyclive serve`, default http://127.0.0.1:8000). It prints PASS / WAIT / WARN / FAIL per check,
then an overall line. WAIT means "too early, run it again in a few minutes": trains need about
5 min, and the first floodnet_live run lands a few minutes after start, then every 30 min.

    uv run --no-sync python scripts/golive_check.py [--api http://127.0.0.1:8000]

Checks (HANDOFF "NEXT SESSION" steps 2-3, review fixes #6, #8, #10):
  trains runs     mta_subway_realtime: >= 5 runs in the last 10 min, >= 90% ok
  trains layer    /api/layers/subway_trains: >= 20 trains, data newer than 3 min
  trains health   /api/health says ok
  trains budget   archive MB/day projected from the time since the first run (budget ~6)
  flood runs      floodnet_live: >= 1 ok run; the newest took < 6 min (~18 requests)
  flood layer     /api/layers/flood_sensors: live depth on >= 300 sensors
  flood changes   /api/changes: <= 10 FloodNet items (the 48 h backfill must not flood it)
  log errors      collect.log ERROR lines for the two feeds since the first run
"""

from __future__ import annotations

import argparse
import json
import sqlite3
import urllib.request
from datetime import UTC, datetime, timedelta
from pathlib import Path

from nyclive.settings import load_settings

TRAINS, FLOOD = "mta_subway_realtime", "floodnet_live"
BUDGET_MB_DAY = 6.0
RESULTS: list[tuple[str, str, str]] = []


def check(name: str, state: str, detail: str) -> None:
    RESULTS.append((state, name, detail))
    print(f"[{state:4}] {name}: {detail}", flush=True)


def get(api: str, path: str) -> dict:
    with urllib.request.urlopen(api + path, timeout=30) as r:
        return json.load(r)


def runs(db: Path, source: str, since: datetime) -> list[sqlite3.Row]:
    con = sqlite3.connect(f"file:{db}?mode=ro", uri=True)
    con.row_factory = sqlite3.Row
    try:
        return con.execute(
            "SELECT * FROM runs WHERE source = ? AND started_at >= ? ORDER BY started_at",
            (source, since.isoformat()),
        ).fetchall()
    finally:
        con.close()


def when(s: str) -> datetime:
    return datetime.fromisoformat(s)


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    ap.add_argument("--api", default="http://127.0.0.1:8000")
    args = ap.parse_args()
    st = load_settings()
    now = datetime.now(UTC)
    ever = datetime(2000, 1, 1, tzinfo=UTC)

    # ---- trains
    all_trains = runs(st.state_db, TRAINS, ever)
    recent = runs(st.state_db, TRAINS, now - timedelta(minutes=10))
    if not all_trains:
        check("trains runs", "WAIT", "no runs yet: is the collector restarted on the new code?")
    else:
        ok = sum(r["ok"] for r in recent)
        state = "PASS" if len(recent) >= 5 and ok >= 0.9 * len(recent) else (
            "WAIT" if len(recent) < 5 else "FAIL")  # fmt: skip
        last_err = next((r["error"] for r in reversed(recent) if not r["ok"]), None)
        check("trains runs", state, f"{ok}/{len(recent)} ok in 10 min"
              + (f"; last error: {last_err[:120]}" if last_err else ""))  # fmt: skip
    try:
        lay = get(args.api, "/api/layers/subway_trains")
        n, asof = lay["meta"]["count"], lay["meta"]["data_as_of"]
        fresh = asof and now - when(asof.replace("Z", "+00:00")) < timedelta(minutes=3)
        state = "PASS" if n >= 20 and fresh else ("WAIT" if not all_trains else "FAIL")
        check("trains layer", state, f"{n} trains, data as of {asof}")
        health = {s["id"]: s for s in get(args.api, "/api/health")["sources"]}
        h = health.get(TRAINS, {}).get("state")
        check(
            "trains health", "PASS" if h == "ok" else ("WAIT" if h == "never" else "FAIL"), str(h)
        )
    except OSError as e:
        check("trains layer", "FAIL", f"API not reachable at {args.api}: {e}")
        health = {}
    if all_trains:
        first = when(all_trains[0]["started_at"])
        hours = max((now - first).total_seconds() / 3600, 1e-6)
        mb = (
            sum(f.stat().st_size for f in (st.archive_dir / f"source={TRAINS}").rglob("*.parquet"))
            / 1e6
        )
        per_day = mb / hours * 24
        state = "WAIT" if hours < 1 else ("PASS" if per_day <= BUDGET_MB_DAY else "WARN")
        check("trains budget", state, f"{mb:.2f} MB in {hours:.1f} h -> ~{per_day:.1f} MB/day "
              f"(budget ~{BUDGET_MB_DAY:g}; measure properly after 24 h)")  # fmt: skip

    # ---- FloodNet live depth
    floods = runs(st.state_db, FLOOD, ever)
    if not floods:
        check(
            "flood runs", "WAIT", "no floodnet_live run yet (the first lands minutes after start)"
        )
    else:
        last = floods[-1]
        took = (when(last["finished_at"]) - when(last["started_at"])).total_seconds()
        ok_runs = sum(r["ok"] for r in floods)
        state = "PASS" if last["ok"] and took < 360 else "FAIL"
        check("flood runs", state, f"{ok_runs}/{len(floods)} ok; newest took {took / 60:.1f} min, "
              f"{last['rows_written']} rows" + (f"; error: {last['error'][:120]}" if last["error"] else ""))  # fmt: skip
    try:
        lay = get(args.api, "/api/layers/flood_sensors")
        live = sum(1 for f in lay["features"] if f["properties"].get("live"))
        note = lay["meta"].get("note")
        state = "PASS" if live >= 300 else ("WAIT" if not floods else "FAIL")
        check("flood layer", state, f"{live}/{lay['meta']['count']} sensors with live depth"
              + (f"; note: {note}" if note else ""))  # fmt: skip
        items = get(args.api, "/api/changes?hours=12&limit=100")["items"]
        fl = [i for i in items if i.get("source") == FLOOD or i.get("kind") == "flood"]
        check(
            "flood changes",
            "PASS" if len(fl) <= 10 else "FAIL",
            f"{len(fl)} FloodNet item(s) in CHANGES (more than 10 means the backfill leaked)",
        )
    except OSError as e:
        check("flood layer", "FAIL", f"API not reachable at {args.api}: {e}")

    # ---- collector log
    log = st.data_dir / "logs" / "collect.log"
    starts = [when(r["started_at"]) for r in (all_trains[:1] + floods[:1])]
    since = min(starts) if starts else now
    errors = []
    if log.exists():
        for line in log.read_text(encoding="utf-8", errors="replace").splitlines():
            if " ERROR " in line and (TRAINS in line or FLOOD in line or "mta_trains" in line):
                try:
                    t = datetime.fromisoformat(line[:19]).replace(tzinfo=UTC)
                except ValueError:
                    continue
                if t >= since:
                    errors.append(line)
    check(
        "log errors",
        "PASS" if not errors else "WARN",
        f"{len(errors)} ERROR line(s) for the two feeds"
        + (f"; last: {errors[-1][:160]}" if errors else ""),
    )

    states = {s for s, _, _ in RESULTS}
    overall = "FAIL" if "FAIL" in states else "WAIT" if "WAIT" in states else (
        "PASS (with warnings)" if "WARN" in states else "PASS")  # fmt: skip
    print(f"GO-LIVE: {overall}")
    return 1 if overall == "FAIL" else 0


if __name__ == "__main__":
    raise SystemExit(main())

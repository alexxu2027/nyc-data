"""Check ROADMAP Phase 1 Gate A against the live data dir.

    uv run python scripts/gate_a.py [--at 2026-11-15T02:00:00Z]

Read-only (opens state.db and the archive; safe while `nyclive collect` runs). Exit 0 = pass.
"""

from __future__ import annotations

import argparse
import sys
import time
from datetime import UTC, datetime, timedelta

from nyclive.registry import load_registry
from nyclive.settings import load_settings
from nyclive.storage import archive
from nyclive.storage.state import StateStore, ts
from nyclive.timeutil import now_utc, parse_iso_utc, to_ny

GATE_SOURCES = ("noaa_tide_battery", "citibike_gbfs", "citibike_station_status")
MIN_STATIONS = 2000
MAX_QUERY_S = 2.0
MIN_HOURS = 1.0


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--at", help="as-of time (ISO, with offset); default: 5 min ago")
    args = ap.parse_args()
    st, reg = load_settings(), load_registry()
    now = now_utc()
    t = parse_iso_utc(args.at) if args.at else now - timedelta(minutes=5)
    ok = True

    def check(passed: bool, label: str) -> None:
        nonlocal ok
        ok &= passed
        print(f"[{'PASS' if passed else 'FAIL'}] {label}")

    with StateStore(st.state_db) as store:
        runs = store.runs_between(ts(now - timedelta(days=2)), ts(now + timedelta(minutes=1)))
        for sid in GATE_SOURCES:
            mine = [r for r in runs if r["source"] == sid]
            good = sum(r["ok"] for r in mine)
            first = min((r["started_at"] for r in mine), default=None)
            hours = (now - datetime.fromisoformat(first)).total_seconds() / 3600 if first else 0
            check(bool(mine) and good == len(mine), f"{sid}: {good}/{len(mine)} runs ok")
            if sid == "citibike_station_status":
                check(hours >= MIN_HOURS, f"{sid}: collecting for {hours:.2f} h (need {MIN_HOURS})")
                cadence = reg.sources[sid].cadence_s
                expected = hours * 3600 / cadence
                check(
                    len(mine) >= 0.9 * expected,
                    f"{sid}: {len(mine)} runs vs ~{expected:.0f} expected at {cadence}s cadence",
                )

    t0 = time.perf_counter()
    snap = archive.as_of_observations(st.archive_dir, "citibike_station_status", t)
    elapsed = time.perf_counter() - t0
    stations = len(set(snap["entity_id"].to_pylist()))
    when = to_ny(t).strftime("%Y-%m-%d %H:%M %Z")
    check(stations >= MIN_STATIONS, f"as-of {when}: {stations} stations (need {MIN_STATIONS})")
    check(elapsed < MAX_QUERY_S, f"as-of query took {elapsed:.2f} s (limit {MAX_QUERY_S})")

    for sid in GATE_SOURCES:
        for table, key in (
            ("observations", ("kind", "entity_id", "metric", "observed_at")),
            ("entities", ("kind", "entity_id", "payload_hash")),
        ):
            days = sorted({now.date(), t.date(), (now - timedelta(days=1)).date()})
            rows = archive.read_table(st.archive_dir, sid, table, days)
            if rows.num_rows == 0:
                continue
            keys = set(zip(*(rows[c].to_pylist() for c in key), strict=True))
            check(len(keys) == rows.num_rows, f"{sid}/{table}: {rows.num_rows} rows, keys unique")

    size = sum(f.stat().st_size for f in st.archive_dir.rglob("*.parquet")) / 1e6
    files = sum(1 for _ in st.archive_dir.rglob("*.parquet"))
    print(f"archive: {size:.1f} MB in {files} file(s); now {now.astimezone(UTC):%H:%M} UTC")
    print("GATE A:", "PASS" if ok else "FAIL")
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main())

"""Check the ROADMAP Phase 1 soak and storage/CPU criteria against the live data dir.

    uv run python scripts/soak_report.py            # read-only; safe while `nyclive collect` runs

Criteria (docs/ROADMAP.md Phase 1):
- soak: >= 48 h of collection in total, including one unbroken >= 24 h run that crosses a UTC
  midnight; every source >= 95% successful scheduled runs while the collector was up;
- storage: archive growth <= 150 MB/day; one file per closed day partition;
- CPU: collector < 5% average.
Exit 0 only when every criterion passes. Until 48 h have passed, it reports progress.
"""

from __future__ import annotations

import itertools
import json
import os
import subprocess
import sys
from collections import defaultdict
from datetime import UTC, date, datetime, timedelta

from nyclive.registry import load_registry
from nyclive.settings import load_settings
from nyclive.storage import archive
from nyclive.storage.state import StateStore, ts
from nyclive.timeutil import now_utc

HEARTBEAT = "citibike_station_status"  # the 60 s source: its runs show when the collector was up
GAP = timedelta(minutes=5)  # a longer silence means the collector was down (or asleep)
NEED_TOTAL_H, NEED_UNBROKEN_H = 48.0, 24.0
MIN_SUCCESS = 0.95
MAX_MB_PER_DAY = 150.0
MAX_CPU_PCT = 5.0


def spans(times: list[datetime]) -> list[tuple[datetime, datetime]]:
    """Merge heartbeat run times into up-spans (a gap > GAP splits them)."""
    out: list[list[datetime]] = []
    for t in sorted(times):
        if out and t - out[-1][1] <= GAP:
            out[-1][1] = t
        else:
            out.append([t, t])
    return [(a, b) for a, b in out]


def collector_cpu() -> tuple[float, float] | None:
    """(% of one core, % of the whole machine) averaged since the collector process started."""
    if os.name != "nt":
        return None
    ps = (
        "Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -like '*nyclive*collect*'"
        " -and $_.Name -eq 'python.exe' } | ForEach-Object { $p = Get-Process -Id $_.ProcessId;"
        " [pscustomobject]@{cpu=$p.TotalProcessorTime.TotalSeconds;"
        " start=$p.StartTime.ToUniversalTime().ToString('o')} } | ConvertTo-Json"
    )
    try:
        out = subprocess.run(
            ["powershell", "-NoProfile", "-Command", ps],
            capture_output=True,
            text=True,
            timeout=60,
            check=False,
        ).stdout.strip()
    except (OSError, subprocess.SubprocessError):
        return None
    if not out:
        return None
    rows = json.loads(out)
    rows = rows if isinstance(rows, list) else [rows]
    cpu = sum(r["cpu"] for r in rows)
    start = min(datetime.fromisoformat(r["start"]) for r in rows)
    wall = (datetime.now(UTC) - start).total_seconds()
    if wall <= 0:
        return None
    one_core = 100 * cpu / wall
    return one_core, one_core / (os.cpu_count() or 1)


def main() -> int:
    for stream in (sys.stdout, sys.stderr):  # cp1252 consoles can't print "≈"
        if hasattr(stream, "reconfigure"):
            stream.reconfigure(encoding="utf-8", errors="replace")
    st, reg = load_settings(), load_registry()
    now = now_utc()
    results: list[tuple[str, bool, str]] = []

    def check(name: str, ok: bool, detail: str) -> None:
        results.append((name, ok, detail))

    with StateStore(st.state_db) as store:
        runs = store.runs_between("2000-01-01", ts(now + timedelta(minutes=1)))
    # state.db keeps 7 days of runs; older days were exported to the archive by compact
    exported = []
    d0 = now.date() - timedelta(days=14)
    for i in range(15):
        t = archive.read_table(st.archive_dir, archive.RUNS_SOURCE, "runs", [d0 + timedelta(i)])
        exported += [
            {**r, "started_at": ts(r["started_at"]), "finished_at": ts(r["finished_at"])}
            for r in t.to_pylist()
        ]
    by_id = {r["run_id"]: r for r in exported}
    by_id.update({r["run_id"]: r for r in runs})
    runs = sorted(by_id.values(), key=lambda r: r["started_at"])

    beats = [datetime.fromisoformat(r["started_at"]) for r in runs if r["source"] == HEARTBEAT]
    up = spans(beats)
    total_h = sum((b - a).total_seconds() for a, b in up) / 3600
    longest = max(up, key=lambda s: s[1] - s[0], default=None)
    longest_h = (longest[1] - longest[0]).total_seconds() / 3600 if longest else 0.0
    crosses = bool(longest and longest[0].date() != longest[1].date())
    check(
        "soak: total collection",
        total_h >= NEED_TOTAL_H,
        f"{total_h:.1f} h of {NEED_TOTAL_H:.0f} h in {len(up)} span(s)",
    )
    check("soak: one unbroken run", longest_h >= NEED_UNBROKEN_H and crosses,
          f"longest {longest_h:.1f} h of {NEED_UNBROKEN_H:.0f} h"
          + (f" ({longest[0]:%m-%d %H:%M} -> {longest[1]:%m-%d %H:%M} UTC"
             f"{', crosses midnight' if crosses else ''})" if longest else ""))  # fmt: skip
    gaps = [(a[1], b[0]) for a, b in itertools.pairwise(up)]
    gap_text = "; ".join(f"{x:%m-%d %H:%M}->{y:%H:%M}" for x, y in gaps[-5:]) or "none"

    # Success rate per source while the collector was up (scheduled = up time / cadence).
    by_src: dict[str, list[dict]] = defaultdict(list)
    for r in runs:
        by_src[r["source"]].append(r)
    worst = []
    for src in sorted((s for s in reg.sources.values() if s.adapter), key=lambda s: s.id):
        mine = by_src.get(src.id, [])
        ok_runs = sum(1 for r in mine if r["ok"])
        # Expected runs count from this source's own first run (sources joined at different
        # times), over the time the collector was up.
        first = datetime.fromisoformat(mine[0]["started_at"]) if mine else now
        up_s = sum(max(0.0, (b - max(a, first)).total_seconds()) for a, b in up)
        expected = max(1, round(up_s / src.cadence_s) + 1) if mine else 1
        rate = ok_runs / max(expected, len(mine), 1)
        worst.append((rate, src.id, ok_runs, len(mine), expected))
    bad = [w for w in worst if w[0] < MIN_SUCCESS]
    check(
        "soak: >= 95% successful runs per source",
        not bad and bool(worst),
        "all sources ok"
        if not bad
        else "; ".join(
            f"{sid} {ok}/{exp} ok ({rate:.0%}, {n} attempted)" for rate, sid, ok, n, exp in bad
        ),
    )

    # Storage.
    sizes: dict[str, int] = defaultdict(int)
    per_day: dict[str, int] = defaultdict(int)
    multi_file_closed = []
    cutoff = archive.closed_before(now)
    for d in archive_dirs(st.archive_dir):
        files = list(d.glob("*.parquet"))
        size = sum(f.stat().st_size for f in files)
        source = d.parent.parent.name.removeprefix("source=")
        day = date.fromisoformat(d.name.removeprefix("date="))
        sizes[source] += size
        per_day[day.isoformat()] += size
        if day < cutoff and len(files) != 1:
            multi_file_closed.append(f"{source}/{d.parent.name}/{d.name} ({len(files)} files)")
    total_mb = sum(sizes.values()) / 1e6
    rate_mb = total_mb / (total_h / 24) if total_h >= 1 else float("nan")
    closed_days = {k: v for k, v in per_day.items() if date.fromisoformat(k) < cutoff}
    if closed_days:
        day_mb = max(closed_days.values()) / 1e6
        check("storage: <= 150 MB/day (largest closed day)", day_mb <= MAX_MB_PER_DAY,
              f"{day_mb:.1f} MB; days: " + ", ".join(
                  f"{k} {v / 1e6:.1f} MB" for k, v in sorted(closed_days.items())))  # fmt: skip
    else:
        check(
            "storage: <= 150 MB/day (extrapolated, no closed day yet)",
            rate_mb <= MAX_MB_PER_DAY,
            f"{total_mb:.1f} MB over {total_h:.1f} h ≈ {rate_mb:.0f} MB/day",
        )
    check(
        "storage: one file per closed day partition",
        not multi_file_closed,
        "ok" if not multi_file_closed else ", ".join(multi_file_closed[:5]),
    )

    cpu = collector_cpu()
    if cpu is None:
        check("cpu: collector < 5% average", False, "collector process not found (is it running?)")
    else:
        check(
            "cpu: collector < 5% average",
            cpu[1] < MAX_CPU_PCT,
            f"{cpu[1]:.2f}% of the machine ({cpu[0]:.1f}% of one core) since process start",
        )

    print(f"NYC Live soak report, {now:%Y-%m-%d %H:%M} UTC")
    for name, ok, detail in results:
        print(f"[{'PASS' if ok else 'FAIL'}] {name}: {detail}")
    print(f"collector gaps (last 5): {gap_text}")
    print("archive by source (MB): " + ", ".join(
        f"{k} {v / 1e6:.1f}" for k, v in sorted(sizes.items(), key=lambda kv: -kv[1])))  # fmt: skip
    passed = all(ok for _, ok, _ in results)
    print("SOAK:", "PASS" if passed else "NOT YET / FAIL")
    return 0 if passed else 1


def archive_dirs(root):
    return [d for d in root.glob("source=*/table=*/date=*") if d.is_dir()]


if __name__ == "__main__":
    sys.exit(main())

"""`nyclive status`: one line per collected source, from state.db (read-only).

Columns: last success (New York time) and its age, consecutive failures, rows in the last run,
data lag, and a state: ok / stale / degraded / never.
"""

from __future__ import annotations

from datetime import datetime

from nyclive.collect.scheduler import DEGRADED_AFTER
from nyclive.registry import Registry
from nyclive.storage.state import StateStore
from nyclive.timeutil import to_ny


def _age(seconds: float | None) -> str:
    if seconds is None:
        return "-"
    s = int(seconds)
    if s < 120:
        return f"{s}s"
    if s < 7200:
        return f"{s // 60}m"
    if s < 172800:
        return f"{s // 3600}h"
    return f"{s // 86400}d"


def source_rows(reg: Registry, store: StateStore, now: datetime) -> list[dict]:
    states = store.all_source_states()
    rows = []
    for src in sorted((s for s in reg.sources.values() if s.adapter), key=lambda s: s.id):
        st = states.get(src.id) or {}
        last = st.get("last_success")
        age = (now - datetime.fromisoformat(last)).total_seconds() if last else None
        stale_after = max(3 * (src.cadence_s or 0), src.max_lag_s or 0)
        failures = st.get("consecutive_failures") or 0
        if failures >= DEGRADED_AFTER:
            state = "degraded"
        elif last is None:
            state = "never"
        elif age is not None and age > stale_after:
            state = "stale"
        else:
            state = "ok"
        rows.append(
            {
                "source": src.id,
                "state": state,
                "last_success": to_ny(datetime.fromisoformat(last)).strftime("%m-%d %H:%M")
                if last
                else "-",
                "age": _age(age),
                "failures": failures,
                "rows": st.get("rows_last_run"),
                "lag": _age(st.get("lag_s")),
                "error": (st.get("last_error") or "")[:60],
            }
        )
    return rows


def render(rows: list[dict]) -> str:
    head = f"{'source':<26} {'state':<9} {'last ok (NY)':<12} {'age':>5} {'fail':>4} "
    head += f"{'rows':>6} {'lag':>5}  error"
    lines = [head]
    for r in rows:
        rows_s = "-" if r["rows"] is None else str(r["rows"])
        lines.append(
            f"{r['source']:<26} {r['state']:<9} {r['last_success']:<12} {r['age']:>5} "
            f"{r['failures']:>4} {rows_s:>6} {r['lag']:>5}  {r['error']}"
        )
    return "\n".join(lines)

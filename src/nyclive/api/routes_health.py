"""GET /api/health: per-source state, same rule as `nyclive status` (§2.2 notes)."""

from __future__ import annotations

from datetime import timedelta

from fastapi import APIRouter, Request
from fastapi.responses import Response

from nyclive.api.cache import conditional, entry_for
from nyclive.api.db import reading
from nyclive.api.layers.common import iso, parse_ts, ts_text

router = APIRouter(prefix="/api")

DEGRADED_AFTER = 3  # same as collect.scheduler.DEGRADED_AFTER (not imported: no pipeline here)
RUNNING_WITHIN_S = 180
STATES = ("ok", "stale", "degraded", "never")


def source_state(src, st: dict, now) -> tuple[str, float | None]:
    last = parse_ts(st.get("last_success"))
    age = (now - last).total_seconds() if last else None
    stale_after = max(3 * (src.cadence_s or 0), src.max_lag_s or 0)
    if (st.get("consecutive_failures") or 0) >= DEGRADED_AFTER:
        return "degraded", age
    if last is None:
        return "never", age
    if age is not None and age > stale_after:
        return "stale", age
    return "ok", age


@router.get("/health", summary="Collector and per-source health")
def health(request: Request) -> Response:
    services = request.app.state.services
    now = services.now()
    since = ts_text(now - timedelta(hours=24))
    with reading(services.settings.state_db) as conn:
        states = {r["source"]: dict(r) for r in conn.execute("SELECT * FROM source_state")}
        runs = {
            r[0]: (r[1], r[2] or 0)
            for r in conn.execute(
                "SELECT source, COUNT(*), SUM(ok) FROM runs WHERE started_at >= ? GROUP BY source",
                (since,),
            )
        }
    sources, summary = [], dict.fromkeys(STATES, 0)
    newest_attempt = None
    for src in sorted(
        (s for s in services.registry.sources.values() if s.adapter), key=lambda s: s.id
    ):
        st = states.get(src.id) or {}
        state, age = source_state(src, st, now)
        summary[state] += 1
        attempt = st.get("last_attempt")
        if attempt and (newest_attempt is None or attempt > newest_attempt):
            newest_attempt = attempt
        n, ok = runs.get(src.id, (0, 0))
        sources.append(
            {
                "id": src.id,
                "name": src.name,
                "state": state,
                "cadence_s": src.cadence_s,
                "last_success": iso(st.get("last_success")),
                "last_attempt": iso(attempt),
                "age_s": None if age is None else round(age),
                "lag_s": None if st.get("lag_s") is None else round(st["lag_s"]),
                "consecutive_failures": int(st.get("consecutive_failures") or 0),
                "rows_last_run": st.get("rows_last_run"),
                "last_error": st.get("last_error"),
                "runs_24h": int(n),
                "ok_24h": int(ok),
                "layers": services.layers_of(src.id),
            }
        )
    if newest_attempt is None:
        collector = "unknown"
    else:
        recent = (now - parse_ts(newest_attempt)).total_seconds() < RUNNING_WITHIN_S
        collector = "running" if recent else "stalled"
    body = {
        "now": iso(now),
        "collector": {"state": collector, "last_attempt": iso(newest_attempt)},
        "summary": summary,
        "sources": sources,
    }
    return conditional(request, entry_for(body))

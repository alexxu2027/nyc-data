"""GET /api/changes: the "what changed" feed (ADR-013, plan I3c)."""

from __future__ import annotations

from datetime import timedelta

from fastapi import APIRouter, Query, Request
from fastapi.responses import Response

from nyclive.api.cache import conditional
from nyclive.api.changes import CHANGE_SOURCES, change_items
from nyclive.api.db import reading
from nyclive.api.layers.common import iso
from nyclive.api.routes_layers import _stamp

router = APIRouter(prefix="/api")

MAX_AGE_S = 30  # `ended` and the window move with the clock even when no source changed


@router.get("/changes", summary="Recent changes across alerts, outages and flooding")
def changes(
    request: Request,
    hours: int = Query(12, ge=1, le=48),
    limit: int = Query(30, ge=1, le=100),
) -> Response:
    services = request.app.state.services
    now = services.now()
    with reading(services.settings.state_db) as conn:
        stamp = _stamp(conn, CHANGE_SOURCES)

        def build() -> dict:
            items = change_items(conn, now, hours, limit, services.boroughs)
            return {"now": iso(now), "since": iso(now - timedelta(hours=hours)), "items": items}

        key = ("changes", hours, limit)
        entry = services.cache.get_or_build(key, stamp, now.timestamp(), MAX_AGE_S, build)
    return conditional(request, entry)

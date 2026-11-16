"""GET /api/changes: the "what changed" feed (ADR-013). Stub from U0; U4 fills `items`."""

from __future__ import annotations

from datetime import UTC, datetime

from fastapi import APIRouter, Query, Request
from fastapi.responses import Response

from nyclive.api.cache import conditional
from nyclive.api.db import reading
from nyclive.api.layers.common import iso
from nyclive.api.routes_layers import _stamp

router = APIRouter(prefix="/api")

CHANGE_SOURCES = ["nws_alerts", "mta_subway_alerts", "mta_elevator_outages", "floodnet_live"]


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
            since = datetime.fromtimestamp(now.timestamp() - hours * 3600, UTC)
            return {"now": iso(now), "since": iso(since), "items": []}

        key = ("changes", hours, limit)
        entry = services.cache.get_or_build(key, stamp, now.timestamp(), 30, build)
    return conditional(request, entry)

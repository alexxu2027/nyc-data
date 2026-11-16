"""GET /api/events (list mode for `list: true` layers) and /api/events/{source}/{id}."""

from __future__ import annotations

from fastapi import APIRouter, Query, Request
from fastapi.responses import Response

from nyclive.api.cache import json_response
from nyclive.api.db import reading
from nyclive.api.errors import bad_request, not_found
from nyclive.api.events import Lookup, detail, summary
from nyclive.api.layers.common import iso, ts_text
from nyclive.api.layers.transit import ALERT_HORIZON
from nyclive.model import BOROUGHS

router = APIRouter(prefix="/api")

LIST_SOURCES = {
    "nws_alerts": "nws_alerts",
    "subway_alerts": "mta_subway_alerts",
    "elevator_outages": "mta_elevator_outages",
    "city_alerts": "notify_nyc",  # ADR-015 (served once the layer is in the catalog)
}
HORIZON = {"subway_alerts": ALERT_HORIZON}


@router.get("/events", summary="Events of a list layer, active first")
def events(
    request: Request,
    layer: str = Query(..., description="a layer with list: true"),
    status: str = Query("active", pattern="^(active|upcoming|all)$"),
    borough: str | None = Query(None),
    limit: int = Query(100, ge=1, le=200),
    offset: int = Query(0, ge=0),
) -> Response:
    services = request.app.state.services
    layer_def = services.catalog.layers.get(layer)
    if layer_def is None or not layer_def["list"] or layer not in LIST_SOURCES:
        raise bad_request(f"layer must be one of {sorted(LIST_SOURCES)}")
    codes = None
    if borough:
        codes = {c.strip().upper() for c in borough.split(",") if c.strip()}
        if codes - set(BOROUGHS):
            raise bad_request(f"borough must be a list of {','.join(BOROUGHS)}")
    now = services.now()
    now_text = ts_text(now)
    with reading(services.settings.state_db) as conn:
        rows = conn.execute(
            "SELECT * FROM events WHERE source = ? AND (ends_at IS NULL OR ends_at > ?)",
            (LIST_SOURCES[layer], now_text),
        ).fetchall()
        lookup = Lookup(conn)
        items = [summary(dict(r), now_text, lookup, services.boroughs) for r in rows]
    if layer in HORIZON:
        horizon = iso(now + HORIZON[layer])
        items = [e for e in items if e["starts_at"] <= horizon]
    if status != "all":
        items = [e for e in items if e["status"] == status]
    if codes is not None:
        items = [e for e in items if e["borough"] is None or e["borough"] in codes]
    active = sorted(
        (e for e in items if e["status"] == "active"),
        key=lambda e: (-e["severity"], _neg(e["starts_at"]), e["id"]),
    )
    upcoming = sorted(
        (e for e in items if e["status"] != "active"), key=lambda e: (e["starts_at"], e["id"])
    )
    ordered = active + upcoming
    return json_response(
        {
            "layer": layer,
            "total": len(ordered),
            "limit": limit,
            "offset": offset,
            "events": ordered[offset : offset + limit],
        }
    )


def _neg(text: str) -> tuple:
    """Sort key for newest-first on an ISO string inside an ascending sort."""
    return tuple(-ord(c) for c in text)


@router.get("/events/{source}/{event_id:path}", summary="One event in full")
def event_detail(request: Request, source: str, event_id: str) -> Response:
    services = request.app.state.services
    with reading(services.settings.state_db) as conn:
        row = conn.execute(
            "SELECT * FROM events WHERE source = ? AND event_id = ?", (source, event_id)
        ).fetchone()
        if row is None:
            raise not_found(f"no event {source}/{event_id}")
        body = detail(dict(row), ts_text(services.now()), Lookup(conn), services.boroughs)
    return json_response(body)

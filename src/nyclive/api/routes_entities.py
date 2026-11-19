"""GET /api/entities/{kind}/{id} (EntityDetail, §2.4) and .../series (history from Parquet).

Ids may contain ':' and '/' (sent as %2F, which the server decodes before routing), so the id
is a `path` parameter and the /series route is declared first.
"""

from __future__ import annotations

import logging
from datetime import timedelta
from typing import Any

from fastapi import APIRouter, Query, Request
from fastapi.responses import Response

from nyclive.api.cache import json_response
from nyclive.api.db import reading
from nyclive.api.errors import bad_request, not_found
from nyclive.api.events import Lookup, summary
from nyclive.api.geo import r5
from nyclive.api.layers.air import air_derived
from nyclive.api.layers.common import iso, loads, ts_text
from nyclive.api.layers.streets import camera_props, is_stale, speed_band
from nyclive.api.layers.transit import ALERT_HORIZON, bike_derived
from nyclive.api.layers.water import live_depth, sensor_stats, weather_derived
from nyclive.api.tide import tide_for
from nyclive.model import KINDS, METRICS
from nyclive.storage import query

log = logging.getLogger(__name__)
router = APIRouter(prefix="/api")

MAX_POINTS = 2000
MAX_EVENTS = 50
UNITS = {
    "bikes_available": "bikes",
    "ebikes_available": "bikes",
    "docks_available": "docks",
    "is_renting": "flag",
    "water_level_ft": "ft",
    "predicted_ft": "ft",
    "speed_mph": "mph",
    "travel_time_s": "s",
    "temp_c": "°C",
    "precip_mm": "mm",
    "rain_mm": "mm",
    "wind_kmh": "km/h",
    "depth_in": "in",
    "pm25_ugm3": "µg/m³",
    "pm10_ugm3": "µg/m³",
    "o3_ppm": "ppm",
    "no2_ppm": "ppm",
}
SERIES = {
    "bike_station": [
        {
            "label": "Bikes and docks",
            "unit": "count",
            "metrics": ["bikes_available", "ebikes_available", "docks_available"],
            "hours": 24,
            "ahead": 0,
        }
    ],
    "tide_gauge": [
        {
            "label": "Water level",
            "unit": "ft",
            "metrics": ["water_level_ft", "predicted_ft"],
            "hours": 24,
            "ahead": 12,
        }
    ],
    "road_segment": [
        {"label": "Speed", "unit": "mph", "metrics": ["speed_mph"], "hours": 24, "ahead": 0}
    ],
    "flood_sensor": [
        {"label": "Water depth", "unit": "in", "metrics": ["depth_in"], "hours": 48, "ahead": 0}
    ],
    "weather_point": [
        {"label": "Temperature", "unit": "°C", "metrics": ["temp_c"], "hours": 24, "ahead": 0},
        {"label": "Wind", "unit": "km/h", "metrics": ["wind_kmh"], "hours": 24, "ahead": 0},
    ],
    "air_sensor": [
        {"label": "PM2.5", "unit": "µg/m³", "metrics": ["pm25_ugm3"], "hours": 48, "ahead": 0},
        {"label": "Ozone", "unit": "ppm", "metrics": ["o3_ppm"], "hours": 48, "ahead": 0},
    ],
}
STATION_EVENT_SOURCES = ("mta_subway_alerts", "mta_elevator_outages")


def _entity(conn, kind: str, entity_id: str):
    row = None
    if kind in KINDS:
        row = conn.execute(
            "SELECT * FROM entities WHERE kind = ? AND entity_id = ?", (kind, entity_id)
        ).fetchone()
    if row is None:
        raise not_found(f"no entity {kind}:{entity_id}")
    return row


def _downsample(points: list, n: int = MAX_POINTS) -> list:
    if len(points) <= n:
        return points
    step = len(points) / n
    picked = [points[int(i * step)] for i in range(n - 1)]
    return [*picked, points[-1]]


@router.get("/entities/{kind}/{entity_id:path}/series", summary="Metric history of one entity")
def entity_series(
    request: Request,
    kind: str,
    entity_id: str,
    metrics: str = Query(..., description="comma-separated metric names"),
    hours: int = Query(24, ge=1, le=168),
    ahead: int = Query(0, ge=0, le=48),
) -> Response:
    services = request.app.state.services
    wanted = list(dict.fromkeys(m.strip() for m in metrics.split(",") if m.strip()))
    if not wanted:
        raise bad_request("metrics is required")
    unknown = [m for m in wanted if m not in METRICS]
    if unknown:
        raise bad_request(f"unknown metric(s): {unknown}")
    now = services.now()
    start, end = now - timedelta(hours=hours), now + timedelta(hours=ahead)
    with reading(services.settings.state_db) as conn:
        ent = _entity(conn, kind, entity_id)
        by_source: dict[str, list[str]] = {}
        for m in wanted:
            row = conn.execute(
                "SELECT source FROM latest WHERE kind = ? AND entity_id = ? AND metric = ?",
                (kind, entity_id, m),
            ).fetchone()
            by_source.setdefault(row[0] if row else ent["source"], []).append(m)
    points: dict[str, list] = {m: [] for m in wanted}
    for source, ms in by_source.items():
        try:
            got = query.series(
                services.settings.archive_dir, source, kind, entity_id, ms, start, end, now
            )
        except Exception as e:  # noqa: BLE001 - history degrades to empty, never a 500
            log.warning("series %s:%s failed: %s", kind, entity_id, e)
            continue
        for m, pts in got.items():
            points[m] = _downsample([[int(t.timestamp()), float(v)] for t, v in pts])
    return json_response(
        {
            "kind": kind,
            "id": entity_id,
            "now": iso(now),
            "from": iso(start),
            "to": iso(end),
            "series": [
                {"metric": m, "unit": UNITS.get(m, "count"), "points": points[m]} for m in wanted
            ],
        }
    )


def _derived(services, conn, kind: str, ent, latest: dict[str, tuple], now) -> dict[str, Any]:
    props = loads(ent["props"])
    if kind == "bike_station":
        d = bike_derived(latest)
        return {"pct": d["pct"], "state": d["state"]}
    if kind == "tide_gauge":
        t = tide_for(services, conn, ent["entity_id"], now)
        return {k: t[k] for k in ("predicted_ft", "surge_ft", "trend", "next_high", "next_low")}
    if kind == "weather_point":
        return weather_derived(latest)
    if kind == "air_sensor":
        return {**air_derived(latest, now), "monitor": props.get("monitor") is True,
                "provider": props.get("provider"), "license": props.get("license")}  # fmt: skip
    if kind == "road_segment":
        speed = latest.get("speed_mph")
        return {
            "band": speed_band(speed[0] if speed else None),
            "stale": is_stale(speed[1] if speed else None, now),
        }
    if kind == "camera":
        c = camera_props(props)
        return {"image_url": c["image_url"], "status": c["status"]}
    if kind == "subway_station":
        return {"routes": str(props.get("daytime_routes") or "").split()}
    if kind == "flood_sensor":
        now_text = ts_text(now)
        st = sensor_stats(conn, now_text).get(ent["entity_id"], {})
        live = live_depth(conn, now_text).get(ent["entity_id"])
        return {
            "events_30d": st.get("events_30d", 0),
            "depth_in": live["depth_in"] if live else None,
            "live": bool(live and live["live"]),
            "flooding": bool(live and live["flooding"]),
        }
    return {}


def _like(text: str) -> str:
    return text.replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_")


def _events(services, conn, kind: str, entity_id: str, now) -> list[dict]:
    if kind == "subway_station":
        sources, ordered = STATION_EVENT_SOURCES, "active"
    elif kind == "flood_sensor":
        sources, ordered = ("floodnet_events", "floodnet_live"), "newest"
    else:
        return []
    ref = _like(f'"{kind}:{entity_id}"')
    marks = ",".join("?" for _ in sources)
    rows = conn.execute(
        f"SELECT * FROM events WHERE source IN ({marks})"
        " AND entity_refs LIKE ? ESCAPE '\\' ORDER BY starts_at DESC",
        (*sources, f"%{ref}%"),
    ).fetchall()
    now_text = ts_text(now)
    lookup = Lookup(conn)
    out = [summary(dict(r), now_text, lookup, services.boroughs) for r in rows]
    if ordered == "active":
        horizon = iso(now + ALERT_HORIZON)
        out = [
            e
            for e in out
            if e["status"] == "active" or (e["status"] == "upcoming" and e["starts_at"] <= horizon)
        ]
        out.sort(key=lambda e: (e["status"] != "active", -e["severity"]))
    return out[:MAX_EVENTS]


@router.get("/entities/{kind}/{entity_id:path}", summary="One entity with latest values")
def entity_detail(request: Request, kind: str, entity_id: str) -> Response:
    services = request.app.state.services
    now = services.now()
    with reading(services.settings.state_db) as conn:
        ent = _entity(conn, kind, entity_id)
        latest = {
            r["metric"]: (r["value"], r["observed_at"])
            for r in conn.execute(
                "SELECT metric, value, observed_at FROM latest WHERE kind = ? AND entity_id = ?",
                (kind, entity_id),
            )
        }
        body = {
            "kind": kind,
            "id": entity_id,
            "source": ent["source"],
            "name": ent["name"],
            "lat": None if ent["lat"] is None else r5(ent["lat"]),
            "lon": None if ent["lon"] is None else r5(ent["lon"]),
            "borough": services.boroughs.resolve(ent["borough"], ent["lon"], ent["lat"]),
            "props": loads(ent["props"]),
            "first_seen": iso(ent["first_seen"]),
            "last_seen": iso(ent["last_seen"]),
            "latest": {m: {"value": v, "observed_at": iso(t)} for m, (v, t) in latest.items()},
            "derived": _derived(services, conn, kind, ent, latest, now),
            "events": _events(services, conn, kind, entity_id, now),
            "series": SERIES.get(kind, []),
        }
    return json_response(body)

"""The "what changed" feed (ADR-013, plan I3c): events first seen in the last few hours.

One item per event (`source:event_id`), dated by `events.first_seen` (when the collector first
stored it), across four sources: NWS alerts, unplanned subway alerts that are in effect, current
elevator outages and live FloodNet flood episodes. Each item names the map layer and feature a
click should open, and a point to fly to.
"""

from __future__ import annotations

import sqlite3
from datetime import datetime, timedelta
from typing import Any

from nyclive.api.events import Lookup
from nyclive.api.geo import geometry_bbox, r5
from nyclive.api.layers.common import iso, loads, ts_text
from nyclive.api.layers.transit import is_unplanned, outage_status
from nyclive.api.layers.water import nws_geometry

CHANGE_SOURCES = ["nws_alerts", "mta_subway_alerts", "mta_elevator_outages", "floodnet_live"]

# source -> (kind, layer, entity kind whose first mappable ref is the feature)
ROUTES: dict[str, tuple[str, str, str | None]] = {
    "nws_alerts": ("weather", "nws_alerts", None),
    "mta_subway_alerts": ("alert", "subway_alerts", "subway_station"),
    "mta_elevator_outages": ("outage", "elevator_outages", "subway_station"),
    "floodnet_live": ("flood", "flood_sensors", "flood_sensor"),
}


def _wanted(ev: dict, now_text: str) -> bool:
    if ev["source"] == "mta_subway_alerts":
        return is_unplanned(ev) and ev["starts_at"] <= now_text
    if ev["source"] == "mta_elevator_outages":
        return outage_status(ev, now_text) == "current"
    return True


def _first_mappable(ev: dict, kind: str, lookup: Lookup) -> sqlite3.Row | None:
    prefix = kind + ":"
    for ref in loads(ev["entity_refs"], []):
        if ref.startswith(prefix):
            hit = lookup.get(kind, ref[len(prefix) :])
            if hit is not None and hit["lat"] is not None:
                return hit
    return None


def _item(ev: dict, now_text: str, lookup: Lookup, boroughs) -> dict[str, Any]:
    kind, layer, ref_kind = ROUTES[ev["source"]]
    feature, lat, lon, borough = None, ev["lat"], ev["lon"], ev["borough"]
    if ref_kind is None:  # NWS: the alert is the feature; fly to its bbox centre
        feature = ev["event_id"]
        geom, _, codes = nws_geometry(ev, boroughs)
        box = geometry_bbox(geom) if geom else None
        if box is not None:
            lon, lat = (box[0] + box[2]) / 2, (box[1] + box[3]) / 2
        if borough is None and len(codes) == 1:
            borough = codes[0]
    else:
        hit = _first_mappable(ev, ref_kind, lookup)
        if hit is not None:
            feature, lat, lon = hit["entity_id"], hit["lat"], hit["lon"]
            borough = borough or boroughs.resolve(hit["borough"], lon, lat)
    ends = ev["ends_at"]
    return {
        "id": f"{ev['source']}:{ev['event_id']}",
        "at": iso(ev["first_seen"]),
        "kind": kind,
        "source": ev["source"],
        "title": ev["title"],
        "severity": int(ev["severity"] or 0),
        "layer": layer,
        "feature": feature,
        "lat": None if lat is None else r5(lat),
        "lon": None if lon is None else r5(lon),
        "borough": borough,
        "ended": ends is not None and ends <= now_text,
    }


def change_items(
    conn: sqlite3.Connection, now: datetime, hours: int, limit: int, boroughs
) -> list[dict[str, Any]]:
    """Newest first (then by id), at most `limit` items first seen in (now - hours, now]."""
    now_text = ts_text(now)
    since_text = ts_text(now - timedelta(hours=hours))
    marks = ",".join("?" for _ in CHANGE_SOURCES)
    rows = conn.execute(
        f"SELECT * FROM events WHERE source IN ({marks}) AND first_seen > ? AND first_seen <= ?",
        (*CHANGE_SOURCES, since_text, now_text),
    ).fetchall()
    lookup = Lookup(conn)
    items = [
        _item(ev, now_text, lookup, boroughs)
        for ev in (dict(r) for r in rows)
        if _wanted(ev, now_text)
    ]
    items.sort(key=lambda i: i["id"])
    items.sort(key=lambda i: i["at"], reverse=True)
    return items[:limit]

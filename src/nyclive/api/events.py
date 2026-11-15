"""EventSummary (§2.5) and EventDetail (§2.6) shapes, shared by entity and event routes."""

from __future__ import annotations

import sqlite3
from typing import Any

from nyclive.api.geo import point, r5, wkt_to_geojson
from nyclive.api.layers.common import event_status, iso, loads
from nyclive.api.layers.transit import outage_status
from nyclive.api.layers.water import nws_geometry

LIST_PROPS = ("description", "reason", "est_return", "instruction")
DESCRIPTION_MAX = 600
MAX_STATIONS = 5
# Kinds whose refs carry a location (first resolvable wins for an event without lat/lon).
LOCATING_KINDS = ("subway_station", "flood_sensor")


class Lookup:
    """Per-request entity lookups for resolving entity_refs, memoized."""

    def __init__(self, conn: sqlite3.Connection) -> None:
        self.conn = conn
        self._memo: dict[tuple[str, str], sqlite3.Row | None] = {}

    def get(self, kind: str, eid: str) -> sqlite3.Row | None:
        key = (kind, eid)
        if key not in self._memo:
            self._memo[key] = self.conn.execute(
                "SELECT kind, entity_id, name, lat, lon, borough FROM entities"
                " WHERE kind = ? AND entity_id = ?",
                key,
            ).fetchone()
        return self._memo[key]


def _split(ref: str) -> tuple[str, str]:
    kind, _, eid = ref.partition(":")
    return kind, eid


def status_of(ev: dict, now_text: str) -> str:
    s = event_status(ev["starts_at"], ev["ends_at"], now_text)
    if s == "active" and ev["source"] == "mta_elevator_outages":
        return "upcoming" if outage_status(ev, now_text) == "upcoming" else "active"
    return s


def trim_props(props: dict) -> dict:
    out = {}
    for k in LIST_PROPS:
        if k in props:
            v = props[k]
            if k == "description" and isinstance(v, str) and len(v) > DESCRIPTION_MAX:
                v = v[: DESCRIPTION_MAX - 1].rstrip() + "…"
            if k == "est_return" and isinstance(v, str):
                v = iso(v) or v
            out[k] = v
    return out


def summary(
    ev: dict, now_text: str, lookup: Lookup, boroughs, *, full: bool = False
) -> dict[str, Any]:
    refs = loads(ev["entity_refs"], [])
    lat, lon = ev["lat"], ev["lon"]
    borough = ev["borough"]
    if lat is None:
        for ref in refs:
            kind, eid = _split(ref)
            if kind in LOCATING_KINDS:
                hit = lookup.get(kind, eid)
                if hit is not None and hit["lat"] is not None:
                    lat, lon = hit["lat"], hit["lon"]
                    borough = borough or hit["borough"]
                    break
    if borough is None and lat is not None:
        borough = boroughs.resolve(None, lon, lat)
    stations = []
    for ref in refs:
        kind, eid = _split(ref)
        if kind == "subway_station" and len(stations) < MAX_STATIONS:
            hit = lookup.get(kind, eid)
            stations.append({"id": eid, "name": hit["name"] if hit else eid})
    props = loads(ev["props"])
    return {
        "source": ev["source"],
        "id": ev["event_id"],
        "category": ev["category"],
        "subtype": ev["subtype"],
        "title": ev["title"],
        "starts_at": iso(ev["starts_at"]),
        "ends_at": iso(ev["ends_at"]),
        "severity": int(ev["severity"] or 0),
        "status": status_of(ev, now_text),
        "lat": None if lat is None else r5(lat),
        "lon": None if lon is None else r5(lon),
        "borough": borough,
        "routes": [_split(r)[1] for r in refs if r.startswith("subway_route:")],
        "stations": stations,
        "props": props if full else trim_props(props),
    }


def detail(ev: dict, now_text: str, lookup: Lookup, boroughs) -> dict[str, Any]:
    out = summary(ev, now_text, lookup, boroughs, full=True)
    refs = loads(ev["entity_refs"], [])
    geom = wkt_to_geojson(ev["geometry_wkt"])
    if geom is None and ev["source"] == "nws_alerts":
        geom = nws_geometry(ev, boroughs)[0]
    if geom is None and out["lat"] is not None:
        geom = point(out["lon"], out["lat"])
    entities = []
    for ref in refs:
        kind, eid = _split(ref)
        hit = lookup.get(kind, eid)
        if hit is not None:
            entities.append(
                {
                    "kind": kind,
                    "id": eid,
                    "name": hit["name"],
                    "lat": None if hit["lat"] is None else r5(hit["lat"]),
                    "lon": None if hit["lon"] is None else r5(hit["lon"]),
                }
            )
    return {**out, "geometry": geom, "entity_refs": refs, "entities": entities}

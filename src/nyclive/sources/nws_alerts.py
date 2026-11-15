"""National Weather Service active alerts for New York, filtered to NYC (nws_alerts).

`/alerts/active?area=NY` returns a GeoJSON FeatureCollection for the whole state; we keep the
features whose SAME geocodes include one of the five NYC counties. The payload is the full
current set, so alerts that drop out of it are closed by the pipeline.

Quirks: the active list is often empty. Many alerts have no geometry (zone-based); only Polygon
and MultiPolygon geometries become WKT. Descriptions can pass 2 KB, so description and
instruction are trimmed to keep props under `PROPS_MAX_BYTES`. Expiration statements (VTEC
action EXP) are sent after the event ended, so their `onset` can be later than `ends`; such a
record can't be built with ends_at >= starts_at and is skipped.
"""

from __future__ import annotations

import json
from typing import Any

from nyclive.model import PROPS_MAX_BYTES, Event, borough_code
from nyclive.sources.base import Batch, FetchContext, RawPart, RawPayload
from nyclive.timeutil import parse_iso_utc

SOURCE_IDS = ("nws_alerts",)

URL = "https://api.weather.gov/alerts/active"
PARAMS = {"area": "NY"}
HEADERS = {"Accept": "application/geo+json"}
NYC_SAME = frozenset({"036005", "036047", "036061", "036081", "036085"})
SEVERITY = {"Extreme": 3, "Severe": 3, "Moderate": 2, "Minor": 1}
CATEGORY = "weather_alert"
_TEXT_FIELDS = ("description", "instruction")
_ELLIPSIS = "…"


def fetch(ctx: FetchContext) -> RawPayload:
    r = ctx.http.get(URL, params=PARAMS, headers=HEADERS)
    return RawPayload(SOURCE_IDS[0], (RawPart("active", str(r.url), r.content, ctx.now),))


def parse(raw: RawPayload) -> Batch:
    if raw.source_id not in SOURCE_IDS:
        raise ValueError(f"nws_alerts adapter does not serve {raw.source_id!r}")
    doc = raw.json("active")
    if not isinstance(doc, dict) or not isinstance(doc.get("features"), list):
        raise ValueError("expected a GeoJSON FeatureCollection")  # noqa: TRY004 (contract)
    batch = Batch(complete=frozenset({"events"}))
    seen: set[str] = set()
    for feature in doc["features"]:
        event = _event(raw.source_id, feature)
        if event is None or event.event_id in seen:
            continue
        seen.add(event.event_id)
        batch.events.append(event)
    return batch


def _event(sid: str, feature: Any) -> Event | None:
    if not isinstance(feature, dict) or not isinstance(feature.get("properties"), dict):
        return None
    p = feature["properties"]
    same = (p.get("geocode") or {}).get("SAME") or []
    nyc = sorted(NYC_SAME.intersection(str(s) for s in same))
    if not nyc or not p.get("id"):
        return None
    try:
        start_s = p.get("onset") or p.get("effective") or p.get("sent")
        if not start_s:
            return None
        starts_at = parse_iso_utc(start_s)
        end_s = p.get("ends") or p.get("expires")
        ends_at = parse_iso_utc(end_s) if end_s else None
    except (TypeError, ValueError):
        return None
    if ends_at is not None and ends_at < starts_at:
        return None  # an EXP statement sent after the event ended (see module docstring)
    boroughs = {borough_code(s) for s in nyc}
    return Event(
        source=sid,
        event_id=str(p["id"]),
        category=CATEGORY,
        title=p.get("headline") or p.get("event") or "Weather alert",
        starts_at=starts_at,
        ends_at=ends_at,
        subtype=p.get("event") or None,
        severity=SEVERITY.get(p.get("severity"), 0),
        geometry_wkt=_wkt(feature.get("geometry")),
        borough=boroughs.pop() if len(boroughs) == 1 else None,
        props=_props(p, nyc),
    )


def _props(p: dict, nyc: list[str]) -> dict[str, Any]:
    props: dict[str, Any] = {
        "areaDesc": p.get("areaDesc"),
        "urgency": p.get("urgency"),
        "certainty": p.get("certainty"),
        "severity": p.get("severity"),
        "status": p.get("status"),
        "messageType": p.get("messageType"),
        "sender_name": p.get("senderName"),
        "nyc_same": nyc,
    }
    for k in _TEXT_FIELDS:
        props[k] = p.get(k) if isinstance(p.get(k), str) else None
    # Trim the longer text field until the props fit; deterministic for a given input.
    while (over := _size(props) - PROPS_MAX_BYTES) > 0:
        k = max(_TEXT_FIELDS, key=lambda f: len(props[f] or ""))
        text = props[k] or ""
        if not text:
            break  # nothing left to trim; record_problems will report the oversize props
        keep = max(0, len(text.rstrip(_ELLIPSIS)) - over - len(_ELLIPSIS))
        props[k] = text[:keep].rstrip() + _ELLIPSIS if keep else None
    return props


def _size(props: dict) -> int:
    return len(json.dumps(props, ensure_ascii=False, allow_nan=False).encode("utf-8"))


def _ring(coords: list) -> str:
    return "(" + ", ".join(f"{float(c[0])!r} {float(c[1])!r}" for c in coords) + ")"


def _polygon(rings: list) -> str:
    return "(" + ", ".join(_ring(r) for r in rings) + ")"


def _wkt(geometry: Any) -> str | None:
    """Polygon / MultiPolygon GeoJSON (lon, lat) to WKT; anything else gives None."""
    if not isinstance(geometry, dict):
        return None
    coords = geometry.get("coordinates")
    try:
        if geometry.get("type") == "Polygon" and coords:
            return "POLYGON " + _polygon(coords)
        if geometry.get("type") == "MultiPolygon" and coords:
            return "MULTIPOLYGON (" + ", ".join(_polygon(poly) for poly in coords) + ")"
    except (TypeError, ValueError, IndexError):
        return None
    return None

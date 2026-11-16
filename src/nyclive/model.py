"""The three record shapes every adapter produces (docs/DATA_MODEL.md).

Adapters build `Entity`, `Observation` and `Event` values. Storage adds bookkeeping columns
(`first_seen`, `last_seen`, `payload_hash`, `updated_at`) when it writes them; the Arrow schemas
below describe the archived rows, including those columns.

Only the conductor edits the enums here. Builders propose additions in their handback.
"""

from __future__ import annotations

import json
import math
import re
from collections.abc import Mapping
from dataclasses import dataclass, field
from datetime import datetime
from typing import Any

import pyarrow as pa

# ------------------------------------------------------------------------------------- enums
KINDS = frozenset(
    {
        "camera",
        "bike_station",
        "flood_sensor",
        "tide_gauge",
        "road_segment",
        "subway_station",
        "weather_point",
        "elevator",
    }
)

# Kinds an Event may reference without anyone writing them as entities.
REF_ONLY_KINDS = frozenset({"subway_route"})

METRICS = frozenset(
    {
        # Citi Bike
        "bikes_available",
        "ebikes_available",
        "docks_available",
        "is_renting",
        # NOAA tides
        "water_level_ft",
        "predicted_ft",
        # DOT speeds
        "speed_mph",
        "travel_time_s",
        # Open-Meteo
        "temp_c",
        "precip_mm",
        "rain_mm",
        "wind_kmh",
        # FloodNet live (if the spike succeeds)
        "depth_in",
        # CV counts (Phase 4)
        "count_car",
        "count_truck",
        "count_bus",
        "count_person",
        "count_bicycle",
        "count_motorcycle",
    }
)

CATEGORIES = frozenset(
    {
        "service_alert",
        "elevator_outage",
        "weather_alert",
        "complaint_311",
        "collision",
        "flood",
        "train",
        "city_alert",  # Notify NYC (ADR-015)
    }
)

BOROUGHS = ("MN", "BK", "QN", "BX", "SI")

# Rough NYC bounding box (a little generous at the edges). Coordinates outside it are bugs.
NYC_BBOX = (40.40, -74.35, 41.00, -73.60)  # min_lat, min_lon, max_lat, max_lon

PROPS_MAX_BYTES = 4096

_BOROUGH_INPUTS = {
    "MN": ("manhattan", "new york", "m", "mn", "036061", "36061"),
    "BK": ("brooklyn", "kings", "bk", "036047", "36047"),
    "QN": ("queens", "q", "qn", "036081", "36081"),
    "BX": ("bronx", "the bronx", "bx", "036005", "36005"),
    "SI": ("staten island", "richmond", "si", "036085", "36085"),
}
_BOROUGH_LOOKUP = {alias: code for code, aliases in _BOROUGH_INPUTS.items() for alias in aliases}


def borough_code(value: object) -> str | None:
    """Normalize a publisher's borough to MN/BK/QN/BX/SI. Unknown or blank gives None.

    Accepts names in any case, county names, MTA's M/Bk/Q/Bx/SI, and NWS SAME / FIPS codes.
    """
    if value is None:
        return None
    key = " ".join(str(value).strip().lower().split())
    return _BOROUGH_LOOKUP.get(key)


# ------------------------------------------------------------------------------------ records
@dataclass(frozen=True)
class Entity:
    source: str
    kind: str
    entity_id: str
    name: str
    lat: float | None
    lon: float | None
    geometry_wkt: str | None = None
    borough: str | None = None
    props: Mapping[str, Any] = field(default_factory=dict)

    @property
    def key(self) -> tuple[str, str]:
        return (self.kind, self.entity_id)


@dataclass(frozen=True)
class Observation:
    source: str
    kind: str
    entity_id: str
    metric: str
    observed_at: datetime
    value: float
    fetched_at: datetime

    @property
    def key(self) -> tuple[str, str, str, datetime]:
        return (self.kind, self.entity_id, self.metric, self.observed_at)


@dataclass(frozen=True)
class Event:
    source: str
    event_id: str
    category: str
    title: str
    starts_at: datetime
    ends_at: datetime | None = None
    subtype: str | None = None
    severity: int = 0
    lat: float | None = None
    lon: float | None = None
    geometry_wkt: str | None = None
    borough: str | None = None
    entity_refs: tuple[str, ...] = ()
    props: Mapping[str, Any] = field(default_factory=dict)

    @property
    def key(self) -> tuple[str, str]:
        return (self.source, self.event_id)


Record = Entity | Observation | Event


# --------------------------------------------------------------------------------- validation
_REF = re.compile(r"^([a-z_]+):(.+)$")


def _is_utc(dt: object) -> bool:
    return (
        isinstance(dt, datetime)
        and dt.utcoffset() is not None
        and dt.utcoffset().total_seconds() == 0
    )


def _check_coords(lat: object, lon: object) -> list[str]:
    if lat is None and lon is None:
        return []
    if lat is None or lon is None:
        return ["lat and lon must both be set or both be None"]
    if not all(isinstance(v, float | int) and not isinstance(v, bool) for v in (lat, lon)):
        return ["lat/lon must be numbers"]
    min_lat, min_lon, max_lat, max_lon = NYC_BBOX
    if not (min_lat <= lat <= max_lat and min_lon <= lon <= max_lon):
        return [f"({lat}, {lon}) is outside the NYC bounding box (swapped lat/lon?)"]
    return []


def _check_borough(b: object) -> list[str]:
    return [] if b is None or b in BOROUGHS else [f"borough {b!r} is not one of {BOROUGHS}"]


def _check_props(props: object) -> list[str]:
    if not isinstance(props, Mapping):
        return ["props must be a mapping"]
    try:
        size = len(json.dumps(props, ensure_ascii=False, allow_nan=False).encode("utf-8"))
    except (TypeError, ValueError) as e:
        return [f"props are not JSON-serializable: {e}"]
    if size > PROPS_MAX_BYTES:
        return [f"props are {size} bytes (max {PROPS_MAX_BYTES}); trim them"]
    return []


def _check_text(name: str, v: object, required: bool = True) -> list[str]:
    if v is None and not required:
        return []
    if not isinstance(v, str) or (required and not v.strip()):
        return [f"{name} must be a non-empty string"]
    return []


def record_problems(r: Record) -> list[str]:
    """Everything wrong with one record, as readable strings. Empty means valid."""
    p: list[str] = []
    p += _check_text("source", r.source)
    if isinstance(r, Entity):
        p += _check_text("entity_id", r.entity_id) + _check_text("name", r.name)
        if r.kind not in KINDS:
            p.append(f"kind {r.kind!r} is not in model.KINDS")
        p += _check_coords(r.lat, r.lon) + _check_borough(r.borough) + _check_props(r.props)
        p += _check_text("geometry_wkt", r.geometry_wkt, required=False)
    elif isinstance(r, Observation):
        p += _check_text("entity_id", r.entity_id)
        if r.kind not in KINDS:
            p.append(f"kind {r.kind!r} is not in model.KINDS")
        if r.metric not in METRICS:
            p.append(f"metric {r.metric!r} is not in model.METRICS")
        if not isinstance(r.value, float) or not math.isfinite(r.value):
            p.append(f"value must be a finite float, got {r.value!r}")
        for name in ("observed_at", "fetched_at"):
            if not _is_utc(getattr(r, name)):
                p.append(f"{name} must be a tz-aware UTC datetime")
    elif isinstance(r, Event):
        p += _check_text("event_id", r.event_id) + _check_text("title", r.title)
        if r.category not in CATEGORIES:
            p.append(f"category {r.category!r} is not in model.CATEGORIES")
        if not _is_utc(r.starts_at):
            p.append("starts_at must be a tz-aware UTC datetime")
        if r.ends_at is not None:
            if not _is_utc(r.ends_at):
                p.append("ends_at must be a tz-aware UTC datetime or None")
            elif _is_utc(r.starts_at) and r.ends_at < r.starts_at:
                p.append("ends_at is before starts_at")
        if (
            not isinstance(r.severity, int)
            or isinstance(r.severity, bool)
            or not 0 <= r.severity <= 3
        ):
            p.append(f"severity must be an int 0-3, got {r.severity!r}")
        if not isinstance(r.entity_refs, tuple):
            p.append("entity_refs must be a tuple")
        else:
            for ref in r.entity_refs:
                m = _REF.match(ref) if isinstance(ref, str) else None
                if not m or m.group(1) not in KINDS | REF_ONLY_KINDS:
                    p.append(f"entity_ref {ref!r} must look like '<kind>:<id>' with a known kind")
        p += _check_text("subtype", r.subtype, required=False)
        p += _check_text("geometry_wkt", r.geometry_wkt, required=False)
        p += _check_coords(r.lat, r.lon) + _check_borough(r.borough) + _check_props(r.props)
    else:
        p.append(f"not a record: {type(r).__name__}")
    return p


# ------------------------------------------------------------------------- Arrow (archive rows)
_TS = pa.timestamp("us", tz="UTC")

ENTITY_SCHEMA = pa.schema(
    [
        ("source", pa.string()),
        ("kind", pa.string()),
        ("entity_id", pa.string()),
        ("name", pa.string()),
        ("lat", pa.float64()),
        ("lon", pa.float64()),
        ("geometry_wkt", pa.string()),
        ("borough", pa.string()),
        ("props", pa.string()),  # JSON
        ("first_seen", _TS),
        ("last_seen", _TS),
        ("payload_hash", pa.string()),
    ]
)

OBSERVATION_SCHEMA = pa.schema(
    [
        ("source", pa.string()),
        ("kind", pa.string()),
        ("entity_id", pa.string()),
        ("metric", pa.string()),
        ("observed_at", _TS),
        ("value", pa.float64()),
        ("fetched_at", _TS),
    ]
)

EVENT_SCHEMA = pa.schema(
    [
        ("source", pa.string()),
        ("event_id", pa.string()),
        ("category", pa.string()),
        ("subtype", pa.string()),
        ("title", pa.string()),
        ("starts_at", _TS),
        ("ends_at", _TS),
        ("severity", pa.int8()),
        ("lat", pa.float64()),
        ("lon", pa.float64()),
        ("geometry_wkt", pa.string()),
        ("borough", pa.string()),
        ("entity_refs", pa.list_(pa.string())),
        ("props", pa.string()),  # JSON
        ("payload_hash", pa.string()),
        ("updated_at", _TS),
    ]
)

RUNS_SCHEMA = pa.schema(
    [
        ("run_id", pa.string()),
        ("source", pa.string()),
        ("started_at", _TS),
        ("finished_at", _TS),
        ("ok", pa.bool_()),
        ("bytes", pa.int64()),
        ("rows_written", pa.int64()),
        ("error", pa.string()),
    ]
)

SCHEMAS = {
    "entities": ENTITY_SCHEMA,
    "observations": OBSERVATION_SCHEMA,
    "events": EVENT_SCHEMA,
    "runs": RUNS_SCHEMA,
}

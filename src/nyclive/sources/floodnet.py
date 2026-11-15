"""FloodNet on NYC Open Data: sensor deployments (floodnet_sensors, kb2e-tjy3) and flood events
(floodnet_events, aq7i-eu5q).

One module, two registry ids (like citibike): parse dispatches on raw.source_id. Both are
Socrata datasets paged with `_socrata.fetch_pages` into parts `page-000`, `page-001`, ...

Quirks: every value is a string, `tidally_influenced` is "Yes"/"No", and the depth profile comes
as a string holding a JSON list ("[0.00, 0.51, ...]"). Flood times are floating timestamps but,
unlike most Socrata data, they are **UTC** (verified 2026-11-15: Beach 84 St flood peaks land
29-61 min after NOAA Rockaway Inlet high tides when read as UTC, and near low tide when read as
New York time). So they go through `parse_naive_utc`, and the `$where` literal is UTC too.
The events dataset lags about two weeks, so the cursor rewinds 30 days on each run.
"""

from __future__ import annotations

import json
import math
from datetime import UTC, datetime, timedelta

from nyclive.model import PROPS_MAX_BYTES, Entity, Event, borough_code
from nyclive.sources import _socrata
from nyclive.sources.base import Batch, FetchContext, RawPayload
from nyclive.timeutil import parse_iso_utc, parse_naive_utc

SOURCE_IDS = ("floodnet_sensors", "floodnet_events")

SENSORS_URL = "https://data.cityofnewyork.us/resource/kb2e-tjy3.json"
EVENTS_URL = "https://data.cityofnewyork.us/resource/aq7i-eu5q.json"
SENSOR_COLUMNS = (
    "sensor_id",
    "sensor_name",
    "latitude",
    "longitude",
    "borough",
    "tidally_influenced",
    "nta",
    "lowest_point_height_delta_inches",
    "date_installed",
)
EVENT_COLUMNS = (
    "sensor_id",
    "sensor_name",
    "flood_start_time",
    "flood_end_time",
    "max_depth_inches",
    "onset_time_mins",
    "drain_time_mins",
    "duration_mins",
    "flood_profile_depth_inches",
    "flood_profile_time_secs",
)
SENSOR_MAX_PAGES = 20  # "all pages": ~500 sensors today, one page
EVENT_MAX_PAGES = 5
FIRST_RUN_LOOKBACK = timedelta(days=90)
CURSOR_REWIND = timedelta(days=30)  # the dataset is published about two weeks late
SEVERE_IN, MODERATE_IN = 12.0, 4.0
_MINUTES = {
    "onset_time_mins": "onset_mins",
    "drain_time_mins": "drain_mins",
    "duration_mins": "duration_mins",
}


# ---------------------------------------------------------------------------------- fetch
def _utc_literal(dt: datetime) -> str:
    """A Socrata floating literal holding UTC wall-clock time (FloodNet events are UTC)."""
    return dt.astimezone(UTC).replace(tzinfo=None).isoformat(timespec="milliseconds")


def fetch(ctx: FetchContext) -> RawPayload:
    sid = ctx.source.id
    if sid == "floodnet_sensors":
        parts = _socrata.fetch_pages(
            ctx,
            SENSORS_URL,
            select=SENSOR_COLUMNS,
            order="sensor_id",
            max_pages=SENSOR_MAX_PAGES,
        )
    elif sid == "floodnet_events":
        since = (
            parse_iso_utc(ctx.cursor) - CURSOR_REWIND
            if ctx.cursor
            else ctx.now - FIRST_RUN_LOOKBACK
        )
        parts = _socrata.fetch_pages(
            ctx,
            EVENTS_URL,
            select=EVENT_COLUMNS,
            order="flood_start_time",
            where=f"flood_start_time > '{_utc_literal(since)}'",
            max_pages=EVENT_MAX_PAGES,
        )
    else:
        raise ValueError(f"floodnet adapter does not serve {sid!r}")
    return _socrata.payload(ctx, parts)


# ---------------------------------------------------------------------------------- parse
def parse(raw: RawPayload) -> Batch:
    if raw.source_id == "floodnet_sensors":
        return _parse_sensors(raw)
    if raw.source_id == "floodnet_events":
        return _parse_events(raw)
    raise ValueError(f"floodnet adapter does not serve {raw.source_id!r}")


def _rows(raw: RawPayload) -> list[dict]:
    rows = _socrata.rows(raw)
    if not all(isinstance(r, dict) for r in rows):
        raise ValueError(f"{raw.source_id}: pages must be JSON lists of objects")
    return rows


def _text(v: object) -> str | None:
    s = str(v).strip() if v is not None else ""
    return s or None


def _float(v: object) -> float | None:
    try:
        x = float(v)  # type: ignore[arg-type]
    except (TypeError, ValueError):
        return None
    return x if math.isfinite(x) else None


def _bool(v: object) -> bool | None:
    s = (_text(v) or "").lower()
    return {"yes": True, "true": True, "no": False, "false": False}.get(s)


def _parse_sensors(raw: RawPayload) -> Batch:
    sid = raw.source_id
    rows = _rows(raw)
    if not rows:
        raise ValueError("floodnet_sensors: no sensors (a complete set can't be empty)")
    batch = Batch(complete=frozenset({"entities"}))
    seen: set[str] = set()
    for r in rows:
        sensor_id = _text(r.get("sensor_id"))
        if sensor_id is None or sensor_id in seen:
            continue
        seen.add(sensor_id)
        lat, lon = _float(r.get("latitude")), _float(r.get("longitude"))
        if lat is None or lon is None or (lat == 0 and lon == 0):
            lat = lon = None
        props = {
            "tidally_influenced": _bool(r.get("tidally_influenced")),
            "nta": _text(r.get("nta")),
            "lowest_point_height_delta_inches": _float(r.get("lowest_point_height_delta_inches")),
            "date_installed": _text(r.get("date_installed")),
        }
        batch.entities.append(
            Entity(
                source=sid,
                kind="flood_sensor",
                entity_id=sensor_id,
                name=_text(r.get("sensor_name")) or sensor_id,
                lat=lat,
                lon=lon,
                borough=borough_code(r.get("borough")),
                props={k: v for k, v in props.items() if v is not None},
            )
        )
    return batch


def _profile(v: object) -> list | None:
    """The profile string ("[0.00, 0.51, ...]") as a list of numbers, or None."""
    if not isinstance(v, str):
        return None
    try:
        values = json.loads(v)
    except ValueError:
        return None
    if not isinstance(values, list) or not all(
        isinstance(x, int | float) and not isinstance(x, bool) and math.isfinite(x) for x in values
    ):
        return None
    return values


def _size(props: dict) -> int:
    return len(json.dumps(props, ensure_ascii=False, allow_nan=False).encode("utf-8"))


def _severity(depth: float | None) -> int:
    if depth is not None and depth >= SEVERE_IN:
        return 3
    if depth is not None and depth >= MODERATE_IN:
        return 2
    return 1


def _parse_events(raw: RawPayload) -> Batch:
    sid = raw.source_id
    batch = Batch(cursor=raw.cursor)
    newest: datetime | None = None
    seen: set[str] = set()
    for r in _rows(raw):
        sensor_id = _text(r.get("sensor_id"))
        start_raw = _text(r.get("flood_start_time"))
        if sensor_id is None or start_raw is None:
            continue
        event_id = f"{sensor_id}:{start_raw}"
        try:
            starts_at = parse_naive_utc(start_raw)
        except ValueError:
            continue
        if event_id in seen:
            continue
        seen.add(event_id)
        ends_at = None
        end_raw = _text(r.get("flood_end_time"))
        if end_raw is not None:
            try:
                ends_at = parse_naive_utc(end_raw)
            except ValueError:
                ends_at = None
            if ends_at is not None and ends_at < starts_at:
                ends_at = None

        depth = _float(r.get("max_depth_inches"))
        props: dict = {"max_depth_inches": depth}
        for col, key in _MINUTES.items():
            props[key] = _float(r.get(col))
        props = {k: v for k, v in props.items() if v is not None}
        depths = _profile(r.get("flood_profile_depth_inches"))
        secs = _profile(r.get("flood_profile_time_secs"))
        if depths is not None and secs is not None:
            full = {**props, "profile_depth_inches": depths, "profile_time_secs": secs}
            if _size(full) <= PROPS_MAX_BYTES:
                props = full
            else:
                props["profile_dropped"] = True

        name = _text(r.get("sensor_name")) or sensor_id
        title = f"Flooding at {name}" + (f", {depth:g} in" if depth is not None else "")
        batch.events.append(
            Event(
                source=sid,
                event_id=event_id,
                category="flood",
                title=title,
                starts_at=starts_at,
                ends_at=ends_at,
                severity=_severity(depth),
                borough=borough_code(sensor_id.split("-", 1)[0]),
                entity_refs=(f"flood_sensor:{sensor_id}",),
                props=props,
            )
        )
        newest = starts_at if newest is None or starts_at > newest else newest
    if newest is not None and (raw.cursor is None or newest > parse_iso_utc(raw.cursor)):
        batch.cursor = newest.isoformat()  # never moves back (the fetch window rewinds 30 days)
    return batch

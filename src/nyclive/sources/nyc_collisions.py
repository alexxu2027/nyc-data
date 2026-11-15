"""NYPD motor vehicle collisions (Socrata h9gi-nx95) as collision events.

One paged query per run: `crash_date >= cursor minus 10 days` (first run: now minus 14 days),
ordered by crash_date, at most 5 pages. The dataset lags several days and rows arrive late, so
each run re-reads a 10-day window and the pipeline upserts on collision_id. The cursor is the
newest crash time seen (UTC ISO).

Quirks: crash_date is a floating midnight ("2026-11-11T00:00:00.000") and crash_time a separate
"H:MM" string, both NY local; they are combined before converting, so DST is applied to the
crash's own wall-clock time. Some rows have no borough, and some have latitude/longitude "0"
(treated as unknown). Vehicle type columns are spelled vehicle_type_code1, vehicle_type_code2,
then vehicle_type_code_3.._5. The payload is not the full set, so nothing is complete.
"""

from __future__ import annotations

import json
from datetime import timedelta
from typing import Any

from nyclive.model import NYC_BBOX, Event, borough_code
from nyclive.sources import _socrata
from nyclive.sources.base import Batch, FetchContext, RawPayload
from nyclive.timeutil import local_to_utc, parse_iso_utc

SOURCE_IDS = ("nyc_collisions",)

URL = "https://data.cityofnewyork.us/resource/h9gi-nx95.json"
COUNTS = (
    "number_of_persons_injured",
    "number_of_persons_killed",
    "number_of_pedestrians_injured",
    "number_of_pedestrians_killed",
    "number_of_cyclist_injured",
    "number_of_cyclist_killed",
    "number_of_motorist_injured",
    "number_of_motorist_killed",
)
VEHICLE_TYPES = (
    "vehicle_type_code1",
    "vehicle_type_code2",
    "vehicle_type_code_3",
    "vehicle_type_code_4",
    "vehicle_type_code_5",
)
STREETS = ("on_street_name", "cross_street_name", "off_street_name")
SELECT = (
    "collision_id",
    "crash_date",
    "crash_time",
    "borough",
    "latitude",
    "longitude",
    *STREETS,
    *COUNTS,
    "contributing_factor_vehicle_1",
    *VEHICLE_TYPES,
)
FIRST_RUN_LOOKBACK = timedelta(days=14)
RELOOK = timedelta(days=10)  # re-read this far behind the cursor for late rows
MAX_PAGES = 5
CATEGORY = "collision"
_LOCAL_FMT = "%Y-%m-%d %H:%M"


def fetch(ctx: FetchContext) -> RawPayload:
    since = parse_iso_utc(ctx.cursor) - RELOOK if ctx.cursor else ctx.now - FIRST_RUN_LOOKBACK
    parts = _socrata.fetch_pages(
        ctx,
        URL,
        select=SELECT,
        order="crash_date",
        where=f"crash_date >= '{_socrata.floating(since)}'",
        max_pages=MAX_PAGES,
    )
    return _socrata.payload(ctx, parts)


def parse(raw: RawPayload) -> Batch:
    if raw.source_id not in SOURCE_IDS:
        raise ValueError(f"nyc_collisions adapter does not serve {raw.source_id!r}")
    pages = [p for p in raw.parts if p.name.startswith("page-")]
    if not pages:
        raise ValueError(f"nyc_collisions payload has no page-NNN parts ({raw.parts[0].name!r})")
    for p in pages:
        if not isinstance(json.loads(p.content), list):
            raise ValueError(f"nyc_collisions part {p.name!r} is not a JSON list")  # noqa: TRY004
    batch = Batch(cursor=raw.cursor)
    seen: set[str] = set()
    newest = None
    for row in _socrata.rows(raw):
        event = _event(raw.source_id, row)
        if event is None or event.event_id in seen:
            continue
        seen.add(event.event_id)
        batch.events.append(event)
        newest = event.starts_at if newest is None or event.starts_at > newest else newest
    if newest is not None:  # clamp: a typo'd future crash_date must not stall the cursor
        batch.cursor = min(newest, raw.fetched_at).isoformat()
    return batch


def _event(sid: str, row: Any) -> Event | None:
    if not isinstance(row, dict) or not row.get("collision_id"):
        return None
    try:
        local = f"{str(row['crash_date'])[:10]} {str(row['crash_time']).strip()}"
        at = local_to_utc(local, _LOCAL_FMT)
    except (KeyError, TypeError, ValueError):
        return None  # no usable crash date + time
    counts = {k.removeprefix("number_of_"): _int(row.get(k)) for k in COUNTS}
    killed, injured = counts["persons_killed"], counts["persons_injured"]
    severity = 3 if killed > 0 else 2 if injured > 0 else 1
    title = "Collision"
    if killed > 0:
        title += f", {killed} killed"
    if injured > 0:
        title += f", {injured} injured"
    lat, lon = _coords(row.get("latitude"), row.get("longitude"))
    props: dict[str, Any] = {
        **counts,
        "vehicle_types": [v for k in VEHICLE_TYPES if (v := _text(row.get(k)))],
        **{k: _text(row.get(k)) for k in STREETS},
    }
    return Event(
        source=sid,
        event_id=str(row["collision_id"]),
        category=CATEGORY,
        title=title,
        starts_at=at,
        ends_at=at,
        subtype=_text(row.get("contributing_factor_vehicle_1")),
        severity=severity,
        lat=lat,
        lon=lon,
        borough=borough_code(row.get("borough")),
        props=props,
    )


def _int(value: Any) -> int:
    try:
        return max(0, int(float(value)))
    except (TypeError, ValueError, OverflowError):
        return 0


def _text(value: Any) -> str | None:
    if not isinstance(value, str):
        return None
    value = " ".join(value.split())
    return value or None


def _coords(lat_s: Any, lon_s: Any) -> tuple[float | None, float | None]:
    """Both coordinates as floats, or (None, None) if either is missing, zero or outside NYC."""
    try:
        lat, lon = float(lat_s), float(lon_s)
    except (TypeError, ValueError):
        return None, None
    min_lat, min_lon, max_lat, max_lon = NYC_BBOX
    if not (min_lat <= lat <= max_lat and min_lon <= lon <= max_lon):
        return None, None
    return lat, lon

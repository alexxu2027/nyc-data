"""NYC DOT real-time traffic speeds (Socrata i4gi-tjb9) as road segments + observations.

Each row is one reading for one link: speed (mph) and travel time (s) as of `data_as_of`, a
floating NY-local timestamp. The feed is near-live (rows can lag ~2 h), so we page forward from
the newest `data_as_of` we have stored. Not a complete set: a link missing from one run is not
gone.

Quirks:
- `link_points` is truncated mid-coordinate, so geometry comes from `encoded_poly_line` (Google
  polyline, precision 5), decoded here.
- In the published polyline every `|` arrives as two backslashes plus `|` (an escaping artifact:
  without undoing it 9 of 40 real rows decode to points far outside NYC). We turn `\\\\|` back
  into `|` before decoding; single backslashes are ordinary polyline characters and are kept.
- Some polylines are themselves truncated (they end mid-number). Those, and any that land outside
  NYC, give an entity with no geometry and no lat/lon; its observations are still written.
- Rows with a negative `status` (seen: -101) carry speed 0 and travel time 0, i.e. no reading.
  They give no observations (a missing value means no row).
"""

from __future__ import annotations

import math
from datetime import datetime, timedelta

from nyclive.model import NYC_BBOX, Entity, Observation, borough_code
from nyclive.sources import _socrata
from nyclive.sources.base import Batch, FetchContext, RawPayload
from nyclive.timeutil import local_to_utc, parse_iso_utc

SOURCE_IDS = ("dot_traffic_speeds",)

URL = "https://data.cityofnewyork.us/resource/i4gi-tjb9.json"
SELECT = (
    "link_id",
    "speed",
    "travel_time",
    "status",
    "data_as_of",
    "borough",
    "link_name",
    "encoded_poly_line",
    "owner",
)
ORDER = "data_as_of"
MAX_PAGES = 5
CURSOR_OVERLAP = timedelta(minutes=15)
FIRST_RUN_LOOKBACK = timedelta(hours=4)  # the feed lags ~2 h; 1 h returned nothing live
KIND = "road_segment"
METRICS = (("speed", "speed_mph"), ("travel_time", "travel_time_s"))
_ESCAPED_PIPE = "\\\\|"  # two backslashes then a pipe, as published


def fetch(ctx: FetchContext) -> RawPayload:
    since = (
        parse_iso_utc(ctx.cursor) if ctx.cursor else ctx.now - FIRST_RUN_LOOKBACK + CURSOR_OVERLAP
    )
    parts = _socrata.fetch_pages(
        ctx,
        URL,
        select=SELECT,
        order=ORDER,
        # Publish batches overlap by minutes across links, so re-read behind the cursor;
        # change-only writes make the overlap free (review finding 2026-11-15: a strict > lost
        # 8-21% of readings live).
        where=f"data_as_of > '{_socrata.floating(since - CURSOR_OVERLAP)}'",
        max_pages=MAX_PAGES,
    )
    return _socrata.payload(ctx, parts)


# ------------------------------------------------------------------------------------ polyline
def decode_polyline(s: str, precision: int = 5) -> list[tuple[float, float]]:
    """Decode a Google encoded polyline to [(lat, lon), ...]. Raises ValueError if malformed."""
    values: list[int] = []
    acc = shift = 0
    for ch in s:
        b = ord(ch) - 63
        if not 0 <= b < 64:
            raise ValueError(f"bad polyline character {ch!r}")
        acc |= (b & 0x1F) << shift
        shift += 5
        if not b & 0x20:
            values.append(~(acc >> 1) if acc & 1 else acc >> 1)
            acc = shift = 0
    if shift or len(values) % 2:
        raise ValueError("polyline ends mid-coordinate")
    scale = 10**precision
    points: list[tuple[float, float]] = []
    lat = lon = 0
    for i in range(0, len(values), 2):
        lat += values[i]
        lon += values[i + 1]
        points.append((lat / scale, lon / scale))
    return points


def _in_nyc(lat: float, lon: float) -> bool:
    min_lat, min_lon, max_lat, max_lon = NYC_BBOX
    return min_lat <= lat <= max_lat and min_lon <= lon <= max_lon


def _geometry(encoded: object) -> tuple[str | None, float | None, float | None]:
    """(LINESTRING WKT in lon lat order, middle-vertex lat, lon), or Nones if unusable."""
    if not isinstance(encoded, str) or not encoded:
        return None, None, None
    try:
        points = decode_polyline(encoded.replace(_ESCAPED_PIPE, "|"))
    except ValueError:
        return None, None, None
    if len(points) < 2 or not all(_in_nyc(lat, lon) for lat, lon in points):
        return None, None, None
    wkt = "LINESTRING (" + ", ".join(f"{lon!r} {lat!r}" for lat, lon in points) + ")"
    mid_lat, mid_lon = points[len(points) // 2]
    return wkt, mid_lat, mid_lon


# --------------------------------------------------------------------------------------- parse
def _float(v: object) -> float | None:
    try:
        x = float(v)  # type: ignore[arg-type]
    except (TypeError, ValueError):
        return None
    return x if math.isfinite(x) else None


def _no_reading(row: dict) -> bool:
    status = str(row.get("status") or "0").strip()
    return status.startswith("-")


def parse(raw: RawPayload) -> Batch:
    if raw.source_id not in SOURCE_IDS:
        raise ValueError(f"dot_speeds adapter does not serve {raw.source_id!r}")
    sid = raw.source_id
    fetched_at = raw.fetched_at
    rows = _socrata.rows(raw)
    if not all(isinstance(r, dict) for r in rows):
        raise ValueError("expected Socrata pages of JSON objects")

    # (observed_at, row) per readable row; newest row per link builds the entity
    readings: list[tuple[datetime, dict]] = []
    for row in rows:
        link_id = str(row.get("link_id") or "").strip()
        when = row.get("data_as_of")
        if not link_id or not isinstance(when, str):
            continue
        try:
            observed_at = local_to_utc(when)
        except ValueError:
            continue
        readings.append((observed_at, row))

    batch = Batch(cursor=raw.cursor)
    newest: dict[str, tuple[datetime, dict]] = {}
    for observed_at, row in readings:
        link_id = str(row["link_id"]).strip()
        if link_id not in newest or observed_at > newest[link_id][0]:
            newest[link_id] = (observed_at, row)
    batch.entities = [_entity(sid, link_id, newest[link_id][1]) for link_id in sorted(newest)]

    seen: set[tuple[str, str, datetime]] = set()
    for observed_at, row in readings:
        link_id = str(row["link_id"]).strip()
        if _no_reading(row):
            continue
        for field, metric in METRICS:
            value = _float(row.get(field))
            key = (link_id, metric, observed_at)
            if value is None or key in seen:
                continue
            seen.add(key)
            batch.observations.append(
                Observation(sid, KIND, link_id, metric, observed_at, value, fetched_at)
            )

    if readings:  # clamp: a future-dated row must not stall the cursor
        batch.cursor = min(max(t for t, _ in readings), raw.fetched_at).isoformat()
    return batch


def _entity(sid: str, link_id: str, row: dict) -> Entity:
    name = str(row.get("link_name") or "").strip() or link_id
    wkt, lat, lon = _geometry(row.get("encoded_poly_line"))
    owner = row.get("owner")
    return Entity(
        source=sid,
        kind=KIND,
        entity_id=link_id,
        name=name,
        lat=lat,
        lon=lon,
        geometry_wkt=wkt,
        borough=borough_code(row.get("borough")),
        props={"owner": owner} if owner else {},
    )

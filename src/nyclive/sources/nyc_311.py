"""NYC 311 service requests (Socrata erm2-nwe9) as complaint_311 events.

Two bounded queries per run (config/sources.yaml notes), both with `$select`:

- `new-NNN`: `created_date > cursor` (first run: now minus 7 days), ordered by created_date;
- `closed-NNN`: `closed_date > cursor minus 3 days AND created_date > now minus 30 days`,
  ordered by closed_date, so requests opened earlier pick up their closure.

Never cursor on `:updated_at`: the city bulk-rewrites it (571,739 rows in two days on
2026-11-14). The cursor is the newest created_date from the `new` query only: the `closed` query
reaches up to 30 days of created dates, so taking its newest created_date could jump the cursor
past new rows that a page-capped `new` query never reached.

Quirks: timestamps are NY local with no offset. Some rows have no coordinates, some have borough
"Unspecified", and a few have a closed_date before created_date (kept with ends_at None and the
raw value in props.bad_closed_date). The payload is not the full set, so nothing is complete.
"""

from __future__ import annotations

import json
from datetime import timedelta
from typing import Any

from nyclive.model import NYC_BBOX, Event, borough_code
from nyclive.sources import _socrata
from nyclive.sources.base import Batch, FetchContext, RawPayload
from nyclive.timeutil import local_to_utc, parse_iso_utc

SOURCE_IDS = ("nyc_311",)

URL = "https://data.cityofnewyork.us/resource/erm2-nwe9.json"
SELECT = (
    "unique_key",
    "created_date",
    "closed_date",
    "agency",
    "complaint_type",
    "descriptor",
    "status",
    "borough",
    "incident_zip",
    "latitude",
    "longitude",
    "resolution_description",
)
FIRST_RUN_LOOKBACK = timedelta(days=7)
CLOSED_OVERLAP = timedelta(days=3)  # closed_date > cursor minus this
CLOSED_MAX_AGE = timedelta(days=30)  # only closures of requests created within this
MAX_PAGES = 5
PREFIXES = ("new", "closed")
CATEGORY = "complaint_311"
RESOLUTION_MAX_CHARS = 500


def fetch(ctx: FetchContext) -> RawPayload:
    since = parse_iso_utc(ctx.cursor) if ctx.cursor else ctx.now - FIRST_RUN_LOOKBACK
    new = _socrata.fetch_pages(
        ctx,
        URL,
        select=SELECT,
        order="created_date",
        where=f"created_date > '{_socrata.floating(since)}'",
        prefix="new",
        max_pages=MAX_PAGES,
    )
    closed = _socrata.fetch_pages(
        ctx,
        URL,
        select=SELECT,
        order="closed_date",
        where=(
            f"closed_date > '{_socrata.floating(since - CLOSED_OVERLAP)}'"
            f" AND created_date > '{_socrata.floating(ctx.now - CLOSED_MAX_AGE)}'"
        ),
        prefix="closed",
        max_pages=MAX_PAGES,
    )
    return _socrata.payload(ctx, new + closed)


def parse(raw: RawPayload) -> Batch:
    if raw.source_id not in SOURCE_IDS:
        raise ValueError(f"nyc_311 adapter does not serve {raw.source_id!r}")
    _check_parts(raw)
    batch = Batch(cursor=raw.cursor)

    # Pick one row per unique_key: a row with a closed_date beats one without; between equals the
    # closed query's (later) copy wins. Rows are visited in page order, so this is deterministic.
    chosen: dict[str, tuple[tuple[bool, int], dict]] = {}
    for rank, prefix in enumerate(PREFIXES):
        for row in _socrata.rows(raw, prefix):
            if not isinstance(row, dict) or not row.get("unique_key"):
                continue
            key = str(row["unique_key"])
            pref = (bool(row.get("closed_date")), rank)
            if key not in chosen or pref >= chosen[key][0]:
                chosen[key] = (pref, row)

    for _, row in chosen.values():
        event = _event(raw.source_id, row)
        if event is not None:
            batch.events.append(event)

    newest = None
    for row in _socrata.rows(raw, "new"):
        try:
            t = local_to_utc(row["created_date"])
        except (KeyError, TypeError, ValueError):
            continue
        newest = t if newest is None or t > newest else newest
    if newest is not None:
        batch.cursor = newest.isoformat()
    return batch


def _check_parts(raw: RawPayload) -> None:
    """Both queries must be present and every page must be a JSON list (Socrata errors are
    objects); anything else means the whole payload is malformed."""
    names = [p.name for p in raw.parts]
    for prefix in PREFIXES:
        if f"{prefix}-000" not in names:
            raise ValueError(f"nyc_311 payload has no {prefix}-000 part (have {names})")
    for p in raw.parts:
        if not isinstance(json.loads(p.content), list):
            raise ValueError(f"nyc_311 part {p.name!r} is not a JSON list")  # noqa: TRY004


def _event(sid: str, row: dict) -> Event | None:
    try:
        starts_at = local_to_utc(row["created_date"])
        closed_s = row.get("closed_date")
        closed = local_to_utc(closed_s) if closed_s else None
    except (KeyError, TypeError, ValueError):
        return None
    props: dict[str, Any] = {
        "agency": row.get("agency"),
        "status": row.get("status"),
        "descriptor": row.get("descriptor"),
        "incident_zip": row.get("incident_zip"),
        "resolution": _trim(row.get("resolution_description")),
    }
    ends_at = closed
    if closed is not None and closed < starts_at:
        ends_at = None
        props["bad_closed_date"] = closed_s
    complaint = (row.get("complaint_type") or "").strip()
    descriptor = (row.get("descriptor") or "").strip()
    title = ": ".join(s for s in (complaint, descriptor) if s) or "311 service request"
    lat, lon = _coords(row.get("latitude"), row.get("longitude"))
    return Event(
        source=sid,
        event_id=str(row["unique_key"]),
        category=CATEGORY,
        title=title,
        starts_at=starts_at,
        ends_at=ends_at,
        subtype=complaint or None,
        severity=0,
        lat=lat,
        lon=lon,
        borough=borough_code(row.get("borough")),
        props=props,
    )


def _trim(text: Any) -> str | None:
    if not isinstance(text, str) or not text.strip():
        return None
    text = text.strip()
    return text if len(text) <= RESOLUTION_MAX_CHARS else text[: RESOLUTION_MAX_CHARS - 1] + "…"


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

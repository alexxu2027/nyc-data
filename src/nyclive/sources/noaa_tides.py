"""NOAA CO-OPS water level + predictions for The Battery (station 8518750).

Reference adapter (ROADMAP 1A): shows a cursor, a multi-part payload, and entity + observations
from one source. Surge (observed minus predicted) is derived in queries, not stored.

Quirks: times come back as "2026-11-15 01:06" in UTC with no offset (we request
`time_zone=gmt`), values are strings and can be "" when the sensor misses a reading, and "no data"
is an `{"error": {...}}` object rather than an empty list.
"""

from __future__ import annotations

from datetime import datetime, timedelta

from nyclive.model import Entity, Observation
from nyclive.sources.base import Batch, FetchContext, RawPart, RawPayload
from nyclive.timeutil import parse_iso_utc, parse_naive_utc

SOURCE_IDS = ("noaa_tide_battery",)

STATION = "8518750"
URL = "https://api.tidesandcurrents.noaa.gov/api/prod/datagetter"
FIRST_RUN_LOOKBACK = timedelta(hours=24)
MAX_LOOKBACK = timedelta(days=3)  # after a long outage, don't backfill more than this
PREDICTION_WINDOW = (timedelta(hours=-1), timedelta(hours=24))
_NOAA_FMT = "%Y-%m-%d %H:%M"
_NO_DATA = "No data was found"


def _params(product: str, begin: datetime, end: datetime) -> dict[str, str]:
    return {
        "station": STATION,
        "product": product,
        "begin_date": begin.strftime("%Y%m%d %H:%M"),
        "end_date": end.strftime("%Y%m%d %H:%M"),
        "datum": "MLLW",
        "units": "english",
        "time_zone": "gmt",
        "format": "json",
        "application": "nyc-live",
    }


def fetch(ctx: FetchContext) -> RawPayload:
    now = ctx.now
    begin = parse_iso_utc(ctx.cursor) if ctx.cursor else now - FIRST_RUN_LOOKBACK
    begin = max(begin, now - MAX_LOOKBACK)
    parts = []
    for name, product, b, e in (
        ("levels", "water_level", begin, now),
        ("predictions", "predictions", now + PREDICTION_WINDOW[0], now + PREDICTION_WINDOW[1]),
    ):
        r = ctx.http.get(URL, params=_params(product, b, e))
        parts.append(RawPart(name, str(r.url), r.content, ctx.now))
    return RawPayload(SOURCE_IDS[0], tuple(parts), cursor=ctx.cursor)


def _rows(doc: dict, key: str) -> list[dict]:
    """The data rows, or [] for NOAA's "no data" error. Any other error is a real failure."""
    if "error" in doc:
        msg = str(doc["error"].get("message", doc["error"]))
        if _NO_DATA in msg:
            return []
        raise ValueError(f"NOAA error: {msg}")
    return doc.get(key) or []


def _value(row: dict) -> float | None:
    v = (row.get("v") or "").strip()
    return float(v) if v else None


def parse(raw: RawPayload) -> Batch:
    sid = raw.source_id
    batch = Batch(cursor=raw.cursor)

    levels_part = raw.part("levels")
    levels = raw.json("levels")
    meta = levels.get("metadata")
    if meta:
        batch.entities.append(
            Entity(
                source=sid,
                kind="tide_gauge",
                entity_id=meta["id"],
                name=meta["name"],
                lat=float(meta["lat"]),
                lon=float(meta["lon"]),
                borough="MN",
                props={"station": meta["id"], "datum": "MLLW", "units": "ft"},
            )
        )

    newest = None
    for row in _rows(levels, "data"):
        value = _value(row)
        if value is None:
            continue
        t = parse_naive_utc(row["t"], _NOAA_FMT)
        batch.observations.append(
            Observation(
                sid, "tide_gauge", STATION, "water_level_ft", t, value, levels_part.fetched_at
            )
        )
        newest = t if newest is None or t > newest else newest
    if newest is not None:
        batch.cursor = newest.isoformat()

    preds_part = raw.part("predictions")
    for row in _rows(raw.json("predictions"), "predictions"):
        value = _value(row)
        if value is None:
            continue
        t = parse_naive_utc(row["t"], _NOAA_FMT)
        batch.observations.append(
            Observation(sid, "tide_gauge", STATION, "predicted_ft", t, value, preds_part.fetched_at)
        )
    return batch

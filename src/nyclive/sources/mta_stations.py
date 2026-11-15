"""MTA subway stations from data.ny.gov `39hk-dx4f` (mta_subway_stations).

One GET returns every station row (496 today, well under `$limit=5000`). Entities only; the
payload is the complete set. `entity_id` is the GTFS parent stop id (e.g. "R01"), which is what
subway alerts and elevator outages reference, so they can be pinned to a station.

Quirks: every value is a string (coordinates too); `borough` is MTA's M/Bk/Q/Bx/SI; `ada` is
"0" (no), "1" (yes) or "2" (partial), and is kept as an int.
"""

from __future__ import annotations

from typing import Any

from nyclive.model import NYC_BBOX, Entity, borough_code
from nyclive.sources.base import Batch, FetchContext, RawPart, RawPayload

SOURCE_IDS = ("mta_subway_stations",)

URL = "https://data.ny.gov/resource/39hk-dx4f.json"
PARAMS = {"$limit": "5000"}
KIND = "subway_station"
_PROP_FIELDS = (
    "complex_id",
    "station_id",
    "line",
    "division",
    "daytime_routes",
    "structure",
)


def fetch(ctx: FetchContext) -> RawPayload:
    r = ctx.http.get(URL, params=PARAMS)
    return RawPayload(SOURCE_IDS[0], (RawPart("body", str(r.url), r.content, ctx.now),))


def parse(raw: RawPayload) -> Batch:
    if raw.source_id not in SOURCE_IDS:
        raise ValueError(f"mta_stations adapter does not serve {raw.source_id!r}")
    rows = raw.json("body")
    if not isinstance(rows, list):
        raise ValueError("station list is not a JSON array")  # noqa: TRY004 (contract)
    batch = Batch(complete=frozenset({"entities"}))
    seen: set[str] = set()
    for row in rows:
        entity = _entity(raw.source_id, row)
        if entity is None or entity.entity_id in seen:
            continue
        seen.add(entity.entity_id)
        batch.entities.append(entity)
    return batch


def _entity(sid: str, row: Any) -> Entity | None:
    if not isinstance(row, dict):
        return None
    stop_id = str(row.get("gtfs_stop_id") or "").strip()
    if not stop_id:
        return None
    lat, lon = _coord(row.get("gtfs_latitude"), row.get("gtfs_longitude"))
    props: dict[str, Any] = {k: row[k] for k in _PROP_FIELDS if row.get(k) not in (None, "")}
    if row.get("ada") not in (None, ""):
        props["ada"] = _int_or_raw(row["ada"])
    return Entity(
        source=sid,
        kind=KIND,
        entity_id=stop_id,
        name=str(row.get("stop_name") or "").strip() or stop_id,
        lat=lat,
        lon=lon,
        borough=borough_code(row.get("borough")),
        props=props,
    )


def _coord(lat: object, lon: object) -> tuple[float | None, float | None]:
    try:
        la, lo = float(lat), float(lon)  # type: ignore[arg-type]
    except (TypeError, ValueError):
        return None, None
    min_lat, min_lon, max_lat, max_lon = NYC_BBOX
    if not (min_lat <= la <= max_lat and min_lon <= lo <= max_lon):
        return None, None
    return la, lo


def _int_or_raw(value: object) -> int | str:
    s = str(value).strip()
    return int(s) if s.isdigit() else s

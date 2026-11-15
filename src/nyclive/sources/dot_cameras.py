"""NYC DOT traffic camera list (webcams.nyctmc.org, undocumented but public).

One GET returns every camera (~974). Entities only; the complete set, so cameras that vanish stop
updating `last_seen`. Images are not fetched here: the UI loads `imageUrl` on demand and the CV
worker polls a watchlist (Phase 4).

Quirks: `isOnline` is the string "true"/"false"; `area` is a borough name.
"""

from __future__ import annotations

from nyclive.model import NYC_BBOX, Entity, borough_code
from nyclive.sources.base import Batch, FetchContext, RawPart, RawPayload

SOURCE_IDS = ("dot_cameras",)
URL = "https://webcams.nyctmc.org/api/cameras"


def fetch(ctx: FetchContext) -> RawPayload:
    r = ctx.http.get(URL)
    return RawPayload(SOURCE_IDS[0], (RawPart("body", str(r.url), r.content, ctx.now),))


def _coord(lat: object, lon: object) -> tuple[float | None, float | None]:
    try:
        la, lo = float(lat), float(lon)  # type: ignore[arg-type]
    except (TypeError, ValueError):
        return None, None
    min_lat, min_lon, max_lat, max_lon = NYC_BBOX
    if not (min_lat <= la <= max_lat and min_lon <= lo <= max_lon):
        return None, None
    return la, lo


def parse(raw: RawPayload) -> Batch:
    cams = raw.json("body")
    if not isinstance(cams, list):
        raise ValueError("DOT camera list is not a JSON array")  # noqa: TRY004 - malformed payload
    batch = Batch(complete=frozenset({"entities"}))
    for c in cams:
        cid = str(c.get("id") or "").strip()
        if not cid:
            continue
        lat, lon = _coord(c.get("latitude"), c.get("longitude"))
        props = {"isOnline": str(c.get("isOnline")).lower() == "true"}
        if c.get("imageUrl"):
            props["imageUrl"] = c["imageUrl"]
        batch.entities.append(
            Entity(
                source=raw.source_id,
                kind="camera",
                entity_id=cid,
                name=(c.get("name") or "").strip() or cid,
                lat=lat,
                lon=lon,
                borough=borough_code(c.get("area")),
                props=props,
            )
        )
    return batch

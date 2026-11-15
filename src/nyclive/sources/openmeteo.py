"""Open-Meteo current weather at one point per borough (openmeteo_current).

One request covers all five points (comma-separated latitude/longitude); the response is a JSON
list in the same order. Each point is a `weather_point` entity keyed by its borough code, with
one observation per metric at `current.time`.

Quirks: response coordinates are snapped to the model grid, so the entity keeps the requested
point as lat/lon and the grid point in props. We request `timeformat=unixtime`, so
`current.time` is epoch seconds (UTC). A null or missing value means no observation.
"""

from __future__ import annotations

from nyclive.model import Entity, Observation
from nyclive.sources.base import Batch, FetchContext, RawPart, RawPayload
from nyclive.timeutil import from_epoch

SOURCE_IDS = ("openmeteo_current",)

URL = "https://api.open-meteo.com/v1/forecast"
# (borough code, name, lat, lon) in request order. Strings keep the request URL exact.
POINTS = (
    ("MN", "Manhattan", "40.7831", "-73.9712"),
    ("BK", "Brooklyn", "40.6782", "-73.9442"),
    ("QN", "Queens", "40.7282", "-73.7949"),
    ("BX", "Bronx", "40.8448", "-73.8648"),
    ("SI", "Staten Island", "40.5795", "-74.1502"),
)
METRICS = {
    "temp_c": "temperature_2m",
    "precip_mm": "precipitation",
    "rain_mm": "rain",
    "wind_kmh": "wind_speed_10m",
}
KIND = "weather_point"


def params() -> dict[str, str]:
    return {
        "latitude": ",".join(p[2] for p in POINTS),
        "longitude": ",".join(p[3] for p in POINTS),
        "current": ",".join(METRICS.values()),
        "timeformat": "unixtime",
    }


def fetch(ctx: FetchContext) -> RawPayload:
    r = ctx.http.get(URL, params=params())
    return RawPayload(SOURCE_IDS[0], (RawPart("body", str(r.url), r.content, ctx.now),))


def parse(raw: RawPayload) -> Batch:
    if raw.source_id not in SOURCE_IDS:
        raise ValueError(f"openmeteo adapter does not serve {raw.source_id!r}")
    sid = raw.source_id
    part = raw.part("body")
    doc = raw.json("body")
    if not isinstance(doc, list) or len(doc) != len(POINTS):
        raise ValueError(f"expected a list of {len(POINTS)} points, got {type(doc).__name__}")
    batch = Batch(complete=frozenset({"entities"}))
    for (code, name, lat, lon), point in zip(POINTS, doc, strict=True):
        if not isinstance(point, dict):
            raise ValueError(f"point {code} is not an object")  # noqa: TRY004 (contract)
        props = {
            k: point[src]
            for k, src in (("grid_lat", "latitude"), ("grid_lon", "longitude"))
            if point.get(src) is not None
        }
        if point.get("elevation") is not None:
            props["elevation_m"] = point["elevation"]
        batch.entities.append(
            Entity(
                source=sid,
                kind=KIND,
                entity_id=code,
                name=name,
                lat=float(lat),
                lon=float(lon),
                borough=code,
                props=props,
            )
        )
        current = point.get("current") or {}
        if current.get("time") is None:
            continue
        observed = from_epoch(current["time"])
        for metric, field in METRICS.items():
            v = current.get(field)
            if v is None:
                continue
            batch.observations.append(
                Observation(sid, KIND, code, metric, observed, float(v), part.fetched_at)
            )
    return batch

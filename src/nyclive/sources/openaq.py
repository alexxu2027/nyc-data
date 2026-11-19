"""OpenAQ air quality stations in NYC (openaq_nyc), ADR-018.

One fetch is the station list for the NYC bbox (part "locations"), then one
`/locations/{id}/latest` per station that reported in the last REPORTED_WITHIN (parts
"latest-<id>"). `/parameters/{id}/latest` would be one call, but it ignores bbox and radius and
returns the whole world, so the per-station calls are the polite option at an hourly cadence.

The key is a header (`X-API-Key`) that `Http` adds for api.openaq.org (settings.host_headers),
so this module never sees it.

Stations are `air_sensor` entities. Props say who runs each one: AirNow stations are government
monitors (`monitor: true`), AirGradient and Clarity are low-cost sensors, which are less
precise, so the UI marks them. Readings become observations of PM2.5, PM10, ozone and NO2,
in µg/m³ or ppm (ppb converted). Negative readings, which low-cost sensors sometimes send, are
dropped. Other parameters (pm1, humidity, particle counts) are ignored.
"""

from __future__ import annotations

from datetime import timedelta
from typing import Any

from nyclive.model import Entity, Observation
from nyclive.sources.base import Batch, FetchContext, RawPart, RawPayload
from nyclive.timeutil import parse_iso_utc

SOURCE_IDS = ("openaq_nyc",)

API = "https://api.openaq.org/v3"
BBOX = "-74.26,40.49,-73.70,40.92"  # the five boroughs plus the near shore of NJ
LOCATIONS_URL = f"{API}/locations?bbox={BBOX}&limit=1000"
REPORTED_WITHIN = timedelta(hours=48)
KIND = "air_sensor"
# (OpenAQ parameter name, units) -> (metric, factor to our unit)
METRICS: dict[tuple[str, str], tuple[str, float]] = {
    ("pm25", "µg/m³"): ("pm25_ugm3", 1.0),
    ("pm10", "µg/m³"): ("pm10_ugm3", 1.0),
    ("o3", "ppm"): ("o3_ppm", 1.0),
    ("o3", "ppb"): ("o3_ppm", 0.001),
    ("no2", "ppm"): ("no2_ppm", 1.0),
    ("no2", "ppb"): ("no2_ppm", 0.001),
}


def latest_url(location_id: int | str) -> str:
    return f"{API}/locations/{location_id}/latest"


def fetch(ctx: FetchContext) -> RawPayload:
    r = ctx.http.get(LOCATIONS_URL)
    parts = [RawPart("locations", LOCATIONS_URL, r.content, ctx.now)]
    for loc in to_fetch(r.json().get("results") or [], ctx.now):
        url = latest_url(loc["id"])
        lr = ctx.http.get(url)  # Http spaces these out (one host, one at a time)
        parts.append(RawPart(f"latest-{loc['id']}", url, lr.content, ctx.now))
    return RawPayload(SOURCE_IDS[0], tuple(parts))


def to_fetch(locations: list[dict], now) -> list[dict]:
    """Fixed stations with a metric we keep that reported within REPORTED_WITHIN of `now`."""
    out = []
    for loc in locations:
        last = (loc.get("datetimeLast") or {}).get("utc")
        if loc.get("isMobile") or not last or not _sensor_metrics(loc):
            continue
        if now - parse_iso_utc(last) <= REPORTED_WITHIN:
            out.append(loc)
    return out


def parse(raw: RawPayload) -> Batch:
    if raw.source_id not in SOURCE_IDS:
        raise ValueError(f"openaq adapter does not serve {raw.source_id!r}")
    locations = raw.json("locations").get("results")
    if not isinstance(locations, list):
        raise ValueError("locations: no results list")  # noqa: TRY004 - contract: reject = ValueError
    batch = Batch()
    by_id: dict[str, dict] = {}
    for loc in locations:
        ent = _entity(raw.source_id, loc)
        if ent is not None:
            batch.entities.append(ent)
            by_id[ent.entity_id] = loc
    for part in raw.parts:
        if not part.name.startswith("latest-"):
            continue
        lid = part.name.removeprefix("latest-")
        loc = by_id.get(lid)
        if loc is None:
            continue
        sensors = _sensor_metrics(loc)
        # A station can carry two sensors for one pollutant (an AirGradient with two PM
        # channels); keep the newest reading per metric, the first one on a tie.
        best: dict[str, Observation] = {}
        for r in raw.json(part.name).get("results") or []:
            obs = _observation(raw.source_id, lid, sensors, r, part.fetched_at)
            if obs is not None and (
                obs.metric not in best or obs.observed_at > best[obs.metric].observed_at
            ):
                best[obs.metric] = obs
        batch.observations.extend(best.values())
    batch.entities.sort(key=lambda e: e.entity_id)
    batch.observations.sort(key=lambda o: (o.entity_id, o.metric))
    return batch


def _sensor_metrics(loc: dict) -> dict[int, tuple[str, float]]:
    out = {}
    for s in loc.get("sensors") or []:
        p = s.get("parameter") or {}
        m = METRICS.get((p.get("name"), p.get("units")))
        if m and isinstance(s.get("id"), int):
            out[s["id"]] = m
    return out


def _entity(sid: str, loc: dict) -> Entity | None:
    c = loc.get("coordinates") or {}
    lat, lon = c.get("latitude"), c.get("longitude")
    if loc.get("isMobile") or not isinstance(loc.get("id"), int) or lat is None or lon is None:
        return None
    provider = (loc.get("provider") or {}).get("name")
    licenses = [x.get("name") for x in loc.get("licenses") or [] if x.get("name")]
    props: dict[str, Any] = {
        "provider": provider,
        "owner": (loc.get("owner") or {}).get("name"),
        "monitor": loc.get("isMonitor") is True,
        "license": licenses[0] if licenses else None,
        "metrics": sorted({m for m, _ in _sensor_metrics(loc).values()}),
        "since": (loc.get("datetimeFirst") or {}).get("utc"),
    }
    name = (loc.get("name") or "").strip() or f"OpenAQ {loc['id']}"
    return Entity(
        source=sid,
        kind=KIND,
        entity_id=str(loc["id"]),
        name=name,
        lat=round(float(lat), 5),
        lon=round(float(lon), 5),
        props=props,
    )


def _observation(
    sid: str, lid: str, sensors: dict[int, tuple[str, float]], r: dict, fetched_at
) -> Observation | None:
    m = sensors.get(r.get("sensorsId"))
    when = (r.get("datetime") or {}).get("utc")
    value = r.get("value")
    if m is None or not when or not isinstance(value, int | float) or value < 0:
        return None
    observed_at = parse_iso_utc(when)
    if observed_at > fetched_at:
        return None  # a clock ahead of ours; never store the future
    metric, factor = m
    return Observation(
        source=sid,
        kind=KIND,
        entity_id=lid,
        metric=metric,
        observed_at=observed_at,
        value=round(float(value) * factor, 4),
        fetched_at=fetched_at,
    )

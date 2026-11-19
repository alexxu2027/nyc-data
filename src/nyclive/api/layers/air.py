"""air_quality layer builder (ADR-018): OpenAQ stations with their latest readings.

Each `air_sensor` entity is one station. PM2.5 sets the colour, on the US EPA AQI scale (the
2024 breakpoints). The official AQI averages over hours (NowCast) or a day; this is one hourly
reading put on the same scale, and the legend and detail say so. A station whose newest PM2.5 is
older than LIVE_WITHIN is drawn hollow, and one with no reading in SHOW_WITHIN isn't drawn. Government monitors (AirNow) and low-cost sensors
(AirGradient, Clarity) are told apart by `monitor`, since low-cost sensors are less precise.
"""

from __future__ import annotations

from datetime import timedelta
from typing import Any

from nyclive.api.geo import point
from nyclive.api.layers.common import (
    Ctx,
    LayerResult,
    entities,
    feature,
    iso,
    latest_by_entity,
    loads,
    num,
    parse_ts,
)

KIND = "air_sensor"
LIVE_WITHIN = timedelta(hours=3)
# OpenAQ still lists stations that went quiet years ago; past this they're left off the map.
SHOW_WITHIN = timedelta(days=7)
# (concentration low, high, AQI low, high, category): US EPA PM2.5 breakpoints, 2024 revision.
PM25_BREAKS = (
    (0.0, 9.0, 0, 50, "good"),
    (9.1, 35.4, 51, 100, "moderate"),
    (35.5, 55.4, 101, 150, "sensitive"),
    (55.5, 125.4, 151, 200, "unhealthy"),
    (125.5, 225.4, 201, 300, "very_unhealthy"),
    (225.5, 325.4, 301, 500, "hazardous"),
)
CATEGORY_WORD = {
    "good": "Good",
    "moderate": "Moderate",
    "sensitive": "Unhealthy for sensitive groups",
    "unhealthy": "Unhealthy",
    "very_unhealthy": "Very unhealthy",
    "hazardous": "Hazardous",
}


def pm25_aqi(ugm3: float | None) -> tuple[int | None, str | None]:
    """AQI number and category for a PM2.5 concentration (truncated to 0.1 µg/m³, per EPA)."""
    if ugm3 is None or ugm3 < 0:
        return None, None
    c = int(ugm3 * 10) / 10
    for lo, hi, ilo, ihi, cat in PM25_BREAKS:
        if c <= hi:
            c = max(c, lo)
            return round((ihi - ilo) / (hi - lo) * (c - lo) + ilo), cat
    return 500, "hazardous"


def air_derived(latest: dict[str, tuple], now) -> dict[str, Any]:
    pm = latest.get("pm25_ugm3")
    at = parse_ts(pm[1]) if pm else None
    live = at is not None and now - at <= LIVE_WITHIN
    aqi, cat = pm25_aqi(pm[0]) if pm and live else (None, None)

    def v(metric: str, digits: int) -> float | None:
        return num(latest[metric][0], digits) if metric in latest else None

    return {
        "pm25": num(pm[0], 1) if pm else None,
        "pm25_at": iso(pm[1]) if pm else None,
        "live": live,
        "aqi": aqi,
        "category": cat,
        "category_name": CATEGORY_WORD.get(cat) if cat else None,
        "pm10": v("pm10_ugm3", 1),
        "o3_ppm": v("o3_ppm", 3),
        "no2_ppm": v("no2_ppm", 3),
    }


def air_quality(ctx: Ctx) -> LayerResult:
    latest = latest_by_entity(ctx.conn, KIND)
    idx = ctx.services.boroughs
    feats, unlocated, newest = [], 0, None
    for e in entities(ctx.conn, KIND):
        if e["lat"] is None:
            unlocated += 1
            continue
        m = latest.get(e["entity_id"], {})
        newest_at = max((parse_ts(v[1]) for v in m.values()), default=None)
        if newest_at is None or ctx.now - newest_at > SHOW_WITHIN:
            continue  # never reported here, or quiet for a week: not a live station
        p = loads(e["props"], {})
        d = air_derived(m, ctx.now)
        if d["pm25_at"] and (newest is None or d["pm25_at"] > newest):
            newest = d["pm25_at"]
        feats.append(
            feature(
                e["entity_id"],
                idx.resolve(e["borough"], e["lon"], e["lat"]),
                point(e["lon"], e["lat"]),
                name=e["name"],
                provider=p.get("provider"),
                monitor=p.get("monitor") is True,
                station="monitor" if p.get("monitor") is True else "sensor",
                **d,
            )
        )
    return LayerResult(feats, data_as_of=newest, unlocated=unlocated)

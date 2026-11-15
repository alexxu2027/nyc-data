"""Streets & safety layers: road_speeds, cameras, collisions."""

from __future__ import annotations

from datetime import datetime, timedelta

from nyclive.api.geo import point, wkt_to_geojson
from nyclive.api.layers.common import (
    Ctx,
    LayerResult,
    as_int,
    entities,
    feature,
    iso,
    latest_by_entity,
    loads,
    num,
    parse_ts,
    window_bounds,
)

STALE_AFTER = timedelta(hours=3)


# ----------------------------------------------------------------------------- road speeds
def speed_band(speed: float | None) -> str:
    if speed is None:
        return "none"
    if speed < 10:
        return "lt10"
    if speed < 20:
        return "10_20"
    if speed < 35:
        return "20_35"
    if speed < 50:
        return "35_50"
    return "gte50"


def is_stale(observed_at: str | None, now: datetime) -> bool:
    t = parse_ts(observed_at)
    return t is not None and now - t > STALE_AFTER


def road_speeds(ctx: Ctx) -> LayerResult:
    latest = latest_by_entity(ctx.conn, "road_segment")
    feats, newest, unlocated = [], None, 0
    for e in entities(ctx.conn, "road_segment"):
        geom = wkt_to_geojson(e["geometry_wkt"])
        if geom is None or geom["type"] != "LineString":
            unlocated += 1
            continue
        m = latest.get(e["entity_id"], {})
        speed = m.get("speed_mph")
        travel = m.get("travel_time_s")
        observed = speed[1] if speed else None
        if observed and (newest is None or observed > newest):
            newest = observed
        feats.append(
            feature(
                e["entity_id"],
                e["borough"],
                geom,
                name=e["name"],
                speed_mph=num(speed[0], 1) if speed else None,
                travel_time_s=as_int(travel[0]) if travel else None,
                band=speed_band(speed[0] if speed else None),
                stale=is_stale(observed, ctx.now),
                observed_at=iso(observed),
                owner=loads(e["props"]).get("owner"),
            )
        )
    return LayerResult(feats, data_as_of=iso(newest), unlocated=unlocated)


# --------------------------------------------------------------------------------- cameras
def camera_props(props: dict) -> dict:
    return {
        "status": "online" if props.get("isOnline") is not False else "offline",
        "image_url": props.get("imageUrl"),
    }


def cameras(ctx: Ctx) -> LayerResult:
    idx = ctx.services.boroughs
    feats, newest, unlocated = [], None, 0
    for e in entities(ctx.conn, "camera"):
        if e["lat"] is None:
            unlocated += 1
            continue
        newest = e["last_seen"] if newest is None or e["last_seen"] > newest else newest
        feats.append(
            feature(
                e["entity_id"],
                idx.resolve(e["borough"], e["lon"], e["lat"]),
                point(e["lon"], e["lat"]),
                name=e["name"],
                **camera_props(loads(e["props"])),
            )
        )
    return LayerResult(feats, data_as_of=iso(newest), unlocated=unlocated)


# ------------------------------------------------------------------------------ collisions
def _n(p: dict, *keys: str) -> int:
    return sum(int(p.get(k) or 0) for k in keys)


def collisions(ctx: Ctx) -> LayerResult:
    window = ctx.params.get("window", "7d")
    start, end = window_bounds(ctx.conn, "nyc_collisions", ctx.now_text, window)
    if end is None:
        return LayerResult([])
    idx = ctx.services.boroughs
    feats, unlocated = [], 0
    rows = ctx.conn.execute(
        "SELECT event_id, title, starts_at, severity, lat, lon, borough, props FROM events"
        " WHERE source = 'nyc_collisions' AND starts_at > ? AND starts_at <= ?"
        " ORDER BY starts_at DESC, event_id",
        (start, end),
    ).fetchall()
    for r in rows:
        if r["lat"] is None:
            unlocated += 1
            continue
        p = loads(r["props"])
        feats.append(
            feature(
                r["event_id"],
                idx.resolve(r["borough"], r["lon"], r["lat"]),
                point(r["lon"], r["lat"]),
                starts_at=iso(r["starts_at"]),
                severity=int(r["severity"] or 1),
                injured=int(p.get("persons_injured") or 0),
                killed=int(p.get("persons_killed") or 0),
                ped=_n(p, "pedestrians_injured", "pedestrians_killed") > 0,
                cyc=_n(p, "cyclist_injured", "cyclist_killed") > 0,
                street=p.get("on_street_name") or p.get("off_street_name") or None,
                title=r["title"],
            )
        )
    return LayerResult(
        feats,
        data_as_of=iso(end),
        window={"from": iso(start), "to": iso(end)},
        unlocated=unlocated,
    )

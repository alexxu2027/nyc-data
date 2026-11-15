"""Water & weather layers: nws_alerts, flood_sensors, flood_events, weather, tide_gauge."""

from __future__ import annotations

from datetime import timedelta

from nyclive.api.geo import point, wkt_to_geojson
from nyclive.api.layers.common import (
    Ctx,
    LayerResult,
    anchor,
    entities,
    entity_index,
    event_status,
    feature,
    first_resolved,
    iso,
    latest_by_entity,
    loads,
    num,
    parse_ts,
    ts_text,
    window_bounds,
)
from nyclive.api.tide import tide_for
from nyclive.model import BOROUGHS, borough_code

RECENT = timedelta(hours=48)
SENSOR_WINDOW = timedelta(days=30)


# ------------------------------------------------------------------------------ NWS alerts
def nws_geometry(ev: dict, boroughs) -> tuple[dict | None, str, list[str]]:
    """(geometry, geom_source, borough codes) for an NWS alert."""
    codes = sorted(
        {c for c in (borough_code(s) for s in loads(ev["props"]).get("nyc_same") or []) if c},
        key=BOROUGHS.index,
    )
    geom = wkt_to_geojson(ev["geometry_wkt"])
    if geom is not None and geom["type"] in ("Polygon", "MultiPolygon"):
        return geom, "polygon", codes
    return boroughs.union(codes), "boroughs", codes


def nws_alerts(ctx: Ctx) -> LayerResult:
    rows = ctx.conn.execute(
        "SELECT * FROM events WHERE source = 'nws_alerts' AND (ends_at IS NULL OR ends_at > ?)"
        " ORDER BY severity DESC, starts_at, event_id",
        (ctx.now_text,),
    ).fetchall()
    feats, unlocated = [], 0
    for r in rows:
        ev = dict(r)
        geom, geom_source, codes = nws_geometry(ev, ctx.services.boroughs)
        if geom is None:
            unlocated += 1
            continue
        p = loads(ev["props"])
        feats.append(
            feature(
                ev["event_id"],
                ev["borough"],
                geom,
                event=ev["subtype"] or "Weather alert",
                severity=int(ev["severity"] or 0),
                status=event_status(ev["starts_at"], ev["ends_at"], ctx.now_text),
                starts_at=iso(ev["starts_at"]),
                ends_at=iso(ev["ends_at"]),
                headline=ev["title"],
                area=(p.get("areaDesc") or "")[:120],
                boroughs=",".join(codes),
                geom_source=geom_source,
            )
        )
    return LayerResult(
        feats, data_as_of=iso(anchor(ctx.conn, "nws_alerts", ctx.now_text)), unlocated=unlocated
    )


# ---------------------------------------------------------------------------- flood events
def flood_events(ctx: Ctx) -> LayerResult:
    window = ctx.params.get("window", "30d")
    start, end = window_bounds(ctx.conn, "floodnet_events", ctx.now_text, window)
    if end is None:
        return LayerResult([])
    sensors = entity_index(ctx.conn, "flood_sensor")
    idx = ctx.services.boroughs
    recent_after = ts_text(parse_ts(end) - RECENT)
    rows = ctx.conn.execute(
        "SELECT * FROM events WHERE source = 'floodnet_events' AND starts_at > ?"
        " AND starts_at <= ? ORDER BY starts_at DESC, event_id",
        (start, end),
    ).fetchall()
    feats, unlocated = [], 0
    for r in rows:
        s = first_resolved(r, "flood_sensor", sensors)
        if s is None:
            unlocated += 1
            continue
        p = loads(r["props"])
        dur = p.get("duration_mins")
        feats.append(
            feature(
                r["event_id"],
                idx.resolve(r["borough"] or s["borough"], s["lon"], s["lat"]),
                point(s["lon"], s["lat"]),
                sensor_id=s["entity_id"],
                name=s["name"],
                starts_at=iso(r["starts_at"]),
                ends_at=iso(r["ends_at"]),
                max_depth_in=num(p.get("max_depth_inches"), 2),
                duration_min=None if dur is None else num(dur, 1),
                severity=int(r["severity"] or 0),
                recent=r["starts_at"] > recent_after,
                title=r["title"],
            )
        )
    return LayerResult(
        feats,
        data_as_of=iso(end),
        window={"from": iso(start), "to": iso(end)},
        unlocated=unlocated,
    )


# --------------------------------------------------------------------------- flood sensors
def sensor_stats(conn, now_text: str) -> dict[str, dict]:
    """sensor id -> {events_30d, last_event_at, last_max_depth_in} (30 d before data_as_of)."""
    end = anchor(conn, "floodnet_events", now_text)
    since = ts_text(parse_ts(end) - SENSOR_WINDOW) if end else None
    out: dict[str, dict] = {}
    rows = conn.execute(
        "SELECT entity_refs, starts_at, props FROM events WHERE source = 'floodnet_events'"
        " AND starts_at <= ? ORDER BY starts_at",
        (now_text,),
    ).fetchall()
    for r in rows:
        for ref in loads(r["entity_refs"], []):
            if not ref.startswith("flood_sensor:"):
                continue
            st = out.setdefault(
                ref.split(":", 1)[1],
                {"events_30d": 0, "last_event_at": None, "last_max_depth_in": None},
            )
            if since and r["starts_at"] > since:
                st["events_30d"] += 1
            st["last_event_at"] = iso(r["starts_at"])
            st["last_max_depth_in"] = num(loads(r["props"]).get("max_depth_inches"), 2)
    return out


def flood_sensors(ctx: Ctx) -> LayerResult:
    stats = sensor_stats(ctx.conn, ctx.now_text)
    idx = ctx.services.boroughs
    empty = {"events_30d": 0, "last_event_at": None, "last_max_depth_in": None}
    feats, newest, unlocated = [], None, 0
    for e in entities(ctx.conn, "flood_sensor"):
        if e["lat"] is None:
            unlocated += 1
            continue
        newest = e["last_seen"] if newest is None or e["last_seen"] > newest else newest
        p = loads(e["props"])
        feats.append(
            feature(
                e["entity_id"],
                idx.resolve(e["borough"], e["lon"], e["lat"]),
                point(e["lon"], e["lat"]),
                name=e["name"],
                tidal=p.get("tidally_influenced") is True,
                nta=p.get("nta"),
                **stats.get(e["entity_id"], empty),
            )
        )
    return LayerResult(feats, data_as_of=iso(newest), unlocated=unlocated)


# --------------------------------------------------------------------------------- weather
def weather_derived(m: dict[str, tuple]) -> dict:
    c = m.get("temp_c")
    w = m.get("wind_kmh")
    p = m.get("precip_mm")
    return {
        "temp_f": None if c is None else round(c[0] * 9 / 5 + 32, 1),
        "wind_mph": None if w is None else round(w[0] * 0.621371, 1),
        "wet": p is not None and p[0] > 0,
    }


def weather(ctx: Ctx) -> LayerResult:
    latest = latest_by_entity(ctx.conn, "weather_point")
    idx = ctx.services.boroughs
    feats, newest = [], None
    for e in entities(ctx.conn, "weather_point"):
        m = latest.get(e["entity_id"])
        if e["lat"] is None or not m:
            continue
        observed = max(v[1] for v in m.values())
        newest = observed if newest is None or observed > newest else newest

        def v(k: str, digits: int = 1) -> float | None:
            return num(m[k][0], digits) if k in m else None  # noqa: B023 - used at once

        feats.append(
            feature(
                e["entity_id"],
                idx.resolve(e["borough"], e["lon"], e["lat"]),
                point(e["lon"], e["lat"]),
                name=e["name"],
                temp_c=v("temp_c"),
                precip_mm=v("precip_mm", 2),
                rain_mm=v("rain_mm", 2),
                wind_kmh=v("wind_kmh"),
                observed_at=iso(observed),
                **weather_derived(m),
            )
        )
    return LayerResult(feats, data_as_of=iso(newest))


# ------------------------------------------------------------------------------ tide gauge
def tide_gauge(ctx: Ctx) -> LayerResult:
    idx = ctx.services.boroughs
    feats, newest = [], None
    for e in entities(ctx.conn, "tide_gauge"):
        t = tide_for(ctx.services, ctx.conn, e["entity_id"], ctx.now)
        if e["lat"] is None or t["water_level_ft"] is None:
            continue
        newest = t["observed_at"]
        feats.append(
            feature(
                e["entity_id"],
                idx.resolve(e["borough"], e["lon"], e["lat"]),
                point(e["lon"], e["lat"]),
                name=e["name"],
                water_level_ft=t["water_level_ft"],
                observed_at=t["observed_at"],
                predicted_ft=t["predicted_ft"],
                surge_ft=t["surge_ft"],
                trend=t["trend"],
                datum=loads(e["props"]).get("datum") or "MLLW",
            )
        )
    return LayerResult(feats, data_as_of=newest)

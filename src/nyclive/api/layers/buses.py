"""buses layer builder (ADR-018): every bus Bus Time reports, at its GPS position.

Each open `mta_bus_time` event is one trip. Its lat/lon is the latest position (the source is
`live_position`, so state.db follows the bus every poll), and its props name the route, direction
and the stop it's at or heading to. Names come from config/bus_static.json (built by
scripts/build_bus_static.py): the route's long name and colours, the stop's name and the usual
headsign for route + direction. Without the static file buses still draw, just without names.
Only trips seen in the last SEEN_WITHIN are shown, so a stopped collector empties the layer.
"""

from __future__ import annotations

import json
from dataclasses import dataclass
from datetime import timedelta
from pathlib import Path
from typing import Any

from nyclive.api.geo import point
from nyclive.api.layers.common import Ctx, LayerResult, feature, iso, loads, parse_ts, ts_text
from nyclive.registry import REPO_ROOT

SOURCE = "mta_bus_time"
STATIC_PATH = REPO_ROOT / "config" / "bus_static.json"
SEEN_WITHIN = timedelta(seconds=240)
CLOCK_SKEW = timedelta(seconds=60)
STALE_AFTER = timedelta(seconds=180)
SERVICE_WORD = {"local": "Local", "sbs": "Select Bus Service", "express": "Express"}
FALLBACK_COLOURS = ("#0039a6", "#ffffff")


@dataclass
class BusStatic:
    routes: dict[str, list[str]]
    stops: dict[str, str]
    headsigns: dict[str, str]


_cache: dict[str, tuple[int, BusStatic]] = {}


def load_static(path: Path | None = None) -> BusStatic | None:
    """The parsed static file, cached until it changes on disk. None when it is missing."""
    path = path or STATIC_PATH
    try:
        mtime = path.stat().st_mtime_ns
    except OSError:
        return None
    hit = _cache.get(str(path))
    if hit and hit[0] == mtime:
        return hit[1]
    try:
        doc = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return None
    s = BusStatic(doc.get("routes") or {}, doc.get("stops") or {}, doc.get("headsigns") or {})
    _cache[str(path)] = (mtime, s)
    return s


def buses(ctx: Ctx) -> LayerResult:
    upper = ts_text(ctx.now + CLOCK_SKEW)
    row = ctx.conn.execute(
        "SELECT MAX(last_seen) FROM events WHERE source = ? AND ends_at IS NULL AND last_seen <= ?",
        (SOURCE, upper),
    ).fetchone()
    newest = parse_ts(row[0]) if row else None
    note = None
    if newest is not None and ctx.now - newest > STALE_AFTER:
        note = f"Bus Time feed {max(1, round((ctx.now - newest).total_seconds() / 60))} min old"
    static = load_static() or BusStatic({}, {}, {})
    rows = ctx.conn.execute(
        "SELECT event_id, lat, lon, props, updated_at, last_seen FROM events"
        " WHERE source = ? AND ends_at IS NULL AND last_seen >= ? AND last_seen <= ?"
        " ORDER BY event_id",
        (SOURCE, ts_text(ctx.now - SEEN_WITHIN), upper),
    ).fetchall()
    idx = ctx.services.boroughs
    feats, unlocated = [], 0
    for r in rows:
        if r["lat"] is None or r["lon"] is None:
            unlocated += 1
            continue
        p = loads(r["props"], {})
        feats.append(
            feature(
                r["event_id"],
                idx.resolve(None, r["lon"], r["lat"]),
                point(r["lon"], r["lat"]),
                **bus_props(static, p, r["updated_at"], r["last_seen"]),
            )
        )
    return LayerResult(feats, data_as_of=iso(newest), unlocated=unlocated, note=note)


def bus_props(static: BusStatic, p: dict, updated_at: str, last_seen: str) -> dict[str, Any]:
    route = str(p.get("route") or "")
    dir_ = p.get("dir")
    info = static.routes.get(route)
    long_name, color, text = info if info else ("", *FALLBACK_COLOURS)
    service = str(p.get("service") or "local")
    stop = str(p.get("stop") or "")
    return {
        "route": route,
        "service": service,
        "service_name": SERVICE_WORD.get(service, service),
        "route_name": long_name or None,
        "route_color": color,
        "route_text": text,
        "headsign": static.headsigns.get(f"{route}:{dir_}"),
        "next_stop": stop or None,
        "next_name": static.stops.get(stop),
        "vehicle": p.get("vehicle"),
        "since": iso(updated_at),  # when it moved on to this stop
        "seen_at": iso(last_seen),
    }

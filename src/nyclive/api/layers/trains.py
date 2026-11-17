"""subway_trains layer builder (plan I3b, ADR-013): live trains placed on the track.

Each open `mta_subway_realtime` event is one trip whose props say which stop it is at or heading
to. The train is drawn on the track from the previous stop to that next stop, as a LineString
cut from static GTFS (config/subway_static.json, built by scripts/build_subway_static.py). The
client animates along it: t0 = when the trip's current version was first seen (`updated_at`,
i.e. when it moved on to this stop) and t1 = t0 + the scheduled run between the two stops.

The previous stop comes from the trip's static stop pattern (shape id = realtime trip id after
the first "_"), else from the usual previous stop for route + direction + stop. With no previous
stop or no track for the pair (a train at its origin terminal), the feature is a Point at the
stop with `at_stop: true`. Only trips seen in the last 120 s are shown.
"""

from __future__ import annotations

import itertools
import json
import re
from collections import Counter
from dataclasses import dataclass, field
from datetime import timedelta
from pathlib import Path
from typing import Any

from nyclive.api.geo import point
from nyclive.api.layers.common import Ctx, LayerResult, feature, iso, loads, parse_ts, ts_text
from nyclive.registry import REPO_ROOT

SOURCE = "mta_subway_realtime"
STATIC_PATH = REPO_ROOT / "config" / "subway_static.json"
SEEN_WITHIN = timedelta(seconds=120)
CLOCK_SKEW = timedelta(seconds=60)  # rows "seen" after now are from a later run: not shown
STALE_AFTER = timedelta(seconds=90)
FALLBACK_ROUTE = {"color": "#7c858c", "text": "#ffffff", "line": "S"}
NOTE_NO_STATIC = "STATIC GTFS NOT BUILT"
_BASE = re.compile(r"^(.+?\.+[NS])")  # "7..S97R" -> "7..S", "SI.N03R" -> "SI.N"


@dataclass
class Static:
    routes: dict[str, dict[str, str]]
    stops: dict[str, list]
    patterns: dict[str, list[str]]
    headsigns: dict[str, str]
    prev: dict[str, str]
    segments: dict[str, dict[str, Any]]
    pos: dict[str, dict[str, int]] = field(default_factory=dict)  # shape -> stop -> index
    base_headsign: dict[str, str] = field(default_factory=dict)  # "7..S" -> usual headsign

    @classmethod
    def from_doc(cls, doc: dict) -> Static:
        s = cls(
            routes=doc.get("routes") or {},
            stops=doc.get("stops") or {},
            patterns=doc.get("patterns") or {},
            headsigns=doc.get("headsigns") or {},
            prev=doc.get("prev") or {},
            segments=doc.get("segments") or {},
        )
        for shape, stops in s.patterns.items():
            idx: dict[str, int] = {}
            for i, stop in enumerate(stops):
                idx.setdefault(stop, i)
            s.pos[shape] = idx
        votes: dict[str, Counter] = {}
        for shape, head in s.headsigns.items():
            if m := _BASE.match(shape):
                votes.setdefault(m.group(1), Counter())[head] += 1
        s.base_headsign = {k: v.most_common(1)[0][0] for k, v in sorted(votes.items())}
        return s

    def prev_stop(self, shape: str, route: str, dir_: str, stop: str) -> str | None:
        idx = self.pos.get(shape)
        if idx is not None and stop in idx:
            i = idx[stop]
            return self.patterns[shape][i - 1] if i > 0 else None  # origin: not departed yet
        return self.prev.get(f"{route}:{dir_}:{stop}")

    def headsign(self, shape: str) -> str:
        if shape in self.headsigns:
            return self.headsigns[shape]
        m = _BASE.match(shape)
        if m and m.group(1) in self.base_headsign:
            return self.base_headsign[m.group(1)]
        last = (self.patterns.get(shape) or [None])[-1]
        return self.stops[last][2] if last in self.stops else ""


_cache: dict[str, tuple[int, Static]] = {}


def load_static(path: Path | None = None) -> Static | None:
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
    static = Static.from_doc(doc)
    _cache[str(path)] = (mtime, static)
    return static


def route_of_shape(shape: str) -> str:
    """'1..N03R' -> '1', 'SI.N03R' -> 'SI'."""
    return shape.partition(".")[0]


def subway_lines(static: Static | None) -> dict[str, Any]:
    """The track as a FeatureCollection for the faint line under the trains: one LineString
    per stop pair (both directions drawn once), coloured by the route that runs it most
    (by stop patterns). Static, so it's built once per static file."""
    if static is None:
        return {"type": "FeatureCollection", "features": []}
    hit = _lines_cache.get(id(static))
    if hit is not None:
        return hit
    use: dict[tuple[str, str], Counter] = {}
    for shape, stops in static.patterns.items():
        route = route_of_shape(shape)
        for a, b in itertools.pairwise(stops):
            use.setdefault(tuple(sorted((a, b))), Counter())[route] += 1
    feats, done = [], set()
    for key in sorted(static.segments):
        a, _, b = key.partition(">")
        pair = tuple(sorted((a, b)))
        if pair in done:
            continue
        done.add(pair)
        routes = use.get(pair) or Counter()
        top = routes.most_common(1)[0][0] if routes else None
        info = static.routes.get(top or "") or FALLBACK_ROUTE
        feats.append({
            "type": "Feature",
            "geometry": {"type": "LineString", "coordinates": static.segments[key]["c"]},
            "properties": {"color": info.get("color") or FALLBACK_ROUTE["color"],
                           "line": info.get("line") or FALLBACK_ROUTE["line"],
                           "routes": sorted(routes)},
        })  # fmt: skip
    out = {"type": "FeatureCollection", "features": feats}
    _lines_cache.clear()
    _lines_cache[id(static)] = out
    return out


_lines_cache: dict[int, dict[str, Any]] = {}


def shape_of(event_id: str) -> str:
    """'20261116:148500_1..N03R' -> '1..N03R'."""
    return event_id.partition(":")[2].partition("_")[2]


def subway_trains(ctx: Ctx) -> LayerResult:
    upper = ts_text(ctx.now + CLOCK_SKEW)
    row = ctx.conn.execute(
        "SELECT MAX(last_seen) FROM events WHERE source = ? AND ends_at IS NULL AND last_seen <= ?",
        (SOURCE, upper),
    ).fetchone()
    newest = parse_ts(row[0]) if row else None
    note = None
    if newest is not None and ctx.now - newest > STALE_AFTER:
        note = f"MTA feed {max(1, round((ctx.now - newest).total_seconds() / 60))} min old"
    static = load_static()
    if static is None:
        return LayerResult([], data_as_of=iso(newest), note=NOTE_NO_STATIC)

    rows = ctx.conn.execute(
        "SELECT event_id, props, updated_at, last_seen FROM events"
        " WHERE source = ? AND ends_at IS NULL AND last_seen >= ? AND last_seen <= ?"
        " ORDER BY event_id",
        (SOURCE, ts_text(ctx.now - SEEN_WITHIN), upper),
    ).fetchall()
    feats, unlocated = [], 0
    for r in rows:
        f = _train(static, r["event_id"], loads(r["props"]), r["updated_at"], r["last_seen"])
        if f is None:
            unlocated += 1
        else:
            feats.append(f)
    return LayerResult(feats, data_as_of=iso(newest), unlocated=unlocated, note=note)


def _train(
    static: Static, event_id: str, p: dict, updated_at: str, last_seen: str
) -> dict[str, Any] | None:
    route, dir_, stop = str(p.get("route") or ""), str(p.get("dir") or ""), str(p.get("stop") or "")
    nxt = static.stops.get(stop)
    t0 = parse_ts(updated_at)
    if nxt is None or t0 is None or dir_ not in ("N", "S"):
        return None
    shape = shape_of(event_id)
    prev = static.prev_stop(shape, route, dir_, stop)
    seg = static.segments.get(f"{prev}>{stop}") if prev else None
    if seg is not None:
        geometry = {"type": "LineString", "coordinates": seg["c"]}
        run_s = int(seg.get("s") or 0)
    else:
        geometry = point(nxt[0], nxt[1])
        run_s = 0
    info = static.routes.get(route) or FALLBACK_ROUTE
    prev_info = static.stops.get(prev) if prev else None
    return feature(
        event_id,
        None,
        geometry,
        route=route,
        line=info.get("line") or FALLBACK_ROUTE["line"],
        color=info.get("color") or FALLBACK_ROUTE["color"],
        dir=dir_,
        headsign=static.headsign(shape),
        next_stop=stop,
        next_name=nxt[2],
        prev_name=prev_info[2] if prev_info else None,
        t0=iso(t0),
        t1=iso(t0 + timedelta(seconds=run_s)),
        run_s=run_s,
        at_stop=seg is None,
        seen_at=iso(last_seen),
    )

"""Geometry helpers for the API: WKT to GeoJSON, bbox tests and borough point-in-polygon.

No shapely: the shapes are small (borough outlines simplified to ~15 m, LINESTRING road
segments, NWS polygons), so plain Python with a latitude-band edge index is fast enough.
"""

from __future__ import annotations

import json
import re
import threading
from collections.abc import Iterable
from itertools import pairwise
from pathlib import Path
from typing import Any

Coord = list[float]
BBox = tuple[float, float, float, float]  # min_lon, min_lat, max_lon, max_lat

NUDGE = 0.003  # degrees, ~300 m: retry offsets for points just outside the simplified outlines
_NUDGES = [
    (dx * NUDGE, dy * NUDGE)
    for dx, dy in ((1, 0), (-1, 0), (0, 1), (0, -1), (1, 1), (1, -1), (-1, 1), (-1, -1))
]
OUTSIDE = "XX"


def r5(x: float) -> float:
    return round(float(x), 5)


def point(lon: float, lat: float) -> dict[str, Any]:
    return {"type": "Point", "coordinates": [r5(lon), r5(lat)]}


# ------------------------------------------------------------------------------------- WKT
_NUM = re.compile(r"-?\d+(?:\.\d*)?(?:[eE][-+]?\d+)?")


def _coords(text: str) -> list[Coord]:
    """'x y, x y, ...' -> [[x, y], ...], rounded to 5 decimals."""
    out = []
    for pair in text.split(","):
        nums = _NUM.findall(pair)
        if len(nums) >= 2:
            out.append([r5(float(nums[0])), r5(float(nums[1]))])
    return out


def _split_groups(body: str) -> list[str]:
    """Top-level parenthesised groups of a WKT body: '(a), (b)' -> ['a', 'b']."""
    groups, depth, start = [], 0, None
    for i, ch in enumerate(body):
        if ch == "(":
            if depth == 0:
                start = i + 1
            depth += 1
        elif ch == ")":
            depth -= 1
            if depth == 0 and start is not None:
                groups.append(body[start:i])
                start = None
    return groups


def wkt_to_geojson(wkt: str | None) -> dict[str, Any] | None:
    """LINESTRING / POLYGON / MULTIPOLYGON (and POINT) WKT to a GeoJSON geometry, or None."""
    if not wkt or not isinstance(wkt, str):
        return None
    s = wkt.strip()
    head, _, rest = s.partition("(")
    kind = head.strip().upper()
    body = "(" + rest
    try:
        if kind == "POINT":
            c = _coords(_split_groups(body)[0])
            return {"type": "Point", "coordinates": c[0]} if c else None
        if kind == "LINESTRING":
            c = _coords(_split_groups(body)[0])
            return {"type": "LineString", "coordinates": c} if len(c) >= 2 else None
        if kind == "POLYGON":
            rings = [_coords(r) for r in _split_groups(_split_groups(body)[0])]
            rings = [r for r in rings if len(r) >= 4]
            return {"type": "Polygon", "coordinates": rings} if rings else None
        if kind == "MULTIPOLYGON":
            polys = []
            for p in _split_groups(_split_groups(body)[0]):
                rings = [_coords(r) for r in _split_groups(p)]
                rings = [r for r in rings if len(r) >= 4]
                if rings:
                    polys.append(rings)
            return {"type": "MultiPolygon", "coordinates": polys} if polys else None
    except IndexError:
        return None
    return None


# ------------------------------------------------------------------------------------ bbox
def _walk(coords: Any) -> Iterable[Coord]:
    if coords and isinstance(coords[0], int | float):
        yield coords
    else:
        for c in coords:
            yield from _walk(c)


def geometry_bbox(geom: dict[str, Any]) -> BBox | None:
    xs, ys = [], []
    for x, y, *_ in _walk(geom.get("coordinates") or []):
        xs.append(x)
        ys.append(y)
    if not xs:
        return None
    return (min(xs), min(ys), max(xs), max(ys))


def intersects(geom: dict[str, Any] | None, bbox: BBox) -> bool:
    if not geom:
        return False
    if geom.get("type") == "Point":
        x, y = geom["coordinates"][:2]
        return bbox[0] <= x <= bbox[2] and bbox[1] <= y <= bbox[3]
    b = geometry_bbox(geom)
    return b is not None and not (
        b[2] < bbox[0] or b[0] > bbox[2] or b[3] < bbox[1] or b[1] > bbox[3]
    )


def parse_bbox(text: str) -> BBox:
    parts = [float(p) for p in text.split(",")]
    if len(parts) != 4:
        raise ValueError("bbox needs four numbers: minLon,minLat,maxLon,maxLat")
    b = (parts[0], parts[1], parts[2], parts[3])
    if not (b[0] <= b[2] and b[1] <= b[3]):
        raise ValueError("bbox min must not exceed max")
    if not all(-180 <= v <= 180 for v in b):
        raise ValueError("bbox values out of range")
    return b


# -------------------------------------------------------------------------------- boroughs
class _Shape:
    """One borough's edges, bucketed by latitude band for even-odd ray casting."""

    BANDS = 256

    def __init__(self, multipolygon: list) -> None:
        edges = []
        for poly in multipolygon:
            for ring in poly:
                for (x1, y1), (x2, y2) in pairwise(ring):
                    if y1 != y2:
                        edges.append((x1, y1, x2, y2))
        ys = [e[1] for e in edges] + [e[3] for e in edges]
        xs = [e[0] for e in edges] + [e[2] for e in edges]
        self.bbox = (min(xs), min(ys), max(xs), max(ys))
        self.h = (self.bbox[3] - self.bbox[1]) / self.BANDS or 1.0
        self.bands: list[list[tuple]] = [[] for _ in range(self.BANDS)]
        for e in edges:
            lo, hi = sorted((e[1], e[3]))
            for b in range(self._band(lo), self._band(hi) + 1):
                self.bands[b].append(e)

    def _band(self, y: float) -> int:
        return min(self.BANDS - 1, max(0, int((y - self.bbox[1]) / self.h)))

    def contains(self, x: float, y: float) -> bool:
        b = self.bbox
        if not (b[0] <= x <= b[2] and b[1] <= y <= b[3]):
            return False
        inside = False
        for x1, y1, x2, y2 in self.bands[self._band(y)]:
            if (y1 > y) != (y2 > y) and x < x1 + (y - y1) * (x2 - x1) / (y2 - y1):
                inside = not inside
        return inside


class BoroughIndex:
    """Point-in-polygon on config/boroughs.geojson, with a cache keyed by rounded coords."""

    def __init__(self, path: Path) -> None:
        doc = json.loads(path.read_text(encoding="utf-8"))
        self.features: list[dict[str, Any]] = doc["features"]
        self._shapes: list[tuple[str, _Shape]] = []
        self.multipolygons: dict[str, list] = {}
        for f in self.features:
            code = f["properties"]["borough"]
            g = f["geometry"]
            polys = g["coordinates"] if g["type"] == "MultiPolygon" else [g["coordinates"]]
            self.multipolygons[code] = polys
            self._shapes.append((code, _Shape(polys)))
        self._cache: dict[tuple[float, float], str] = {}
        self._lock = threading.Lock()

    def _hit(self, x: float, y: float) -> str | None:
        for code, shape in self._shapes:
            if shape.contains(x, y):
                return code
        return None

    def locate(self, lon: float, lat: float) -> str:
        """Borough code containing the point; nudged up to 300 m; else 'XX' (outside)."""
        key = (round(lon, 5), round(lat, 5))
        hit = self._cache.get(key)
        if hit is not None:
            return hit
        code = self._hit(lon, lat)
        if code is None:
            for dx, dy in _NUDGES:
                code = self._hit(lon + dx, lat + dy)
                if code:
                    break
        code = code or OUTSIDE
        with self._lock:
            self._cache[key] = code
        return code

    def resolve(self, stored: str | None, lon: float | None, lat: float | None) -> str | None:
        """The §2.3 rule: stored column, else point-in-polygon, else 'XX'; no location: None."""
        if stored:
            return stored
        if lon is None or lat is None:
            return None
        return self.locate(lon, lat)

    def union(self, codes: Iterable[str]) -> dict[str, Any] | None:
        """MultiPolygon made of the given boroughs' polygons (for zone-only NWS alerts)."""
        polys = [p for c in codes for p in self.multipolygons.get(c, [])]
        return {"type": "MultiPolygon", "coordinates": polys} if polys else None

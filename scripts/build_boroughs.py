"""Build config/boroughs.geojson: simplified NYC borough boundaries for the map and filters.

    uv run python scripts/build_boroughs.py

Source: NYC Open Data "Borough Boundaries" (dataset gthc-hcne, NYC Department of City Planning).
Simplified with Douglas-Peucker (~15 m) and rounded to 5 decimals (~1 m) so the file is small
enough to ship to the browser. Properties: borough (MN/BK/QN/BX/SI), name, borocode.
"""

from __future__ import annotations

import json
from pathlib import Path

from nyclive.http import Http
from nyclive.model import borough_code
from nyclive.settings import load_settings

URL = "https://data.cityofnewyork.us/resource/gthc-hcne.geojson"
OUT = Path(__file__).resolve().parents[1] / "config" / "boroughs.geojson"
TOLERANCE = 0.00015  # degrees, ~15 m
MIN_RING_POINTS = 4


def _perp(p, a, b) -> float:
    (x, y), (x1, y1), (x2, y2) = p, a, b
    dx, dy = x2 - x1, y2 - y1
    if dx == dy == 0:
        return ((x - x1) ** 2 + (y - y1) ** 2) ** 0.5
    return abs(dy * x - dx * y + x2 * y1 - y2 * x1) / (dx * dx + dy * dy) ** 0.5


def simplify(points: list, tol: float) -> list:
    """Iterative Douglas-Peucker (rings here are long; recursion would be deep)."""
    if len(points) < 3:
        return points
    keep = [False] * len(points)
    keep[0] = keep[-1] = True
    stack = [(0, len(points) - 1)]
    while stack:
        i, j = stack.pop()
        best, idx = 0.0, -1
        for k in range(i + 1, j):
            d = _perp(points[k], points[i], points[j])
            if d > best:
                best, idx = d, k
        if best > tol and idx > 0:
            keep[idx] = True
            stack += [(i, idx), (idx, j)]
    return [p for p, k in zip(points, keep, strict=True) if k]


def main() -> None:
    with Http(load_settings().user_agent) as h:
        doc = h.get(URL).json()
    features = []
    for f in doc["features"]:
        polys = []
        for poly in f["geometry"]["coordinates"]:
            rings = []
            for ring in poly:
                r = [[round(x, 5), round(y, 5)] for x, y in simplify(ring, TOLERANCE)]
                if len(r) >= MIN_RING_POINTS:
                    if r[0] != r[-1]:
                        r.append(r[0])
                    rings.append(r)
            if rings:
                polys.append(rings)
        name = f["properties"]["boroname"]
        features.append(
            {
                "type": "Feature",
                "properties": {
                    "borough": borough_code(name),
                    "name": name,
                    "borocode": int(f["properties"]["borocode"]),
                },
                "geometry": {"type": "MultiPolygon", "coordinates": polys},
            }
        )
    features.sort(key=lambda f: f["properties"]["borocode"])
    out = {
        "type": "FeatureCollection",
        "attribution": "NYC Department of City Planning, Borough Boundaries (NYC Open Data gthc-hcne)",
        "features": features,
    }
    OUT.write_text(json.dumps(out, separators=(",", ":")), encoding="utf-8", newline="\n")
    print(f"wrote {OUT} ({OUT.stat().st_size // 1024} KB, {len(features)} boroughs)")


if __name__ == "__main__":
    main()

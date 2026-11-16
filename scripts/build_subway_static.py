"""Build config/subway_static.json: what the subway_trains layer needs from static GTFS.

    uv run python scripts/build_subway_static.py              # download the zip (5.6 MB)
    uv run python scripts/build_subway_static.py --zip PATH   # use a local copy

Source: MTA subway static GTFS (https://rrgtfsfeeds.s3.amazonaws.com/gtfs_subway.zip). Output
(plan I4c, ADR-013), coordinates [lon, lat] at 5 decimals, track simplified to ~3 m:

    routes    {route_id: {color, text, line}}       line = the layer's filter group (123, ACE...)
    stops     {parent stop id: [lon, lat, name]}
    patterns  {shape_id: [parent stop ids]}         the most common stop list of its trips
    headsigns {shape_id: headsign}
    prev      {"route:dir:stop": stop}              the usual previous stop (fallback)
    segments  {"from>to": {c: [[lon, lat]...], s: scheduled run seconds (median)}}

Realtime trip ids map to shape ids by dropping the origin-time prefix: "148500_1..N03R" →
"1..N03R", the same as static trips' `shape_id`. Segment track is cut from the shape most of
that pair's trips use; with no shape it is a straight line between the two stops.
"""

from __future__ import annotations

import argparse
import csv
import io
import itertools
import json
import math
import statistics
import sys
import zipfile
from collections import Counter, defaultdict
from datetime import UTC, datetime
from pathlib import Path

URL = "https://rrgtfsfeeds.s3.amazonaws.com/gtfs_subway.zip"
OUT = Path(__file__).resolve().parents[1] / "config" / "subway_static.json"
TOLERANCE_M = 3.0
MAX_BYTES = 1_500_000
# Route -> the layer's `line` filter group (config/layers.yaml subway_trains).
LINE_OF = {
    "1": "123", "2": "123", "3": "123",
    "4": "456", "5": "456", "5X": "456", "6": "456", "6X": "456",
    "7": "7", "7X": "7",
    "A": "ACE", "C": "ACE", "E": "ACE",
    "B": "BDFM", "D": "BDFM", "F": "BDFM", "FX": "BDFM", "M": "BDFM",
    "G": "G", "J": "JZ", "Z": "JZ", "L": "L",
    "N": "NQRW", "Q": "NQRW", "R": "NQRW", "W": "NQRW",
    "GS": "S", "FS": "S", "H": "S", "SI": "SIR", "SS": "SIR",
}  # fmt: skip
M_PER_DEG_LAT = 111_320.0
COS_LAT = math.cos(math.radians(40.73))


def rows(z: zipfile.ZipFile, name: str):
    with z.open(name) as f:
        yield from csv.DictReader(io.TextIOWrapper(f, encoding="utf-8-sig"))


def gtfs_seconds(t: str) -> int | None:
    """'25:03:30' -> seconds after service-day midnight (hours may pass 24)."""
    try:
        h, m, s = (int(x) for x in t.strip().split(":"))
    except ValueError:
        return None
    return h * 3600 + m * 60 + s


def parent_of(stop_id: str, parents: dict[str, str]) -> str:
    return parents.get(stop_id) or stop_id


def dir_of(stop_id: str) -> str | None:
    return stop_id[-1] if stop_id[-1:] in ("N", "S") else None


# ---------------------------------------------------------------------------- geometry
def _xy(p) -> tuple[float, float]:
    return p[0] * M_PER_DEG_LAT * COS_LAT, p[1] * M_PER_DEG_LAT


def _seg_dist(p, a, b) -> float:
    """Distance in metres from p to segment ab (lon/lat inputs, local planar)."""
    (x, y), (x1, y1), (x2, y2) = _xy(p), _xy(a), _xy(b)
    dx, dy = x2 - x1, y2 - y1
    L = dx * dx + dy * dy
    t = 0.0 if L == 0 else max(0.0, min(1.0, ((x - x1) * dx + (y - y1) * dy) / L))
    return math.hypot(x - (x1 + t * dx), y - (y1 + t * dy))


def _project(p, a, b) -> tuple[float, list[float]]:
    (x, y), (x1, y1), (x2, y2) = _xy(p), _xy(a), _xy(b)
    dx, dy = x2 - x1, y2 - y1
    L = dx * dx + dy * dy
    t = 0.0 if L == 0 else max(0.0, min(1.0, ((x - x1) * dx + (y - y1) * dy) / L))
    q = [a[0] + t * (b[0] - a[0]), a[1] + t * (b[1] - a[1])]
    return math.hypot(x - (x1 + t * dx), y - (y1 + t * dy)), q


def simplify(points: list, tol_m: float) -> list:
    """Iterative Douglas-Peucker in metres."""
    if len(points) < 3:
        return points
    keep = [False] * len(points)
    keep[0] = keep[-1] = True
    stack = [(0, len(points) - 1)]
    while stack:
        i, j = stack.pop()
        best, idx = 0.0, -1
        for k in range(i + 1, j):
            d = _seg_dist(points[k], points[i], points[j])
            if d > best:
                best, idx = d, k
        if best > tol_m and idx > 0:
            keep[idx] = True
            stack += [(i, idx), (idx, j)]
    return [p for p, k in zip(points, keep, strict=True) if k]


def locate(shape: list, p, start: int = 0) -> tuple[int, list[float], float]:
    """Nearest point to p on shape at or after vertex `start`: (segment index, point, metres)."""
    best = (start, list(shape[start]), math.inf)
    for i in range(start, len(shape) - 1):
        d, q = _project(p, shape[i], shape[i + 1])
        if d < best[2]:
            best = (i, q, d)
    return best


def cut(shape: list, a, b) -> list | None:
    """The piece of `shape` from the point nearest stop a to the one nearest stop b after it."""
    if len(shape) < 2:
        return None
    ia, qa, da = locate(shape, a)
    ib, qb, db = locate(shape, b, ia)
    if da > 150 or db > 150:  # the shape doesn't serve these stops
        return None
    if ib == ia:
        return [qa, qb]
    return [qa, *[list(p) for p in shape[ia + 1 : ib + 1]], qb]


def r5(p) -> list[float]:
    return [round(p[0], 5), round(p[1], 5)]


# --------------------------------------------------------------------------------- build
def build(z: zipfile.ZipFile) -> dict:
    routes = {}
    for r in rows(z, "routes.txt"):
        rid = r["route_id"].strip()
        color = (r.get("route_color") or "").strip() or "7c858c"
        text = (r.get("route_text_color") or "").strip() or "ffffff"
        routes[rid] = {"color": "#" + color.lower(), "text": "#" + text.lower(),
                       "line": LINE_OF.get(rid, "S")}  # fmt: skip

    parents: dict[str, str] = {}
    stops: dict[str, list] = {}
    for s in rows(z, "stops.txt"):
        sid = s["stop_id"].strip()
        if (s.get("parent_station") or "").strip():
            parents[sid] = s["parent_station"].strip()
        if (s.get("location_type") or "0").strip() in ("1",) or not s.get("parent_station"):
            stops.setdefault(sid, [round(float(s["stop_lon"]), 5), round(float(s["stop_lat"]), 5),
                                   s["stop_name"].strip()])  # fmt: skip

    shapes_pts: dict[str, list] = defaultdict(list)
    for s in rows(z, "shapes.txt"):
        shapes_pts[s["shape_id"]].append(
            (int(s["shape_pt_sequence"]), float(s["shape_pt_lon"]), float(s["shape_pt_lat"]))
        )
    shapes = {k: [(x, y) for _, x, y in sorted(v)] for k, v in shapes_pts.items()}

    trips = {}
    for t in rows(z, "trips.txt"):
        tid = t["trip_id"].strip()
        shape = (t.get("shape_id") or "").strip()
        if not shape:  # static trip ids end with the same "<route>..<dir><variant>" part
            shape = tid.rsplit("_", 1)[-1] if "_" in tid else ""
        trips[tid] = (t["route_id"].strip(), shape, (t.get("trip_headsign") or "").strip())

    stop_seq: dict[str, list] = defaultdict(list)
    for st in rows(z, "stop_times.txt"):
        tid = st["trip_id"].strip()
        if tid not in trips:
            continue
        stop_seq[tid].append(
            (
                int(st["stop_sequence"]),
                st["stop_id"].strip(),
                gtfs_seconds(st.get("arrival_time") or ""),
                gtfs_seconds(st.get("departure_time") or ""),
            )
        )

    pattern_votes: dict[str, Counter] = defaultdict(Counter)
    head_votes: dict[str, Counter] = defaultdict(Counter)
    prev_votes: dict[str, Counter] = defaultdict(Counter)
    runs: dict[str, list[int]] = defaultdict(list)
    pair_shapes: dict[str, Counter] = defaultdict(Counter)
    for tid, seq in stop_seq.items():
        route, shape, headsign = trips[tid]
        seq.sort()
        ids = [parent_of(s[1], parents) for s in seq]
        if shape:
            pattern_votes[shape][tuple(ids)] += 1
            if headsign:
                head_votes[shape][headsign] += 1
        for (_, sa, _, dep), (_, sb, arr, _) in itertools.pairwise(seq):
            a, b = parent_of(sa, parents), parent_of(sb, parents)
            d = dir_of(sb) or dir_of(sa)
            if a == b:
                continue
            if d:
                prev_votes[f"{route}:{d}:{b}"][a] += 1
            key = f"{a}>{b}"
            if dep is not None and arr is not None and arr >= dep:
                runs[key].append(arr - dep)
            if shape in shapes:
                pair_shapes[key][shape] += 1
            else:
                pair_shapes[key][""] += 1

    segments = {}
    straight = 0
    for key in sorted(pair_shapes):
        a, b = key.split(">")
        if a not in stops or b not in stops:
            continue
        coords = None
        for shape, _ in pair_shapes[key].most_common():
            if shape and (coords := cut(shapes[shape], stops[a][:2], stops[b][:2])):
                break
        if not coords:
            coords = [stops[a][:2], stops[b][:2]]
            straight += 1
        c = [r5(p) for p in simplify(coords, TOLERANCE_M)]
        c = [p for i, p in enumerate(c) if i == 0 or p != c[i - 1]] or c[:1]
        if len(c) == 1:
            c = [c[0], c[0]]
        s = int(statistics.median(runs[key])) if runs.get(key) else 0
        segments[key] = {"c": c, "s": s}

    used = {s for key in segments for s in key.split(">")}
    used |= {s for v in pattern_votes.values() for p in v for s in p}
    out = {
        "version": 1,
        "built_at": datetime.now(UTC).strftime("%Y-%m-%dT%H:%M:%SZ"),
        "source_url": URL,
        "routes": dict(sorted(routes.items())),
        "stops": {k: stops[k] for k in sorted(stops) if k in used},
        "patterns": {k: list(v.most_common(1)[0][0]) for k, v in sorted(pattern_votes.items())},
        "headsigns": {k: v.most_common(1)[0][0] for k, v in sorted(head_votes.items())},
        "prev": {k: v.most_common(1)[0][0] for k, v in sorted(prev_votes.items())},
        "segments": segments,
    }
    print(
        f"routes {len(routes)}, stops {len(out['stops'])}, patterns {len(out['patterns'])}, "
        f"prev {len(out['prev'])}, segments {len(segments)} ({straight} straight), "
        f"points {sum(len(s['c']) for s in segments.values())}",
        file=sys.stderr,
    )
    return out


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--zip", type=Path, help="local gtfs_subway.zip instead of downloading")
    ap.add_argument("--save-zip", type=Path, help="also save the downloaded zip here")
    ap.add_argument("--out", type=Path, default=OUT)
    args = ap.parse_args()
    if args.zip:
        data = args.zip.read_bytes()
    else:
        from nyclive.http import Http
        from nyclive.settings import load_settings

        with Http(load_settings().user_agent) as h:
            data = h.get(URL).content
        if args.save_zip:
            args.save_zip.parent.mkdir(parents=True, exist_ok=True)
            args.save_zip.write_bytes(data)
    with zipfile.ZipFile(io.BytesIO(data)) as z:
        doc = build(z)
    text = json.dumps(doc, ensure_ascii=False, separators=(",", ":"))
    if len(text.encode()) > MAX_BYTES:
        raise SystemExit(f"{len(text.encode())} bytes is over the {MAX_BYTES} byte budget")
    args.out.write_text(text + "\n", encoding="utf-8", newline="\n")
    print(f"wrote {args.out} ({len(text.encode()) / 1024:.0f} KB)", file=sys.stderr)


if __name__ == "__main__":
    main()

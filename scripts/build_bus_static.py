"""Build config/bus_static.json: what the buses layer needs from MTA bus static GTFS (ADR-018).

    uv run python scripts/build_bus_static.py                 # download the 6 zips (~55 MB)
    uv run python scripts/build_bus_static.py --zips DIR      # use local copies (gtfs_b.zip...)
    uv run python scripts/build_bus_static.py --save-zips DIR # download and keep them

Sources: MTA bus static GTFS, one zip per borough for NYCT plus one for MTA Bus Company
(https://rrgtfsfeeds.s3.amazonaws.com/gtfs_{b,bx,m,q,si,busco}.zip). Output:

    routes    {route_id: [long name, colour, text colour]}   colours "#rrggbb"
    stops     {stop_id: name}
    headsigns {"route:direction_id": headsign}               the most common trip headsign

Realtime route ids ("Q44+", "BXM2") and stop ids ("500367") are the static ones. Positions come
from the realtime feed, so stops carry names only.
"""

from __future__ import annotations

import argparse
import csv
import io
import json
import sys
import zipfile
from collections import Counter
from pathlib import Path

BASE = "https://rrgtfsfeeds.s3.amazonaws.com/"
ZIPS = ("gtfs_b", "gtfs_bx", "gtfs_m", "gtfs_q", "gtfs_si", "gtfs_busco")
OUT = Path(__file__).resolve().parents[1] / "config" / "bus_static.json"
MAX_BYTES = 1_200_000


def rows(z: zipfile.ZipFile, name: str):
    with z.open(name) as f:
        yield from csv.DictReader(io.TextIOWrapper(f, encoding="utf-8-sig"))


def _hex(v: str | None, default: str) -> str:
    v = (v or "").strip().lstrip("#")
    return f"#{v.lower()}" if len(v) == 6 else default


def build(zips: list[zipfile.ZipFile]) -> dict:
    routes: dict[str, list[str]] = {}
    stops: dict[str, str] = {}
    heads: dict[str, Counter] = {}
    for z in zips:
        for r in rows(z, "routes.txt"):
            rid = r["route_id"].strip()
            long = (r.get("route_long_name") or "").strip()
            routes[rid] = [
                long,
                _hex(r.get("route_color"), "#0039a6"),
                _hex(r.get("route_text_color"), "#ffffff"),
            ]
        for s in rows(z, "stops.txt"):
            stops[s["stop_id"].strip()] = s["stop_name"].strip()
        for t in rows(z, "trips.txt"):
            h = (t.get("trip_headsign") or "").strip()
            if h:
                key = f"{t['route_id'].strip()}:{(t.get('direction_id') or '0').strip()}"
                heads.setdefault(key, Counter())[h] += 1
    headsigns = {k: c.most_common(1)[0][0] for k, c in sorted(heads.items())}
    print(f"routes {len(routes)}, stops {len(stops)}, headsigns {len(headsigns)}", file=sys.stderr)
    return {
        "routes": dict(sorted(routes.items())),
        "stops": dict(sorted(stops.items())),
        "headsigns": headsigns,
    }


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--zips", type=Path, help="folder with local gtfs_*.zip copies")
    ap.add_argument("--save-zips", type=Path, help="also save the downloaded zips here")
    ap.add_argument("--out", type=Path, default=OUT)
    args = ap.parse_args()
    blobs: list[bytes] = []
    if args.zips:
        blobs = [(args.zips / f"{n}.zip").read_bytes() for n in ZIPS]
    else:
        from nyclive.http import Http
        from nyclive.settings import load_settings

        with Http(load_settings().user_agent, timeout_s=120) as h:
            for n in ZIPS:
                blobs.append(h.get(f"{BASE}{n}.zip").content)
                print(f"got {n}.zip ({len(blobs[-1]) / 1e6:.1f} MB)", file=sys.stderr)
                if args.save_zips:
                    args.save_zips.mkdir(parents=True, exist_ok=True)
                    (args.save_zips / f"{n}.zip").write_bytes(blobs[-1])
    doc = build([zipfile.ZipFile(io.BytesIO(b)) for b in blobs])
    text = json.dumps(doc, ensure_ascii=False, separators=(",", ":"))
    if len(text.encode()) > MAX_BYTES:
        raise SystemExit(f"{len(text.encode())} bytes is over the {MAX_BYTES} byte budget")
    args.out.write_text(text + "\n", encoding="utf-8", newline="\n")
    print(f"wrote {args.out} ({len(text.encode()) / 1024:.0f} KB)", file=sys.stderr)


if __name__ == "__main__":
    main()

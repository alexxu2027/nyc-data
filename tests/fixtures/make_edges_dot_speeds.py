"""Regenerate the hand-derived edge_* cases for dot_speeds (dot_traffic_speeds) from its real case.

    uv run python tests/fixtures/make_edges_dot_speeds.py

Each edge case is a copy of `real` with one documented change (see its meta.json note). Rows are
trimmed to keep each case small; the page envelope (a JSON list in part page-000) is kept.
"""

from __future__ import annotations

import copy
import json
from dataclasses import replace
from pathlib import Path

from nyclive.sources.base import RawPayload

HERE = Path(__file__).parent
SOURCE_ID = "dot_traffic_speeds"
GOOGLE_EXAMPLE = "_p~iF~ps|U_ulLnnqC_mqNvxq`@"  # decodes to California, outside NYC


def edit(case: str, note: str, change) -> None:
    raw = RawPayload.load(HERE / SOURCE_ID / "real")
    p = raw.part("page-000")
    rows = change(json.loads(p.content))
    p = replace(p, content=json.dumps(rows, separators=(",", ":"), ensure_ascii=False).encode())
    replace(raw, parts=(p,)).save(HERE / SOURCE_ID / case, note=note)


def by_link(rows, link_id):
    return next(r for r in rows if r["link_id"] == link_id)


def two_snapshots(rows):
    a = by_link(rows, "4362250")  # CVE NB GCP - WILLETS PT BLVD, 20:42:05
    b = by_link(rows, "4362314")  # TNB S Qns Anchorage - CIP S @ TNB, 20:42:05
    older = copy.deepcopy(a)
    older["data_as_of"] = "2026-11-14T20:37:05.000"
    older["speed"] = "30.5"
    older["travel_time"] = "540"
    older["link_name"] = "OLD NAME"
    return [older, a, b, copy.deepcopy(b)]


def bad_polylines(rows):
    a = by_link(rows, "4362250")
    b = by_link(rows, "4362314")
    c = by_link(rows, "4362342")
    a["encoded_poly_line"] = "uk}wF tckaM"  # space is not a polyline character
    b["encoded_poly_line"] = GOOGLE_EXAMPLE
    del c["encoded_poly_line"]
    return [a, b, c]


edit(
    "edge_two_snapshots",
    "4 rows: link 4362250 twice (an older 20:37:05 copy with speed 30.5, travel_time 540, "
    "link_name OLD NAME, then the real 20:42:05 row); link 4362314 twice with identical rows",
    two_snapshots,
)
edit(
    "edge_bad_polylines",
    "3 rows: 4362250 polyline has a space (undecodable); 4362314 polyline is Google's example "
    "(decodes to California); 4362342 has no encoded_poly_line key",
    bad_polylines,
)
print("ok")

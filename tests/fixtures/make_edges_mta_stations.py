"""Regenerate tests/fixtures/mta_subway_stations/edge_* from the real case.

uv run python tests/fixtures/make_edges_mta_stations.py
"""

from __future__ import annotations

import json
from dataclasses import replace
from pathlib import Path

from nyclive.sources.base import RawPayload

HERE = Path(__file__).parent / "mta_subway_stations"

raw = RawPayload.load(HERE / "real")
rows = json.loads(raw.part("body").content)[:8]
rows[1]["borough"] = "Bx"
rows[2]["borough"] = "SI"
rows[3]["borough"] = "Nowhere"  # unknown -> None
rows[4]["gtfs_latitude"], rows[4]["gtfs_longitude"] = "NaN", ""  # no location
del rows[5]["ada"]  # props lack ada
rows[6]["stop_name"] = ""  # name falls back to the id
rows.append({"stop_name": "no id", "gtfs_latitude": "40.7", "gtfs_longitude": "-73.9"})  # skipped
rows.append(dict(rows[0], stop_name="duplicate of R01"))  # same gtfs_stop_id: first one kept
body = json.dumps(rows, separators=(",", ":")).encode()
replace(raw, parts=(replace(raw.part("body"), content=body),)).save(
    HERE / "edge_bad_rows",
    note="first 8 real rows; [1] borough Bx, [2] SI, [3] 'Nowhere'; [4] lat NaN, lon blank; "
    "[5] no ada key; [6] blank stop_name; plus a row with no gtfs_stop_id and a duplicate of R01",
)
print("ok")

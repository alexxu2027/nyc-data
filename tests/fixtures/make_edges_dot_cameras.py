"""Regenerate tests/fixtures/dot_cameras/edge_* from the real case.

uv run python tests/fixtures/make_edges_dot_cameras.py
"""

from __future__ import annotations

import json
from dataclasses import replace
from pathlib import Path

from nyclive.sources.base import RawPayload

HERE = Path(__file__).parent / "dot_cameras"

raw = RawPayload.load(HERE / "real")
cams = json.loads(raw.part("body").content)
cams[0]["latitude"], cams[0]["longitude"] = 0, 0  # no location
cams[1]["isOnline"] = "false"
cams[2]["area"] = ""  # unknown borough
cams[3]["name"] = None  # falls back to the id
cams[4]["latitude"], cams[4]["longitude"] = -73.94, 40.75  # swapped -> outside NYC -> None
cams.append({"id": "", "name": "no id"})  # skipped
body = json.dumps(cams, separators=(",", ":")).encode()
replace(raw, parts=(replace(raw.part("body"), content=body),)).save(
    HERE / "edge_bad_rows",
    note="cams[0] at 0,0; [1] offline; [2] empty area; [3] null name; [4] swapped lat/lon; "
    "plus a row with no id",
)
print("ok")

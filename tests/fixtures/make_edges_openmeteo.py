"""Regenerate the hand-derived edge_* cases for openmeteo_current from its real case.

    uv run python tests/fixtures/make_edges_openmeteo.py

Each edge case is a copy of `real` with one documented change (see its meta.json note).
"""

from __future__ import annotations

import json
from dataclasses import replace
from pathlib import Path

from nyclive.sources.base import RawPayload

HERE = Path(__file__).parent
SOURCE_ID = "openmeteo_current"


def edit(case: str, note: str, change) -> None:
    raw = RawPayload.load(HERE / SOURCE_ID / "real")
    p = raw.part("body")
    doc = change(json.loads(p.content))
    p = replace(p, content=json.dumps(doc, separators=(",", ":"), ensure_ascii=False).encode())
    replace(raw, parts=(p,)).save(HERE / SOURCE_ID / case, note=note)


def missing_values(doc):
    doc[1]["current"]["precipitation"] = None  # BK: null value
    del doc[3]["current"]["wind_speed_10m"]  # BX: key absent
    del doc[4]["current"]  # SI: no current block at all
    return doc


edit(
    "edge_missing_values",
    "BK current.precipitation=null; BX current lacks wind_speed_10m; SI has no current block",
    missing_values,
)
print("ok")

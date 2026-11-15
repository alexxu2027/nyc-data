"""Regenerate the hand-derived edge_* cases for the 1A reference adapters from their real cases.

    uv run python tests/fixtures/make_edges_1a.py

Each edge case is a copy of `real` with one documented change (see its meta.json note).
"""

from __future__ import annotations

import json
from dataclasses import replace
from pathlib import Path

from nyclive.sources.base import RawPayload

HERE = Path(__file__).parent


def edit(source_id: str, case: str, note: str, changes: dict) -> None:
    raw = RawPayload.load(HERE / source_id / "real")
    parts = []
    for p in raw.parts:
        if p.name in changes:
            doc = changes[p.name](json.loads(p.content))
            p = replace(p, content=json.dumps(doc, separators=(",", ":")).encode())
        parts.append(p)
    replace(raw, parts=tuple(parts)).save(HERE / source_id / case, note=note)


def no_data(_doc):
    return {
        "error": {
            "message": "No data was found. This product may not be offered at this "
            "station at the requested time."
        }
    }


def blank_second_level(doc):
    doc["data"][1]["v"] = ""
    return doc


def sentinel_and_missing(doc):
    st = doc["data"]["stations"]
    st[0]["last_reported"] = 86400
    st[1].pop("num_ebikes_available", None)
    st[2]["last_reported"] = 4102444800  # 2100-01-01: future clock skew
    return doc


def info_missing_optional(doc):
    st = doc["data"]["stations"]
    st[0].pop("region_id", None)
    st[0]["name"] = ""
    return doc


edit(
    "noaa_tide_battery",
    "edge_no_data",
    "both products return NOAA's no-data error",
    {"levels": no_data, "predictions": no_data},
)
edit(
    "noaa_tide_battery",
    "edge_blank_value",
    "levels data[1].v set to '' (missed reading)",
    {"levels": blank_second_level},
)
edit(
    "citibike_station_status",
    "edge_sentinel",
    "stations[0] last_reported=86400 sentinel; stations[1] lacks num_ebikes_available; "
    "stations[2] last_reported in 2100",
    {"station_status": sentinel_and_missing},
)
edit(
    "citibike_gbfs",
    "edge_missing_optional",
    "stations[0] has no region_id and an empty name",
    {"station_information": info_missing_optional},
)
print("ok")

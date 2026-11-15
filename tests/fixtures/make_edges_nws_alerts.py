"""Regenerate the hand-derived edge_* cases for nws_alerts from its real case.

    uv run python tests/fixtures/make_edges_nws_alerts.py

Each edge case is a copy of `real` with one documented change (see its meta.json note). Feature
lists are trimmed to keep each case small; the FeatureCollection envelope is kept.
"""

from __future__ import annotations

import json
from dataclasses import replace
from pathlib import Path

from nyclive.sources.base import RawPayload

HERE = Path(__file__).parent
SOURCE_ID = "nws_alerts"


def edit(case: str, note: str, change) -> None:
    raw = RawPayload.load(HERE / SOURCE_ID / "real")
    p = raw.part("active")
    doc = change(json.loads(p.content))
    p = replace(p, content=json.dumps(doc, separators=(",", ":"), ensure_ascii=False).encode())
    replace(raw, parts=(p,)).save(HERE / SOURCE_ID / case, note=note)


def by_suffix(doc, suffix):
    return next(f for f in doc["features"] if f["properties"]["id"].endswith(suffix))


def empty(doc):
    doc["features"] = []
    return doc


def no_ends(doc):
    outside = doc["features"][0]  # Otsego county, not NYC
    a = by_suffix(doc, "de01fcd82d28ef.001.1")  # Tornado Warning, Queens
    b = by_suffix(doc, "6ed8b6b08aed83.001.1")  # Flash Flood Warning, Queens
    a["properties"]["ends"] = None
    del b["properties"]["ends"]
    b["properties"]["expires"] = None
    doc["features"] = [outside, a, b]
    return doc


def long_text_multipolygon(doc):
    f = by_suffix(doc, "57f1a30e160a8a.001.1")  # Flood Advisory, all five boroughs
    p = f["properties"]
    p["description"] = (p["description"] + "\n") * 4  # ~5.5 KB
    p["instruction"] = (p["instruction"] + "\n") * 10
    poly = f["geometry"]["coordinates"]
    f["geometry"] = {"type": "MultiPolygon", "coordinates": [poly, poly]}
    doc["features"] = [f]
    return doc


edit("edge_empty", "features = [] (no active alerts, the usual state)", empty)
edit(
    "edge_no_ends",
    "3 features: [0] Otsego (outside NYC); Tornado Warning de01.. ends=null (expires kept); "
    "Flash Flood Warning 6ed8.. has no ends key and expires=null",
    no_ends,
)
edit(
    "edge_long_text_multipolygon",
    "1 feature (57f1.. Flood Advisory): description x4 and instruction x10 (props over 4 KB "
    "untrimmed); geometry turned into a MultiPolygon of the polygon twice",
    long_text_multipolygon,
)
print("ok")

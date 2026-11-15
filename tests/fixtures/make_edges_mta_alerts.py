"""Regenerate tests/fixtures/mta_subway_alerts/edge_* from the real case.

    uv run python tests/fixtures/make_edges_mta_alerts.py

Each edge case is a copy of `real` with documented changes (see its meta.json note). Entity
lists are trimmed to keep each case small; the FeedMessage header is kept.
"""

from __future__ import annotations

import copy
import json
from dataclasses import replace
from pathlib import Path

from nyclive.sources.base import RawPayload

HERE = Path(__file__).parent
SOURCE_ID = "mta_subway_alerts"
MERCURY = "transit_realtime.mercury_alert"


def edit(case: str, note: str, change) -> None:
    raw = RawPayload.load(HERE / SOURCE_ID / "real")
    p = raw.part("body")
    doc = change(json.loads(p.content))
    p = replace(p, content=json.dumps(doc, separators=(",", ":"), ensure_ascii=False).encode())
    replace(raw, parts=(p,)).save(HERE / SOURCE_ID / case, note=note)


def by_id(doc, eid):
    return next(e for e in doc["entity"] if e["id"] == eid)


def empty(doc):
    del doc["entity"]  # proto JSON omits an empty repeated field
    return doc


def open_ended(doc):
    delays = by_id(doc, "lmm:alert:276422:26")  # 1 period with an end; routes D, N
    del delays["alert"]["active_period"][0]["end"]

    part = by_id(doc, "lmm:planned_work:36463")  # 2 periods, Part Suspended, R stations
    del part["alert"]["active_period"][1]["end"]  # one open period -> whole event open
    ie = part["alert"]["informed_entity"]
    ie[0]["stop_id"] = "R30N"  # platform ids -> parent R30 (deduped against ie[0] itself)
    ie[1]["stop_id"] = "R30S"
    ie.append({"agency_id": "MTASBWY", "route_id": "R"})  # route-only selector, duplicate route

    notice = by_id(doc, "lmm:planned_work:36566")  # Station Notice, S21
    del notice["alert"]["active_period"]  # no periods -> starts at mercury created_at
    notice["alert"][MERCURY]["alert_type"] = "No Trains Running"

    longtxt = copy.deepcopy(by_id(doc, "lmm:planned_work:36419"))
    longtxt["id"] = "edge:long_description"
    for t in longtxt["alert"]["description_text"]["translation"]:
        t["text"] = (t["text"] + "\n") * 6  # props over 4 KB untrimmed

    doc["entity"] = [
        delays,
        part,
        notice,
        longtxt,
        copy.deepcopy(delays),  # duplicate id: first one kept
        {"id": "edge:no_alert", "trip_update": {}},  # not an alert: skipped
    ]
    return doc


edit("bad_empty", "no entity key: must be rejected, not treated as a complete empty feed", empty)
edit(
    "edge_open_ended",
    "6 entities: 276422 Delays with its only period's end removed; 36463 Part Suspended with "
    "period[1] end removed, stop ids R30N/R30S and a route-only R selector; 36566 with no "
    "active_period and alert_type 'No Trains Running'; a copy of 36419 (id "
    "edge:long_description) with description x6; a duplicate of 276422; a non-alert entity",
    open_ended,
)
print("ok")

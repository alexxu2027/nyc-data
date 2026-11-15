"""Regenerate the hand-derived edge_* cases for floodnet_sensors and floodnet_events from their
real cases.

    uv run python tests/fixtures/make_edges_floodnet.py

Each edge case is a copy of `real` (part page-000) with documented changes (see its meta.json
note). Rows are trimmed to keep each case small; the Socrata list envelope is kept.
"""

from __future__ import annotations

import json
from dataclasses import replace
from pathlib import Path

from nyclive.sources.base import RawPayload

HERE = Path(__file__).parent


def edit(source_id: str, case: str, note: str, change, cursor: str | None = None) -> None:
    raw = RawPayload.load(HERE / source_id / "real")
    p = raw.part("page-000")
    rows = change(json.loads(p.content))
    p = replace(p, content=json.dumps(rows, separators=(",", ":"), ensure_ascii=False).encode())
    replace(raw, parts=(p,), cursor=cursor).save(HERE / source_id / case, note=note)


# ------------------------------------------------------------------------------- sensors
def sensors_odd_values(rows):
    a, b, c, d, e = (dict(r) for r in rows[:5])
    a["tidally_influenced"] = "Yes"
    a["borough"] = "Queens"
    b["latitude"] = ""
    del b["longitude"]
    b["lowest_point_height_delta_inches"] = "n/a"
    del c["sensor_id"]  # skipped
    d["borough"] = "Narnia"  # unknown borough → None
    del d["nta"]
    e2 = dict(e)
    e2["sensor_name"] = "duplicate of the previous row"  # same sensor_id: first one wins
    return [a, b, c, d, e, e2]


edit(
    "floodnet_sensors",
    "edge_odd_values",
    "rows 0-4 of real plus a duplicate of row 4: [0] tidally_influenced Yes, borough Queens; "
    "[1] latitude '' and no longitude, height delta 'n/a'; [2] no sensor_id (skipped); "
    "[3] borough Narnia, no nta; [5] repeats [4]'s sensor_id (dropped)",
    sensors_odd_values,
)


# -------------------------------------------------------------------------------- events
def events_thresholds_missing_end(rows):
    # four short-profile rows from the real page; real is newest-first
    picks = [dict(rows[i]) for i in (4, 5, 7, 8)]
    picks[0]["max_depth_inches"] = "12.00"  # severity 3
    picks[1]["max_depth_inches"] = "4.00"  # severity 2
    picks[2]["max_depth_inches"] = "3.99"  # severity 1
    del picks[2]["flood_end_time"]  # still flooding / no end yet
    picks[3]["flood_end_time"] = "2026-10-24T10:00:00.000"  # before its start → None
    return picks


def events_long_profile(rows):
    r = dict(rows[0])  # BX Ditmars 2026-10-26, 199 points (fits)
    long = dict(r)
    long["flood_start_time"] = "2026-10-27T01:00:00.000"
    long["flood_end_time"] = "2026-10-27T11:06:00.000"
    depth = json.loads(r["flood_profile_depth_inches"])
    secs = json.loads(r["flood_profile_time_secs"])
    long["flood_profile_depth_inches"] = json.dumps(depth * 3)
    long["flood_profile_time_secs"] = json.dumps(
        [s + k * (secs[-1] + 60) for k in range(3) for s in secs]
    )
    bad = dict(rows[1])
    bad["flood_profile_depth_inches"] = "[0.00, oops]"  # unparsable: profile omitted, not dropped
    return [r, long, bad]


edit(
    "floodnet_events",
    "edge_thresholds_missing_end",
    "real rows 4,5,7,8: max_depth set to 12.00 / 4.00 / 3.99 (severity 3/2/1; row 8 keeps 2.13); "
    "row 7 has no flood_end_time; row 8 flood_end_time moved before its start",
    events_thresholds_missing_end,
)
edit(
    "floodnet_events",
    "edge_long_profile",
    "real row 0 as is; a copy starting 2026-10-27T01:00 with its profile repeated 3x (597 "
    "points, props over 4 KB → profile dropped); real row 1 with an unparsable depth profile",
    events_long_profile,
)
edit(
    "floodnet_events",
    "edge_empty_keeps_cursor",
    "no rows (nothing new); meta cursor set so parse keeps it",
    lambda rows: [],
    cursor="2026-10-26T18:43:29+00:00",
)
print("ok")

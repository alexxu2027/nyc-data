"""Regenerate the hand-derived edge_* cases for nyc_collisions from its real case.

    uv run python tests/fixtures/make_edges_nyc_collisions.py

Each edge case is a copy of `real` with one documented change (see its meta.json note). The one
page (page-000, 30 rows) is kept whole.
"""

from __future__ import annotations

import json
from dataclasses import replace
from pathlib import Path

from nyclive.sources.base import RawPayload

HERE = Path(__file__).parent
SOURCE_ID = "nyc_collisions"


def edit(case: str, note: str, change) -> None:
    raw = RawPayload.load(HERE / SOURCE_ID / "real")
    p = raw.part("page-000")
    rows = json.loads(p.content)
    change(rows)
    p = replace(p, content=json.dumps(rows, separators=(",", ":")).encode())
    replace(raw, parts=(p,)).save(HERE / SOURCE_ID / case, note=note)


def by_id(rows, prefix):
    return next(r for r in rows if r["collision_id"].startswith(prefix))


def severity(rows):
    a = by_id(rows, "820a200c")  # 0 injured, 0 killed
    a["number_of_persons_killed"] = a["number_of_pedestrians_killed"] = "1"
    b = by_id(rows, "a1269442")  # 2 injured
    b["number_of_persons_killed"] = b["number_of_motorist_killed"] = "1"


def dst(rows):
    by_id(rows, "1110bd45").update(crash_date="2026-11-01T00:00:00.000", crash_time="1:30")
    by_id(rows, "3f9057e7").update(crash_date="2026-03-08T00:00:00.000", crash_time="2:30")
    by_id(rows, "158b5470").update(crash_date="2026-07-04T00:00:00.000", crash_time="23:30")
    by_id(rows, "179a3fde").update(crash_date="2026-11-12T00:00:00.000", crash_time="23:59")


def bad_rows(rows):
    del by_id(rows, "1110bd45")["longitude"]
    r = by_id(rows, "3f9057e7")
    r["latitude"], r["longitude"] = r["longitude"], r["latitude"]
    del by_id(rows, "158b5470")["crash_time"]
    dup = dict(by_id(rows, "179a3fde"))
    dup["number_of_persons_injured"] = "5"
    rows.append(dup)


edit(
    "edge_severity",
    "820a200c..: persons_killed and pedestrians_killed 1 (0 injured); a1269442..: persons_killed "
    "and motorist_killed 1 (2 injured)",
    severity,
)
edit(
    "edge_dst",
    "1110bd45.. 2026-11-01 1:30 (repeated hour, single-digit hour); 3f9057e7.. 2026-03-08 2:30 "
    "(skipped hour); 158b5470.. 2026-07-04 23:30 (EDT, next day in UTC); 179a3fde.. 2026-11-12 "
    "23:59 (newest crash)",
    dst,
)
edit(
    "edge_bad_rows",
    "1110bd45..: longitude removed; 3f9057e7..: latitude/longitude swapped; 158b5470..: "
    "crash_time removed; 179a3fde.. appended again (as from overlapping pages) with 5 injured",
    bad_rows,
)
print("ok")

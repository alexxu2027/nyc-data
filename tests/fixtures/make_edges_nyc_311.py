"""Regenerate the hand-derived edge_* cases for nyc_311 from its real case.

    uv run python tests/fixtures/make_edges_nyc_311.py

Each edge case is a copy of `real` with one documented change (see its meta.json note). Both
parts (new-000, closed-000) are kept whole; they are small.
"""

from __future__ import annotations

import json
from dataclasses import replace
from pathlib import Path

from nyclive.sources.base import RawPayload

HERE = Path(__file__).parent
SOURCE_ID = "nyc_311"


def edit(case: str, note: str, change) -> None:
    """`change(new_rows, closed_rows)` edits the two row lists in place."""
    raw = RawPayload.load(HERE / SOURCE_ID / "real")
    docs = {p.name: json.loads(p.content) for p in raw.parts}
    change(docs["new-000"], docs["closed-000"])
    parts = tuple(
        replace(p, content=json.dumps(docs[p.name], separators=(",", ":")).encode())
        for p in raw.parts
    )
    replace(raw, parts=parts).save(HERE / SOURCE_ID / case, note=note)


def by_key(rows, key):
    return next(r for r in rows if r["unique_key"] == key)


def overlap(new, closed):
    # 71095931 is open in `new`; add a closed copy to `closed`.
    row = dict(by_key(new, "71095931"))
    row.update(
        closed_date="2026-11-13T05:00:00.000",
        status="Closed",
        resolution_description="The Police Department responded to the complaint.",
    )
    closed.append(row)
    # 71096195 is closed in `closed`; add a stale open copy (no closed_date) to `new`.
    stale = dict(by_key(closed, "71096195"))
    del stale["closed_date"], stale["resolution_description"]
    stale["status"] = "In Progress"
    new.append(stale)


def bad_closed_date(new, closed):
    by_key(closed, "71096195")["closed_date"] = "2026-11-11T20:05:00.000"  # created 11-12 20:05


def unspecified_borough(new, closed):
    by_key(new, "71095931")["borough"] = "Unspecified"
    row = by_key(new, "71104214")
    del row["latitude"], row["longitude"]


edit(
    "edge_overlap",
    "71095931 (open in new-000) also appended to closed-000 with closed_date "
    "2026-11-13T05:00:00.000; 71096195 (closed in closed-000) also appended to new-000 without "
    "closed_date/resolution, status In Progress",
    overlap,
)
edit(
    "edge_bad_closed_date",
    "closed-000 71096195: closed_date set to 2026-11-11T20:05:00.000, a day before its "
    "created_date 2026-11-12T20:05:00.000",
    bad_closed_date,
)
edit(
    "edge_unspecified_borough",
    "new-000 71095931: borough 'Unspecified'; new-000 71104214: latitude and longitude removed",
    unspecified_borough,
)
print("ok")

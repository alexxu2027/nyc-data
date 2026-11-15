"""Regenerate tests/fixtures/mta_elevator_outages/edge_* from the real case.

    uv run python tests/fixtures/make_edges_mta_elevators.py

The real case is all planned (upcoming) elevator outages whose equipment all match; this edge
case adds current outages, an escalator, unmatched equipment and malformed rows.
"""

from __future__ import annotations

import copy
import json
from dataclasses import replace
from pathlib import Path

from nyclive.sources.base import RawPayload

HERE = Path(__file__).parent / "mta_elevator_outages"


def dump(doc) -> bytes:
    return json.dumps(doc, separators=(",", ":"), ensure_ascii=False).encode()


raw = RawPayload.load(HERE / "real")
outages = json.loads(raw.part("outages").content)[:11]  # rows 0-10
equipments = json.loads(raw.part("equipments").content)
by_no = {e["equipmentno"]: e for e in equipments}

# [1] EL142 and [4] EL143 (125 St) lose their equipment rows -> no station refs
keep = {o["equipment"] for o in outages} - {"EL142", "EL143"}
equipments = [by_no[n] for n in sorted(keep)]
by_no = {e["equipmentno"]: e for e in equipments}

# [0] EL124: a current outage (not upcoming), maintenance, no return estimate
outages[0].update(
    outagedate="11/14/2026 07:15:00 AM",
    estimatedreturntoservice="",
    isupcomingoutage="N",
    ismaintenanceoutage="Y",
    reason="Repair",
)
# [2] EL123: stop ids comma-separated with a platform suffix -> A07, L01
by_no["EL123"]["elevatorsgtfsstopid"] = "A07, L01N"
by_no["EL123"]["isactive"] = "N"
# [3] an escalator with no equipment row
outages[3].update(equipment="ES999", equipmenttype="ES", serving="Street to mezzanine")
# [5] unparseable outage date -> skipped; [6] no equipment -> skipped
outages[5]["outagedate"] = "soon"
outages[6]["equipment"] = ""
# [7] unparseable return estimate -> est_return None
outages[7]["estimatedreturntoservice"] = "TBD"
# a duplicate of [8] (same equipment + outagedate) -> first kept
outages.append(copy.deepcopy(outages[8]))
# an equipment row with no equipmentno -> skipped
equipments.append({"station": "Nowhere", "equipmentno": "", "equipmenttype": "EL"})

parts = (
    replace(raw.part("outages"), content=dump(outages)),
    replace(raw.part("equipments"), content=dump(equipments)),
)
replace(raw, parts=parts).save(
    HERE / "edge_unmatched_current",
    note="outages = real[0:11] + dup of [8]; equipments = real rows for those minus EL142/EL143 "
    "(125 St, unmatched) + a row with no equipmentno. [0] EL124 current (11/14 7:15 AM, not "
    "upcoming, maintenance, blank estimate); EL123 stop ids 'A07, L01N' and isactive N; [3] "
    "ES999 escalator (unmatched); [5] outagedate 'soon'; [6] blank equipment; [7] estimate 'TBD'",
)
print("ok")

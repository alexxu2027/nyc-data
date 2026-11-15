from datetime import UTC, datetime

import httpx
import pytest
from helpers import parse_fixture

from nyclive.http import Http
from nyclive.registry import load_registry
from nyclive.sources import mta_elevators
from nyclive.sources.base import FetchContext

SID = "mta_elevator_outages"
MOD = "mta_elevators"


def _event(batch, eid):
    return next(e for e in batch.events if e.event_id == eid)


def test_real_fixture():
    b = parse_fixture(SID, module=MOD)
    assert b.complete == frozenset({"events", "entities"})
    assert len(b.entities) == 35 and len(b.events) == 60
    assert all(e.kind == "elevator" and e.lat is None for e in b.entities)
    assert all(e.category == "elevator_outage" and e.ends_at is None for e in b.events)
    assert all(e.props["upcoming"] for e in b.events)  # the real capture is all planned work
    # every real outage matches an equipment row, so every event is pinned to a station
    assert all(any(r.startswith("subway_station:") for r in e.entity_refs) for e in b.events)


def test_real_sample_entity():
    b = parse_fixture(SID, module=MOD)
    e = next(x for x in b.entities if x.entity_id == "EL143")
    assert e.name == "125 St: Mezzanine to downtown platform"
    assert e.borough is None  # the feed's borough is blank
    assert e.props == {
        "equipmenttype": "EL",
        "elevatorsgtfsstopid": "A15",
        "stationcomplexid": "153",
        "ADA": True,
        "isactive": True,
    }


def test_real_sample_upcoming_outage():
    e = _event(parse_fixture(SID, module=MOD), "EL124:2026-12-17T03:00:00+00:00")
    assert e.title == "175 St: EL Mezzanine to platform for service in both directions."
    assert e.subtype == "EL"
    assert e.starts_at == datetime(2026, 12, 17, 3, 0, tzinfo=UTC)  # 12/16 10:00 PM EST
    assert e.entity_refs == ("elevator:EL124", "subway_station:A07")
    assert e.props == {
        "est_return": "2026-12-17T11:00:00+00:00",  # 12/17 06:00 AM EST
        "upcoming": True,
        "maintenance": False,
        "reason": "Planned Work",
        "serving": "Mezzanine to platform for service in both directions.",
        "ADA": True,
    }


def test_real_multi_station_equipment():
    e = _event(parse_fixture(SID, module=MOD), "EL779:2026-12-12T03:00:00+00:00")
    assert e.entity_refs == ("elevator:EL779", "subway_station:G29", "subway_station:L10")


def test_unmatched_current_and_bad_rows():
    b = parse_fixture(SID, "edge_unmatched_current", module=MOD)
    assert len(b.entities) == 8  # the row without equipmentno is skipped
    assert len(b.events) == 9  # bad date, blank equipment and the duplicate are skipped
    ids = {e.entity_id for e in b.entities}
    assert "EL142" not in ids and "EL123" in ids
    assert next(e for e in b.entities if e.entity_id == "EL123").props["isactive"] is False

    current = _event(b, "EL124:2026-11-14T12:15:00+00:00")  # 7:15 AM EST
    assert current.props["upcoming"] is False and current.props["maintenance"] is True
    assert current.props["est_return"] is None
    assert current.props["reason"] == "Repair"

    unmatched = _event(b, "EL142:2026-12-17T03:00:00+00:00")
    assert unmatched.entity_refs == ("elevator:EL142",)
    assert unmatched.title.startswith("125 St: EL 125 St & St Nicholas Ave")
    escalator = _event(b, "ES999:2026-12-17T03:00:00+00:00")
    assert escalator.subtype == "ES" and escalator.title == "Grand St: ES Street to mezzanine"
    assert escalator.entity_refs == ("elevator:ES999",)

    multi = _event(b, "EL123:2026-12-17T03:00:00+00:00")  # "A07, L01N"
    assert multi.entity_refs == ("elevator:EL123", "subway_station:A07", "subway_station:L01")
    assert _event(b, "EL783:2026-12-13T03:00:00+00:00").props["est_return"] is None  # "TBD"


def test_stop_ids_splits_and_strips():
    assert mta_elevators.stop_ids("232/423/R28") == ["232", "423", "R28"]
    assert mta_elevators.stop_ids("A31, L01N") == ["A31", "L01"]
    assert mta_elevators.stop_ids("") == []


def test_fetch_gets_outages_then_equipments():
    seen = []

    def handler(req):
        seen.append(str(req.url))
        # the real feed's broken Content-Type must not matter
        return httpx.Response(200, content=b"[]", headers={"Content-Type": "${header.s3FileType}"})

    http = Http("t", transport=httpx.MockTransport(handler), min_gap_s=0)
    src = load_registry().sources[SID]
    now = datetime(2026, 11, 14, 18, 0, tzinfo=UTC)
    raw = mta_elevators.fetch(FetchContext(src, http, None, now))
    assert [p.name for p in raw.parts] == ["outages", "equipments"]
    base = "https://api-endpoint.mta.info/Dataservice/mtagtfsfeeds/"
    assert seen == [base + "nyct%2Fnyct_ene.json", base + "nyct%2Fnyct_ene_equipments.json"]
    with pytest.raises(ValueError, match="empty"):
        mta_elevators.parse(raw)  # the mock bodies are empty: rejected, not "complete"

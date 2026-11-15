import json
from datetime import UTC, datetime

import httpx
import pytest
from helpers import load_fixture, parse_fixture

from nyclive.http import Http
from nyclive.model import PROPS_MAX_BYTES
from nyclive.registry import load_registry
from nyclive.sources import mta_alerts
from nyclive.sources.base import FetchContext

SID = "mta_subway_alerts"


def _by_id(batch, eid):
    return next(e for e in batch.events if e.event_id == eid)


def test_real_fixture():
    b = parse_fixture(SID, module="mta_alerts")
    assert len(b.events) == 25 and b.complete == frozenset({"events"})
    assert all(e.category == "service_alert" for e in b.events)
    assert all(e.ends_at is not None for e in b.events)  # every real period has an end
    assert sum(e.severity == 2 for e in b.events) == 3  # the three "Part Suspended"
    assert all(ref.startswith(("subway_route:", "subway_station:")) for ref in _refs(b))


def _refs(batch):
    return [r for e in batch.events for r in e.entity_refs]


def test_real_sample_delays():
    e = _by_id(parse_fixture(SID, module="mta_alerts"), "lmm:alert:276422:26")
    assert e.subtype == "Delays" and e.severity == 1
    assert e.title.startswith("Coney Island-Stillwell Av-bound [D][N] trains are running")
    assert "<" not in e.title  # the plain "en" translation, not "en-html"
    assert e.starts_at == datetime(2026, 11, 15, 2, 58, 37, tzinfo=UTC)
    assert e.ends_at == datetime(2026, 11, 15, 3, 15, tzinfo=UTC)
    assert e.entity_refs == ("subway_route:D", "subway_route:N")
    assert e.props == {
        "alert_type": "Delays",
        "active_periods": 1,
        "created_at": "2026-11-15T02:58:37+00:00",
        "updated_at": "2026-11-15T03:00:12+00:00",
        "description": None,
    }


def test_real_multi_period_part_suspended():
    e = _by_id(parse_fixture(SID, module="mta_alerts"), "lmm:planned_work:36463")
    assert e.subtype == "Planned - Part Suspended" and e.severity == 2
    assert e.props["active_periods"] == 2
    assert e.starts_at == datetime(2026, 12, 3, 4, 45, tzinfo=UTC)  # earliest start
    assert e.ends_at == datetime(2026, 12, 4, 10, 0, tzinfo=UTC)  # latest end
    assert e.entity_refs[0] == "subway_route:R"
    assert "subway_station:R30" in e.entity_refs
    assert list(e.entity_refs) == sorted(set(e.entity_refs))
    assert e.props["description"].startswith("[R] runs in Brooklyn")


def test_open_ended_periods_platform_ids_and_fallbacks():
    b = parse_fixture(SID, "edge_open_ended", module="mta_alerts")
    assert [e.event_id for e in b.events] == [
        "lmm:alert:276422:26",
        "lmm:planned_work:36463",
        "lmm:planned_work:36566",
        "edge:long_description",
    ]  # the duplicate id and the non-alert entity are skipped
    delays = _by_id(b, "lmm:alert:276422:26")
    assert delays.ends_at is None  # its only period lost its end
    part = _by_id(b, "lmm:planned_work:36463")
    assert part.ends_at is None  # one of two periods is open-ended
    assert part.starts_at == datetime(2026, 12, 3, 4, 45, tzinfo=UTC)
    assert "subway_station:R30" in part.entity_refs  # R30N / R30S stripped
    assert not any(r.endswith(("N", "S")) for r in part.entity_refs if "station" in r)
    assert part.entity_refs.count("subway_route:R") == 1
    notice = _by_id(b, "lmm:planned_work:36566")
    assert notice.props["active_periods"] == 0
    assert notice.starts_at == datetime(2026, 11, 13, 17, 16, 56, tzinfo=UTC)  # created_at
    assert notice.ends_at is None
    assert notice.severity == 2  # "No Trains Running"
    assert notice.entity_refs == ("subway_route:SI", "subway_station:S21")  # S21 is not S-stripped


def test_long_description_is_trimmed():
    e = _by_id(parse_fixture(SID, "edge_open_ended", module="mta_alerts"), "edge:long_description")
    size = len(json.dumps(e.props, ensure_ascii=False).encode("utf-8"))
    assert size <= PROPS_MAX_BYTES
    assert e.props["description"].endswith("…") and len(e.props["description"]) > 3000


def test_feed_without_entities_is_rejected_not_complete():
    """An empty feed would close every open alert; it is treated as a failed run instead."""
    with pytest.raises(ValueError, match="no alerts"):
        mta_alerts.parse(load_fixture(SID, "bad_empty"))


def test_station_id_strips_only_direction_suffix():
    assert mta_alerts.station_id("R30N") == "R30"
    assert mta_alerts.station_id("101S") == "101"
    assert mta_alerts.station_id("S21") == "S21"
    assert mta_alerts.station_id("A15") == "A15"


def test_fetch():
    seen = []

    def handler(req):
        seen.append(str(req.url))
        return httpx.Response(200, content=b'{"header":{},"entity":[]}')

    http = Http("t", transport=httpx.MockTransport(handler), min_gap_s=0)
    src = load_registry().sources[SID]
    now = datetime(2026, 11, 14, 18, 0, tzinfo=UTC)
    raw = mta_alerts.fetch(FetchContext(src, http, None, now))
    assert [p.name for p in raw.parts] == ["body"]
    assert seen == [
        "https://api-endpoint.mta.info/Dataservice/mtagtfsfeeds/camsys%2Fsubway-alerts.json"
    ]
    with pytest.raises(ValueError):
        mta_alerts.parse(raw)  # the mock body is an empty feed

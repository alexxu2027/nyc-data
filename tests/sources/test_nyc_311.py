import json
from datetime import UTC, datetime

import httpx
import pytest
from helpers import load_fixture, parse_fixture

from nyclive.http import Http
from nyclive.registry import load_registry
from nyclive.sources import nyc_311
from nyclive.sources.base import FetchContext, RawPart, RawPayload

SID = "nyc_311"
SELECT = (
    "unique_key,created_date,closed_date,agency,complaint_type,descriptor,status,borough,"
    "incident_zip,latitude,longitude,resolution_description"
)


def _parse(case="real"):
    return parse_fixture(SID, case, module="nyc_311")


def _by_id(batch, key):
    return next(e for e in batch.events if e.event_id == key)


def test_real_fixture_counts_and_cursor():
    b = _parse()
    assert len(b.events) == 60  # 30 new + 30 closed, no key in both
    assert b.complete == frozenset()
    assert all(e.category == "complaint_311" and e.severity == 0 for e in b.events)
    # newest created_date in new-000: 2026-11-13T02:05:34 EST
    assert b.cursor == "2026-11-13T07:05:34+00:00"


def test_real_sample_open_request():
    e = _by_id(_parse(), "71095931")
    assert e.title == "Noise - Residential: Loud Music/Party"
    assert e.subtype == "Noise - Residential"
    assert e.starts_at == datetime(2026, 11, 13, 7, 5, 34, tzinfo=UTC)
    assert e.ends_at is None
    assert e.borough == "QN"
    assert (e.lat, e.lon) == (40.67463754621075, -73.82237035039367)
    assert e.props == {
        "agency": "NYPD",
        "status": "In Progress",
        "descriptor": "Loud Music/Party",
        "incident_zip": "11420",
        "resolution": None,
    }


def test_real_sample_closed_request_and_trimmed_resolution():
    b = _parse()
    e = _by_id(b, "54304503")
    assert e.starts_at == datetime(2022, 5, 28, 18, 30, 51, tzinfo=UTC)  # EDT
    assert e.ends_at == datetime(2033, 3, 1, 5, 0, tzinfo=UTC)  # EST; the city's own date
    assert e.borough == "BK" and e.props["status"] == "Closed"
    assert e.props["resolution"].startswith("The City has removed the graffiti")
    assert max(len(e.props["resolution"] or "") for e in b.events) == 500  # one was 700


def test_real_missing_coordinates():
    e = _by_id(_parse(), "71092894")
    assert e.lat is None and e.lon is None
    assert e.borough == "MN" and e.props["incident_zip"] is None


def test_key_in_both_queries_keeps_the_closed_version():
    b = _parse("edge_overlap")
    assert len(b.events) == 60  # 62 rows, 2 keys appear twice
    a = _by_id(b, "71095931")  # open in new-000, closed copy in closed-000
    assert a.ends_at == datetime(2026, 11, 13, 10, 0, tzinfo=UTC)
    assert a.props["status"] == "Closed"
    stale = _by_id(b, "71096195")  # closed in closed-000, stale open copy in new-000
    assert stale.ends_at == datetime(2026, 11, 14, 3, 10, tzinfo=UTC)
    assert stale.props["status"] == "Closed" and stale.props["resolution"]
    assert b.cursor == _parse().cursor


def test_closed_before_created_keeps_event_without_end():
    e = _by_id(_parse("edge_bad_closed_date"), "71096195")
    assert e.starts_at == datetime(2026, 11, 13, 1, 5, tzinfo=UTC)
    assert e.ends_at is None
    assert e.props["bad_closed_date"] == "2026-11-11T20:05:00.000"
    assert "bad_closed_date" not in _by_id(_parse(), "71096195").props


def test_unspecified_borough_and_missing_coordinates():
    b = _parse("edge_unspecified_borough")
    e = _by_id(b, "71095931")
    assert e.borough is None and e.lat is not None
    e = _by_id(b, "71104214")
    assert e.lat is None and e.lon is None and e.borough == "MN"


def test_missing_query_or_error_object_is_malformed():
    real = load_fixture(SID)
    with pytest.raises(ValueError, match="closed-000"):
        nyc_311.parse(RawPayload(SID, (real.part("new-000"),)))
    err = RawPart("closed-000", "u", b'{"error": true, "message": "bad"}', real.fetched_at)
    with pytest.raises(ValueError, match="not a JSON list"):
        nyc_311.parse(RawPayload(SID, (real.part("new-000"), err)))


def test_empty_new_query_keeps_the_cursor():
    real = load_fixture(SID)
    empty = RawPart("new-000", "u", b"[]", real.fetched_at)
    b = nyc_311.parse(RawPayload(SID, (empty, real.part("closed-000")), cursor="2026-11-13T00:00Z"))
    assert len(b.events) == 30 and b.cursor == "2026-11-13T00:00Z"


NOW = datetime(2026, 11, 14, 18, 0, tzinfo=UTC)


def _fetch(cursor):
    seen = []

    def handler(req):
        seen.append(dict(req.url.params))
        return httpx.Response(200, content=json.dumps([{"unique_key": "1"}]).encode())

    http = Http("t", transport=httpx.MockTransport(handler), min_gap_s=0)
    raw = nyc_311.fetch(FetchContext(load_registry().sources[SID], http, cursor, NOW))
    return raw, seen


def test_fetch_first_run_looks_back_7_days():
    raw, seen = _fetch(None)
    assert [p.name for p in raw.parts] == ["new-000", "closed-000"]
    assert raw.source_id == SID and raw.cursor is None
    new, closed = seen
    assert all(p["$select"] == SELECT and p["$limit"] == "5000" for p in seen)
    assert new["$order"] == "created_date,:id"
    assert new["$where"] == "created_date > '2026-11-07T13:00:00.000'"  # now - 7 d, NY local
    assert closed["$order"] == "closed_date,:id"
    assert closed["$where"] == (
        "closed_date > '2026-11-04T13:00:00.000' AND created_date > '2026-10-15T14:00:00.000'"
    )  # (now - 7 d) - 3 d; now - 30 d is still EDT


def test_fetch_with_cursor():
    raw, seen = _fetch("2026-11-13T07:05:34+00:00")
    assert raw.cursor == "2026-11-13T07:05:34+00:00"
    new, closed = seen
    assert new["$where"] == "created_date > '2026-11-13T02:05:34.000'"
    assert closed["$where"] == (
        "closed_date > '2026-11-10T02:05:34.000' AND created_date > '2026-10-15T14:00:00.000'"
    )


def test_fetch_caps_each_query_at_5_pages():
    page = json.dumps([{"unique_key": str(i)} for i in range(5000)]).encode()
    seen = []

    def handler(req):
        seen.append(dict(req.url.params))
        return httpx.Response(200, content=page)

    http = Http("t", transport=httpx.MockTransport(handler), min_gap_s=0)
    raw = nyc_311.fetch(FetchContext(load_registry().sources[SID], http, None, NOW))
    names = [p.name for p in raw.parts]
    assert names == [f"new-00{i}" for i in range(5)] + [f"closed-00{i}" for i in range(5)]
    assert [p["$offset"] for p in seen[:5]] == ["0", "5000", "10000", "15000", "20000"]

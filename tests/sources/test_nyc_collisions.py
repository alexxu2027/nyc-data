import json
from datetime import UTC, datetime

import httpx
import pytest
from helpers import load_fixture, parse_fixture

from nyclive.http import Http
from nyclive.registry import load_registry
from nyclive.sources import nyc_collisions
from nyclive.sources.base import FetchContext, RawPart, RawPayload

SID = "nyc_collisions"


def _parse(case="real"):
    return parse_fixture(SID, case, module="nyc_collisions")


def _by_id(batch, prefix):
    return next(e for e in batch.events if e.event_id.startswith(prefix))


def test_real_fixture_counts_severity_and_cursor():
    b = _parse()
    assert len(b.events) == 30
    assert b.complete == frozenset()
    assert all(e.category == "collision" and e.ends_at == e.starts_at for e in b.events)
    # 20 rows with injuries, 10 without, none killed
    assert sorted(e.severity for e in b.events) == [1] * 10 + [2] * 20
    # newest crash: 2026-11-11 23:30 EST, which is the next day in UTC
    assert b.cursor == "2026-11-12T04:30:00+00:00"


def test_real_sample_collision():
    e = _by_id(_parse(), "1110bd45")
    assert e.title == "Collision, 1 injured" and e.severity == 2
    assert e.subtype == "Driver Inexperience"
    assert e.starts_at == datetime(2026, 11, 11, 15, 35, tzinfo=UTC)  # 10:35 EST
    assert e.borough == "BX"
    assert (e.lat, e.lon) == (40.81651, -73.88986)
    assert e.props["persons_injured"] == 1 and e.props["motorist_injured"] == 1
    assert e.props["persons_killed"] == 0
    assert e.props["vehicle_types"] == ["Station Wagon/Sport Utility Vehicle"]
    assert e.props["on_street_name"] == "BARRETTO ST"
    assert e.props["cross_street_name"] == "LAFAYETTE AVE"
    assert e.props["off_street_name"] is None


def test_real_no_injuries_zero_coords_and_missing_borough():
    b = _parse()
    calm = _by_id(b, "820a200c")
    assert calm.severity == 1 and calm.title == "Collision"
    for prefix in ("9b6c222d", "aa3acc49"):  # latitude/longitude "0"
        e = _by_id(b, prefix)
        assert e.lat is None and e.lon is None and e.props["off_street_name"]
    assert _by_id(b, "9db761ac").borough is None
    three = _by_id(b, "9b6c222d")
    assert three.props["vehicle_types"] == ["Tractor Trailer", "4 dr sedan"]


def test_killed_is_severity_3():
    b = _parse("edge_severity")
    a = _by_id(b, "820a200c")
    assert a.severity == 3 and a.title == "Collision, 1 killed"
    assert a.props["pedestrians_killed"] == 1
    c = _by_id(b, "a1269442")
    assert c.severity == 3 and c.title == "Collision, 1 killed, 2 injured"


def test_local_date_and_time_combine_across_dst():
    b = _parse("edge_dst")
    # repeated 1 AM hour on 2026-11-01 takes the first (EDT) occurrence
    assert _by_id(b, "1110bd45").starts_at == datetime(2026, 11, 1, 5, 30, tzinfo=UTC)
    # skipped 2 AM hour on 2026-03-08 is read with EST
    assert _by_id(b, "3f9057e7").starts_at == datetime(2026, 3, 8, 7, 30, tzinfo=UTC)
    # summer evening (EDT) lands on the next UTC day
    assert _by_id(b, "158b5470").starts_at == datetime(2026, 7, 5, 3, 30, tzinfo=UTC)
    # an untouched November row is EST
    assert _by_id(b, "820a200c").starts_at == datetime(2026, 11, 11, 6, 55, tzinfo=UTC)
    assert b.cursor == "2026-11-13T04:59:00+00:00"  # 2026-11-12 23:59 EST


def test_bad_rows():
    b = _parse("edge_bad_rows")
    assert len(b.events) == 29  # one row has no crash_time; the duplicate id is dropped
    assert not any(e.event_id.startswith("158b5470") for e in b.events)
    for prefix in ("1110bd45", "3f9057e7"):  # longitude missing; lat/lon swapped
        e = _by_id(b, prefix)
        assert e.lat is None and e.lon is None
    dup = [e for e in b.events if e.event_id.startswith("179a3fde")]
    assert len(dup) == 1 and dup[0].props["persons_injured"] == 1  # first copy wins


def test_error_object_is_malformed():
    real = load_fixture(SID)
    err = RawPart("page-000", "u", b'{"error": true}', real.fetched_at)
    with pytest.raises(ValueError, match="not a JSON list"):
        nyc_collisions.parse(RawPayload(SID, (err,)))


NOW = datetime(2026, 11, 14, 18, 0, tzinfo=UTC)


def _fetch(cursor, page=b"[]"):
    seen = []

    def handler(req):
        seen.append(dict(req.url.params))
        return httpx.Response(200, content=page)

    http = Http("t", transport=httpx.MockTransport(handler), min_gap_s=0)
    raw = nyc_collisions.fetch(FetchContext(load_registry().sources[SID], http, cursor, NOW))
    return raw, seen


def test_fetch_first_run_looks_back_14_days():
    raw, seen = _fetch(None)
    assert [p.name for p in raw.parts] == ["page-000"]
    (p,) = seen
    assert p["$where"] == "crash_date >= '2026-10-31T14:00:00.000'"  # now - 14 d, still EDT
    assert p["$order"] == "crash_date,:id" and p["$limit"] == "5000"
    cols = p["$select"].split(",")
    assert cols[:3] == ["collision_id", "crash_date", "crash_time"]
    assert {"latitude", "longitude", "borough", "contributing_factor_vehicle_1"} <= set(cols)
    assert {"number_of_persons_killed", "vehicle_type_code_3", "off_street_name"} <= set(cols)


def test_fetch_relooks_10_days_behind_cursor():
    raw, seen = _fetch("2026-11-12T04:30:00+00:00")
    assert raw.cursor == "2026-11-12T04:30:00+00:00"
    assert seen[0]["$where"] == "crash_date >= '2026-11-01T23:30:00.000'"  # EST


def test_fetch_caps_at_5_pages():
    page = json.dumps([{"collision_id": str(i)} for i in range(5000)]).encode()
    raw, seen = _fetch(None, page)
    assert [p.name for p in raw.parts] == [f"page-00{i}" for i in range(5)]
    assert [p["$offset"] for p in seen] == ["0", "5000", "10000", "15000", "20000"]


def test_future_dated_row_cannot_push_cursor_past_fetch_time():
    """Review finding 9: a typo'd future crash_date would otherwise stall the cursor."""
    import json
    from dataclasses import replace

    from nyclive.sources import nyc_collisions

    raw = load_fixture("nyc_collisions")
    rows = json.loads(raw.part("page-000").content)
    rows[0]["crash_date"] = "2099-01-01T00:00:00.000"
    raw = replace(raw, parts=(replace(raw.part("page-000"), content=json.dumps(rows).encode()),))
    b = nyc_collisions.parse(raw)
    assert b.cursor <= raw.fetched_at.isoformat()

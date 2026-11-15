import json
from datetime import UTC, datetime

import httpx
from helpers import parse_fixture

from nyclive.http import Http
from nyclive.model import PROPS_MAX_BYTES
from nyclive.registry import load_registry
from nyclive.sources import floodnet
from nyclive.sources.base import FetchContext

SENSORS = "floodnet_sensors"
EVENTS = "floodnet_events"
NOW = datetime(2026, 11, 14, 18, 0, tzinfo=UTC)
DITMARS = "BX-ditmars-st-hunter-ave-1kwrk0"
BEACH_84 = "Q-beach-84-st-0me680"


def _event(batch, event_id):
    return next(e for e in batch.events if e.event_id == event_id)


def _size(props):
    return len(json.dumps(props, ensure_ascii=False).encode("utf-8"))


# ----------------------------------------------------------------------------- sensors
def test_real_sensors_are_a_complete_entity_set():
    b = parse_fixture(SENSORS, module="floodnet")
    assert b.complete == frozenset({"entities"}) and b.cursor is None
    assert len(b.entities) == 40 and not b.events and not b.observations
    assert all(e.kind == "flood_sensor" and e.borough == "BK" for e in b.entities)
    e = b.entities[0]
    assert e.entity_id == "BK-10th-ave-76th-st-1umos0" and e.name == "BK - 76th St/10th Ave"
    assert (e.lat, e.lon) == (40.623751, -74.014499)
    assert e.props == {
        "tidally_influenced": False,
        "nta": "BK1002",
        "lowest_point_height_delta_inches": 24.13,
        "date_installed": "2024-04-18T00:00:00.000",
    }
    assert all(isinstance(x.props["tidally_influenced"], bool) for x in b.entities)
    assert all(isinstance(x.props["lowest_point_height_delta_inches"], float) for x in b.entities)


def test_sensor_odd_values():
    b = parse_fixture(SENSORS, "edge_odd_values", module="floodnet")
    assert len(b.entities) == 4  # no sensor_id skipped, duplicate id dropped
    a, no_coords, unknown, dup = b.entities
    assert a.props["tidally_influenced"] is True and a.borough == "QN"
    assert no_coords.lat is None and no_coords.lon is None
    assert "lowest_point_height_delta_inches" not in no_coords.props
    assert unknown.borough is None and "nta" not in unknown.props
    assert dup.name != "duplicate of the previous row"


# ------------------------------------------------------------------------------ events
def test_real_events_mapping():
    b = parse_fixture(EVENTS, module="floodnet")
    assert b.complete == frozenset() and len(b.events) == 30
    assert all(e.category == "flood" for e in b.events)
    e = _event(b, f"{DITMARS}:2026-10-26T14:43:29.000")
    assert e.entity_refs == (f"flood_sensor:{DITMARS}",) and e.borough == "BX"
    # floating times read as NY local (EDT, UTC-4); UNVERIFIED for FloodNet
    assert e.starts_at == datetime(2026, 10, 26, 18, 43, 29, tzinfo=UTC)
    assert e.ends_at == datetime(2026, 10, 26, 22, 5, 50, tzinfo=UTC)
    assert e.severity == 2 and e.title == "Flooding at BX - Ditmars St/Hunter Ave 2, 5.16 in"
    p = e.props
    assert (p["max_depth_inches"], p["onset_mins"], p["drain_mins"], p["duration_mins"]) == (
        5.16,
        92.99,
        109.36,
        202.35,
    )
    assert len(p["profile_depth_inches"]) == len(p["profile_time_secs"]) == 199
    assert "profile_dropped" not in p


def test_real_events_cursor_is_newest_start_utc():
    b = parse_fixture(EVENTS, module="floodnet")
    assert b.cursor == "2026-10-26T18:43:29+00:00"


def test_real_long_profile_is_dropped():
    b = parse_fixture(EVENTS, module="floodnet")
    e = _event(b, f"{BEACH_84}:2026-10-24T10:05:39.000")  # 399 points
    assert e.props["profile_dropped"] is True and "profile_depth_inches" not in e.props
    assert e.props["max_depth_inches"] == 4.45
    assert all(_size(x.props) <= PROPS_MAX_BYTES for x in b.events)


def test_severity_thresholds_and_missing_end():
    b = parse_fixture(EVENTS, "edge_thresholds_missing_end", module="floodnet")
    assert [e.severity for e in b.events] == [3, 2, 1, 1]
    no_end = b.events[2]
    assert no_end.event_id == "Q-brookville-blvd-rockaway-blvd-1-23ndo0:2026-10-24T12:22:29.000"
    assert no_end.ends_at is None
    assert b.events[3].ends_at is None  # end before start
    assert b.events[0].ends_at is not None
    assert b.cursor == "2026-10-25T15:34:20+00:00"


def test_long_profile_dropped_and_bad_profile_omitted():
    b = parse_fixture(EVENTS, "edge_long_profile", module="floodnet")
    kept, long, bad = b.events
    assert len(kept.props["profile_depth_inches"]) == 199
    assert long.props["profile_dropped"] is True and "profile_time_secs" not in long.props
    assert _size(long.props) <= PROPS_MAX_BYTES
    assert "profile_dropped" not in bad.props and "profile_depth_inches" not in bad.props
    assert b.cursor == "2026-10-27T05:00:00+00:00"


def test_empty_page_keeps_cursor():
    b = parse_fixture(EVENTS, "edge_empty_keeps_cursor", module="floodnet")
    assert len(b) == 0 and b.cursor == "2026-10-26T18:43:29+00:00"


# ------------------------------------------------------------------------------- fetch
def _ctx(sid, handler, cursor=None):
    http = Http("t", transport=httpx.MockTransport(handler), min_gap_s=0)
    return FetchContext(load_registry().sources[sid], http, cursor, NOW)


def test_fetch_sensors_all_columns_ordered_by_id():
    seen = []

    def handler(req):
        seen.append(req)
        return httpx.Response(200, content=b'[{"sensor_id":"x"}]')

    raw = floodnet.fetch(_ctx(SENSORS, handler))
    assert [p.name for p in raw.parts] == ["page-000"]
    (req,) = seen
    assert str(req.url.copy_with(query=None)) == floodnet.SENSORS_URL
    p = dict(req.url.params)
    assert p["$order"] == "sensor_id,:id" and p["$offset"] == "0" and "$where" not in p
    assert p["$select"].split(",")[:2] == ["sensor_id", "sensor_name"]


def test_fetch_events_first_run_and_with_cursor():
    seen = []

    def handler(req):
        seen.append(dict(req.url.params))
        return httpx.Response(200, content=b"[]")

    raw = floodnet.fetch(_ctx(EVENTS, handler))
    assert [p.name for p in raw.parts] == ["page-000"] and raw.cursor is None
    first = seen[0]
    # now - 90 days = 2026-08-16T18:00Z = 14:00 EDT
    assert first["$where"] == "flood_start_time > '2026-08-16T14:00:00.000'"
    assert first["$order"] == "flood_start_time,:id"
    assert first["$select"] == ",".join(floodnet.EVENT_COLUMNS)
    assert first["$limit"] == "5000"

    raw = floodnet.fetch(_ctx(EVENTS, handler, cursor="2026-10-26T18:43:29+00:00"))
    assert raw.cursor == "2026-10-26T18:43:29+00:00"
    # cursor - 30 days = 2026-09-26T18:43:29Z = 14:43:29 EDT
    assert seen[1]["$where"] == "flood_start_time > '2026-09-26T14:43:29.000'"


def test_fetch_events_page_cap():
    full = json.dumps([{}] * 5000).encode()
    seen = []

    def handler(req):
        seen.append(req.url.params["$offset"])
        return httpx.Response(200, content=full)

    raw = floodnet.fetch(_ctx(EVENTS, handler))
    assert [p.name for p in raw.parts] == [f"page-{i:03d}" for i in range(5)]
    assert seen == ["0", "5000", "10000", "15000", "20000"]

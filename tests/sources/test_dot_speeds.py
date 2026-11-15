import json
import re
from datetime import UTC, datetime

import httpx
import pytest
from helpers import parse_fixture

from nyclive.http import Http
from nyclive.model import NYC_BBOX
from nyclive.registry import load_registry
from nyclive.sources import dot_speeds
from nyclive.sources.base import FetchContext

SID = "dot_traffic_speeds"
MOD = "dot_speeds"


def _parse(case="real"):
    return parse_fixture(SID, case, module=MOD)


def _points(wkt):
    m = re.fullmatch(r"LINESTRING \((.+)\)", wkt)
    assert m, wkt
    return [tuple(float(v) for v in pair.split()) for pair in m.group(1).split(", ")]


def _obs(batch, link_id, metric):
    return sorted(
        (o for o in batch.observations if o.entity_id == link_id and o.metric == metric),
        key=lambda o: o.observed_at,
    )


def test_decoder_matches_google_example():
    assert dot_speeds.decode_polyline("_p~iF~ps|U_ulLnnqC_mqNvxq`@") == [
        (38.5, -120.2),
        (40.7, -120.95),
        (43.252, -126.453),
    ]


@pytest.mark.parametrize("bad", ["_p~iF~ps|U_ulL", "_p~iF~ps|U_ulLnnqC_mqNvxq", "ab c"])
def test_decoder_rejects_malformed(bad):
    with pytest.raises(ValueError):
        dot_speeds.decode_polyline(bad)


def test_real_fixture_mapping():
    b = _parse()
    assert b.complete == frozenset()
    assert len(b.entities) == 40  # 40 rows, 40 distinct links
    assert all(e.kind == "road_segment" for e in b.entities)
    e = next(e for e in b.entities if e.entity_id == "4362250")
    assert e.name == "CVE NB GCP - WILLETS PT BLVD"
    assert e.borough == "QN"
    assert e.props == {"owner": "NYC-DOT-Region 10"}
    pts = _points(e.geometry_wkt)
    assert pts[0] == (-73.79019, 40.78795)  # lon lat order (Willets Point)
    assert (e.lon, e.lat) == pts[len(pts) // 2]  # middle vertex
    assert {x.borough for x in b.entities} == {"MN", "BK", "QN", "BX", "SI"}

    # cursor = newest data_as_of (20:42:05 EST)
    assert b.cursor == "2026-11-15T01:42:05+00:00"
    speed = _obs(b, "4362250", "speed_mph")
    assert [(o.observed_at, o.value) for o in speed] == [
        (datetime(2026, 11, 15, 1, 42, 5, tzinfo=UTC), 21.12)
    ]
    assert _obs(b, "4362250", "travel_time_s")[0].value == 778.0


def test_real_geometry_is_lon_lat_inside_nyc():
    b = _parse()
    min_lat, min_lon, max_lat, max_lon = NYC_BBOX
    with_geom = [e for e in b.entities if e.geometry_wkt]
    # the published "\\|" escape is undone; only 4362244 (truncated polyline) has no geometry
    assert len(with_geom) == 39
    for e in with_geom:
        for lon, lat in _points(e.geometry_wkt):
            assert min_lon <= lon <= max_lon and min_lat <= lat <= max_lat, e.entity_id


def test_truncated_polyline_still_writes_observations():
    b = _parse()
    e = next(e for e in b.entities if e.entity_id == "4362244")
    assert (e.geometry_wkt, e.lat, e.lon) == (None, None, None)
    assert _obs(b, "4362244", "speed_mph")[0].value == 52.19


def test_negative_status_rows_give_no_observations():
    b = _parse()
    # 13 rows have status -101 with speed 0 and travel_time 0 (no reading)
    assert len(b.observations) == (40 - 13) * 2
    assert any(e.entity_id == "4329473" for e in b.entities)
    assert not _obs(b, "4329473", "speed_mph")


def test_bad_polylines_give_no_geometry_but_observations():
    b = _parse("edge_bad_polylines")
    assert sorted(e.entity_id for e in b.entities) == ["4362250", "4362314", "4362342"]
    for e in b.entities:
        assert (e.geometry_wkt, e.lat, e.lon) == (None, None, None), e.entity_id
    assert len(b.observations) == 6


def test_link_twice_in_one_payload():
    b = _parse("edge_two_snapshots")
    assert sorted(e.entity_id for e in b.entities) == ["4362250", "4362314"]
    a = next(e for e in b.entities if e.entity_id == "4362250")
    assert a.name == "CVE NB GCP - WILLETS PT BLVD"  # newest row wins, not "OLD NAME"
    assert [o.value for o in _obs(b, "4362250", "speed_mph")] == [30.5, 21.12]
    assert [o.value for o in _obs(b, "4362250", "travel_time_s")] == [540.0, 778.0]
    # identical observed_at: one observation per metric
    assert len(_obs(b, "4362314", "speed_mph")) == 1
    assert len(b.observations) == 6
    assert b.cursor == "2026-11-15T01:42:05+00:00"


def test_fetch_where_select_order_and_page_cap():
    seen = []

    def handler(req):
        seen.append(dict(req.url.params))
        return httpx.Response(200, content=json.dumps([{}] * 5000).encode())

    http = Http("t", transport=httpx.MockTransport(handler), min_gap_s=0)
    src = load_registry().sources[SID]
    now = datetime(2026, 11, 14, 18, 0, tzinfo=UTC)

    raw = dot_speeds.fetch(FetchContext(src, http, None, now))
    assert [p.name for p in raw.parts] == [f"page-{i:03d}" for i in range(5)]
    assert len(seen) == 5 and seen[-1]["$offset"] == "20000"
    first = seen[0]
    assert first["$where"] == "data_as_of > '2026-11-14T09:00:00.000'"  # now - 4 h, NY local
    assert first["$select"] == (
        "link_id,speed,travel_time,status,data_as_of,borough,link_name,encoded_poly_line,owner"
    )
    assert first["$order"] == "data_as_of,:id"
    assert first["$limit"] == "5000"
    assert raw.cursor is None

    seen.clear()
    raw = dot_speeds.fetch(FetchContext(src, http, "2026-11-15T01:42:05+00:00", now))
    assert seen[0]["$where"] == "data_as_of > '2026-11-14T20:27:05.000'"  # cursor - 15 min overlap
    assert raw.cursor == "2026-11-15T01:42:05+00:00"

from datetime import UTC, datetime

import httpx
from helpers import parse_fixture

from nyclive.http import Http
from nyclive.registry import load_registry
from nyclive.sources import openmeteo
from nyclive.sources.base import FetchContext

SID = "openmeteo_current"


def test_real_fixture():
    b = parse_fixture(SID, module="openmeteo")
    assert b.complete == frozenset({"entities"})
    assert [e.entity_id for e in b.entities] == ["MN", "BK", "QN", "BX", "SI"]
    mn = b.entities[0]
    assert (mn.kind, mn.name, mn.borough) == ("weather_point", "Manhattan", "MN")
    assert (mn.lat, mn.lon) == (40.7831, -73.9712)  # request point, not the grid point
    assert mn.props["grid_lat"] == 40.78858 and mn.props["grid_lon"] == -73.9661
    assert len(b.observations) == 5 * 4
    observed = datetime(2026, 11, 15, 3, 15, tzinfo=UTC)  # current.time 1794712500
    assert {o.observed_at for o in b.observations} == {observed}
    bk = {o.metric: o.value for o in b.observations if o.entity_id == "BK"}
    assert bk == {"temp_c": 4.2, "precip_mm": 0.0, "rain_mm": 0.0, "wind_kmh": 10.9}
    fetched = datetime.fromisoformat("2026-11-15T03:20:28.191763+00:00")
    assert {o.fetched_at for o in b.observations} == {fetched}


def test_missing_values_are_skipped():
    b = parse_fixture(SID, "edge_missing_values", module="openmeteo")
    assert len(b.entities) == 5  # SI without a current block still has its entity
    by_point = {}
    for o in b.observations:
        by_point.setdefault(o.entity_id, set()).add(o.metric)
    assert "precip_mm" not in by_point["BK"] and "rain_mm" in by_point["BK"]
    assert "wind_kmh" not in by_point["BX"]
    assert "SI" not in by_point
    assert len(b.observations) == 20 - 4 - 1 - 1


def test_fetch_requests_five_points_in_one_call():
    seen = []

    def handler(req):
        seen.append((str(req.url.copy_with(query=None)), dict(req.url.params)))
        return httpx.Response(200, content=b"[]")

    http = Http("t", transport=httpx.MockTransport(handler), min_gap_s=0)
    src = load_registry().sources[SID]
    now = datetime(2026, 11, 14, 18, 0, tzinfo=UTC)
    raw = openmeteo.fetch(FetchContext(src, http, None, now))
    assert [p.name for p in raw.parts] == ["body"]
    assert raw.parts[0].fetched_at == now
    url, params = seen[0]
    assert len(seen) == 1 and url == "https://api.open-meteo.com/v1/forecast"
    assert params == {
        "latitude": "40.7831,40.6782,40.7282,40.8448,40.5795",
        "longitude": "-73.9712,-73.9442,-73.7949,-73.8648,-74.1502",
        "current": "temperature_2m,precipitation,rain,wind_speed_10m",
        "timeformat": "unixtime",
    }

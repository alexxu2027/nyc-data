from datetime import UTC, datetime

import httpx
from helpers import parse_fixture

from nyclive.http import Http
from nyclive.registry import load_registry
from nyclive.sources import mta_stations
from nyclive.sources.base import FetchContext

SID = "mta_subway_stations"


def test_real_fixture():
    b = parse_fixture(SID, module="mta_stations")
    assert len(b.entities) == 40 and b.complete == frozenset({"entities"})
    assert not b.events and not b.observations
    assert all(e.kind == "subway_station" and e.lat is not None for e in b.entities)
    assert {e.borough for e in b.entities} == {"MN", "BK", "QN"}
    first = b.entities[0]
    assert (first.entity_id, first.name) == ("R01", "Astoria-Ditmars Blvd")
    assert (first.lat, first.lon) == (40.775036, -73.912034)
    assert first.borough == "QN"
    assert first.props == {
        "complex_id": "1",
        "station_id": "1",
        "line": "Astoria",
        "division": "BMT",
        "daytime_routes": "N W",
        "structure": "Elevated",
        "ada": 0,
    }


def test_bad_rows():
    b = parse_fixture(SID, "edge_bad_rows", module="mta_stations")
    e = {x.entity_id: x for x in b.entities}
    assert len(b.entities) == 8  # the id-less row and the duplicate R01 are skipped
    assert e["R01"].name == "Astoria-Ditmars Blvd"  # first R01 kept
    assert e["R03"].borough == "BX" and e["R04"].borough == "SI"
    assert e["R05"].borough is None
    assert (e["R06"].lat, e["R06"].lon) == (None, None)
    assert "ada" not in e["R08"].props
    assert e["R11"].name == "R11"


def test_fetch():
    seen = []

    def handler(req):
        seen.append(req)
        return httpx.Response(200, content=b"[]")

    http = Http("t", transport=httpx.MockTransport(handler), min_gap_s=0)
    src = load_registry().sources[SID]
    now = datetime(2026, 11, 14, 18, 0, tzinfo=UTC)
    raw = mta_stations.fetch(FetchContext(src, http, None, now))
    assert [p.name for p in raw.parts] == ["body"]
    (req,) = seen
    assert str(req.url.copy_with(query=None)) == "https://data.ny.gov/resource/39hk-dx4f.json"
    assert dict(req.url.params) == {"$limit": "5000"}
    assert len(mta_stations.parse(raw)) == 0

import httpx
from helpers import parse_fixture

from nyclive.http import Http
from nyclive.registry import load_registry
from nyclive.sources import dot_cameras
from nyclive.sources.base import FetchContext


def test_real_fixture():
    b = parse_fixture("dot_cameras", module="dot_cameras")
    assert len(b.entities) == 40 and b.complete == frozenset({"entities"})
    first = b.entities[0]
    assert first.kind == "camera" and first.borough == "QN"
    assert first.props["isOnline"] is True and first.props["imageUrl"].endswith("/image")
    assert all(e.lat is not None for e in b.entities)


def test_bad_rows():
    b = parse_fixture("dot_cameras", "edge_bad_rows", module="dot_cameras")
    e = b.entities
    assert len(e) == 40  # the id-less row is skipped
    assert (e[0].lat, e[0].lon) == (None, None)
    assert e[1].props["isOnline"] is False
    assert e[2].borough is None
    assert e[3].name == e[3].entity_id
    assert (e[4].lat, e[4].lon) == (None, None)


def test_fetch():
    seen = []

    def handler(req):
        seen.append(str(req.url))
        return httpx.Response(200, content=b"[]")

    http = Http("t", transport=httpx.MockTransport(handler), min_gap_s=0)
    from datetime import UTC, datetime

    src = load_registry().sources["dot_cameras"]
    raw = dot_cameras.fetch(FetchContext(src, http, None, datetime(2026, 1, 1, tzinfo=UTC)))
    assert [p.name for p in raw.parts] == ["body"] and seen == [dot_cameras.URL]

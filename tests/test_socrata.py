import json
from datetime import UTC, datetime

import httpx

from nyclive.http import Http
from nyclive.registry import load_registry
from nyclive.sources import _socrata
from nyclive.sources.base import FetchContext

NOW = datetime(2026, 11, 14, 18, 0, tzinfo=UTC)


def ctx(handler, cursor=None):
    http = Http("t", transport=httpx.MockTransport(handler), min_gap_s=0)
    return FetchContext(load_registry().sources["nyc_311"], http, cursor, NOW)


def test_floating_is_ny_local():
    assert (
        _socrata.floating(datetime(2026, 11, 14, 23, 12, 6, tzinfo=UTC))
        == "2026-11-14T18:12:06.000"
    )
    assert _socrata.floating(datetime(2026, 7, 1, 4, 0, tzinfo=UTC)) == "2026-07-01T00:00:00.000"


def test_pages_until_short_page_and_params():
    seen = []

    def handler(req):
        p = dict(req.url.params)
        seen.append(p)
        n = 2 if p["$offset"] == "0" else 1
        return httpx.Response(
            200, content=json.dumps([{"i": int(p["$offset"]) + k} for k in range(n)]).encode()
        )

    c = ctx(handler)
    parts = _socrata.fetch_pages(
        c,
        "https://data.cityofnewyork.us/resource/x.json",
        select=["a", "b"],
        order="created_date",
        where="a > 1",
        prefix="new",
        page_size=2,
    )
    assert [p.name for p in parts] == ["new-000", "new-001"]
    assert seen[0] == {
        "$select": "a,b",
        "$order": "created_date,:id",
        "$limit": "2",
        "$where": "a > 1",
        "$offset": "0",
    }
    raw = _socrata.payload(c, parts)
    assert [r["i"] for r in _socrata.rows(raw, "new")] == [0, 1, 2]


def test_page_cap():
    def handler(req):
        return httpx.Response(200, content=b'[{"x":1}]')

    parts = _socrata.fetch_pages(
        ctx(handler), "https://x/y.json", select=["x"], order="x", page_size=1, max_pages=3
    )
    assert len(parts) == 3

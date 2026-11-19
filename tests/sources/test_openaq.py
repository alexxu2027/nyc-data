"""OpenAQ air quality stations (openaq_nyc), ADR-018."""

import json
from datetime import UTC, datetime, timedelta

import pytest
from helpers import load_fixture, parse_fixture

from nyclive.registry import load_registry
from nyclive.sources import openaq
from nyclive.sources.base import FetchContext, RawPayload

SID = "openaq_nyc"


def test_real_stations_and_readings():
    raw = load_fixture(SID)
    batch = parse_fixture(SID)
    listed = raw.json("locations")["results"]
    assert len(batch.entities) == len(listed)  # stale ones too: they're still stations
    monitors = [e for e in batch.entities if e.props["monitor"]]
    low_cost = [e for e in batch.entities if not e.props["monitor"]]
    assert monitors and low_cost
    assert {e.props["provider"] for e in monitors} == {"AirNow"}
    assert all(e.kind == "air_sensor" for e in batch.entities)
    fetched = {p.name.removeprefix("latest-") for p in raw.parts if p.name != "locations"}
    assert {o.entity_id for o in batch.observations} <= fetched
    assert "pm25_ugm3" in {o.metric for o in batch.observations}
    keys = [(o.entity_id, o.metric) for o in batch.observations]
    assert len(keys) == len(set(keys))  # one reading per station and metric
    assert all(o.value >= 0 for o in batch.observations)


def test_saved_urls_carry_no_key():
    for p in load_fixture(SID).parts:
        assert p.url.startswith(openaq.API) and "key" not in p.url.lower()


def test_odd_readings():
    batch = parse_fixture(SID, "edge_odd_readings")
    raw = load_fixture(SID, "edge_odd_readings")
    first = str(raw.json("locations")["results"][0]["id"])
    got = {o.metric: o.value for o in batch.observations if o.entity_id == first}
    assert got == {"o3_ppm": 0.041}  # pm25 -3 dropped, humidity ignored, 2099 NO2 dropped
    ids = {e.entity_id for e in batch.entities}
    assert "999001" not in ids  # mobile
    assert "123456789" not in {o.entity_id for o in batch.observations}  # orphan latest part


def test_bad_locations_raise():
    with pytest.raises(ValueError, match="no results"):
        openaq.parse(load_fixture(SID, "bad_no_results"))


def test_wrong_source_raises():
    with pytest.raises(ValueError, match="does not serve"):
        openaq.parse(RawPayload("nws_alerts", load_fixture(SID).parts))


def _loc(i, last, mobile=False, params=("pm25",)):
    units = {"pm25": "µg/m³", "relativehumidity": "%"}
    return {
        "id": i, "isMobile": mobile, "datetimeLast": {"utc": last},
        "sensors": [{"id": i * 10 + n, "parameter": {"name": p, "units": units[p]}}
                    for n, p in enumerate(params)],
    }  # fmt: skip


def test_to_fetch_skips_mobile_old_and_unusable():
    now = datetime(2026, 11, 19, 1, 0, tzinfo=UTC)
    recent = (now - timedelta(hours=2)).isoformat()
    old = (now - timedelta(days=3)).isoformat()
    locs = [
        _loc(1, recent), _loc(2, old), _loc(3, recent, mobile=True),
        _loc(4, recent, params=("relativehumidity",)), {"id": 5},
    ]  # fmt: skip
    assert [x["id"] for x in openaq.to_fetch(locs, now)] == [1]


def test_fetch_lists_then_asks_each_live_station():
    now = datetime(2026, 11, 19, 1, 0, tzinfo=UTC)
    body = {
        "results": [
            _loc(1, (now - timedelta(hours=1)).isoformat()),
            _loc(2, "2020-01-01T00:00:00Z"),
        ]
    }

    class Http:
        def __init__(self):
            self.urls = []

        def get(self, url, **kw):
            self.urls.append(url)
            content = json.dumps(body if "bbox" in url else {"results": []}).encode()
            return type("R", (), {"content": content, "json": lambda s: json.loads(content)})()

    http = Http()
    raw = openaq.fetch(FetchContext(load_registry().sources[SID], http, None, now))
    assert http.urls == [openaq.LOCATIONS_URL, openaq.latest_url(1)]
    assert [p.name for p in raw.parts] == ["locations", "latest-1"]

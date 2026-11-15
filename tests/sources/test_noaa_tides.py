from datetime import UTC, datetime

import httpx
from helpers import parse_fixture

from nyclive.http import Http
from nyclive.registry import load_registry
from nyclive.sources import noaa_tides
from nyclive.sources.base import FetchContext


def test_real_fixture():
    b = parse_fixture("noaa_tide_battery")
    assert [e.entity_id for e in b.entities] == ["8518750"]
    metrics = {o.metric for o in b.observations}
    assert metrics == {"water_level_ft", "predicted_ft"}
    levels = [o for o in b.observations if o.metric == "water_level_ft"]
    assert b.cursor == max(o.observed_at for o in levels).isoformat()
    assert all(o.observed_at.tzinfo is UTC for o in b.observations)


def test_no_data_is_an_empty_batch_and_keeps_cursor():
    b = parse_fixture("noaa_tide_battery", "edge_no_data")
    assert len(b) == 0
    assert b.cursor is None  # real fixture was captured on a first run


def test_blank_value_is_skipped():
    real = parse_fixture("noaa_tide_battery")
    blank = parse_fixture("noaa_tide_battery", "edge_blank_value")
    n = sum(o.metric == "water_level_ft" for o in real.observations)
    assert sum(o.metric == "water_level_ft" for o in blank.observations) == n - 1


def test_fetch_uses_cursor_and_caps_lookback():
    seen = []

    def handler(req):
        seen.append(dict(req.url.params))
        return httpx.Response(200, content=b"{}")

    http = Http("t", transport=httpx.MockTransport(handler), min_gap_s=0)
    src = load_registry().sources["noaa_tide_battery"]
    now = datetime(2026, 11, 14, 18, 0, tzinfo=UTC)
    raw = noaa_tides.fetch(FetchContext(src, http, "2026-11-14T17:00:00+00:00", now))
    assert [p.name for p in raw.parts] == ["levels", "predictions"]
    assert seen[0]["begin_date"] == "20261114 17:00" and seen[0]["time_zone"] == "gmt"
    noaa_tides.fetch(FetchContext(src, http, "2026-01-01T00:00:00+00:00", now))
    assert seen[2]["begin_date"] == "20261111 18:00"  # capped at 3 days back

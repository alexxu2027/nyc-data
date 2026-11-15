import json
from datetime import UTC, datetime

import httpx
from helpers import parse_fixture

from nyclive.http import Http
from nyclive.model import PROPS_MAX_BYTES
from nyclive.registry import load_registry
from nyclive.sources import nws_alerts
from nyclive.sources.base import FetchContext

SID = "nws_alerts"
PREFIX = "urn:oid:2.49.0.1.840.0."


def _by_suffix(batch, suffix):
    return next(e for e in batch.events if e.event_id.endswith(suffix))


def test_real_fixture_keeps_only_nyc_alerts():
    b = parse_fixture(SID, module="nws_alerts")
    assert b.complete == frozenset({"events"})
    # 40 NY features, 14 touch NYC; 3 of those are EXP statements with ends < onset (skipped)
    assert len(b.events) == 11
    assert all(e.event_id.startswith(PREFIX) for e in b.events)
    assert all(e.category == "weather_alert" for e in b.events)
    assert not any(e.event_id.endswith("4eb1432631ead1.001.1") for e in b.events)


def test_real_sample_tornado_warning():
    e = _by_suffix(parse_fixture(SID, module="nws_alerts"), "de01fcd82d28ef.001.1")
    assert e.subtype == "Tornado Warning" and e.severity == 3
    assert e.title.startswith("Tornado Warning issued November 12")
    assert e.starts_at == datetime(2026, 11, 12, 18, 56, tzinfo=UTC)  # onset 13:56 EST
    assert e.ends_at == datetime(2026, 11, 12, 19, 0, tzinfo=UTC)  # ends 14:00 EST
    assert e.borough == "QN"
    assert e.geometry_wkt.startswith("POLYGON ((") and e.geometry_wkt.endswith("))")
    assert e.props["nyc_same"] == ["036081"]
    assert e.props["sender_name"] == "NWS Upton NY"
    assert {"areaDesc", "urgency", "certainty", "severity", "status", "messageType"} <= set(e.props)


def test_real_multi_borough_and_zone_alerts():
    b = parse_fixture(SID, module="nws_alerts")
    flood = _by_suffix(b, "57f1a30e160a8a.001.1")
    assert flood.borough is None and len(flood.props["nyc_same"]) == 5
    assert flood.severity == 1
    coastal = _by_suffix(b, "85f1bab816e350.003.1")  # zone-based, no geometry
    assert coastal.geometry_wkt is None
    assert coastal.props["nyc_same"] == ["036047", "036061", "036081", "036085"]


def test_empty_feed_is_a_complete_empty_batch():
    b = parse_fixture(SID, "edge_empty", module="nws_alerts")
    assert len(b) == 0 and b.complete == frozenset({"events"})


def test_missing_ends_falls_back_to_expires_then_none():
    b = parse_fixture(SID, "edge_no_ends", module="nws_alerts")
    assert len(b.events) == 2  # the Otsego feature is outside NYC
    tornado = _by_suffix(b, "de01fcd82d28ef.001.1")
    assert tornado.ends_at == datetime(2026, 11, 12, 19, 5, tzinfo=UTC)  # expires 14:05 EST
    flash = _by_suffix(b, "6ed8b6b08aed83.001.1")
    assert flash.ends_at is None


def test_long_text_is_trimmed_and_multipolygon_kept():
    (e,) = parse_fixture(SID, "edge_long_text_multipolygon", module="nws_alerts").events
    size = len(json.dumps(e.props, ensure_ascii=False).encode("utf-8"))
    assert size <= PROPS_MAX_BYTES
    assert e.props["description"].endswith("…") and len(e.props["description"]) > 1000
    assert e.geometry_wkt.startswith("MULTIPOLYGON (((") and e.geometry_wkt.count("((") == 2


def test_fetch_requests_active_ny_as_geojson():
    seen = []

    def handler(req):
        seen.append(req)
        return httpx.Response(200, content=b'{"type":"FeatureCollection","features":[]}')

    http = Http("t", transport=httpx.MockTransport(handler), min_gap_s=0)
    src = load_registry().sources[SID]
    now = datetime(2026, 11, 14, 18, 0, tzinfo=UTC)
    raw = nws_alerts.fetch(FetchContext(src, http, None, now))
    assert [p.name for p in raw.parts] == ["active"]
    (req,) = seen
    assert str(req.url.copy_with(query=None)) == "https://api.weather.gov/alerts/active"
    assert dict(req.url.params) == {"area": "NY"}
    assert req.headers["Accept"] == "application/geo+json"
    assert len(nws_alerts.parse(raw)) == 0

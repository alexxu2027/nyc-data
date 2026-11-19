"""Optional API keys (ADR-018): where they go, where they never go, and what runs without them."""

import logging

import httpx
import pytest

from nyclive.collect.scheduler import Collector
from nyclive.http import Http, HttpError, redact_url
from nyclive.probe import probe_source
from nyclive.registry import load_registry
from nyclive.settings import load_settings

REG = load_registry()
KEYS = {"OPENAQ_API_KEY": "aq-secret-123", "MTA_BUSTIME_KEY": "bus-secret-456"}


def settings(tmp_path, **env):
    return load_settings(env={"NYCLIVE_DATA_DIR": str(tmp_path), **env}, dotenv=None)


def test_settings_route_each_key_to_its_host(tmp_path):
    s = settings(tmp_path, **KEYS)
    assert s.host_headers()["api.openaq.org"] == {"X-API-Key": "aq-secret-123"}
    assert s.host_params() == {"gtfsrt.prod.obanyc.com": {"key": "bus-secret-456"}}
    assert set(s.secrets()) == set(KEYS.values())
    assert s.key("MTA_BUSTIME_KEY") == "bus-secret-456"
    assert s.has_key_for(REG.sources["mta_bus_time"])
    none = settings(tmp_path)
    assert none.host_params() == {} and none.secrets() == ()
    assert not none.has_key_for(REG.sources["openaq_nyc"])
    assert none.has_key_for(REG.sources["citibike_station_status"])  # keyless


def test_redact_url():
    assert redact_url("https://h/x?key=abc&format=json") == "https://h/x?key=***&format=json"
    assert redact_url("https://h/x?a=1&api_key=abc") == "https://h/x?a=1&api_key=***"
    assert redact_url("https://h/x/abc/y", ("abc",)) == "https://h/x/***/y"
    assert redact_url("https://h/x?keyword=ok") == "https://h/x?keyword=ok"


def test_http_adds_host_params_and_never_logs_or_raises_the_key(caplog):
    seen = []

    def handler(req):
        seen.append(str(req.url))
        return httpx.Response(503 if len(seen) == 1 else 403)

    http = Http(
        "ua/1",
        transport=httpx.MockTransport(handler),
        sleep=lambda s: None,
        host_params={"gtfsrt.prod.obanyc.com": {"key": "bus-secret-456"}},
        secrets=("bus-secret-456",),
    )
    with caplog.at_level(logging.WARNING), pytest.raises(HttpError) as e:
        http.get("https://gtfsrt.prod.obanyc.com/vehiclePositions")
    assert seen[0] == "https://gtfsrt.prod.obanyc.com/vehiclePositions?key=bus-secret-456"
    assert "bus-secret-456" not in str(e.value) and "bus-secret-456" not in caplog.text
    assert "retry" in caplog.text  # the 503 was logged, redacted
    # a URL that has the key in it already (a probe URL) is redacted too
    with pytest.raises(HttpError) as e2:
        http.get("https://other.example/x?key=bus-secret-456")
    assert "bus-secret-456" not in str(e2.value)


def test_collector_skips_keyed_sources_without_keys(tmp_path):
    c = Collector(REG, settings(tmp_path), http=None)
    assert "mta_bus_time" not in c.sources and "openaq_nyc" not in c.sources
    assert set(c.skipped) >= {"mta_bus_time", "openaq_nyc"}
    assert "citibike_station_status" in c.sources
    with pytest.raises(SystemExit, match="MTA_BUSTIME_KEY"):
        Collector(REG, settings(tmp_path), only=["mta_bus_time"], http=None)


def test_collector_runs_keyed_sources_with_keys(tmp_path):
    c = Collector(REG, settings(tmp_path, **KEYS), http=None)
    assert {"mta_bus_time", "openaq_nyc"} <= set(c.sources)
    assert c.skipped == []


def test_probe_reads_keys_from_settings(tmp_path, monkeypatch):
    monkeypatch.delenv("MTA_BUSTIME_KEY", raising=False)
    seen = {}

    def handler(req):
        seen["url"], seen["headers"] = str(req.url), dict(req.headers)
        return httpx.Response(200, content=b'{"results": []}')

    client = httpx.Client(transport=httpx.MockTransport(handler))
    skipped = probe_source(client, REG.sources["mta_bus_time"], settings(tmp_path))
    assert skipped.status == "skipped" and "MTA_BUSTIME_KEY" in skipped.detail
    ok = probe_source(client, REG.sources["mta_bus_time"], settings(tmp_path, **KEYS))
    assert ok.ok and seen["url"].endswith("key=bus-secret-456")
    ok = probe_source(client, REG.sources["openaq_nyc"], settings(tmp_path, **KEYS))
    assert ok.ok and seen["headers"]["x-api-key"] == "aq-secret-123"

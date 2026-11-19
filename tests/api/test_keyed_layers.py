"""The keyed layers (ADR-018): buses and air quality, and what a clone without keys sees."""

from dataclasses import replace

import pytest
from conftest import NOW, RAN_AT, REG
from fastapi.testclient import TestClient
from helpers import load_fixture

from nyclive.api.app import create_app
from nyclive.api.layers.air import pm25_aqi
from nyclive.collect.pipeline import run_once
from nyclive.settings import Settings
from nyclive.sources.base import Adapter, load_adapter
from nyclive.storage.state import StateStore

KEYS = {"openaq_api_key": "test-aq", "mta_bustime_key": "test-bus"}


def seeded(tmp_path, keys=True) -> TestClient:
    """Buses and air quality run once at RAN_AT, as the collector would (fetch time = run time)."""
    settings = Settings(data_dir=tmp_path, user_agent="t", **(KEYS if keys else {}))
    with StateStore(settings.state_db) as store:
        for sid in ("mta_bus_time", "openaq_nyc"):
            raw = load_fixture(sid)
            parse = load_adapter(REG.sources[sid].adapter).parse
            if sid == "mta_bus_time":
                # Buses show only trips seen in the last minutes, so they're fetched "at RAN_AT";
                # the header must then count as fresh. (OpenAQ keeps its own fetch time: its
                # adapter drops readings newer than the fetch.)
                raw = replace(raw, parts=tuple(replace(p, fetched_at=RAN_AT) for p in raw.parts))
                parse = _fresh(parse)
            adapter = Adapter("t", (sid,), lambda ctx, raw=raw: raw, parse)
            r = run_once(REG.sources[sid], adapter, None, store, settings.archive_dir,
                         now=lambda: RAN_AT)  # fmt: skip
            assert r.ok, (sid, r.error)
    return TestClient(create_app(settings, now=lambda: NOW, web_dist=None))


def _fresh(parse):
    from nyclive.sources import mta_buses

    def go(raw):
        old = mta_buses.MAX_HEADER_AGE
        mta_buses.MAX_HEADER_AGE = old * 10**6
        try:
            return parse(raw)
        finally:
            mta_buses.MAX_HEADER_AGE = old

    return go


def test_buses_layer(tmp_path):
    c = seeded(tmp_path)
    body = c.get("/api/layers/buses").json()
    feats = body["features"]
    assert len(feats) > 80 and body["meta"]["unlocated"] == 0
    p = feats[0]["properties"]
    assert p["route_color"].startswith("#") and p["headsign"] and p["next_name"]
    assert {f["properties"]["service"] for f in feats} == {"local", "sbs", "express"}
    assert {f["properties"]["borough"] for f in feats} <= {"MN", "BK", "QN", "BX", "SI", "XX"}


def test_air_quality_layer_and_detail(tmp_path):
    c = seeded(tmp_path)
    feats = c.get("/api/layers/air_quality").json()["features"]
    props = {f["properties"]["name"]: f["properties"] for f in feats}
    ccny = props["CCNY"]
    assert ccny["monitor"] is True and ccny["station"] == "monitor"
    assert ccny["pm25"] is not None and ccny["category"] in ("good", "moderate")
    assert props["Carteret, NJ"]["borough"] == "XX"
    # the fixture lists 10 stations; the 2 that weren't fetched (quiet) aren't drawn
    assert len(feats) == 8
    low = [p for p in props.values() if not p["monitor"]]
    assert low and all(p["station"] == "sensor" for p in low)
    eid = next(f["properties"]["id"] for f in feats if f["properties"]["name"] == "CCNY")
    d = c.get(f"/api/entities/air_sensor/{eid}").json()
    assert d["derived"]["monitor"] is True and d["derived"]["provider"] == "AirNow"
    assert [s["label"] for s in d["series"]] == ["PM2.5", "Ozone"]


def test_without_keys_the_layers_and_feeds_are_hidden(tmp_path):
    c = seeded(tmp_path, keys=False)
    ids = {x["id"] for x in c.get("/api/layers").json()["layers"]}
    assert "buses" not in ids and "air_quality" not in ids and "citibike" in ids
    assert c.get("/api/layers/buses").status_code == 404
    # they ran here once (seeded), so health still reports them: hidden only if never run
    src = {s["id"] for s in c.get("/api/health").json()["sources"]}
    assert {"mta_bus_time", "openaq_nyc"} <= src


@pytest.mark.parametrize("ugm3, aqi, cat", [
    (0, 0, "good"), (9.0, 50, "good"), (9.05, 50, "good"), (9.1, 51, "moderate"),
    (35.4, 100, "moderate"), (35.5, 101, "sensitive"), (55.5, 151, "unhealthy"),
    (150, 225, "very_unhealthy"), (300, 449, "hazardous"), (999, 500, "hazardous"),
    (None, None, None), (-1, None, None),
])  # fmt: skip
def test_pm25_aqi(ugm3, aqi, cat):
    assert pm25_aqi(ugm3) == (aqi, cat)

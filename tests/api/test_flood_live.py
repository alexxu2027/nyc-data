"""Phase 2.5 U1: live depth on flood_sensors and the flood_sensor entity (ADR-013 I3a)."""

from dataclasses import replace
from datetime import timedelta
from urllib.parse import quote

import pytest
from conftest import COLLECTED, NOW, seed
from fastapi.testclient import TestClient

from nyclive.api.app import create_app
from nyclive.model import Event, Observation
from nyclive.registry import load_registry
from nyclive.sources.base import Batch

SENSORS = ("floodnet_sensors", "floodnet_events")
MIN = timedelta(minutes=1)


def _sensor_ids():
    from helpers import load_fixture

    from nyclive.sources.base import load_adapter

    parse = load_adapter(load_registry().sources["floodnet_sensors"].adapter).parse
    return [e.entity_id for e in parse(load_fixture("floodnet_sensors")).entities]


DEEP, SHALLOW, STALE, NONE, EVENT_ONLY, *_ = _sensor_ids()


def _live_batch(raw_batch: Batch) -> Batch:
    fetched = raw_batch.observations[0].fetched_at
    obs = [
        Observation("floodnet_live", "flood_sensor", DEEP, "depth_in", NOW - 10 * MIN, 3.2, fetched),
        Observation("floodnet_live", "flood_sensor", DEEP, "depth_in", NOW - 40 * MIN, 0.0, fetched),
        Observation("floodnet_live", "flood_sensor", SHALLOW, "depth_in", NOW - 30 * MIN, 0.4, fetched),
        Observation("floodnet_live", "flood_sensor", STALE, "depth_in", NOW - 3 * 60 * MIN, 5.0, fetched),
        Observation("floodnet_live", "flood_sensor", EVENT_ONLY, "depth_in", NOW - 5 * MIN, 0.2, fetched),
    ]  # fmt: skip
    open_event = Event(
        "floodnet_live",
        f"{EVENT_ONLY}:syn",
        "flood",
        "Flooding at synthetic, 2 in",
        NOW - 45 * MIN,
        severity=1,
        entity_refs=(f"flood_sensor:{EVENT_ONLY}",),
        props={"max_depth_in": 2.0, "live": True},
    )
    return replace(raw_batch, observations=obs, events=[open_event])


def _client(tmp_path, with_live: bool):
    sources = [s for s in COLLECTED if s in SENSORS or (with_live and s == "floodnet_live")]
    settings = seed(
        tmp_path,
        sources,
        extras=False,
        tweak=lambda b: (
            _live_batch(b) if any(o.source == "floodnet_live" for o in b.observations) else b
        ),
    )
    return TestClient(create_app(settings, now=lambda: NOW, web_dist=None))


@pytest.fixture(scope="module")
def live(tmp_path_factory):
    return _client(tmp_path_factory.mktemp("live"), True)


@pytest.fixture(scope="module")
def never(tmp_path_factory):
    return _client(tmp_path_factory.mktemp("never"), False)


def _props(client):
    body = client.get("/api/layers/flood_sensors").json()
    return {f["properties"]["id"]: f["properties"] for f in body["features"]}, body["meta"]


def test_layer_live_props(live):
    props, meta = _props(live)
    deep, shallow, stale, none, ev = (props[i] for i in (DEEP, SHALLOW, STALE, NONE, EVENT_ONLY))
    assert (deep["depth_in"], deep["live"], deep["flooding"]) == (3.2, True, True)
    assert deep["depth_at"] == "2026-11-15T03:20:00Z" and deep["flood_since"] is None
    assert (shallow["depth_in"], shallow["live"], shallow["flooding"]) == (0.4, True, False)
    # 5 in, but 3 h old: no live reading, so not flooding
    assert (stale["depth_in"], stale["live"], stale["flooding"]) == (5.0, False, False)
    assert (none["depth_in"], none["depth_at"], none["live"], none["flooding"]) == (
        None,
        None,
        False,
        False,
    )
    # an open floodnet_live event makes it flooding even at 0.2 in
    assert (ev["depth_in"], ev["flooding"], ev["flood_since"]) == (
        0.2,
        True,
        "2026-11-15T02:45:00Z",
    )
    assert meta["note"] is None
    assert meta["data_as_of"] == "2026-11-15T03:25:00Z"  # the newest reading


def test_note_when_never_collected(never):
    props, meta = _props(never)
    assert meta["note"] == "LIVE DEPTH NOT COLLECTED YET"
    assert all(
        p["depth_in"] is None and not p["live"] and not p["flooding"] for p in props.values()
    )
    assert meta["data_as_of"] is not None  # falls back to the sensor list's age


def test_entity_derived_series_and_events(live):
    d = live.get(f"/api/entities/flood_sensor/{quote(EVENT_ONLY, safe='')}").json()
    assert d["derived"] == {"events_30d": 0, "depth_in": 0.2, "live": True, "flooding": True}
    assert d["series"] == [
        {"label": "Water depth", "unit": "in", "metrics": ["depth_in"], "hours": 48, "ahead": 0}
    ]
    assert d["latest"]["depth_in"]["observed_at"] == "2026-11-15T03:25:00Z"
    assert [e["id"] for e in d["events"]] == [f"{EVENT_ONLY}:syn"]
    assert d["events"][0]["status"] == "active"
    none = live.get(f"/api/entities/flood_sensor/{quote(NONE, safe='')}").json()
    assert none["derived"]["depth_in"] is None and none["derived"]["live"] is False
    assert none["derived"]["flooding"] is False and none["latest"] == {}


def test_series_endpoint_accepts_depth(live):
    r = live.get(
        f"/api/entities/flood_sensor/{quote(DEEP, safe='')}/series",
        params={"metrics": "depth_in", "hours": 48},
    )
    assert r.status_code == 200
    assert r.json()["series"][0]["unit"] == "in"

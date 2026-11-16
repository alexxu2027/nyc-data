"""Phase 2.5 U4: GET /api/changes, the "what changed" feed (ADR-013 I3c)."""

import hashlib
from dataclasses import replace
from datetime import timedelta
from itertools import pairwise

import pytest
from conftest import NOW, RAN_AT, REG, canned, first_id, seed
from fastapi.testclient import TestClient
from helpers import load_fixture

from nyclive.api.app import create_app
from nyclive.collect.pipeline import run_once
from nyclive.model import Event
from nyclive.storage.state import StateStore

H = timedelta(hours=1)
POLY = "POLYGON ((-74.0 40.7, -73.9 40.7, -73.9 40.8, -74.0 40.8, -74.0 40.7))"
BASE = ["mta_subway_stations", "floodnet_sensors"]


def _events(sid: str, station: str, sensor: str) -> list[Event]:
    if sid == "nws_alerts":
        return [
            Event(sid, "nws-new", "weather_alert", "Flood watch", NOW - H, ends_at=NOW + 6 * H,
                  subtype="Flood Watch", severity=3, geometry_wkt=POLY,
                  props={"nyc_same": ["036061"]}),
            Event(sid, "nws-ended", "weather_alert", "Wind advisory", NOW - 3 * H,
                  ends_at=NOW - H, subtype="Wind Advisory", severity=2,
                  props={"nyc_same": ["036047", "036081"]}),
        ]  # fmt: skip
    if sid == "mta_subway_alerts":
        refs = ("subway_route:A", "subway_station:NOPE", f"subway_station:{station}")
        return [
            Event(sid, "alert-delay", "service_alert", "A trains delayed", NOW - H,
                  subtype="Delays", severity=2, entity_refs=refs),
            Event(sid, "alert-planned", "service_alert", "Planned work", NOW - H,
                  subtype="Planned - Part Suspended", severity=1, entity_refs=refs),
            Event(sid, "alert-later", "service_alert", "Later delay", NOW + 2 * H,
                  subtype="Delays", severity=1, entity_refs=refs),
            Event(sid, "alert-lost", "service_alert", "Line-wide delay", NOW - H,
                  subtype="Delays", severity=1, entity_refs=("subway_route:A",)),
        ]  # fmt: skip
    if sid == "mta_elevator_outages":
        refs = ("elevator:EL1", f"subway_station:{station}")
        return [
            Event(sid, "EL1:now", "elevator_outage", "Elevator out", NOW - 2 * H, subtype="EL",
                  entity_refs=refs, props={"upcoming": False}),
            Event(sid, "EL1:soon", "elevator_outage", "Elevator work soon", NOW + 5 * H,
                  subtype="EL", entity_refs=refs, props={"upcoming": True}),
        ]  # fmt: skip
    if sid == "floodnet_live":
        return [
            Event(sid, f"{sensor}:wet", "flood", "Flooding, 3 in", NOW - H, severity=2,
                  entity_refs=(f"flood_sensor:{sensor}",), props={"live": True}),
            # Backfilled from the 48 h tail on the first run: first seen now, began 30 h ago.
            Event(sid, f"{sensor}:old", "flood", "Flooding, 2 in", NOW - 30 * H,
                  ends_at=NOW - 29 * H, severity=1, entity_refs=(f"flood_sensor:{sensor}",),
                  props={"live": True}),
        ]  # fmt: skip
    return []


SOURCES = ["nws_alerts", "mta_subway_alerts", "mta_elevator_outages", "floodnet_live"]


def _run(settings, sid: str, at, events: list[Event]) -> None:
    """One pipeline run of `sid` fetched at `at` (first_seen = fetched_at) with `events`."""
    raw = load_fixture(sid)
    raw = replace(raw, parts=tuple(replace(p, fetched_at=at) for p in raw.parts))
    adapter = canned(sid, raw, False, lambda b: replace(b, events=events))
    with StateStore(settings.state_db) as store:
        r = run_once(REG.sources[sid], adapter, None, store, settings.archive_dir, now=lambda: at)
    assert r.ok, (sid, r.error)


def _seed(d):
    settings = seed(d, BASE, extras=False)
    station = first_id("mta_subway_stations", "subway_station")
    sensor = first_id("floodnet_sensors", "flood_sensor")
    # A source outside the feed, with events in the window: must not appear.
    seed(d, ["floodnet_events"], extras=False)
    # An NWS alert first seen 20 h ago: outside the default 12 h window.
    old = Event("nws_alerts", "nws-old", "weather_alert", "Old advisory", NOW - 21 * H,
                ends_at=NOW + H, subtype="Advisory", severity=1, props={"nyc_same": ["036005"]})  # fmt: skip
    _run(settings, "nws_alerts", NOW - 20 * H, [old])
    # Newest first: NWS at RAN_AT, then each source 10 min earlier than the one before.
    for i, sid in enumerate(SOURCES):
        evs = _events(sid, station, sensor) + ([old] if sid == "nws_alerts" else [])
        _run(settings, sid, RAN_AT - i * timedelta(minutes=10), evs)
    return settings, station, sensor


@pytest.fixture(scope="module")
def feed(tmp_path_factory):
    d = tmp_path_factory.mktemp("changes")
    settings, station, sensor = _seed(d)
    client = TestClient(create_app(settings, now=lambda: NOW, web_dist=None))
    return client, settings, station, sensor


def _items(client, query=""):
    r = client.get(f"/api/changes{query}")
    assert r.status_code == 200, r.text
    return r.json()


def test_only_the_four_sources_and_exclusions(feed):
    client, *_ = feed
    body = _items(client)
    ids = [i["id"] for i in body["items"]]
    assert {i["source"] for i in body["items"]} == set(SOURCES)
    assert "mta_subway_alerts:alert-planned" not in ids  # planned work is not a change
    assert "mta_subway_alerts:alert-later" not in ids  # not in effect yet
    assert "mta_elevator_outages:EL1:soon" not in ids  # upcoming outage
    assert "nws_alerts:nws-old" not in ids  # first seen 20 h ago
    assert len(ids) == len(set(ids)) == 6
    assert body["now"] == "2026-11-15T03:30:00Z" and body["since"] == "2026-11-14T15:30:00Z"
    wide = [i["id"] for i in _items(client, "?hours=24")["items"]]
    assert "nws_alerts:nws-old" in wide


def test_layer_and_feature_mapping(feed):
    client, _, station, sensor = feed
    items = {i["id"]: i for i in _items(client)["items"]}
    nws = items["nws_alerts:nws-new"]
    assert (nws["kind"], nws["layer"], nws["feature"]) == ("weather", "nws_alerts", "nws-new")
    assert (nws["lon"], nws["lat"]) == (-73.95, 40.75) and nws["borough"] == "MN"
    assert nws["severity"] == 3 and nws["ended"] is False and nws["title"] == "Flood watch"
    ended = items["nws_alerts:nws-ended"]
    assert ended["ended"] is True and ended["lat"] is not None  # zone-only: borough union bbox
    alert = items["mta_subway_alerts:alert-delay"]
    assert (alert["kind"], alert["layer"], alert["feature"]) == ("alert", "subway_alerts", station)
    assert alert["lat"] is not None and alert["borough"] in ("MN", "BK", "QN", "BX", "SI")
    lost = items["mta_subway_alerts:alert-lost"]
    assert lost["feature"] is None and lost["lat"] is None and lost["lon"] is None
    out = items["mta_elevator_outages:EL1:now"]
    assert (out["kind"], out["layer"], out["feature"]) == ("outage", "elevator_outages", station)
    flood = items[f"floodnet_live:{sensor}:wet"]
    assert (flood["kind"], flood["layer"], flood["feature"]) == ("flood", "flood_sensors", sensor)
    assert flood["lat"] is not None
    assert set(nws) == {"id", "at", "kind", "source", "title", "severity", "layer", "feature",
                        "lat", "lon", "borough", "ended"}  # fmt: skip


def test_sorted_by_at_then_id_and_limit(feed):
    client, *_ = feed
    items = _items(client)["items"]
    for a, b in pairwise(items):
        assert a["at"] > b["at"] or (a["at"] == b["at"] and a["id"] < b["id"])
    assert items[0]["source"] == "nws_alerts"  # seeded last, at RAN_AT
    assert items[-1]["source"] == "floodnet_live"  # seeded 30 min earlier
    assert [i["id"] for i in _items(client, "?limit=2")["items"]] == [i["id"] for i in items[:2]]
    for bad in ("?hours=0", "?hours=49", "?limit=0", "?limit=101"):
        assert client.get(f"/api/changes{bad}").status_code in (400, 422), bad


def test_etag_304(feed):
    client, *_ = feed
    r = client.get("/api/changes")
    tag = r.headers["etag"]
    assert r.headers["cache-control"] == "no-cache"
    again = client.get("/api/changes", headers={"If-None-Match": tag})
    assert again.status_code == 304 and again.content == b""
    other = client.get("/api/changes?limit=3", headers={"If-None-Match": tag})
    assert other.status_code == 200


def test_read_only(feed):
    client, settings, *_ = feed
    before = hashlib.sha256(settings.state_db.read_bytes()).hexdigest()
    for q in ("", "?hours=48&limit=100", "?hours=1"):
        assert client.get(f"/api/changes{q}").status_code == 200
    assert hashlib.sha256(settings.state_db.read_bytes()).hexdigest() == before


def test_etag_survives_clock_only_rebuilds(feed):
    """Known gap (2026-11-16): `now` in the body changed the ETag on every 30 s rebuild."""
    from datetime import timedelta

    _, settings, *_ = feed
    clock = {"t": NOW}
    client = TestClient(create_app(settings, now=lambda: clock["t"], web_dist=None))
    r = client.get("/api/changes")
    tag = r.headers["etag"]
    clock["t"] = NOW + timedelta(seconds=45)  # past MAX_AGE_S: the body is rebuilt
    again = client.get("/api/changes", headers={"If-None-Match": tag})
    assert again.status_code == 304 and again.headers["etag"] == tag
    fresh = client.get("/api/changes")
    assert fresh.json()["now"] != r.json()["now"]  # the body itself still has the new clock


def test_backfilled_old_flood_is_not_a_change(feed):
    """Review 2026-11-16 #6: a flood that began before the window isn't new on the first run."""
    client, _, _, sensor = feed
    ids = [i["id"] for i in _items(client, "?limit=100")["items"]]  # the default 12 h
    assert any(i.endswith(f"{sensor}:wet") for i in ids)
    assert not any(i.endswith(f"{sensor}:old") for i in ids)
    wide = [i["id"] for i in _items(client, "?hours=48&limit=100")["items"]]
    assert any(i.endswith(f"{sensor}:old") for i in wide)  # inside a 48 h window it counts

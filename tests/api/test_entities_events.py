"""Group 8: entity detail, series, event detail and list (ids with ':' and '/'), 404 shape."""

from urllib.parse import quote

import pytest
from conftest import CAM, NOW, ZONE_ALERT

ENTITY_KEYS = {
    "kind", "id", "source", "name", "lat", "lon", "borough", "props", "first_seen",
    "last_seen", "latest", "derived", "events", "series",
}  # fmt: skip
SUMMARY_KEYS = {
    "source", "id", "category", "subtype", "title", "starts_at", "ends_at", "severity",
    "status", "lat", "lon", "borough", "routes", "stations", "props",
}  # fmt: skip


def first(client, layer):
    return client.get(f"/api/layers/{layer}").json()["features"][0]["properties"]


@pytest.mark.parametrize(
    ("kind", "layer", "derived"),
    [
        ("bike_station", "citibike", {"pct", "state"}),
        ("tide_gauge", "tide_gauge", {"predicted_ft", "surge_ft", "trend", "next_high",
                                      "next_low"}),
        ("weather_point", "weather", {"temp_f", "wind_mph", "wet"}),
        ("road_segment", "road_speeds", {"band", "stale"}),
        ("camera", "cameras", {"image_url", "status"}),
        ("subway_station", "subway_stations", {"routes"}),
        ("flood_sensor", "flood_sensors", {"events_30d"}),
    ],
)  # fmt: skip
def test_entity_detail(client, kind, layer, derived):
    eid = first(client, layer)["id"]
    r = client.get(f"/api/entities/{kind}/{quote(eid, safe='')}")
    assert r.status_code == 200, r.text
    d = r.json()
    assert set(d) == ENTITY_KEYS and d["kind"] == kind and d["id"] == eid
    assert set(d["derived"]) == derived
    for s in d["series"]:
        assert set(s) == {"label", "unit", "metrics", "hours", "ahead"}
    for e in d["events"]:
        assert set(e) == SUMMARY_KEYS


def test_station_events_and_tide_series_spec(client):
    sid = first(client, "subway_alerts")["id"]
    d = client.get(f"/api/entities/subway_station/{sid}").json()
    assert d["events"] and d["events"][0]["status"] == "active"
    assert all(len(e["props"].get("description", "")) <= 600 for e in d["events"])
    tide = client.get("/api/entities/tide_gauge/8518750").json()
    assert tide["series"][0]["metrics"] == ["water_level_ft", "predicted_ft"]
    assert tide["series"][0]["ahead"] == 12


def test_id_with_colon_and_slash(client):
    for path in (f"/api/entities/camera/{quote(CAM, safe='')}", f"/api/entities/camera/{CAM}"):
        r = client.get(path)
        assert r.status_code == 200, (path, r.text)
        assert r.json()["id"] == CAM and r.json()["derived"]["status"] == "offline"
    s = client.get(
        f"/api/entities/camera/{quote(CAM, safe='')}/series", params={"metrics": "temp_c"}
    )
    assert s.status_code == 200 and s.json()["id"] == CAM
    assert s.json()["series"] == [{"metric": "temp_c", "unit": "°C", "points": []}]


def test_series_sorted_in_range_capped(client):
    r = client.get(
        "/api/entities/tide_gauge/8518750/series",
        params={"metrics": "water_level_ft,predicted_ft", "hours": 48, "ahead": 48},
    )
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["now"] == "2026-11-15T03:30:00Z"
    lo, hi = NOW.timestamp() - 48 * 3600, NOW.timestamp() + 48 * 3600
    levels = next(s for s in body["series"] if s["metric"] == "water_level_ft")
    assert levels["unit"] == "ft" and levels["points"]
    for s in body["series"]:
        ts = [p[0] for p in s["points"]]
        assert ts == sorted(ts) and len(ts) <= 2000
        assert all(lo <= t <= hi for t in ts)
    # the fixture's levels are older than 2 h: a 1 h window still gets the last value, clamped
    short = client.get(
        "/api/entities/tide_gauge/8518750/series", params={"metrics": "water_level_ft", "hours": 1}
    ).json()
    pts = short["series"][0]["points"]
    assert len(pts) == 1 and pts[0][0] == int(NOW.timestamp()) - 3600


@pytest.mark.parametrize(
    ("params", "status"),
    [
        ({"metrics": "nope"}, 400),
        ({}, 400),
        ({"metrics": "water_level_ft", "hours": 0}, 400),
        ({"metrics": "water_level_ft", "hours": 169}, 400),
        ({"metrics": "water_level_ft", "ahead": 49}, 400),
    ],
)
def test_series_errors(client, params, status):
    r = client.get("/api/entities/tide_gauge/8518750/series", params=params)
    assert r.status_code == status and r.json()["error"]["code"] == "bad_request"


@pytest.mark.parametrize(
    "path",
    [
        "/api/entities/camera/nope",
        "/api/entities/notakind/x",
        "/api/entities/tide_gauge/nope/series?metrics=water_level_ft",
        "/api/events/nyc_311/nope",
        "/api/events/nope/x:y",
    ],
)
def test_404_shape(client, path):
    r = client.get(path)
    assert r.status_code == 404
    assert r.json()["error"]["code"] == "not_found"


def test_event_detail_ids_with_colon_and_slash(client):
    for source, eid in (
        ("mta_elevator_outages", "SYN/1:2026"),
        ("mta_subway_alerts", "syn:alert:ok"),
        ("nws_alerts", ZONE_ALERT),
    ):
        r = client.get(f"/api/events/{source}/{quote(eid, safe='')}")
        assert r.status_code == 200, (eid, r.text)
        d = r.json()
        assert set(d) == SUMMARY_KEYS | {"geometry", "entity_refs", "entities"}
        assert d["id"] == eid and d["source"] == source
    out = client.get("/api/events/mta_elevator_outages/SYN/1:2026").json()
    assert out["entities"] and out["entities"][0]["kind"] == "subway_station"
    assert out["geometry"]["type"] == "Point" and out["status"] == "active"
    zone = client.get(f"/api/events/nws_alerts/{ZONE_ALERT}").json()
    assert zone["geometry"]["type"] == "MultiPolygon"
    assert zone["props"]["instruction"] == "Secure loose objects."
    alert = client.get("/api/events/mta_subway_alerts/syn:alert:ok").json()
    assert alert["routes"] == ["A"] and len(alert["props"]["description"]) == 900


def test_events_list(client):
    r = client.get("/api/events", params={"layer": "subway_alerts", "limit": 5})
    assert r.status_code == 200
    page = r.json()
    assert set(page) == {"layer", "total", "limit", "offset", "events"}
    assert page["total"] >= 2 and len(page["events"]) <= 5
    for e in page["events"]:
        assert set(e) == SUMMARY_KEYS and e["status"] == "active"
        assert set(e["props"]) <= {"description", "reason", "est_return", "instruction"}
        assert len(e["props"].get("description") or "") <= 600
    ids = [e["id"] for e in page["events"]]
    assert "syn:alert:bad" in [
        e["id"]
        for e in client.get("/api/events", params={"layer": "subway_alerts", "limit": 200}).json()[
            "events"
        ]
    ], "route-wide / unmapped alerts appear in list mode"
    nxt = client.get("/api/events", params={"layer": "subway_alerts", "limit": 5, "offset": 5})
    assert not set(ids) & {e["id"] for e in nxt.json()["events"]}
    assert (
        client.get("/api/events", params={"layer": "nws_alerts", "status": "all"}).json()["total"]
        >= 2
    )
    assert client.get("/api/events", params={"layer": "cameras"}).status_code == 400
    assert (
        client.get("/api/events", params={"layer": "nws_alerts", "limit": 500}).status_code == 400
    )
    bk = client.get("/api/events", params={"layer": "nws_alerts", "borough": "MN"}).json()
    assert all(e["borough"] in (None, "MN") for e in bk["events"])

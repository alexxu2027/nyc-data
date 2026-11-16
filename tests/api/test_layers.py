"""Groups 2, 4, 5, 6, 11: layer bodies, params, ref resolution, tide, NWS empty state."""

import shutil

import pytest
from conftest import BAD_REF, NJ, NOW, NULL_BK, TIDE_PREDICTED, ZONE_ALERT, seed
from fastapi.testclient import TestClient

from nyclive.api.app import create_app
from nyclive.api.layers import BUILDERS
from nyclive.settings import Settings

S, I, N, B = (str,), ("int",), ("num",), (bool,)
NULL = (type(None),)
GEOM = {"point": "Point", "cluster": "Point", "line": "LineString"}
BOROUGH_VALUES = {"MN", "BK", "QN", "BX", "SI", "XX", None}

PROPS = {
    "citibike": {"name": S, "capacity": I + NULL, "bikes": I, "ebikes": I, "docks": I,
                 "pct": N + NULL, "state": S, "observed_at": S},
    "cameras": {"name": S, "status": S, "image_url": S},
    "road_speeds": {"name": S, "speed_mph": N + NULL, "travel_time_s": I + NULL, "band": S,
                    "stale": B, "observed_at": S + NULL, "owner": S + NULL},
    "subway_stations": {"name": S, "routes": S, "ada": I, "line": S, "structure": S},
    "subway_alerts": {"name": S, "routes": S, "status": S, "n": I, "active": I, "upcoming": I,
                      "unplanned": I, "severity": I, "top_title": S, "top_subtype": S + NULL},
    "elevator_outages": {"name": S, "routes": S, "status": S, "n": I, "current": I,
                         "upcoming": I, "elevators": I, "escalators": I, "ada": B,
                         "top_title": S, "est_return": S + NULL},
    "collisions": {"starts_at": S, "severity": I, "injured": I, "killed": I, "ped": B, "cyc": B,
                   "street": S + NULL, "title": S},
    "nws_alerts": {"event": S, "severity": I, "status": S, "starts_at": S, "ends_at": S + NULL,
                   "headline": S, "area": S, "boroughs": S, "geom_source": S},
    "flood_events": {"sensor_id": S, "name": S, "starts_at": S, "ends_at": S + NULL,
                     "max_depth_in": N, "duration_min": N + NULL, "severity": I, "recent": B,
                     "title": S},
    "flood_sensors": {"name": S, "tidal": B, "nta": S + NULL, "events_30d": I,
                      "last_event_at": S + NULL, "last_max_depth_in": N + NULL},
    "tide_gauge": {"name": S, "water_level_ft": N, "observed_at": S, "predicted_ft": N + NULL,
                   "surge_ft": N + NULL, "trend": S + NULL, "datum": S},
    "weather": {"name": S, "temp_c": N, "temp_f": N, "precip_mm": N, "rain_mm": N,
                "wind_kmh": N, "wind_mph": N, "wet": B, "observed_at": S},
    "complaints_311": {"starts_at": S, "type": S, "group": S, "status": S, "agency": S},
    "boroughs": {"name": S, "borocode": I},
}  # fmt: skip
ENUMS = {
    ("citibike", "state"): {"empty", "low", "ok", "full", "offline"},
    ("cameras", "status"): {"online", "offline"},
    ("road_speeds", "band"): {"lt10", "10_20", "20_35", "35_50", "gte50", "none"},
    ("subway_alerts", "status"): {"active", "upcoming"},
    ("elevator_outages", "status"): {"current", "upcoming"},
    ("collisions", "severity"): {1, 2, 3},
    ("nws_alerts", "status"): {"active", "upcoming"},
    ("nws_alerts", "geom_source"): {"polygon", "boroughs"},
    ("complaints_311", "status"): {"open", "closed"},
    ("tide_gauge", "trend"): {"rising", "falling", "steady", None},
}
GROUPS_311 = {"noise", "housing", "sanitation", "streets", "water", "social", "vehicles", "other"}


def _ok(v, types) -> bool:
    for t in types:
        if t == "int" and type(v) is int:
            return True
        if t == "num" and type(v) in (int, float):
            return True
        if isinstance(t, type) and type(v) is t:
            return True
    return False


def get(client, layer, **params):
    r = client.get(f"/api/layers/{layer}", params=params)
    assert r.status_code == 200, r.text
    return r.json()


def by_id(body):
    return {f["properties"]["id"]: f for f in body["features"]}


@pytest.mark.parametrize("layer", sorted(BUILDERS))
def test_layer_shape(client, layer):
    body = get(client, layer)
    assert body["type"] == "FeatureCollection"
    meta = body["meta"]
    assert set(meta) == {"layer", "count", "total", "truncated", "unlocated", "data_as_of",
                         "updated_at", "window", "note"}  # fmt: skip
    assert meta["layer"] == layer and meta["count"] == len(body["features"])
    if layer != "subway_trains":  # U2 seeds trains and drops this exemption
        assert body["features"], f"{layer}: seeded fixtures should give a feature"
    kind = client.get("/api/layers").json()["layers"]
    kind = next(x["kind"] for x in kind if x["id"] == layer)
    ids = [f["properties"]["id"] for f in body["features"]]
    assert len(ids) == len(set(ids))
    for f in body["features"]:
        assert "id" not in f, "no top-level feature id"
        p = f["properties"]
        assert isinstance(p["id"], str)
        assert p["borough"] in BOROUGH_VALUES
        gtype = f["geometry"]["type"]
        if kind == "polygon":
            assert gtype in ("Polygon", "MultiPolygon")
        else:
            assert gtype == GEOM[kind]
        if gtype == "Point":
            lon, lat = f["geometry"]["coordinates"]
            assert lon == round(lon, 5) and lat == round(lat, 5)
        expected = PROPS[layer]
        assert set(p) == {"id", "borough", *expected}, set(p) ^ {"id", "borough", *expected}
        for k, types in expected.items():
            assert _ok(p[k], types), (layer, k, p[k])
        for (lid, k), allowed in ENUMS.items():
            if lid == layer:
                assert p[k] in allowed, (layer, k, p[k])
        if layer == "complaints_311":
            assert p["group"] in GROUPS_311


def test_citibike_derived_and_boroughs(client):
    feats = by_id(get(client, "citibike"))
    assert feats[NJ]["properties"]["borough"] == "XX"
    nb = feats[NULL_BK]["properties"]
    assert nb["borough"] == "BK", "null column resolved by point-in-polygon"
    assert nb["state"] == "empty" and nb["pct"] == 0.0
    assert feats[NJ]["properties"]["state"] == "low"


# ------------------------------------------------------------------------------- group 4
def test_borough_filter(client):
    for layer in ("cameras", "citibike", "collisions", "complaints_311", "nws_alerts"):
        body = get(client, layer, borough="BK")
        assert {f["properties"]["borough"] for f in body["features"]} <= {"BK", None}, layer
    assert NJ not in by_id(get(client, "citibike", borough="BK,MN"))


def test_bbox(client):
    everything = get(client, "cameras")
    lon, lat = everything["features"][0]["geometry"]["coordinates"]
    box = f"{lon - 0.001},{lat - 0.001},{lon + 0.001},{lat + 0.001}"
    body = get(client, "cameras", bbox=box)
    assert 1 <= body["meta"]["count"] < everything["meta"]["count"]
    for f in body["features"]:
        x, y = f["geometry"]["coordinates"]
        assert abs(x - lon) <= 0.001 and abs(y - lat) <= 0.001


@pytest.mark.parametrize(
    "params",
    [
        {"f.nope": "1"},
        {"f.window": "3y"},
        {"f.status": "open"},  # a client filter is not a server param
        {"borough": "ZZ"},
        {"bbox": "1,2,3"},
        {"limit": "0"},
        {"limit": "abc"},
    ],
)
def test_bad_params_are_400(client, params):
    r = client.get("/api/layers/complaints_311", params=params)
    assert r.status_code == 400
    err = r.json()["error"]
    assert err["code"] == "bad_request" and isinstance(err["message"], str)


def test_unknown_layer_404(client):
    r = client.get("/api/layers/nope")
    assert r.status_code == 404 and r.json()["error"]["code"] == "not_found"


def test_limit_truncates(client):
    meta = get(client, "complaints_311", limit=5)["meta"]
    assert meta["truncated"] is True and meta["count"] == 5 and meta["total"] > 5
    full = get(client, "complaints_311")["meta"]
    assert full["truncated"] is False and full["total"] == meta["total"]


def test_311_window_anchored_at_newest_record(client):
    day = get(client, "complaints_311")
    week = get(client, "complaints_311", **{"f.window": "7d"})
    assert day["meta"]["window"]["to"] == day["meta"]["data_as_of"]
    assert day["meta"]["data_as_of"] < NOW.strftime("%Y-%m-%dT%H:%M:%SZ")
    assert week["meta"]["total"] >= day["meta"]["total"]
    starts = [f["properties"]["starts_at"] for f in day["features"]]
    assert starts == sorted(starts, reverse=True), "newest first"
    assert all(s > day["meta"]["window"]["from"] for s in starts)


# ------------------------------------------------------------------------------- group 5
def _station(client, sid):
    r = client.get(f"/api/entities/subway_station/{sid}")
    assert r.status_code == 200
    return r.json()


def test_refs_resolve_to_entity_points(client):
    alerts = get(client, "subway_alerts")
    assert alerts["meta"]["unlocated"] >= 1, "the BAD_REF alert is counted, not mapped"
    for f in alerts["features"]:
        st = _station(client, f["properties"]["id"])
        assert f["geometry"]["coordinates"] == [st["lon"], st["lat"]]
    outages = get(client, "elevator_outages")
    assert outages["meta"]["unlocated"] >= 1
    for f in outages["features"]:
        st = _station(client, f["properties"]["id"])
        assert f["geometry"]["coordinates"] == [st["lon"], st["lat"]]
    floods = get(client, "flood_events")
    assert floods["meta"]["unlocated"] >= 1
    for f in floods["features"]:
        s = client.get(f"/api/entities/flood_sensor/{f['properties']['sensor_id']}").json()
        assert f["geometry"]["coordinates"] == [s["lon"], s["lat"]]
    assert all(BAD_REF not in f["properties"]["id"] for f in floods["features"])


def test_zone_only_nws_alert_uses_borough_union(client):
    feats = by_id(get(client, "nws_alerts"))
    zone = feats[ZONE_ALERT]
    assert zone["geometry"]["type"] == "MultiPolygon"
    assert zone["properties"]["geom_source"] == "boroughs"
    assert zone["properties"]["boroughs"] == "BK,QN"
    assert zone["properties"]["status"] == "active"
    assert any(f["properties"]["geom_source"] == "polygon" for f in feats.values())


# ------------------------------------------------------------------------------- group 6
def test_tide_prediction_from_archive(client):
    p = get(client, "tide_gauge")["features"][0]["properties"]
    assert p["predicted_ft"] == TIDE_PREDICTED, "nearest archived prediction, not latest +24 h"
    latest = client.get("/api/entities/tide_gauge/8518750").json()["latest"]
    assert latest["predicted_ft"]["value"] != p["predicted_ft"]
    assert p["surge_ft"] == round(p["water_level_ft"] - p["predicted_ft"], 3)


def test_tide_without_archive_gives_nulls(tmp_path, data_dir):
    shutil.copy(data_dir / "state.db", tmp_path / "state.db")
    assert not (tmp_path / "archive").exists()
    app = create_app(Settings(data_dir=tmp_path, user_agent="t"), now=lambda: NOW, web_dist=None)
    r = TestClient(app).get("/api/layers/tide_gauge")
    assert r.status_code == 200
    p = r.json()["features"][0]["properties"]
    assert p["predicted_ft"] is None and p["surge_ft"] is None and p["water_level_ft"] is not None


# ------------------------------------------------------------------------------ group 11
def test_nws_empty_state(tmp_path):
    settings = seed(tmp_path, ["nws_alerts"], extras=False, cases={"nws_alerts": "edge_empty"})
    app = create_app(settings, now=lambda: NOW, web_dist=None)
    r = TestClient(app).get("/api/layers/nws_alerts")
    assert r.status_code == 200
    assert r.json()["features"] == [] and r.json()["meta"]["count"] == 0

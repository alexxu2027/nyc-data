"""Phase 2.5 U0 stubs: radar is a raster layer, trains and the feed are empty until U2/U4."""


def test_radar_is_catalog_only(client):
    layers = {layer["id"]: layer for layer in client.get("/api/layers").json()["layers"]}
    radar = layers["radar"]
    assert radar["kind"] == "raster" and radar["default"] is False
    assert radar["raster"]["max_zoom"] == 7 and radar["sources"] == []
    assert layers["subway_trains"]["default"] is True
    assert layers["flood_sensors"]["changes"] == {"props": ["flooding"], "new": False}
    assert client.get("/api/layers/radar").status_code == 404


def test_trains_stub_is_empty_feature_collection(client):
    body = client.get("/api/layers/subway_trains").json()
    assert body["type"] == "FeatureCollection" and body["features"] == []
    assert body["meta"]["layer"] == "subway_trains"


def test_changes_stub_and_etag(client):
    r = client.get("/api/changes")
    assert r.status_code == 200
    body = r.json()
    assert body["items"] == [] and {"now", "since"} <= set(body)
    again = client.get("/api/changes", headers={"If-None-Match": r.headers["etag"]})
    assert again.status_code == 304
    assert client.get("/api/changes?hours=49").status_code in (400, 422)

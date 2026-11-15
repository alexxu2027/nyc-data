"""Group 3: ETag / 304, param-sensitive ETags, and a new run invalidating the cache."""

from dataclasses import replace
from datetime import timedelta

from conftest import NOW, RAN_AT, seed
from fastapi.testclient import TestClient

from nyclive.api.app import create_app


def test_revalidate_gives_304(client):
    for path in ("/api/layers", "/api/layers/citibike", "/api/health"):
        r = client.get(path)
        tag = r.headers["etag"]
        assert tag.startswith('W/"') and len(tag) == 2 + 1 + 16 + 1
        assert r.headers["cache-control"] == "no-cache"
        again = client.get(path, headers={"If-None-Match": tag})
        assert again.status_code == 304 and again.content == b""
        # weak comparison: a strong form of the same tag matches too
        strong = client.get(path, headers={"If-None-Match": tag[2:]})
        assert strong.status_code == 304


def test_params_change_etag(client):
    a = client.get("/api/layers/complaints_311").headers["etag"]
    b = client.get("/api/layers/complaints_311", params={"limit": 3}).headers["etag"]
    c = client.get("/api/layers/complaints_311", params={"f.window": "7d", "limit": 3})
    assert a != b and b != c.headers["etag"]


def test_explicit_default_equals_absent(client):
    a = client.get("/api/layers/complaints_311").headers["etag"]
    b = client.get("/api/layers/complaints_311", params={"f.window": "24h"}).headers["etag"]
    assert a == b


def test_gzip_when_accepted(client):
    r = client.get("/api/layers/cameras", headers={"Accept-Encoding": "gzip"})
    assert r.headers.get("content-encoding") == "gzip"
    assert r.json()["type"] == "FeatureCollection"  # httpx decodes it


def test_new_run_changes_etag(tmp_path):
    settings = seed(tmp_path, ["openmeteo_current"], extras=False)
    client = TestClient(create_app(settings, now=lambda: NOW, web_dist=None))
    first = client.get("/api/layers/weather")
    tag = first.headers["etag"]
    assert client.get("/api/layers/weather", headers={"If-None-Match": tag}).status_code == 304

    def warmer(batch):
        obs = [
            replace(o, value=o.value + 5.0, observed_at=o.observed_at + timedelta(minutes=15))
            if o.metric == "temp_c"
            else o
            for o in batch.observations
        ]
        return replace(batch, observations=obs)

    seed(tmp_path, ["openmeteo_current"], ran_at=RAN_AT + timedelta(minutes=1), extras=False,
         tweak=warmer)  # fmt: skip
    second = client.get("/api/layers/weather", headers={"If-None-Match": tag})
    assert second.status_code == 200 and second.headers["etag"] != tag
    t1 = {f["properties"]["id"]: f["properties"]["temp_c"] for f in first.json()["features"]}
    t2 = {f["properties"]["id"]: f["properties"]["temp_c"] for f in second.json()["features"]}
    assert all(round(t2[k] - t1[k], 1) == 5.0 for k in t1)

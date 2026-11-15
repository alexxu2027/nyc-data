"""Groups 10 and 12: web/dist serving with index fallback, and `nyclive serve --help`."""

import pytest
from conftest import NOW
from fastapi.testclient import TestClient

from nyclive.api.app import create_app
from nyclive.cli import main


@pytest.fixture
def dist(tmp_path):
    d = tmp_path / "dist"
    (d / "assets").mkdir(parents=True)
    (d / "index.html").write_text("<!doctype html><title>NYC Live</title>INDEX", encoding="utf-8")
    (d / "assets" / "app.js").write_text("console.log('hi')", encoding="utf-8")
    return d


def test_static_with_dist(settings, dist):
    c = TestClient(create_app(settings, now=lambda: NOW, web_dist=dist))
    root = c.get("/")
    assert root.status_code == 200 and "INDEX" in root.text
    assert "console.log" in c.get("/assets/app.js").text
    deep = c.get("/x/y")
    assert deep.status_code == 200 and "INDEX" in deep.text
    assert "INDEX" in c.get("/../../etc/passwd").text  # no escape from dist
    nope = c.get("/api/nope")
    assert nope.status_code == 404
    assert nope.json() == {"error": {"code": "not_found", "message": "no API route /api/nope"}}
    assert c.get("/api/docs").status_code == 200
    assert c.get("/api/openapi.json").json()["info"]["title"] == "NYC Live API"


def test_static_without_dist(settings, tmp_path):
    c = TestClient(create_app(settings, now=lambda: NOW, web_dist=tmp_path / "missing"))
    r = c.get("/")
    assert r.status_code == 200 and "npm run build" in r.text
    assert c.get("/api/nope").json()["error"]["code"] == "not_found"


def test_serve_help(capsys):
    with pytest.raises(SystemExit) as e:
        main(["serve", "--help"])
    assert e.value.code == 0
    out = capsys.readouterr().out
    assert "--port" in out and "--no-web" in out and "--reload" in out

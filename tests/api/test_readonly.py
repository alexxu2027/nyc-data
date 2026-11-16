"""Group 9: the API never writes state.db."""

import ast
import hashlib
import sqlite3
from pathlib import Path
from urllib.parse import quote

import pytest
from conftest import CAM

import nyclive.api
from nyclive.api.db import connect_ro
from nyclive.api.layers import BUILDERS

API_DIR = Path(nyclive.api.__file__).parent


def sha(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def test_every_endpoint_leaves_state_db_untouched(client, settings):
    before = sha(settings.state_db)
    paths = ["/api/health", "/api/layers", "/api/docs", "/api/openapi.json", "/api/changes"]
    paths += ["/api/layers/radar"]
    paths += [f"/api/layers/{lid}" for lid in BUILDERS]
    paths += [
        "/api/layers/complaints_311?f.window=7d&borough=BK&bbox=-74.1,40.5,-73.7,40.9&limit=3",
        "/api/entities/tide_gauge/8518750",
        "/api/entities/tide_gauge/8518750/series?metrics=water_level_ft,predicted_ft&ahead=12",
        f"/api/entities/camera/{quote(CAM, safe='')}",
        "/api/events?layer=subway_alerts&status=all",
        "/api/events?layer=elevator_outages",
        "/api/events?layer=nws_alerts",
        "/api/events/mta_subway_alerts/syn:alert:ok",
        "/api/entities/camera/nope",
    ]
    for p in paths:
        assert client.get(p).status_code in (200, 404), p
    assert sha(settings.state_db) == before


def test_api_connection_rejects_writes(settings):
    conn = connect_ro(settings.state_db)
    try:
        with pytest.raises(sqlite3.OperationalError, match="readonly"):
            conn.execute("CREATE TABLE x (a)")
        with pytest.raises(sqlite3.OperationalError, match="readonly"):
            conn.execute("DELETE FROM events")
    finally:
        conn.close()


def test_api_package_never_imports_writers():
    banned_names = {"StateStore", "write_part", "export_runs", "compact", "compact_partition"}
    banned_modules = {"nyclive.collect.pipeline", "nyclive.collect.scheduler"}
    for path in API_DIR.rglob("*.py"):
        tree = ast.parse(path.read_text(encoding="utf-8"))
        for node in ast.walk(tree):
            if isinstance(node, ast.ImportFrom):
                assert node.module not in banned_modules, path
                assert not {a.name for a in node.names} & banned_names, path
            elif isinstance(node, ast.Import):
                assert not {a.name for a in node.names} & banned_modules, path
            elif isinstance(node, ast.Name | ast.Attribute):
                name = node.id if isinstance(node, ast.Name) else node.attr
                assert name not in {"StateStore", "write_part"}, path

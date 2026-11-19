"""Group 7: health states (ok / stale / degraded / never) and collector state, injected clock."""

import sqlite3
from datetime import timedelta

from conftest import COLLECTED, KEYLESS, NOW, RAN_AT, seed
from fastapi.testclient import TestClient

from nyclive.api.app import create_app
from nyclive.settings import Settings


def health(settings, now):
    r = TestClient(create_app(settings, now=lambda: now, web_dist=None)).get("/api/health")
    assert r.status_code == 200
    return r.json()


def test_all_ok_when_fresh(client):
    h = client.get("/api/health").json()
    assert h["now"] == "2026-11-15T03:30:00Z"
    assert h["collector"]["state"] == "running"
    n = len(COLLECTED)
    assert len(h["sources"]) == n
    assert h["summary"] == {"ok": n, "stale": 0, "degraded": 0, "never": 0}
    src = {s["id"]: s for s in h["sources"]}
    cb = src["citibike_station_status"]
    assert cb["age_s"] == 120 and cb["runs_24h"] == 1 and cb["ok_24h"] == 1
    assert "citibike" in cb["layers"]
    assert set(src["mta_subway_stations"]["layers"]) >= {"subway_stations", "subway_alerts"}


def test_stale_never_degraded(tmp_path):
    settings = seed(tmp_path, ["citibike_station_status", "nyc_311"], extras=False)
    conn = sqlite3.connect(settings.state_db)  # test-side write, not the API
    conn.execute(
        "INSERT INTO source_state (source, last_attempt, consecutive_failures, last_error)"
        " VALUES ('dot_cameras', ?, 3, 'boom')",
        (RAN_AT.isoformat(timespec="microseconds"),),
    )
    conn.commit()
    conn.close()
    later = NOW + timedelta(minutes=10)  # citibike status cadence 60 s: stale after 180 s
    h = health(settings, later)
    st = {s["id"]: s["state"] for s in h["sources"]}
    assert st["citibike_station_status"] == "stale"
    assert st["nyc_311"] == "ok"
    assert st["dot_cameras"] == "degraded"
    assert st["openmeteo_current"] == "never"
    assert h["summary"]["never"] == len(KEYLESS) - 3 and h["summary"]["degraded"] == 1
    assert "mta_bus_time" not in st  # no key in these settings, so not "never run" (ADR-018)
    assert h["collector"]["state"] == "stalled"  # last attempt is 12 minutes old
    assert health(settings, NOW)["collector"]["state"] == "running"


def test_unknown_collector_and_missing_db(tmp_path):
    (tmp_path / "x").mkdir()
    app = create_app(
        Settings(data_dir=tmp_path, user_agent="t"),
        now=lambda: NOW,
        web_dist=None,
    )
    r = TestClient(app).get("/api/health")
    assert r.status_code == 503 and r.json()["error"]["code"] == "unavailable"
    conn = sqlite3.connect(tmp_path / "state.db")
    conn.execute("CREATE TABLE source_state (source TEXT, last_attempt TEXT, last_success TEXT,"
                 " last_error TEXT, consecutive_failures INTEGER, rows_last_run INTEGER,"
                 " lag_s REAL)")  # fmt: skip
    conn.execute("CREATE TABLE runs (source TEXT, started_at TEXT, ok INTEGER)")
    conn.commit()
    conn.close()
    h = TestClient(app).get("/api/health").json()
    assert h["collector"]["state"] == "unknown" and h["summary"]["never"] == len(KEYLESS)

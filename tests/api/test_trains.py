"""subway_trains layer (plan I3b): track geometry, t0/t1, staleness, notes and build time."""

import json
import random
import sqlite3
import time
from datetime import UTC, datetime, timedelta
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from nyclive.api.app import create_app
from nyclive.api.layers import trains
from nyclive.api.layers.common import Ctx, iso
from nyclive.settings import Settings
from nyclive.storage.state import EVENT_COLS, StateStore, ts

HERE = Path(__file__).parent
SMALL = HERE / "trains_data" / "static_small.json"
SID = "mta_subway_realtime"
NOW = datetime(2026, 11, 16, 12, 0, tzinfo=UTC)
PROPS = {"id", "borough", "route", "line", "color", "dir", "headsign", "next_stop", "next_name",
         "prev_name", "t0", "t1", "run_s", "at_stop", "seen_at"}  # fmt: skip


def row(event_id, route, dir_, stop, updated_s=-40, seen_s=-10, ended=False, source=SID):
    t_up, t_seen = NOW + timedelta(seconds=updated_s), NOW + timedelta(seconds=seen_s)
    props = json.dumps({"dir": dir_, "route": route, "stop": stop}, sort_keys=True)
    return {
        "source": source, "event_id": event_id, "category": "train", "subtype": route,
        "title": f"{route} train", "starts_at": ts(t_up - timedelta(hours=1)),
        "ends_at": ts(t_seen) if ended else None, "severity": 0, "lat": None, "lon": None,
        "geometry_wkt": None, "borough": None, "entity_refs": json.dumps([]), "props": props,
        "payload_hash": "h", "first_seen": ts(t_up), "updated_at": ts(t_up),
        "last_seen": ts(t_seen),
    }  # fmt: skip


def write_db(data_dir: Path, rows: list[dict]) -> Settings:
    settings = Settings(data_dir=data_dir, user_agent="t")
    StateStore(settings.state_db).close()
    con = sqlite3.connect(settings.state_db)
    marks = ",".join("?" for _ in EVENT_COLS)
    con.executemany(
        f"INSERT INTO events ({','.join(EVENT_COLS)}) VALUES ({marks})",
        [tuple(r[c] for c in EVENT_COLS) for r in rows],
    )
    con.commit()
    con.close()
    return settings


def get(settings: Settings) -> dict:
    client = TestClient(create_app(settings, now=lambda: NOW, web_dist=None))
    r = client.get("/api/layers/subway_trains")
    assert r.status_code == 200, r.text
    return r.json()


@pytest.fixture
def small_static(monkeypatch):
    monkeypatch.setattr(trains, "STATIC_PATH", SMALL)


ROWS = [
    row("20261116:100000_1..N03R", "1", "N", "103"),  # prev 101 from the pattern
    row("20261116:100100_1..N15X", "1", "N", "106"),  # unknown shape: prev from the fallback
    row("20261116:100200_1..N03R", "1", "N", "101"),  # origin of its pattern: at the stop
    row("20261116:100300_1..N03R", "1", "N", "104"),  # prev 103 but no track for 103>104
    row("20261116:100400_9..S", "9", "S", "A01"),  # unknown route, no prev
    row("20261116:100500_1..N03R", "1", "N", "H19"),  # stop not in static: unlocated
    row("20261116:100600_1..N03R", "1", "N", "103", seen_s=-121),  # not seen for > 120 s
    row("20261116:100700_1..N03R", "1", "N", "103", ended=True),  # trip closed
    row("20261116:100800_1..N03R", "1", "N", "103", seen_s=300),  # "seen" after now
    row("x", "1", "N", "103", source="mta_subway_alerts"),  # other source
]


@pytest.fixture
def body(tmp_path, small_static):
    return get(write_db(tmp_path, ROWS))


def feats(body) -> dict[str, dict]:
    return {f["properties"]["id"]: f for f in body["features"]}


def test_shape_and_props(body):
    f = feats(body)
    assert sorted(f) == [
        "20261116:100000_1..N03R",
        "20261116:100100_1..N15X",
        "20261116:100200_1..N03R",
        "20261116:100300_1..N03R",
        "20261116:100400_9..S",
    ]
    meta = body["meta"]
    assert meta["unlocated"] == 1 and meta["note"] is None
    assert meta["data_as_of"] == iso(NOW - timedelta(seconds=10))
    for feat in f.values():
        p = feat["properties"]
        assert set(p) == PROPS and p["borough"] is None
        assert type(p["run_s"]) is int and type(p["at_stop"]) is bool
        assert p["seen_at"] == iso(NOW - timedelta(seconds=10))
        assert feat["geometry"]["type"] == ("Point" if p["at_stop"] else "LineString")


def test_prev_stop_from_pattern(body):
    f = feats(body)["20261116:100000_1..N03R"]
    p = f["properties"]
    assert f["geometry"] == {
        "type": "LineString",
        "coordinates": [[-73.99, 40.75], [-73.985, 40.756], [-73.98, 40.76]],
    }
    assert p["route"] == "1" and p["line"] == "123" and p["color"] == "#d82233"
    assert p["dir"] == "N" and p["headsign"] == "Delta Pl"
    assert (p["next_stop"], p["next_name"], p["prev_name"]) == ("103", "Bravo Av", "Alpha St")
    assert p["t0"] == iso(NOW - timedelta(seconds=40))
    assert p["t1"] == iso(NOW + timedelta(seconds=50)) and p["run_s"] == 90
    assert p["at_stop"] is False


def test_prev_stop_fallback(body):
    p = feats(body)["20261116:100100_1..N15X"]["properties"]
    assert p["prev_name"] == "Charlie Sq" and p["next_name"] == "Delta Pl"
    assert p["run_s"] == 60 and p["at_stop"] is False
    assert p["headsign"] == "Delta Pl"  # "1..N" shapes' usual headsign


def test_at_stop_points(body):
    f = feats(body)
    origin = f["20261116:100200_1..N03R"]
    assert origin["geometry"] == {"type": "Point", "coordinates": [-73.99, 40.75]}
    p = origin["properties"]
    assert p["at_stop"] is True and p["run_s"] == 0 and p["t0"] == p["t1"]
    assert p["prev_name"] is None
    noseg = f["20261116:100300_1..N03R"]
    assert noseg["geometry"]["type"] == "Point"
    assert noseg["properties"]["prev_name"] == "Bravo Av" and noseg["properties"]["at_stop"]
    other = f["20261116:100400_9..S"]["properties"]
    assert other["line"] == "S" and other["color"] == "#7c858c" and other["headsign"] == ""


def test_old_rows_note(tmp_path, small_static):
    stale = [row("20261116:100000_1..N03R", "1", "N", "103", seen_s=-300)]
    body = get(write_db(tmp_path / "a", stale))
    assert body["features"] == [] and body["meta"]["note"] == "MTA feed 5 min old"
    recent = [row("20261116:100000_1..N03R", "1", "N", "103", seen_s=-100)]
    body = get(write_db(tmp_path / "b", recent))
    assert len(body["features"]) == 1 and body["meta"]["note"] == "MTA feed 2 min old"
    body = get(write_db(tmp_path / "c", []))
    assert body["features"] == [] and body["meta"]["note"] is None


def test_static_missing(tmp_path, monkeypatch):
    monkeypatch.setattr(trains, "STATIC_PATH", tmp_path / "nope.json")
    body = get(write_db(tmp_path, ROWS))
    assert body["features"] == [] and body["meta"]["note"] == "STATIC GTFS NOT BUILT"
    assert body["meta"]["data_as_of"] == iso(NOW - timedelta(seconds=10))


def test_committed_static_file():
    """config/subway_static.json: format I4c, within budget."""
    path = trains.REPO_ROOT / "config" / "subway_static.json"
    assert path.stat().st_size <= 1_500_000
    doc = json.loads(path.read_text(encoding="utf-8"))
    assert doc["version"] == 1
    assert {"routes", "stops", "patterns", "headsigns", "prev", "segments"} <= set(doc)
    lines = {"123", "456", "7", "ACE", "BDFM", "G", "JZ", "L", "NQRW", "S", "SIR"}
    assert {r["line"] for r in doc["routes"].values()} == lines
    assert doc["routes"]["A"]["color"] == "#0062cf"
    assert doc["patterns"]["1..N03R"][0] == "142"  # South Ferry
    for key, seg in doc["segments"].items():
        a, b = key.split(">")
        assert a in doc["stops"] and b in doc["stops"]
        assert len(seg["c"]) >= 2 and isinstance(seg["s"], int)
        assert all(round(x, 5) == x and round(y, 5) == y for x, y in seg["c"])


def test_600_trains_build_fast(tmp_path):
    """Plan check: 600 trains (a rush-hour feed) build in < 150 ms with the real static file."""
    static = trains.load_static()
    assert static is not None
    rng = random.Random(3)
    keys = sorted(static.prev)
    rows = []
    for i in range(600):
        route, dir_, stop = rng.choice(keys).split(":")
        shape = rng.choice([s for s in static.patterns if s.startswith(f"{route}.")] or ["x"])
        rows.append(row(f"20261116:{i:06d}_{shape}", route, dir_, stop))
    settings = write_db(tmp_path, rows)
    conn = sqlite3.connect(settings.state_db.resolve().as_uri() + "?mode=ro", uri=True)
    conn.row_factory = sqlite3.Row
    ctx = Ctx(conn=conn, now=NOW, services=None, layer={})
    best = float("inf")
    for _ in range(5):
        t0 = time.perf_counter()
        result = trains.subway_trains(ctx)
        best = min(best, time.perf_counter() - t0)
    conn.close()
    lines = sum(1 for f in result.features if f["geometry"]["type"] == "LineString")
    print(f"\nsubway_trains build: 600 rows -> {len(result.features)} features "
          f"({lines} LineString) in {best * 1000:.1f} ms")  # fmt: skip
    assert len(result.features) + result.unlocated == 600
    assert lines > 400
    assert best < 0.150


def test_subway_lines_one_feature_per_stop_pair(small_static, tmp_path):
    """The faint track under the trains: each pair once, coloured by the route that runs it."""
    settings = write_db(tmp_path, [])
    client = TestClient(create_app(settings, now=lambda: NOW, web_dist=None))
    r = client.get("/api/static/subway_lines")
    assert r.status_code == 200 and r.headers["etag"]
    feats = r.json()["features"]
    assert len(feats) == 2  # 101>103 and 104>106
    by_routes = {tuple(f["geometry"]["coordinates"][0]): f["properties"] for f in feats}
    assert by_routes[(-73.99, 40.75)] == {"color": "#d82233", "line": "123", "routes": ["1"]}
    again = client.get("/api/static/subway_lines", headers={"If-None-Match": r.headers["etag"]})
    assert again.status_code == 304


def test_subway_lines_draw_both_directions_once():
    seg = {"c": [[0, 0], [1, 1]], "s": 60}
    static = trains.Static.from_doc({
        "routes": {"4": {"color": "#00933c", "line": "456"}, "5": {"color": "#00933c", "line": "456"}},
        "patterns": {"4..N01R": ["a", "b"], "4..S01R": ["b", "a"], "5..N01R": ["a", "b"]},
        "segments": {"a>b": seg, "b>a": {"c": [[1, 1], [0, 0]], "s": 60}},
    })  # fmt: skip
    (f,) = trains.subway_lines(static)["features"]
    assert f["properties"] == {"color": "#00933c", "line": "456", "routes": ["4", "5"]}


def test_subway_lines_real_static_is_small():
    lines = trains.subway_lines(trains.load_static())
    assert len(lines["features"]) > 400
    assert all(f["properties"]["routes"] for f in lines["features"])
    assert len(json.dumps(lines)) < 400_000

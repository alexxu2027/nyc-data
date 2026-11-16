"""Pipeline + storage behaviour (ADR-011), driven by real fixtures and fake adapters."""

from dataclasses import replace
from datetime import UTC, datetime, timedelta

import pyarrow.compute as pc
import pytest
from helpers import load_fixture

from nyclive.collect.pipeline import SimulatedCrash, run_once
from nyclive.model import Event
from nyclive.registry import load_registry
from nyclive.sources import citibike, noaa_tides
from nyclive.sources.base import Adapter, Batch, RawPart, RawPayload
from nyclive.storage import archive
from nyclive.storage.state import StateStore
from nyclive.storage.state import ts as ts_

REG = load_registry()
STATUS = REG.sources["citibike_station_status"]


@pytest.fixture
def store(tmp_path):
    with StateStore(tmp_path / "state.db") as s:
        yield s


def at(raw: RawPayload, when: datetime) -> RawPayload:
    return replace(raw, parts=tuple(replace(p, fetched_at=when) for p in raw.parts))


HOLDERS: dict[int, dict] = {}


def fixed(raw: RawPayload, parse, sid: str) -> Adapter:
    """An adapter whose fetch returns a canned payload; change it with set_raw()."""
    holder = {"raw": raw}
    a = Adapter("fixed", (sid,), lambda ctx: holder["raw"], parse)
    HOLDERS[id(a)] = holder
    return a


def set_raw(a: Adapter, raw: RawPayload) -> None:
    HOLDERS[id(a)]["raw"] = raw


def get_raw(a: Adapter) -> RawPayload:
    return HOLDERS[id(a)]["raw"]


def clock(t):
    return lambda: t


def obs_rows(archive_dir, sid, day):
    return archive.read_table(archive_dir, sid, "observations", [day])


T1 = datetime(2026, 11, 14, 15, 0, tzinfo=UTC)


def status_adapter():
    raw = at(load_fixture("citibike_station_status"), T1)
    return fixed(raw, citibike.parse, STATUS.id), raw


def test_change_only_and_keyframes(store, tmp_path):
    arch = tmp_path / "archive"
    a, raw = status_adapter()
    n_keys = len(citibike.parse(raw).observations)

    r1 = run_once(STATUS, a, None, store, arch, now=clock(T1))
    assert r1.ok and r1.rows_written == n_keys  # first run of the day = keyframe
    assert store.count("latest", STATUS.id) == n_keys

    r2 = run_once(STATUS, a, None, store, arch, now=clock(T1))
    assert r2.ok and r2.rows_written == 0  # nothing changed

    # One station's bikes change, an hour later.
    import json

    doc = json.loads(raw.part("station_status").content)
    st = doc["data"]["stations"][0]
    st["num_bikes_available"] += 1
    st["last_reported"] += 3600
    body = json.dumps(doc).encode()
    t2 = T1 + timedelta(hours=1)
    set_raw(
        a,
        at(
            replace(
                raw,
                parts=(raw.part("manifest"), replace(raw.part("station_status"), content=body)),
            ),
            t2,
        ),
    )
    r3 = run_once(STATUS, a, None, store, arch, now=clock(t2))
    assert r3.rows_written == 1

    # Next UTC day: keyframe again, even though nothing changed.
    t3 = T1 + timedelta(days=1)
    set_raw(a, at(get_raw(a), t3))
    r4 = run_once(STATUS, a, None, store, arch, now=clock(t3))
    assert r4.rows_written == n_keys
    assert len(obs_rows(arch, STATUS.id, t3.date())) == n_keys


def test_as_of_reads_keyframe_day(store, tmp_path):
    arch = tmp_path / "archive"
    a, raw = status_adapter()
    run_once(STATUS, a, None, store, arch, now=clock(T1))
    stations = {o.entity_id for o in citibike.parse(raw).observations}
    snap = archive.as_of_observations(arch, STATUS.id, T1 + timedelta(minutes=5))
    bikes = snap.filter(pc.equal(snap["metric"], "bikes_available"))
    assert set(bikes["entity_id"].to_pylist()) == stations


def test_restart_after_crash_leaves_no_duplicates_after_compact(store, tmp_path):
    """ROADMAP Phase 1 acceptance: crash between archive write and state commit."""
    arch = tmp_path / "archive"
    a, raw = status_adapter()
    n_keys = len(citibike.parse(raw).observations)

    def crash():
        raise SimulatedCrash()

    with pytest.raises(SimulatedCrash):
        run_once(STATUS, a, None, store, arch, now=clock(T1), after_archive=crash)
    assert store.count("latest", STATUS.id) == 0  # state never committed
    run_once(STATUS, a, None, store, arch, now=clock(T1))  # restart rewrites the same rows

    parts = archive.partition_files(arch, STATUS.id, "observations", T1.date())
    assert len(parts) == 2  # duplicate part on disk...
    assert len(obs_rows(arch, STATUS.id, T1.date())) == n_keys  # ...but reads dedupe

    done = archive.compact(arch, now=T1 + timedelta(days=1, hours=2))
    assert done
    files = archive.partition_files(arch, STATUS.id, "observations", T1.date())
    assert [f.name for f in files] == [archive.COMPACTED]
    import pyarrow.parquet as pq

    t = pq.read_table(files[0])
    keys = set(zip(*(t[c].to_pylist() for c in ("kind", "entity_id", "metric", "observed_at"))))
    assert t.num_rows == n_keys == len(keys)
    assert archive.compact(arch, now=T1 + timedelta(days=1, hours=2)) == []  # idempotent


def test_compact_skips_open_days(store, tmp_path):
    arch = tmp_path / "archive"
    a, _ = status_adapter()
    run_once(STATUS, a, None, store, arch, now=clock(T1))
    # 00:30 the next day is inside the grace period, so T1's day is not closed yet.
    assert archive.compact(arch, now=datetime(2026, 11, 15, 0, 30, tzinfo=UTC)) == []


def test_failing_source_is_isolated(store, tmp_path):
    """ROADMAP Phase 1 acceptance (pipeline half): a failing source records failures and the
    others keep writing. The scheduler's `degraded` backoff is tested with the scheduler."""
    arch = tmp_path / "archive"

    def boom(ctx):
        raise RuntimeError("feed down")

    bad = Adapter("bad", ("noaa_tide_battery",), boom, noaa_tides.parse)
    noaa = REG.sources["noaa_tide_battery"]
    for i in range(3):
        r = run_once(noaa, bad, None, store, arch, now=clock(T1))
        assert not r.ok and r.consecutive_failures == i + 1 and "feed down" in r.error
    a, _ = status_adapter()
    assert run_once(STATUS, a, None, store, arch, now=clock(T1)).ok
    assert store.source_state("noaa_tide_battery")["consecutive_failures"] == 3
    assert store.count("runs") == 4


def test_noaa_cursor_and_predictions_not_rewritten(store, tmp_path):
    arch = tmp_path / "archive"
    noaa = REG.sources["noaa_tide_battery"]
    raw = load_fixture("noaa_tide_battery")
    a = fixed(raw, noaa_tides.parse, noaa.id)
    t = raw.fetched_at
    r1 = run_once(noaa, a, None, store, arch, now=clock(t))
    assert r1.rows_written > 0
    assert store.source_state(noaa.id)["cursor"] == noaa_tides.parse(raw).cursor
    r2 = run_once(noaa, a, None, store, arch, now=clock(t))
    assert r2.rows_written == 0


def test_invalid_records_are_dropped_not_fatal(store, tmp_path):
    from nyclive.model import Observation

    sid = "noaa_tide_battery"

    def parse(raw):
        good = Observation(sid, "tide_gauge", "1", "water_level_ft", T1, 1.0, T1)
        bad = Observation(sid, "tide_gauge", "1", "not_a_metric", T1, 1.0, T1)
        return Batch(observations=[good, bad])

    raw = RawPayload(sid, (RawPart("body", "u", b"{}", T1),))
    r = run_once(REG.sources[sid], fixed(raw, parse, sid), None, store, tmp_path, now=clock(T1))
    assert r.ok and r.rows_written == 1 and r.dropped == 1
    assert "dropped 1" in store.runs_between("2026", "2027")[0]["error"]


def test_events_version_log_and_closing(store, tmp_path):
    arch = tmp_path / "archive"
    sid = "mta_subway_alerts"
    src = REG.sources[sid]

    def make(events):
        def parse(raw):
            return Batch(events=list(events), complete=frozenset({"events"}))

        return parse

    e1 = Event(sid, "a1", "service_alert", "A trains delayed", T1, entity_refs=("subway_route:A",))
    e2 = Event(sid, "a2", "service_alert", "L suspended", T1)
    raw = RawPayload(sid, (RawPart("body", "u", b"{}", T1),))
    a = Adapter("x", (sid,), lambda ctx: raw, make([e1, e2]))
    assert run_once(src, a, None, store, arch, now=clock(T1)).rows_written == 2
    assert run_once(src, a, None, store, arch, now=clock(T1)).rows_written == 0  # unchanged

    t2 = T1 + timedelta(minutes=5)
    raw2 = at(raw, t2)
    e1b = replace(e1, title="A trains delayed (updated)")
    a2 = Adapter("x", (sid,), lambda ctx: raw2, make([e1b]))  # a2 left the feed
    assert run_once(src, a2, None, store, arch, now=clock(t2)).rows_written == 2

    open_now = store.events_for(sid, open_only=True)
    assert set(open_now) == {"a1"}
    closed = store.events_for(sid)["a2"]
    assert closed["ends_at"] == t2.isoformat(timespec="microseconds")
    assert "left_feed" in closed["props"]

    versions = archive.read_table(arch, sid, "events", [T1.date()])
    assert sorted(versions["event_id"].to_pylist()) == ["a1", "a1", "a2", "a2"]


def test_export_runs(store, tmp_path):
    arch = tmp_path / "archive"
    a, _ = status_adapter()
    run_once(STATUS, a, None, store, arch, now=clock(T1))
    day = T1.date()
    runs = store.runs_between(day.isoformat(), (day + timedelta(days=1)).isoformat())
    path = archive.export_runs(arch, day, runs)
    t = archive.read_table(arch, archive.RUNS_SOURCE, "runs", [day])
    assert path and t.num_rows == 1 and t["ok"].to_pylist() == [True]
    assert archive.export_runs(arch, day, runs) is None  # already exported


def test_compact_open_day_then_keep_writing(store, tmp_path):
    arch = tmp_path / "archive"
    a, raw = status_adapter()
    n_keys = len(citibike.parse(raw).observations)
    run_once(STATUS, a, None, store, arch, now=clock(T1))
    assert archive.compact(arch, now=T1) == []  # open day untouched by default
    assert archive.compact(arch, now=T1, include_open=True)
    # A later run in the same day adds a part next to compacted.parquet.
    import json

    doc = json.loads(raw.part("station_status").content)
    doc["data"]["stations"][0]["num_bikes_available"] += 5
    doc["data"]["stations"][0]["last_reported"] += 60
    t2 = T1 + timedelta(minutes=1)
    body = json.dumps(doc).encode()
    set_raw(
        a,
        at(
            replace(
                raw, parts=(raw.part("manifest"), replace(raw.part("station_status"), content=body))
            ),
            t2,
        ),
    )
    run_once(STATUS, a, None, store, arch, now=clock(t2))
    names = sorted(
        f.name for f in archive.partition_files(arch, STATUS.id, "observations", T1.date())
    )
    assert names[0] == archive.COMPACTED and len(names) == 2
    assert len(obs_rows(arch, STATUS.id, T1.date())) == n_keys + 1
    archive.compact(arch, now=t2, include_open=True)
    assert len(archive.partition_files(arch, STATUS.id, "observations", T1.date())) == 1
    assert len(obs_rows(arch, STATUS.id, T1.date())) == n_keys + 1


def test_prune_keeps_old_closed_events_that_are_still_being_sent(store, tmp_path):
    """Regression (2026-11-15): pruning by ends_at made collisions re-write every run."""
    arch = tmp_path / "archive"
    sid = "nyc_collisions"
    src = REG.sources[sid]
    old = T1 - timedelta(days=9)
    ev = Event(sid, "c1", "collision", "Collision", old, old)  # instant, ended 9 days ago

    def parse(raw):
        return Batch(events=[ev])

    raw = RawPayload(sid, (RawPart("body", "u", b"{}", T1),))
    a = Adapter("x", (sid,), lambda ctx: raw, parse)
    assert run_once(src, a, None, store, arch, now=clock(T1)).rows_written == 1
    store.prune(ts_(T1 - timedelta(days=7)))  # it was seen today, so it stays
    assert store.count("events", sid) == 1
    assert run_once(src, a, None, store, arch, now=clock(T1)).rows_written == 0
    store.prune(ts_(T1 + timedelta(days=8)))  # not seen for 8 days: now it goes
    assert store.count("events", sid) == 0


def test_state_v1_migrates_to_v2(tmp_path):
    import sqlite3

    db = tmp_path / "old.db"
    con = sqlite3.connect(db)
    con.executescript(
        "CREATE TABLE events (source TEXT NOT NULL, event_id TEXT NOT NULL, category TEXT,"
        " subtype TEXT, title TEXT, starts_at TEXT, ends_at TEXT, severity INTEGER, lat REAL,"
        " lon REAL, geometry_wkt TEXT, borough TEXT, entity_refs TEXT, props TEXT,"
        " payload_hash TEXT, first_seen TEXT, updated_at TEXT, PRIMARY KEY (source, event_id));"
        "INSERT INTO events (source, event_id, updated_at) VALUES ('s', 'e', '2026-01-01');"
        "PRAGMA user_version=1;"
    )
    con.close()
    with StateStore(db) as s:
        assert s.events_for("s")["e"]["last_seen"] == "2026-01-01"


def _events_adapter(sid, events_by_run):
    """An adapter whose parse returns the next list of events each run (complete feed)."""
    runs = iter(events_by_run)

    def parse(raw):
        return Batch(events=list(next(runs)), complete=frozenset({"events"}))

    return parse


def test_superseded_event_with_future_end_is_closed(store, tmp_path):
    """Review finding 2: only ends_at=None events used to be closed."""
    arch, sid = tmp_path / "archive", "nws_alerts"
    warn = Event(sid, "w1", "weather_alert", "Flash Flood Warning", T1, T1 + timedelta(hours=2))
    upd = Event(
        sid, "w2", "weather_alert", "Flash Flood Warning (upd)", T1, T1 + timedelta(hours=3)
    )
    raw1 = RawPayload(sid, (RawPart("active", "u", b"{}", T1),))
    t2 = T1 + timedelta(minutes=10)
    raw2 = at(raw1, t2)
    parse = _events_adapter(sid, [[warn], [upd]])
    raws = iter([raw1, raw2])
    a = Adapter("x", (sid,), lambda ctx: next(raws), parse)
    run_once(REG.sources[sid], a, None, store, arch, now=clock(T1))
    run_once(REG.sources[sid], a, None, store, arch, now=clock(t2))
    w1 = store.events_for(sid)["w1"]
    assert w1["ends_at"] == ts_(t2) and '"left_feed"' in w1["props"]


def test_event_leaving_before_it_starts_ends_at_its_start(store, tmp_path):
    """Review finding 3: a cancelled planned outage must not get ends_at < starts_at."""
    arch, sid = tmp_path / "archive", "mta_elevator_outages"
    future = T1 + timedelta(days=3)
    planned = Event(sid, "EL1:x", "elevator_outage", "Planned outage", future)
    other = Event(sid, "EL2:y", "elevator_outage", "Other outage", T1)
    raws = iter(
        [
            RawPayload(sid, (RawPart("outages", "u", b"[]", T1),)),
            RawPayload(sid, (RawPart("outages", "u", b"[]", T1 + timedelta(hours=1)),)),
        ]
    )
    a = Adapter(
        "x", (sid,), lambda ctx: next(raws), _events_adapter(sid, [[planned, other], [other]])
    )
    run_once(REG.sources[sid], a, None, store, arch, now=clock(T1))
    run_once(REG.sources[sid], a, None, store, arch, now=clock(T1 + timedelta(hours=1)))
    closed = store.events_for(sid)["EL1:x"]
    assert closed["ends_at"] == closed["starts_at"] == ts_(future)
    assert "left_feed_before_start" in closed["props"]
    versions = archive.read_table(arch, sid, "events", [T1.date()]).to_pylist()
    assert all(v["ends_at"] is None or v["ends_at"] >= v["starts_at"] for v in versions)


def test_prune_drops_long_open_unseen_events(store, tmp_path):
    """Review finding 5: 311 requests that never close used to stay in state forever."""
    sid = "nyc_311"
    ev = Event(sid, "r1", "complaint_311", "Noise", T1)  # open, never closes
    raw = RawPayload(sid, (RawPart("new-000", "u", b"[]", T1),))
    a = Adapter("x", (sid,), lambda ctx: raw, lambda raw: Batch(events=[ev]))
    run_once(REG.sources[sid], a, None, store, tmp_path, now=clock(T1))
    store.prune(ts_(T1 + timedelta(days=30)), ts_(T1 + timedelta(days=30)))
    assert store.count("events", sid) == 0


def test_events_for_run_loads_batch_ids_and_active_only(store, tmp_path):
    """The open-events fix (2026-11-16): a run loads its own ids + still-active events only."""
    sid = "mta_trains"
    t_old = T1 - timedelta(hours=2)
    rows = [
        # (event_id, ends_at)
        ("open", None),
        ("future_end", ts_(T1 + timedelta(hours=1))),
        ("closed", ts_(t_old)),
        ("closed_in_batch", ts_(t_old)),
    ] + [(f"bulk{i:04d}", ts_(t_old)) for i in range(1200)]
    store._conn.executemany(
        "INSERT INTO events (source, event_id, starts_at, ends_at, payload_hash, first_seen,"
        " last_seen, updated_at) VALUES (?, ?, ?, ?, 'h', ?, ?, ?)",
        [(sid, e, ts_(t_old), end, ts_(t_old), ts_(t_old), ts_(t_old)) for e, end in rows],
    )
    store._conn.commit()
    batch_ids = ["closed_in_batch", "new"] + [f"bulk{i:04d}" for i in range(0, 1200, 2)]
    got = store.events_for_run(sid, batch_ids, active_at=ts_(T1))
    want = {"open", "future_end", "closed_in_batch"} | {f"bulk{i:04d}" for i in range(0, 1200, 2)}
    assert set(got) == want  # chunked IN (> 500 ids) works; "closed" and "new" are absent
    assert set(store.events_for_run(sid, ["closed"])) == {"closed"}  # incomplete feed: ids only


def test_pipeline_does_not_load_every_stored_event(store, tmp_path, monkeypatch):
    """A complete feed still closes events and keeps first_seen without a full events load."""
    arch, sid = tmp_path / "archive", "nws_alerts"
    a1 = Event(sid, "a1", "weather_alert", "Wind Advisory", T1)
    a2 = Event(sid, "a2", "weather_alert", "Flood Watch", T1)
    t2, t3 = T1 + timedelta(minutes=10), T1 + timedelta(minutes=20)
    raws = iter(RawPayload(sid, (RawPart("active", "u", b"{}", t),)) for t in (T1, t2, t3))
    parse = _events_adapter(sid, [[a1, a2], [a1], [a1]])
    a = Adapter("x", (sid,), lambda ctx: next(raws), parse)
    run_once(REG.sources[sid], a, None, store, arch, now=clock(T1))

    def boom(*args, **kwargs):
        raise AssertionError("pipeline must not call events_for")

    monkeypatch.setattr(StateStore, "events_for", boom)
    run_once(REG.sources[sid], a, None, store, arch, now=clock(t2))  # a2 leaves -> closed
    assert run_once(REG.sources[sid], a, None, store, arch, now=clock(t3)).rows_written == 0
    monkeypatch.undo()
    ev = store.events_for(sid)
    assert ev["a2"]["ends_at"] == ts_(t2)
    assert ev["a1"]["ends_at"] is None and ev["a1"]["first_seen"] == ts_(T1)

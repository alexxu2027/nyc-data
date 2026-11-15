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

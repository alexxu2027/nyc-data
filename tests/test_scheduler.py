from datetime import UTC, datetime, timedelta

import pytest
from helpers import load_fixture

from nyclive.collect.scheduler import Collector, SingleInstance, backoff_s
from nyclive.registry import load_registry
from nyclive.settings import load_settings
from nyclive.sources import citibike
from nyclive.sources.base import Adapter
from nyclive.status import render, source_rows
from nyclive.storage import archive

REG = load_registry()
T = datetime(2026, 11, 14, 15, 0, tzinfo=UTC)


class Clock:
    def __init__(self, t):
        self.t = t

    def __call__(self):
        return self.t


def boom(ctx):
    raise RuntimeError("feed down")


def make(tmp_path, clock):
    settings = load_settings(env={"NYCLIVE_DATA_DIR": str(tmp_path)}, dotenv=None)
    raw = load_fixture("citibike_station_status")
    from dataclasses import replace

    raw = replace(raw, parts=tuple(replace(p, fetched_at=clock.t) for p in raw.parts))
    adapters = {
        "citibike_station_status": Adapter(
            "c", citibike.SOURCE_IDS, lambda ctx: raw, citibike.parse
        ),
        "noaa_tide_battery": Adapter("n", ("noaa_tide_battery",), boom, lambda raw: None),
    }
    return Collector(
        REG,
        settings,
        only=["citibike_station_status", "noaa_tide_battery"],
        adapters=adapters,
        http=None,
        now=clock,
    )


def test_backoff_curve():
    assert [backoff_s(360, n) for n in (0, 2, 3, 4, 5)] == [0, 0, 720, 1440, 1800]


def test_failing_source_degrades_and_backs_off_others_keep_writing(tmp_path):
    """ROADMAP Phase 1 acceptance: isolation test."""
    clock = Clock(T)
    c = make(tmp_path, clock)
    try:
        for _ in range(3):
            assert c.run_source("noaa_tide_battery").ok is False
            clock.t += timedelta(seconds=1)
        assert c.run_source("citibike_station_status").ok
        # degraded: the next attempt waits cadence * 2 = 720 s
        assert c.run_source("noaa_tide_battery") is None
        clock.t += timedelta(seconds=721)
        assert c.run_source("noaa_tide_battery").ok is False
        rows = {r["source"]: r for r in source_rows(REG, c.store, clock.t)}
        assert rows["noaa_tide_battery"]["state"] == "degraded"
        assert rows["noaa_tide_battery"]["failures"] == 4
        assert rows["citibike_station_status"]["state"] == "stale"  # 12 min > 3 x 60 s
        assert rows["citibike_gbfs"]["state"] == "never"
        text = render(list(rows.values()))
        assert "feed down" in text and "degraded" in text
    finally:
        c.close()


def test_status_ok_right_after_success(tmp_path):
    clock = Clock(T)
    c = make(tmp_path, clock)
    try:
        c.run_source("citibike_station_status")
        rows = {r["source"]: r for r in source_rows(REG, c.store, T + timedelta(seconds=30))}
        assert rows["citibike_station_status"]["state"] == "ok"
        assert rows["citibike_station_status"]["rows"] > 0
    finally:
        c.close()


def test_maintenance_exports_runs_and_compacts_closed_days(tmp_path):
    clock = Clock(T)
    c = make(tmp_path, clock)
    try:
        c.run_source("citibike_station_status")
        c.run_source("noaa_tide_battery")
        clock.t = T + timedelta(days=1, hours=2)
        c.maintenance()
        runs = archive.read_table(c.settings.archive_dir, archive.RUNS_SOURCE, "runs", [T.date()])
        assert runs.num_rows == 2 and sorted(runs["ok"].to_pylist()) == [False, True]
        files = archive.partition_files(
            c.settings.archive_dir, "citibike_station_status", "observations", T.date()
        )
        assert [f.name for f in files] == [archive.COMPACTED]
        clock.t = T + timedelta(days=8, hours=2)
        c.maintenance()  # prunes runs older than 7 days from state.db
        assert c.store.count("runs") == 0
    finally:
        c.close()


def test_unknown_or_uncollected_ids_are_rejected(tmp_path):
    settings = load_settings(env={"NYCLIVE_DATA_DIR": str(tmp_path)}, dotenv=None)
    with pytest.raises(SystemExit, match="unknown"):
        Collector(REG, settings, only=["nope"], http=None)
    with pytest.raises(SystemExit, match="no adapter"):
        Collector(REG, settings, only=["dot_camera_image"], http=None)  # on demand, no adapter


def test_single_instance_lock(tmp_path):
    lock = tmp_path / "collect.lock"
    with SingleInstance(lock):
        second = SingleInstance(lock)
        with pytest.raises(SystemExit, match="already running"):
            second.__enter__()
    with SingleInstance(lock):  # released after exit
        pass

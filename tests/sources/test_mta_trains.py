"""mta_trains adapter (plan I4b), the archive budget for per-trip events, and an events_for
timing report (ADR-013)."""

import json
import random
import sqlite3
import time
from datetime import UTC, datetime, timedelta

import pytest
from fixtures.make_edges_mta_trains import header, trip, vehicle
from helpers import load_fixture, parse_fixture

from nyclive.collect.pipeline import payload_hash
from nyclive.model import Event
from nyclive.sources import _gtfsrt, mta_trains
from nyclive.sources.base import RawPart, RawPayload
from nyclive.storage import archive
from nyclive.storage.state import EVENT_COLS, StateStore, ts
from nyclive.timeutil import NY

SID = "mta_subway_realtime"


def vehicles_with_stop(raw) -> set[str]:
    ids = set()
    for name in mta_trains.FEEDS:
        for v in _gtfsrt.decode_feed(raw.part(name).content).vehicles:
            if v.trip.trip_id and v.stop_id:
                ids.add(f"{v.trip.start_date}:{v.trip.trip_id}")
    return ids


def test_real_one_event_per_vehicle_with_a_stop():
    raw = load_fixture(SID)
    batch = parse_fixture(SID)
    ids = [e.event_id for e in batch.events]
    assert len(ids) == len(set(ids)) == 260
    assert set(ids) == vehicles_with_stop(raw)
    assert batch.complete == {"events"}
    assert not batch.entities and not batch.observations
    for e in batch.events:
        assert e.category == "train" and e.ends_at is None and e.severity == 0
        assert set(e.props) == {"route", "dir", "stop"}
        assert e.props["dir"] in ("N", "S")
        assert e.props["stop"] == mta_trains.station_id(e.props["stop"])
        assert e.subtype == e.props["route"]
        assert e.entity_refs == (f"subway_route:{e.props['route']}",)
        word = {"N": "northbound", "S": "southbound"}[e.props["dir"]]
        assert e.title == f"{e.props['route']} train {word}"
        assert e.lat is None and e.lon is None
    routes = {e.props["route"] for e in batch.events}
    assert {"1", "7", "A", "H", "FS", "G", "J", "L", "N", "SI"} <= routes


def test_real_direction_and_stop_mapping():
    batch = parse_fixture(SID)
    ev = {e.event_id: e for e in batch.events}
    # no NYCT direction (NORTH is omitted): taken from "..N" in the trip id
    a = ev["20261116:002200_A..N"]
    assert a.props == {"route": "A", "dir": "N", "stop": "A06"}
    # SIR trip ids use a single dot
    si = ev["20261116:009100_SI.N03R"]
    assert si.props == {"route": "SI", "dir": "N", "stop": "S30"}
    assert si.starts_at == datetime(2026, 11, 16, 1, 31, tzinfo=NY).astimezone(UTC)


def test_starts_at_from_origin_code_past_midnight():
    batch = parse_fixture(SID, "edge_synthetic")
    ev = {e.event_id: e for e in batch.events}
    late = ev["20261116:148500_1..N03R"]
    assert late.starts_at == datetime(2026, 11, 17, 0, 45, tzinfo=NY).astimezone(UTC)
    assert late.starts_at == datetime(2026, 11, 17, 5, 45, tzinfo=UTC)
    assert late.props == {"route": "1", "dir": "N", "stop": "103"}


def test_edge_synthetic_skips_and_fallbacks():
    real = {e.event_id for e in parse_fixture(SID).events}
    batch = parse_fixture(SID, "edge_synthetic")
    ids = {e.event_id for e in batch.events}
    assert ids - real == {"20261116:148500_1..N03R", "20261116:151000_6..X"}
    assert len(batch.events) == len(real) + 2  # no stop / no trip / repeat / deleted dropped
    noroute = next(e for e in batch.events if e.event_id == "20261116:151000_6..X")
    assert noroute.props == {"route": "6", "dir": "S", "stop": "635"}


@pytest.mark.parametrize(
    ("case", "match"),
    [
        ("bad_empty_feed", "gtfs-l: feed has no vehicles"),
        ("bad_stale_header", "gtfs-g: feed header is 20 min old"),
        ("bad_truncated", "truncated"),
        ("bad_missing_feed", "expected the 8 feeds"),
    ],
)
def test_bad_cases_raise(case, match):
    with pytest.raises(ValueError, match=match):
        mta_trains.parse(load_fixture(SID, case))


def test_wrong_source_raises():
    raw = load_fixture(SID)
    with pytest.raises(ValueError):
        mta_trains.parse(RawPayload("mta_subway_alerts", raw.parts))


def test_header_without_timestamp_raises():
    raw = load_fixture(SID)
    t = trip("000100_1..N", "1", "20261116")
    bad = header(0) + vehicle("v", t, "101N")
    parts = tuple(
        RawPart(p.name, p.url, bad if p.name == "gtfs" else p.content, p.fetched_at)
        for p in raw.parts
    )
    with pytest.raises(ValueError, match="no timestamp"):
        mta_trains.parse(RawPayload(SID, parts))


def test_helpers():
    assert mta_trains.station_id("A27S") == "A27" and mta_trains.station_id("H19") == "H19"
    assert mta_trains.shape_of("148500_1..N03R") == "1..N03R"
    t = _gtfsrt.TripDescriptor(trip_id="no-origin", start_date="20261116", start_time="25:10:00")
    fallback = datetime(2026, 1, 1, tzinfo=UTC)
    assert mta_trains.starts_at(t, "20261116", fallback) == datetime(
        2026, 11, 17, 1, 10, tzinfo=NY
    ).astimezone(UTC)
    t = _gtfsrt.TripDescriptor(trip_id="no-origin")
    assert mta_trains.starts_at(t, "20261116", fallback) == fallback
    # no start_date: the feed's local date
    assert mta_trains.service_date(t, 1_794_813_000) == "20261116"


class FakeHttp:
    def __init__(self, raw):
        self.raw, self.calls = raw, []

    def get(self, url, **kw):
        self.calls.append(url)
        name = url.rsplit("%2F", 1)[1]

        class R:
            content = self.raw.part(name).content

        R.url = url
        return R


def test_fetch_gets_the_eight_feeds_in_order():
    raw = load_fixture(SID)
    http = FakeHttp(raw)
    ctx = type("Ctx", (), {"http": http, "now": raw.fetched_at, "source": None, "cursor": None})
    got = mta_trains.fetch(ctx)
    assert [p.name for p in got.parts] == list(mta_trains.FEEDS)
    assert http.calls == [mta_trains.feed_url(n) for n in mta_trains.FEEDS]
    assert mta_trains.parse(got) == mta_trains.parse(raw)


# --------------------------------------------------------------------------- archive budget
ROWS_PER_DAY = 300_000
PART_S = 300
BUDGET_MB = 30.0


def _versions(n_trips: int, stops: int, day: datetime) -> list[list[dict]]:
    """Version rows the pipeline would archive, grouped in 5 min parts (the scheduler writes a
    part per 30 s run and compacts hourly; only the compacted day file is measured): each trip
    advances one stop every 60-150 s, then a closing version when it leaves the feed."""
    rng = random.Random(7)
    routes = ["1", "2", "3", "4", "5", "6", "7", "A", "C", "E", "F", "N", "Q", "R", "L", "G"]
    runs: dict[int, list[dict]] = {}
    for i in range(n_trips):
        route = rng.choice(routes)
        dir_ = rng.choice("NS")
        origin = rng.randrange(0, 20 * 3600)
        trip_id = f"{origin * 100 // 60:06d}_{route}..{dir_}{rng.randrange(1, 40):02d}R"
        t = day + timedelta(seconds=origin)
        base = Event(
            SID, f"{day:%Y%m%d}:{trip_id}", "train", f"{route} train northbound",
            starts_at=t, subtype=route, entity_refs=(f"subway_route:{route}",),
            props={},
        )  # fmt: skip
        for k in range(stops):
            ev = Event(**{**base.__dict__, "props": {"route": route, "dir": dir_,
                                                     "stop": f"{route}{k:02d}"}})  # fmt: skip
            run = int((t - day).total_seconds() // PART_S)
            runs.setdefault(run, []).append(archive.event_row(ev, payload_hash(ev), t))
            t += timedelta(seconds=rng.randrange(60, 150))
        closed = Event(**{**base.__dict__, "ends_at": t, "props": {
            "route": route, "dir": dir_, "stop": f"{route}{stops - 1:02d}",
            "closed_reason": "left_feed"}})  # fmt: skip
        run = int((t - day).total_seconds() // PART_S)
        runs.setdefault(run, []).append(archive.event_row(closed, payload_hash(closed), t))
    return [runs[k] for k in sorted(runs)]


def test_archive_budget(tmp_path):
    day = datetime(2026, 11, 16, tzinfo=UTC)
    runs = _versions(n_trips=400, stops=30, day=day)
    n = 0
    for i, rows in enumerate(runs):
        fetched = rows[0]["updated_at"]
        archive.write_part(tmp_path, SID, "events", rows, fetched, f"run{i:05d}")
        n += len(rows)
    assert n >= 2_000
    archive.compact(tmp_path, now=day + timedelta(days=1, hours=2))
    d = archive.partition_dir(tmp_path, SID, "events", day.date())
    files = list(d.glob("*.parquet"))
    assert [f.name for f in files] == [archive.COMPACTED]
    size = sum(f.stat().st_size for f in files)
    assert len(archive.read_table(tmp_path, SID, "events", [day.date()])) == n
    per_row = size / n
    mb_day = per_row * ROWS_PER_DAY / 1e6
    print(f"\narchive budget: {n} rows, {size} B compacted, {per_row:.1f} B/row, "
          f"{mb_day:.1f} MB/day at {ROWS_PER_DAY} rows/day")  # fmt: skip
    assert mb_day <= BUDGET_MB


# ---------------------------------------------------------------------- events_for report
def test_events_for_timing_report(tmp_path):
    """Not a gate (plan U2): how long the pipeline's events_for takes over 60k trip rows."""
    path = tmp_path / "state.db"
    StateStore(path).close()
    now = datetime(2026, 11, 16, 12, tzinfo=UTC)
    rows = []
    for i in range(60_000):
        route = "1234567ACEFNQRLG"[i % 16]
        t = ts(now - timedelta(seconds=i))
        props = json.dumps({"dir": "N", "route": route, "stop": f"{route}{i % 40:02d}"})
        rows.append((SID, f"20261116:{i:06d}_{route}..N03R", "train", route,
                     f"{route} train northbound", t, None if i < 600 else t, 0, None, None,
                     None, None, json.dumps([f"subway_route:{route}"]), props,
                     f"{i:016x}", t, t, t))  # fmt: skip
    con = sqlite3.connect(path)
    marks = ",".join("?" for _ in EVENT_COLS)
    con.executemany(f"INSERT INTO events ({','.join(EVENT_COLS)}) VALUES ({marks})", rows)
    con.commit()
    con.close()
    with StateStore(path) as store:
        store.events_for(SID)  # warm the page cache
        best = float("inf")
        for _ in range(3):
            t0 = time.perf_counter()
            got = store.events_for(SID)
            best = min(best, time.perf_counter() - t0)
        open_t0 = time.perf_counter()
        open_only = store.events_for(SID, open_only=True)
        open_ms = (time.perf_counter() - open_t0) * 1000
    assert len(got) == 60_000 and len(open_only) == 600
    print(f"\nevents_for over 60k rows: {best * 1000:.0f} ms (open_only: {open_ms:.0f} ms)")

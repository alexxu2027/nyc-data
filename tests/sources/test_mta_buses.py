"""MTA Bus Time vehicle positions (mta_bus_time), ADR-018."""

from datetime import UTC, datetime, timedelta
from pathlib import Path

import pytest
from helpers import load_fixture, parse_fixture

from nyclive.collect.pipeline import run_once
from nyclive.model import NYC_BBOX
from nyclive.registry import load_registry
from nyclive.sources import _gtfsrt, mta_buses
from nyclive.sources.base import Adapter, Batch, RawPart, RawPayload
from nyclive.storage.state import StateStore
from nyclive.timeutil import NY, from_epoch

SID = "mta_bus_time"


def fresh_vehicles(raw: RawPayload) -> set[str]:
    feed = _gtfsrt.decode_feed(raw.part("body").content)
    cutoff = feed.header.timestamp - mta_buses.MAX_VEHICLE_AGE.total_seconds()
    lo_lat, lo_lon, hi_lat, hi_lon = NYC_BBOX
    return {
        f"{v.trip.start_date}:{v.trip.trip_id}"
        for v in feed.vehicles
        if v.trip.trip_id and v.trip.route_id and v.stop_id
        and (not v.timestamp or v.timestamp >= cutoff)
        and lo_lat <= v.latitude <= hi_lat and lo_lon <= v.longitude <= hi_lon
    }  # fmt: skip


def test_real_one_event_per_fresh_bus():
    raw = load_fixture(SID)
    batch = parse_fixture(SID)
    assert {e.event_id for e in batch.events} == fresh_vehicles(raw)
    assert len(batch.events) > 80
    assert batch.complete == frozenset({"events"})
    e = batch.events[0]
    assert e.category == "bus" and e.title == f"{e.props['route']} bus"
    assert set(e.props) == {"route", "dir", "stop", "vehicle", "service"}
    assert e.entity_refs == (f"bus_route:{e.props['route']}",)
    assert {ev.props["service"] for ev in batch.events} == {"local", "sbs", "express"}
    assert all(ev.lat is not None and ev.lon is not None for ev in batch.events)


def test_saved_url_carries_no_key():
    raw = load_fixture(SID)
    assert raw.part("body").url == mta_buses.URL
    assert "key" not in raw.part("body").url


def test_starts_at_from_trip_ids():
    batch = parse_fixture(SID, "edge_synthetic")
    by_id = {e.event_id: e for e in batch.events}
    late = by_id["20261117:EN_D6-Weekday-SDon-147000_B15_9"]
    assert late.starts_at.astimezone(NY).isoformat() == "2026-11-18T00:30:00-05:00"
    mtabc = by_id["20261118:47000001-LGPD6-LG_D6-Weekday-04-SDon"]
    assert mtabc.starts_at.astimezone(NY).isoformat() == "2026-11-18T00:00:00-05:00"
    assert mtabc.props["vehicle"] == "3962"
    ids = set(by_id)
    for skipped in ("_B15_8", "_B15_7", "_B15_6", "_B15_5"):  # ghost, outside, no stop/route
        assert not any(i.endswith(skipped) for i in ids)
    assert len(batch.events) == len(parse_fixture(SID).events) + 2


def test_start_is_never_a_day_ahead():
    header = datetime(2026, 11, 18, 5, 0, tzinfo=UTC)  # 00:00 ET
    s = mta_buses.starts_at("X_D6-Weekday-SDon-140000_Q1_1", "20261118", header)  # 23:20 ET
    assert s.astimezone(NY).isoformat() == "2026-11-17T23:20:00-05:00"


@pytest.mark.parametrize("case, match", [
    ("bad_stale_header", "min old"), ("bad_empty", "no vehicles"), ("bad_truncated", None),
])  # fmt: skip
def test_bad_cases_raise(case, match):
    with pytest.raises(ValueError, match=match):
        mta_buses.parse(load_fixture(SID, case))


def test_wrong_source_raises():
    raw = load_fixture(SID)
    with pytest.raises(ValueError, match="does not serve"):
        mta_buses.parse(RawPayload("mta_subway_realtime", raw.parts))


@pytest.mark.parametrize("route, kind", [
    ("B41", "local"), ("M15+", "sbs"), ("BXM2", "express"), ("QM21", "express"),
    ("SIM1C", "express"), ("X27", "express"), ("BX12+", "sbs"), ("S79+", "sbs"), ("Q09", "local"),
])  # fmt: skip
def test_service_type(route, kind):
    assert mta_buses.service_type(route) == kind


def test_vehicle_number():
    assert mta_buses.vehicle_number("MTA NYCT_8440") == "8440"
    assert mta_buses.vehicle_number("MTABC_3962") == "3962"
    assert mta_buses.vehicle_number("") is None


def test_fetch_one_feed_by_plain_url():
    class Http:
        def __init__(self):
            self.urls: list[str] = []

        def get(self, url, **kw):
            self.urls.append(url)
            return type("R", (), {"content": b"x", "url": url + "?key=SECRET"})()

    from nyclive.sources.base import FetchContext

    http = Http()
    now = datetime(2026, 11, 19, tzinfo=UTC)
    raw = mta_buses.fetch(FetchContext(load_registry().sources[SID], http, None, now))
    assert http.urls == [mta_buses.URL]
    assert raw.part("body").url == mta_buses.URL  # never the response URL with the key


# ------------------------------------------------------------------------ live position (ADR-018)
def _feed_batch(stop: str, lat: float) -> Batch:
    from nyclive.model import Event

    ev = Event(
        source=SID, event_id="20261118:T1", category="bus", title="B41 bus",
        starts_at=datetime(2026, 11, 18, 23, 0, tzinfo=UTC), subtype="B41",
        lat=lat, lon=-73.95, entity_refs=("bus_route:B41",),
        props={"route": "B41", "dir": 0, "stop": stop, "vehicle": "1", "service": "local"},
    )  # fmt: skip
    return Batch(events=[ev], complete=frozenset({"events"}))


def test_moving_bus_updates_state_but_archives_once_per_stop(tmp_path: Path):
    src = load_registry().sources[SID]
    assert src.live_position
    polls = iter([("S1", 40.60), ("S1", 40.61), ("S1", 40.62), ("S2", 40.63)])
    t = [datetime(2026, 11, 19, 0, 0, tzinfo=UTC)]

    def fetch(ctx):
        return RawPayload(SID, (RawPart("body", mta_buses.URL, b"x", t[0]),))

    def parse(raw):
        stop, lat = next(polls)
        return _feed_batch(stop, lat)

    adapter = Adapter("mta_buses", (SID,), fetch, parse)
    store = StateStore(tmp_path / "state.db")
    written, lats = [], []
    for _ in range(4):
        r = run_once(src, adapter, None, store, tmp_path / "archive", now=lambda: t[0])
        assert r.ok, r.error
        written.append(r.rows_written)
        lats.append(store.events_for(SID)["20261118:T1"]["lat"])
        t[0] += timedelta(minutes=1)
    assert written == [1, 0, 0, 1]  # a version at the first sighting and at the next stop
    assert lats == [40.60, 40.61, 40.62, 40.63]  # state follows the bus every poll
    assert from_epoch(0)  # keep the import honest

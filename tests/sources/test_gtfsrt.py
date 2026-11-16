"""The stdlib GTFS-realtime decoder (nyclive.sources._gtfsrt, ADR-013)."""

import struct

import pytest
from fixtures.make_edges_mta_trains import (
    f_bytes,
    f_str,
    f_varint,
    header,
    trip,
    trip_update,
    varint,
    vehicle,
)
from helpers import load_fixture

from nyclive.sources import _gtfsrt
from nyclive.sources._gtfsrt import decode_feed, fields

SID = "mta_subway_realtime"


def real(name: str) -> bytes:
    return load_fixture(SID).part(name).content


# Counts in the committed real capture (2026-11-16 07:13 UTC).
COUNTS = {
    "gtfs": (206, 87, 118, 1),
    "gtfs-ace": (96, 48, 48, 0),
    "gtfs-bdfm": (110, 55, 55, 0),
    "gtfs-g": (20, 10, 10, 0),
    "gtfs-jz": (18, 9, 9, 0),
    "gtfs-nqrw": (76, 38, 38, 0),
    "gtfs-l": (12, 5, 7, 0),
    "gtfs-si": (16, 8, 8, 0),
}


@pytest.mark.parametrize("name", sorted(COUNTS))
def test_real_feed_counts(name):
    feed = decode_feed(real(name))
    entities, vehicles, updates, alerts = COUNTS[name]
    assert feed.header.version == "1.0" and feed.header.incrementality == 0
    assert feed.header.timestamp > 1_794_000_000
    assert len(feed.entities) == entities
    assert len(feed.vehicles) == vehicles
    assert len(feed.trip_updates) == updates
    assert sum(e.has_alert for e in feed.entities) == alerts
    # NYCT vehicles carry a stop but no coordinates
    assert all(v.stop_id and v.trip.trip_id for v in feed.vehicles)
    assert all(v.latitude is None for v in feed.vehicles)


def test_real_nyct_extension_and_stop_times():
    feed = decode_feed(real("gtfs-ace"))
    v = next(v for v in feed.vehicles if v.trip.trip_id == "002950_A..S74R")
    assert v.trip.direction == "S" and v.trip.route_id == "A"
    assert v.trip.train_id == "1A 0029+ 207/FAR" and v.trip.is_assigned is True
    assert v.trip.start_date == "20261116" and v.trip.start_time == "00:29:30"
    assert v.stop_id == "H07S" and v.current_status == 1 and v.current_stop_sequence == 53
    tu = next(t for t in feed.trip_updates if t.trip.trip_id == "002200_A..N")
    first = tu.stop_time_updates[0]
    assert first.stop_id == "A05N" and first.arrival_time == 1794813253
    assert first.scheduled_track == "A4" and first.actual_track == "A4"
    # the NYCT feeds omit direction NORTH; the trip id still says "..N"
    assert decode_feed(real("gtfs-ace")).vehicles[0].trip.direction is None


def test_encoded_round_trip():
    t = trip("100000_G..N", "G", "20261116", "16:40:00", direction=1, train_id="1G 1640")
    data = (
        header(1_794_813_000)
        + vehicle("v1", t, "G22N", status=2, ts=1_794_812_990)
        + trip_update("t1", t, [("G22N", 1_794_813_060), ("G24N", 1_794_813_150)])
    )
    feed = decode_feed(data)
    assert feed.header.timestamp == 1_794_813_000
    (v,) = feed.vehicles
    assert v.trip.direction == "N" and v.trip.train_id == "1G 1640"
    assert v.trip.start_time == "16:40:00" and v.current_status == 2
    assert v.timestamp == 1_794_812_990 and v.stop_id == "G22N"
    (tu,) = feed.trip_updates
    assert [s.stop_id for s in tu.stop_time_updates] == ["G22N", "G24N"]
    assert tu.stop_time_updates[1].departure_time == 1_794_813_150


def test_position_and_unknown_fields():
    pos = varint(1 << 3 | 5) + struct.pack("<f", 40.75) + varint(2 << 3 | 5)
    pos += struct.pack("<f", -73.99)
    v = f_bytes(1, trip("x_1..N", "1")) + f_bytes(2, pos) + f_str(7, "101N")
    unknown = f_varint(99, 7) + varint(98 << 3 | 1) + b"\0" * 8 + f_bytes(97, b"zz")
    data = header(1) + unknown + f_bytes(2, f_str(1, "e") + unknown + f_bytes(4, v + unknown))
    (veh,) = decode_feed(data).vehicles
    assert veh.latitude == pytest.approx(40.75) and veh.longitude == pytest.approx(-73.99)
    assert veh.stop_id == "101N"


def test_negative_int64_time():
    stu = f_bytes(2, f_varint(2, -5)) + f_str(4, "101N")
    data = header(1) + f_bytes(
        2, f_str(1, "e") + f_bytes(3, f_bytes(1, trip("t")) + f_bytes(2, stu))
    )
    assert decode_feed(data).trip_updates[0].stop_time_updates[0].arrival_time == -5


def test_deleted_entities_are_not_vehicles():
    t = trip("t_1..N", "1")
    data = header(1) + f_bytes(2, f_str(1, "d") + f_varint(2, 1) + f_bytes(4, f_bytes(1, t)))
    feed = decode_feed(data)
    assert len(feed.entities) == 1 and feed.entities[0].is_deleted and feed.vehicles == []


@pytest.mark.parametrize("cut", [1, 5, 40, 1000, -1, -7])
def test_truncated_bytes_raise(cut):
    data = real("gtfs-jz")
    # every cut point inside the first entity or the last byte of the feed is malformed
    with pytest.raises(ValueError):
        decode_feed(data[:cut])


def test_truncated_varint_and_fixed():
    with pytest.raises(ValueError, match="varint"):
        fields(b"\x08\x80")
    with pytest.raises(ValueError, match="fixed32"):
        fields(varint(1 << 3 | 5) + b"\0\0")
    with pytest.raises(ValueError, match="fixed64"):
        fields(varint(1 << 3 | 1) + b"\0" * 7)


def test_malformed_inputs_raise():
    with pytest.raises(ValueError, match="no header"):
        decode_feed(b"")
    with pytest.raises(ValueError, match="wire type"):
        decode_feed(varint(1 << 3 | 3))  # start group
    with pytest.raises(ValueError, match="UTF-8"):
        decode_feed(f_bytes(1, f_bytes(1, b"\xff\xfe")))
    with pytest.raises(ValueError, match="embedded message"):
        decode_feed(f_varint(1, 5))  # header as a varint
    with pytest.raises(ValueError):
        decode_feed(b"<html>503</html>")


def test_direction_table():
    assert _gtfsrt.NYCT_DIRECTIONS == {1: "N", 2: "E", 3: "S", 4: "W"}

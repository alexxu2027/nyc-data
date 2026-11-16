"""Regenerate tests/fixtures/mta_subway_realtime/{edge_*,bad_*} from the real case.

    uv run python tests/fixtures/make_edges_mta_trains.py

The feeds are protobuf, so cases are edited at the wire level: a feed's top-level fields (the
header and each FeedEntity) are copied whole, and synthetic entities are encoded with the small
encoder below (also used by tests/sources/test_gtfsrt.py). Each case notes its change in
meta.json.
"""

from __future__ import annotations

from dataclasses import replace
from pathlib import Path

from nyclive.sources import _gtfsrt
from nyclive.sources.base import RawPayload

HERE = Path(__file__).parent
SOURCE_ID = "mta_subway_realtime"


# ------------------------------------------------------------------------------- encoder
def varint(n: int) -> bytes:
    if n < 0:
        n += 1 << 64
    out = bytearray()
    while True:
        b = n & 0x7F
        n >>= 7
        if n:
            out.append(b | 0x80)
        else:
            out.append(b)
            return bytes(out)


def f_varint(num: int, v: int) -> bytes:
    return varint(num << 3) + varint(v)


def f_bytes(num: int, b: bytes) -> bytes:
    return varint(num << 3 | 2) + varint(len(b)) + b


def f_str(num: int, s: str) -> bytes:
    return f_bytes(num, s.encode("utf-8"))


def header(ts: int, version: str = "1.0") -> bytes:
    return f_bytes(1, f_str(1, version) + f_varint(2, 0) + f_varint(3, ts))


def trip(
    trip_id: str,
    route: str = "",
    start_date: str = "",
    start_time: str = "",
    direction: int | None = None,
    train_id: str = "",
) -> bytes:
    b = f_str(1, trip_id) if trip_id else b""
    b += f_str(2, start_time) if start_time else b""
    b += f_str(3, start_date) if start_date else b""
    b += f_str(5, route) if route else b""
    ext = f_str(1, train_id) if train_id else b""
    ext += f_varint(2, 1)
    ext += f_varint(3, direction) if direction is not None else b""
    return b + f_bytes(_gtfsrt.NYCT_EXT, ext)


def vehicle(eid: str, trip_b: bytes, stop: str = "", status: int = 1, ts: int = 0) -> bytes:
    v = f_bytes(1, trip_b) + f_varint(4, status)
    v += f_varint(5, ts) if ts else b""
    v += f_str(7, stop) if stop else b""
    return f_bytes(2, f_str(1, eid) + f_bytes(4, v))


def trip_update(eid: str, trip_b: bytes, stops: list[tuple[str, int]]) -> bytes:
    stus = b"".join(
        f_bytes(2, f_bytes(2, f_varint(2, t)) + f_bytes(3, f_varint(2, t)) + f_str(4, s))
        for s, t in stops
    )
    return f_bytes(2, f_str(1, eid) + f_bytes(3, f_bytes(1, trip_b) + stus))


def deleted(eid: str) -> bytes:
    return f_bytes(2, f_str(1, eid) + f_varint(2, 1))


def top_fields(feed: bytes) -> list[bytes]:
    """A feed's top-level fields re-encoded one by one (header first, then entities)."""
    return [f_bytes(num, v) for num, _, v in _gtfsrt.fields(feed)]


# --------------------------------------------------------------------------------- cases
def edit(case: str, note: str, change) -> None:
    """change(parts: dict[name, bytes], raw) -> dict[name, bytes] (a missing name drops it)."""
    raw = RawPayload.load(HERE / SOURCE_ID / "real")
    parts = change({p.name: p.content for p in raw.parts}, raw)
    new = tuple(replace(p, content=parts[p.name]) for p in raw.parts if p.name in parts)
    replace(raw, parts=new).save(HERE / SOURCE_ID / case, note=note)


def header_ts(feed: bytes) -> int:
    return _gtfsrt.decode_feed(feed).header.timestamp


def synthetic(parts: dict, raw) -> dict:
    g = parts["gtfs"]
    ts = header_ts(g)
    fields = top_fields(g)
    first_vehicle = next(f for f in fields[1:] if _gtfsrt.decode_feed(fields[0] + f).vehicles)
    extra = [
        # origin code 148500 = 24:45 on service day 2026-11-16 -> 2026-11-17 00:45 ET
        vehicle("syn-late", trip("148500_1..N03R", "1", "20261116"), "103N", 2, ts),
        trip_update("syn-late-tu", trip("148500_1..N03R", "1", "20261116"), [("103N", ts + 60)]),
        # no stop_id / no trip_id: skipped
        vehicle("syn-nostop", trip("150000_2..S", "2", "20261116"), "", 1, ts),
        vehicle("syn-notrip", trip("", "3", "20261116"), "120S", 1, ts),
        # no route_id: taken from the shape part of the trip id; direction from the NYCT ext
        vehicle("syn-noroute", trip("151000_6..X", "", "20261116", direction=3), "635S", 1, ts),
        # a repeat of the feed's first vehicle: deduped by event id (first wins)
        first_vehicle,
        deleted("syn-deleted"),
    ]
    parts["gtfs"] = b"".join(fields) + b"".join(extra)
    return parts


def empty_feed(parts: dict, raw) -> dict:
    parts["gtfs-l"] = top_fields(parts["gtfs-l"])[0]  # header only
    return parts


def stale_header(parts: dict, raw) -> dict:
    fetched = int(raw.part("gtfs-g").fetched_at.timestamp())
    parts["gtfs-g"] = header(fetched - 20 * 60) + b"".join(top_fields(parts["gtfs-g"])[1:])
    return parts


def truncated(parts: dict, raw) -> dict:
    fields = top_fields(parts["gtfs-jz"])
    whole = b"".join(fields)
    cut = len(b"".join(fields[:3])) + len(fields[3]) // 2  # mid-way through an entity
    parts["gtfs-jz"] = whole[:cut]
    return parts


def missing_feed(parts: dict, raw) -> dict:
    del parts["gtfs-si"]
    return parts


def main() -> None:
    edit(
        "edge_synthetic",
        "real + synthetic gtfs entities: trip 148500_1..N03R (start 20261116, origin 24:45 -> "
        "2026-11-17 00:45 ET) at 103N with a trip update; a vehicle with no stop_id and one with "
        "no trip_id (skipped); trip 151000_6..X with no route_id and NYCT direction SOUTH at "
        "635S; a repeat of the feed's first vehicle (deduped); a deleted entity",
        synthetic,
    )
    edit("edge_quiet_line", "gtfs-l reduced to its header: a line with no trains", empty_feed)
    edit("bad_stale_header", "gtfs-g header timestamp set 20 min before fetched_at", stale_header)
    edit("bad_truncated", "gtfs-jz cut mid-way through its third entity", truncated)
    edit("bad_missing_feed", "gtfs-si part removed (7 of 8 feeds)", missing_feed)


if __name__ == "__main__":
    main()

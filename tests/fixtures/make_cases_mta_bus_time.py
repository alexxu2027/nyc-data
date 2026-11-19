"""Build tests/fixtures/mta_bus_time/{real,edge_*,bad_*}.

    uv run python tests/fixtures/make_cases_mta_bus_time.py --from <snapshot.bin> --fetched <iso>
    uv run python tests/fixtures/make_cases_mta_bus_time.py          # edges/bad only, from real

`real` is a full Bus Time snapshot cut down at the wire level to its header and a spread of
entities (local, Select Bus, express, NYCT and MTA Bus Company trips), so it stays small. The
other cases edit `real`, as tests/fixtures/make_edges_mta_trains.py does for the subway, and use
its encoder. The saved URL never carries the key (the adapter records the plain URL).
"""

from __future__ import annotations

import argparse
import struct
from dataclasses import replace
from datetime import datetime
from pathlib import Path

from make_edges_mta_trains import f_bytes, f_str, f_varint, header, top_fields, varint

from nyclive.sources import _gtfsrt, mta_buses
from nyclive.sources.base import RawPart, RawPayload

HERE = Path(__file__).parent
SOURCE_ID = "mta_bus_time"
KEEP = 90  # entities in `real`


def f_float(num: int, x: float) -> bytes:
    return varint(num << 3 | 5) + struct.pack("<f", x)


def bus(
    eid: str,
    trip_id: str,
    route: str,
    stop: str,
    lat: float,
    lon: float,
    ts: int,
    start_date: str = "20261118",
    direction: int = 0,
    vehicle_id: str = "MTA NYCT_9999",
) -> bytes:
    t = f_str(1, trip_id) if trip_id else b""
    t += f_str(3, start_date) + (f_str(5, route) if route else b"") + f_varint(6, direction)
    pos = f_float(1, lat) + f_float(2, lon) + f_float(3, 90.0)
    v = f_bytes(1, t) + f_bytes(2, pos) + f_varint(5, ts) + (f_str(7, stop) if stop else b"")
    v += f_bytes(8, f_str(1, vehicle_id))
    return f_bytes(2, f_str(1, eid) + f_bytes(4, v))


def build_real(snapshot: Path, fetched: datetime) -> None:
    feed = snapshot.read_bytes()
    fields = top_fields(feed)
    head, ents = fields[0], fields[1:]

    def route(e: bytes) -> str:
        vs = _gtfsrt.decode_feed(head + e).vehicles
        return vs[0].trip.route_id if vs else ""

    picked = ents[:KEEP]
    have = {mta_buses.service_type(route(e)) for e in picked}
    for kind in ("sbs", "express"):  # make sure each service type is in the case
        if kind not in have:
            picked += [e for e in ents[KEEP:] if mta_buses.service_type(route(e)) == kind][:3]
    body = head + b"".join(picked)
    raw = RawPayload(SOURCE_ID, (RawPart("body", mta_buses.URL, body, fetched),))
    raw.save(
        HERE / SOURCE_ID / "real",
        note=f"Bus Time vehicle positions 2026-11-18 ~7:37 PM ET, cut to the header and "
        f"{len(picked)} of {len(ents)} entities at the wire level",
    )


def edit(case: str, note: str, change) -> None:
    raw = RawPayload.load(HERE / SOURCE_ID / "real")
    body = change(raw.part("body").content, raw)
    replace(raw, parts=(replace(raw.part("body"), content=body),)).save(
        HERE / SOURCE_ID / case, note=note
    )


def synthetic(body: bytes, raw: RawPayload) -> bytes:
    ts = _gtfsrt.decode_feed(body).header.timestamp
    fields = top_fields(body)
    extra = [
        # after midnight: origin 147000 = 1470 min = 24:30 on service day 20261117 -> 2026-11-18 00:30 ET
        bus(
            "syn-late",
            "EN_D6-Weekday-SDon-147000_B15_9",
            "B15",
            "301101",
            40.69,
            -73.94,
            ts,
            start_date="20261117",
        ),
        # MTA Bus Company id: no origin code -> the service day's midnight
        bus(
            "syn-mtabc",
            "47000001-LGPD6-LG_D6-Weekday-04-SDon",
            "Q33",
            "550001",
            40.76,
            -73.88,
            ts,
            vehicle_id="MTABC_3962",
        ),
        bus(
            "syn-ghost",
            "EN_D6-Weekday-SDon-100000_B15_8",
            "B15",
            "301101",
            40.69,
            -73.94,
            ts - 20 * 60,
        ),
        bus("syn-outside", "EN_D6-Weekday-SDon-100000_B15_7", "B15", "301101", 41.2, -73.94, ts),
        bus("syn-nostop", "EN_D6-Weekday-SDon-100000_B15_6", "B15", "", 40.69, -73.94, ts),
        bus("syn-noroute", "EN_D6-Weekday-SDon-100000_B15_5", "", "301101", 40.69, -73.94, ts),
        fields[1],  # a repeat of the first entity: deduped by event id
    ]
    return b"".join(fields) + b"".join(extra)


def stale(body: bytes, raw: RawPayload) -> bytes:
    fetched = int(raw.part("body").fetched_at.timestamp())
    return header(fetched - 20 * 60) + b"".join(top_fields(body)[1:])


def empty(body: bytes, raw: RawPayload) -> bytes:
    return top_fields(body)[0]


def truncated(body: bytes, raw: RawPayload) -> bytes:
    fields = top_fields(body)
    return b"".join(fields[:4]) + fields[4][: len(fields[4]) // 2]


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--from", dest="snapshot", type=Path)
    ap.add_argument("--fetched", type=datetime.fromisoformat)
    a = ap.parse_args()
    if a.snapshot:
        build_real(a.snapshot, a.fetched)
    edit(
        "edge_synthetic",
        "real + synthetic buses: B15 trip 147000 on 20261117 (origin 24:30 -> 2026-11-18 00:30 "
        "ET); an MTA Bus Company Q33 trip with no origin code (service-day midnight); a ghost 20 "
        "min old, one outside the NYC bbox, one with no stop and one with no route (all "
        "skipped); a repeat of the first entity (deduped)",
        synthetic,
    )
    edit("bad_stale_header", "header timestamp set 20 min before fetched_at", stale)
    edit("bad_empty", "header only: no vehicles", empty)
    edit("bad_truncated", "cut mid-way through the fourth entity", truncated)


if __name__ == "__main__":
    main()

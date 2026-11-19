"""A small stdlib decoder for GTFS-realtime protobuf feeds (ADR-013).

Decodes only what the adapters need: `FeedMessage` → header + entities, each with an optional
`TripUpdate` and `VehiclePosition`, plus the NYCT extension (field 1001) on `TripDescriptor`
(`train_id`, `is_assigned`, `direction`) and `StopTimeUpdate` (tracks). Alerts are only flagged.
Unknown fields are skipped by wire type, so newer feeds still decode.

Field numbers follow gtfs-realtime.proto (google/transit) and nyct-subway.proto (MTA):

    FeedMessage   1 header, 2 entity*
    FeedHeader    1 gtfs_realtime_version, 2 incrementality, 3 timestamp
    FeedEntity    1 id, 2 is_deleted, 3 trip_update, 4 vehicle, 5 alert
    TripUpdate    1 trip, 2 stop_time_update*, 3 vehicle, 4 timestamp, 5 delay
    StopTimeUpdate 1 stop_sequence, 2 arrival, 3 departure, 4 stop_id, 5 schedule_relationship
    StopTimeEvent 1 delay, 2 time, 3 uncertainty
    TripDescriptor 1 trip_id, 2 start_time, 3 start_date, 4 schedule_relationship, 5 route_id,
                  6 direction_id; ext 1001 NyctTripDescriptor 1 train_id, 2 is_assigned, 3 direction
    VehiclePosition 1 trip, 2 position, 3 current_stop_sequence, 4 current_status, 5 timestamp,
                  7 stop_id, 8 vehicle
    Position      1 latitude (float), 2 longitude (float), 3 bearing (float)
    VehicleDescriptor 1 id, 2 label
    NyctStopTimeUpdate 1 scheduled_track, 2 actual_track

Malformed or truncated bytes raise `ValueError` (the adapter contract's rejection signal).
"""

from __future__ import annotations

import struct
from dataclasses import dataclass

NYCT_EXT = 1001
# NyctTripDescriptor.Direction
NYCT_DIRECTIONS = {1: "N", 2: "E", 3: "S", 4: "W"}
# VehiclePosition.VehicleStopStatus
VEHICLE_STATUS = {0: "INCOMING_AT", 1: "STOPPED_AT", 2: "IN_TRANSIT_TO"}

_VARINT, _I64, _LEN, _I32 = 0, 1, 2, 5


# ------------------------------------------------------------------------------- messages
@dataclass(frozen=True)
class FeedHeader:
    version: str = ""
    incrementality: int = 0  # 0 FULL_DATASET, 1 DIFFERENTIAL
    timestamp: int = 0  # epoch seconds; 0 = unset


@dataclass(frozen=True)
class TripDescriptor:
    trip_id: str = ""
    start_time: str = ""
    start_date: str = ""  # YYYYMMDD
    route_id: str = ""
    direction_id: int | None = None
    schedule_relationship: int = 0
    train_id: str = ""  # NYCT extension
    is_assigned: bool | None = None  # NYCT extension
    direction: str | None = None  # NYCT extension: "N" | "E" | "S" | "W"


@dataclass(frozen=True)
class StopTimeUpdate:
    stop_id: str = ""
    stop_sequence: int | None = None
    arrival_time: int | None = None  # epoch seconds
    departure_time: int | None = None
    scheduled_track: str = ""  # NYCT extension
    actual_track: str = ""


@dataclass(frozen=True)
class TripUpdate:
    trip: TripDescriptor
    stop_time_updates: tuple[StopTimeUpdate, ...] = ()
    timestamp: int = 0


@dataclass(frozen=True)
class VehiclePosition:
    trip: TripDescriptor
    stop_id: str = ""
    current_status: int = 2  # proto default IN_TRANSIT_TO
    current_stop_sequence: int | None = None
    timestamp: int = 0
    latitude: float | None = None
    longitude: float | None = None
    bearing: float | None = None  # degrees clockwise from north (buses send it; NYCT doesn't)
    vehicle_id: str = ""  # VehicleDescriptor.id ("MTA NYCT_8440")


@dataclass(frozen=True)
class FeedEntity:
    id: str
    is_deleted: bool = False
    trip_update: TripUpdate | None = None
    vehicle: VehiclePosition | None = None
    has_alert: bool = False


@dataclass(frozen=True)
class FeedMessage:
    header: FeedHeader
    entities: tuple[FeedEntity, ...]

    @property
    def vehicles(self) -> list[VehiclePosition]:
        return [e.vehicle for e in self.entities if e.vehicle is not None and not e.is_deleted]

    @property
    def trip_updates(self) -> list[TripUpdate]:
        return [e.trip_update for e in self.entities if e.trip_update and not e.is_deleted]


# ------------------------------------------------------------------------------ wire level
def _varint(buf: bytes, i: int) -> tuple[int, int]:
    result = shift = 0
    n = len(buf)
    while True:
        if i >= n:
            raise ValueError("truncated varint")
        b = buf[i]
        i += 1
        result |= (b & 0x7F) << shift
        if not b & 0x80:
            return result, i
        shift += 7
        if shift > 63:
            raise ValueError("varint too long")


def fields(buf: bytes) -> list[tuple[int, int, int | bytes]]:
    """Split one message into (field number, wire type, value) triples.

    Varints come back as unsigned ints, fixed64/fixed32 as unsigned ints, length-delimited
    fields as bytes. Groups (wire types 3 and 4) are not used by GTFS-rt and raise.
    """
    out: list[tuple[int, int, int | bytes]] = []
    i, n = 0, len(buf)
    while i < n:
        key, i = _varint(buf, i)
        num, wt = key >> 3, key & 7
        if num == 0:
            raise ValueError("field number 0")
        if wt == _VARINT:
            v, i = _varint(buf, i)
            out.append((num, wt, v))
        elif wt == _LEN:
            size, i = _varint(buf, i)
            if i + size > n:
                raise ValueError("truncated length-delimited field")
            out.append((num, wt, buf[i : i + size]))
            i += size
        elif wt == _I64:
            if i + 8 > n:
                raise ValueError("truncated fixed64")
            out.append((num, wt, int.from_bytes(buf[i : i + 8], "little")))
            i += 8
        elif wt == _I32:
            if i + 4 > n:
                raise ValueError("truncated fixed32")
            out.append((num, wt, int.from_bytes(buf[i : i + 4], "little")))
            i += 4
        else:
            raise ValueError(f"unsupported wire type {wt}")
    return out


def _signed(v: int) -> int:
    """int32/int64 varints are two's complement over 64 bits."""
    return v - (1 << 64) if v >= 1 << 63 else v


def _float(v: int) -> float:
    return struct.unpack("<f", v.to_bytes(4, "little"))[0]


def _str(v: int | bytes) -> str:
    if not isinstance(v, bytes):
        raise ValueError("expected a string field")  # noqa: TRY004 (contract: ValueError)
    try:
        return v.decode("utf-8")
    except UnicodeDecodeError as e:
        raise ValueError(f"bad UTF-8 in string field: {e}") from None


def _msg(v: int | bytes) -> bytes:
    if not isinstance(v, bytes):
        raise ValueError("expected an embedded message")  # noqa: TRY004
    return v


def _int(v: int | bytes) -> int:
    if isinstance(v, bytes):
        raise ValueError("expected a varint")  # noqa: TRY004
    return v


# ---------------------------------------------------------------------------- messages
def _header(buf: bytes) -> FeedHeader:
    version, inc, ts = "", 0, 0
    for num, _, v in fields(buf):
        if num == 1:
            version = _str(v)
        elif num == 2:
            inc = _int(v)
        elif num == 3:
            ts = _int(v)
    return FeedHeader(version, inc, ts)


def _trip(buf: bytes) -> TripDescriptor:
    d: dict = {}
    for num, _, v in fields(buf):
        if num == 1:
            d["trip_id"] = _str(v)
        elif num == 2:
            d["start_time"] = _str(v)
        elif num == 3:
            d["start_date"] = _str(v)
        elif num == 4:
            d["schedule_relationship"] = _int(v)
        elif num == 5:
            d["route_id"] = _str(v)
        elif num == 6:
            d["direction_id"] = _int(v)
        elif num == NYCT_EXT:
            for n2, _, v2 in fields(_msg(v)):
                if n2 == 1:
                    d["train_id"] = _str(v2)
                elif n2 == 2:
                    d["is_assigned"] = bool(_int(v2))
                elif n2 == 3:
                    d["direction"] = NYCT_DIRECTIONS.get(_int(v2))
    return TripDescriptor(**d)


def _event_time(buf: bytes) -> int | None:
    for num, _, v in fields(buf):
        if num == 2:
            return _signed(_int(v))
    return None


def _stop_time_update(buf: bytes) -> StopTimeUpdate:
    d: dict = {}
    for num, _, v in fields(buf):
        if num == 1:
            d["stop_sequence"] = _int(v)
        elif num == 2:
            d["arrival_time"] = _event_time(_msg(v))
        elif num == 3:
            d["departure_time"] = _event_time(_msg(v))
        elif num == 4:
            d["stop_id"] = _str(v)
        elif num == NYCT_EXT:
            for n2, _, v2 in fields(_msg(v)):
                if n2 == 1:
                    d["scheduled_track"] = _str(v2)
                elif n2 == 2:
                    d["actual_track"] = _str(v2)
    return StopTimeUpdate(**d)


def _trip_update(buf: bytes) -> TripUpdate:
    trip, stus, ts = TripDescriptor(), [], 0
    for num, _, v in fields(buf):
        if num == 1:
            trip = _trip(_msg(v))
        elif num == 2:
            stus.append(_stop_time_update(_msg(v)))
        elif num == 4:
            ts = _int(v)
    return TripUpdate(trip, tuple(stus), ts)


def _vehicle(buf: bytes) -> VehiclePosition:
    d: dict = {"trip": TripDescriptor()}
    for num, wt, v in fields(buf):
        if num == 1:
            d["trip"] = _trip(_msg(v))
        elif num == 2:
            for n2, wt2, v2 in fields(_msg(v)):
                if n2 in (1, 2, 3) and wt2 == _I32:
                    d[("latitude", "longitude", "bearing")[n2 - 1]] = _float(_int(v2))
        elif num == 3:
            d["current_stop_sequence"] = _int(v)
        elif num == 4:
            d["current_status"] = _int(v)
        elif num == 5:
            d["timestamp"] = _int(v)
        elif num == 7:
            d["stop_id"] = _str(v)
        elif num == 8:
            for n2, _, v2 in fields(_msg(v)):
                if n2 == 1:
                    d["vehicle_id"] = _str(v2)
    return VehiclePosition(**d)


def _entity(buf: bytes) -> FeedEntity:
    d: dict = {"id": ""}
    for num, _, v in fields(buf):
        if num == 1:
            d["id"] = _str(v)
        elif num == 2:
            d["is_deleted"] = bool(_int(v))
        elif num == 3:
            d["trip_update"] = _trip_update(_msg(v))
        elif num == 4:
            d["vehicle"] = _vehicle(_msg(v))
        elif num == 5:
            d["has_alert"] = True
    return FeedEntity(**d)


def decode_feed(data: bytes) -> FeedMessage:
    """Decode a GTFS-realtime FeedMessage. Raises ValueError on malformed bytes or no header."""
    if not isinstance(data, bytes | bytearray | memoryview):
        raise ValueError("expected bytes")  # noqa: TRY004
    header, entities = None, []
    for num, _, v in fields(bytes(data)):
        if num == 1:
            header = _header(_msg(v))
        elif num == 2:
            entities.append(_entity(_msg(v)))
    if header is None:
        raise ValueError("not a GTFS-rt FeedMessage: no header")
    return FeedMessage(header, tuple(entities))

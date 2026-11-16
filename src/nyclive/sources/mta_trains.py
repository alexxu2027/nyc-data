"""MTA subway trains from GTFS-realtime protobuf (mta_subway_realtime), ADR-013.

One fetch pulls the 8 line-group feeds (parts named after them: gtfs, gtfs-ace, ...). Every
VehiclePosition that names a trip and a stop becomes one Event per trip, so change-only
archiving writes a new version only when a train moves on to its next stop (props are exactly
route, dir and stop). The feed set is complete for events: trips that leave it are closed.

Quirks: NYCT vehicles carry no lat/lon, only the stop they are at or heading to; the API places
them on the track using config/subway_static.json. Stop ids are platform ids ("A27S"), stored as
the parent station ("A27"). NYCT trip ids start with the origin time in hundredths of a minute
after midnight of the service day ("148500_1..N03R" = 24:45:00, i.e. 00:45 the next morning),
which gives `starts_at`. Direction comes from the NYCT extension, else from the trip id
("..N"/"..S"), else from the platform suffix. A missing feed or a stale header is rejected so a
glitch can't close every open trip. A quiet feed (no vehicles, no trip updates) with a fresh
header is a line with no trains and is accepted; the registry's close_grace_s keeps one empty
poll from closing its trips.
"""

from __future__ import annotations

import re
from datetime import date, datetime, timedelta
from typing import Any

from nyclive.model import Event
from nyclive.sources import _gtfsrt
from nyclive.sources.base import Batch, FetchContext, RawPart, RawPayload
from nyclive.timeutil import from_epoch, local_to_utc, to_ny

SOURCE_IDS = ("mta_subway_realtime",)

BASE = "https://api-endpoint.mta.info/Dataservice/mtagtfsfeeds/nyct%2F"
FEEDS = ("gtfs", "gtfs-ace", "gtfs-bdfm", "gtfs-g", "gtfs-jz", "gtfs-nqrw", "gtfs-l", "gtfs-si")
CATEGORY = "train"
MAX_HEADER_AGE = timedelta(minutes=15)
# A vehicle whose own position is this much older than its feed header is a ghost: MTA leaves
# finished trips in the feed for hours (a day, once), and they would be drawn as live trains.
MAX_VEHICLE_AGE = timedelta(minutes=30)
# A computed start this far after the header is a day late: NYCT dates after-midnight trips
# (origin code 24:xx+) by the calendar day, not the service day (review 2026-11-16, #2).
MAX_START_AHEAD = timedelta(hours=6)
DIR_WORD = {"N": "northbound", "S": "southbound"}
_PLATFORM = re.compile(r"^(.*\d)[NS]$")  # "A27S" -> "A27"; parent ids never end in N/S
_ORIGIN = re.compile(r"^(\d{4,6})_")  # "148500_1..N03R" -> 148500
_TRIP_DIR = re.compile(r"\.+([NS])")  # "1..N03R" / "A..S58R" -> N / S
_START_TIME = re.compile(r"^(\d{1,2}):(\d{2}):(\d{2})$")


def feed_url(name: str) -> str:
    return BASE + name


def fetch(ctx: FetchContext) -> RawPayload:
    parts = []
    for name in FEEDS:  # Http spaces requests to one host (one at a time)
        r = ctx.http.get(feed_url(name))
        parts.append(RawPart(name, str(r.url), r.content, ctx.now))
    return RawPayload(SOURCE_IDS[0], tuple(parts))


def parse(raw: RawPayload) -> Batch:
    if raw.source_id not in SOURCE_IDS:
        raise ValueError(f"mta_trains adapter does not serve {raw.source_id!r}")
    names = [p.name for p in raw.parts]
    if sorted(names) != sorted(FEEDS):
        # A missing feed would close every trip in it (complete set), so refuse.
        raise ValueError(f"expected the {len(FEEDS)} feeds {FEEDS}, got {names}")
    batch = Batch(complete=frozenset({"events"}))
    seen: set[str] = set()
    for name in FEEDS:
        part = raw.part(name)
        feed = _gtfsrt.decode_feed(part.content)
        _check_feed(name, feed, part.fetched_at)
        for v in feed.vehicles:
            if (
                v.timestamp
                and v.timestamp < feed.header.timestamp - MAX_VEHICLE_AGE.total_seconds()
            ):
                continue  # a ghost (see MAX_VEHICLE_AGE)
            ev = _event(raw.source_id, v, feed.header.timestamp)
            if ev is None or ev.event_id in seen:
                continue
            seen.add(ev.event_id)
            batch.events.append(ev)
    batch.events.sort(key=lambda e: e.event_id)
    return batch


def _check_feed(name: str, feed: _gtfsrt.FeedMessage, fetched_at: datetime) -> None:
    # A quiet feed with a fresh header is a line with no trains (a weekend G shutdown), not a
    # glitch: accepted, so the other lines still update (review 2026-11-16, #8). The registry's
    # close_grace_s keeps one glitchy empty poll from closing that line's trips.
    if not feed.header.timestamp:
        raise ValueError(f"{name}: feed header has no timestamp")
    age = fetched_at - from_epoch(feed.header.timestamp)
    if age > MAX_HEADER_AGE:
        raise ValueError(f"{name}: feed header is {age.total_seconds() / 60:.0f} min old")


def station_id(stop_id: str) -> str:
    """GTFS platform id to its parent station id: strip a trailing N/S direction."""
    s = stop_id.strip()
    m = _PLATFORM.match(s)
    return m.group(1) if m else s


def shape_of(trip_id: str) -> str:
    """Realtime trip id to its static shape id: everything after the first '_'."""
    return trip_id.partition("_")[2]


def direction(trip: _gtfsrt.TripDescriptor, stop_id: str) -> str | None:
    if trip.direction in DIR_WORD:
        return trip.direction
    m = _TRIP_DIR.search(shape_of(trip.trip_id))
    if m:
        return m.group(1)
    s = stop_id.strip()
    return s[-1] if s[-1:] in DIR_WORD and _PLATFORM.match(s) else None


def route_of(trip: _gtfsrt.TripDescriptor) -> str:
    if trip.route_id.strip():
        return trip.route_id.strip()
    shape = shape_of(trip.trip_id)
    return shape.split(".", 1)[0] if "." in shape else ""


def service_date(trip: _gtfsrt.TripDescriptor, header_ts: int) -> str:
    """The trip's service day as YYYYMMDD (the feed's local date if the trip lacks one)."""
    s = trip.start_date.strip()
    if re.fullmatch(r"\d{8}", s):
        return s
    return to_ny(from_epoch(header_ts)).strftime("%Y%m%d")


def starts_at(
    trip: _gtfsrt.TripDescriptor, day: str, fallback: datetime, header: datetime | None = None
) -> datetime:
    """Origin departure: service day + the trip id's origin code (or start_time), in NY time.

    With `header` (the feed time), a start more than MAX_START_AHEAD after it moves back a day
    at a time: a train in the feed now can't start tomorrow night."""
    base = datetime.combine(date(int(day[:4]), int(day[4:6]), int(day[6:])), datetime.min.time())
    m = _ORIGIN.match(trip.trip_id)
    if m:
        local = base + timedelta(minutes=int(m.group(1)) / 100)
    elif mt := _START_TIME.match(trip.start_time.strip()):
        h, mi, se = (int(x) for x in mt.groups())
        local = base + timedelta(hours=h, minutes=mi, seconds=se)
    else:
        return fallback
    out = local_to_utc(local.strftime("%Y-%m-%dT%H:%M:%S"))
    while header is not None and out - header > MAX_START_AHEAD:
        local -= timedelta(days=1)  # by wall clock, so a DST night stays right
        out = local_to_utc(local.strftime("%Y-%m-%dT%H:%M:%S"))
    return out


def _event(sid: str, v: _gtfsrt.VehiclePosition, header_ts: int) -> Event | None:
    trip = v.trip
    trip_id = trip.trip_id.strip()
    stop = v.stop_id.strip()
    if not trip_id or not stop:
        return None
    route = route_of(trip)
    dir_ = direction(trip, stop)
    if not route or dir_ is None:
        return None
    day = service_date(trip, header_ts)
    fallback = from_epoch(v.timestamp or header_ts)
    props: dict[str, Any] = {"route": route, "dir": dir_, "stop": station_id(stop)}
    return Event(
        source=sid,
        event_id=f"{day}:{trip_id}",
        category=CATEGORY,
        title=f"{route} train {DIR_WORD[dir_]}",
        starts_at=starts_at(trip, day, fallback, from_epoch(header_ts)),
        subtype=route,
        entity_refs=(f"subway_route:{route}",),
        props=props,
    )

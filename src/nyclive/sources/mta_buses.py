"""MTA buses from Bus Time GTFS-realtime vehicle positions (mta_bus_time), ADR-018.

One fetch of one feed: every bus in the city (~2,700 at 7 PM). Each VehiclePosition that names a
trip, a route, a next stop and a position becomes one Event per trip, like the subway adapter.
Props are route, direction, next stop and vehicle, so change-only archiving writes a version when
a bus moves on to its next stop. The registry's `live_position` keeps lat/lon out of that hash:
the pipeline updates the position in state.db every poll without a new archive row (ADR-018).

The key is a query param that `Http` adds per host and redacts from logs (settings.host_params),
so this module never sees it, and the URL saved with the payload carries no key.

Quirks:
- NYCT trip ids carry the origin time in hundredths of a minute after midnight of the service
  day ("..-SDon-117200_MISC_882" = 19:32), as on the subway. MTA Bus Company ids don't
  ("47368816-LGPD6-LG_D6-Weekday-04-SDon"); their trips start at the service day's midnight,
  which is at least stable from poll to poll (a changing start would version every poll).
- route_id is the public name ("B41", "Q44+" for Select Bus Service, "BXM2" express).
- Positions older than MAX_VEHICLE_AGE behind the header are ghosts and skipped, and so are
  positions outside the NYC bbox (a few routes run to Yonkers or a depot outside it).
- An empty feed or a stale header is rejected, so a glitch can't close every open trip; the
  registry's close_grace_s keeps one missed poll from closing a trip.
"""

from __future__ import annotations

import re
from datetime import date, datetime, timedelta
from typing import Any

from nyclive.model import NYC_BBOX, Event
from nyclive.sources import _gtfsrt
from nyclive.sources.base import Batch, FetchContext, RawPart, RawPayload
from nyclive.timeutil import from_epoch, local_to_utc, to_ny

SOURCE_IDS = ("mta_bus_time",)

URL = "https://gtfsrt.prod.obanyc.com/vehiclePositions"
CATEGORY = "bus"
MAX_HEADER_AGE = timedelta(minutes=10)
MAX_VEHICLE_AGE = timedelta(minutes=10)
MAX_START_AHEAD = timedelta(hours=6)
_ORIGIN = re.compile(r"-(\d{5,6})_")  # "..-SDon-117200_MISC_882" -> 117200
_VEHICLE = re.compile(r"_(\w+)$")  # "MTA NYCT_8440" -> 8440
_EXPRESS = re.compile(r"^(BM|BXM|QM|SIM|X)\d", re.IGNORECASE)


def fetch(ctx: FetchContext) -> RawPayload:
    r = ctx.http.get(URL)  # Http adds ?key=... for this host (ADR-018)
    return RawPayload(SOURCE_IDS[0], (RawPart("body", URL, r.content, ctx.now),))


def parse(raw: RawPayload) -> Batch:
    if raw.source_id not in SOURCE_IDS:
        raise ValueError(f"mta_buses adapter does not serve {raw.source_id!r}")
    part = raw.part("body")
    feed = _gtfsrt.decode_feed(part.content)
    header_ts = feed.header.timestamp
    if not header_ts:
        raise ValueError("feed header has no timestamp")
    age = part.fetched_at - from_epoch(header_ts)
    if age > MAX_HEADER_AGE:
        raise ValueError(f"feed header is {age.total_seconds() / 60:.0f} min old")
    if not feed.vehicles:
        # The city never has zero buses; an empty feed is a glitch and would close every trip.
        raise ValueError("feed has no vehicles")
    batch = Batch(complete=frozenset({"events"}))
    seen: set[str] = set()
    oldest = header_ts - MAX_VEHICLE_AGE.total_seconds()
    for v in feed.vehicles:
        if v.timestamp and v.timestamp < oldest:
            continue  # a ghost
        ev = _event(raw.source_id, v, header_ts)
        if ev is None or ev.event_id in seen:
            continue
        seen.add(ev.event_id)
        batch.events.append(ev)
    batch.events.sort(key=lambda e: e.event_id)
    return batch


def service_type(route: str) -> str:
    """'sbs' (Select Bus Service, "M15+"), 'express' (BM/BxM/QM/SIM/X), else 'local'."""
    if route.endswith("+"):
        return "sbs"
    if _EXPRESS.match(route):
        return "express"
    return "local"


def vehicle_number(vehicle_id: str) -> str | None:
    """ "MTA NYCT_8440" / "MTABC_3962" -> the fleet number."""
    m = _VEHICLE.search(vehicle_id.strip())
    return m.group(1) if m else (vehicle_id.strip() or None)


def starts_at(trip_id: str, day: str, header: datetime) -> datetime:
    """Origin departure from the trip id, in NY time; the service day's midnight without one."""
    base = datetime.combine(date(int(day[:4]), int(day[4:6]), int(day[6:])), datetime.min.time())
    m = _ORIGIN.search(trip_id)
    local = base + timedelta(minutes=int(m.group(1)) / 100) if m else base
    out = local_to_utc(local.strftime("%Y-%m-%dT%H:%M:%S"))
    while out - header > MAX_START_AHEAD:
        local -= timedelta(days=1)  # by wall clock, so a DST night stays right
        out = local_to_utc(local.strftime("%Y-%m-%dT%H:%M:%S"))
    return out


def _in_nyc(lat: float | None, lon: float | None) -> bool:
    if lat is None or lon is None:
        return False
    min_lat, min_lon, max_lat, max_lon = NYC_BBOX
    return min_lat <= lat <= max_lat and min_lon <= lon <= max_lon


def _event(sid: str, v: _gtfsrt.VehiclePosition, header_ts: int) -> Event | None:
    trip = v.trip
    trip_id, route, stop = trip.trip_id.strip(), trip.route_id.strip(), v.stop_id.strip()
    if not trip_id or not route or not stop or not _in_nyc(v.latitude, v.longitude):
        return None
    header = from_epoch(header_ts)
    day = trip.start_date.strip()
    if not re.fullmatch(r"\d{8}", day):
        day = to_ny(header).strftime("%Y%m%d")
    props: dict[str, Any] = {
        "route": route,
        "dir": trip.direction_id,  # 0 / 1, per the static GTFS
        "stop": stop,  # the stop it's at or heading to
        "vehicle": vehicle_number(v.vehicle_id),
        "service": service_type(route),
    }
    return Event(
        source=sid,
        event_id=f"{day}:{trip_id}",
        category=CATEGORY,
        title=f"{route} bus",
        starts_at=starts_at(trip_id, day, header),
        subtype=route,
        lat=round(v.latitude, 5),
        lon=round(v.longitude, 5),
        entity_refs=(f"bus_route:{route}",),
        props=props,
    )

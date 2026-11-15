"""MTA elevator and escalator outages, joined to the equipment list (mta_elevator_outages).

Two GETs: `outages` (current and planned outages) and `equipments` (every elevator/escalator,
with its GTFS stop ids). Both are complete sets: equipment become `elevator` entities, outages
become `elevator_outage` events, and outages that leave the feed are closed by the pipeline.

Quirks: the Content-Type header is broken (`${header.s3FileType}`), so parts are decoded as JSON
regardless. Dates are New York local strings like "12/16/2026 10:00:00 PM". The feed includes
planned future outages (`isupcomingoutage` "Y"); their `starts_at` is in the future. Outages carry
no station id and an empty `borough`, so stations come from joining `equipment` to the
equipment list's `equipmentno`; not every outage has a match, and then the event references only
the elevator. `elevatorsgtfsstopid` can hold several ids ("A31/L01"). `estimatedreturntoservice`
is an estimate, not an end time, so it goes in props and `ends_at` stays None. Y/N flags become
booleans.
"""

from __future__ import annotations

import re
from typing import Any

from nyclive.model import Entity, Event, borough_code
from nyclive.sources.base import Batch, FetchContext, RawPart, RawPayload
from nyclive.timeutil import local_to_utc

SOURCE_IDS = ("mta_elevator_outages",)

BASE = "https://api-endpoint.mta.info/Dataservice/mtagtfsfeeds/"
OUTAGES_URL = BASE + "nyct%2Fnyct_ene.json"
EQUIPMENTS_URL = BASE + "nyct%2Fnyct_ene_equipments.json"
DATE_FMT = "%m/%d/%Y %I:%M:%S %p"
KIND = "elevator"
CATEGORY = "elevator_outage"
_STOP_SEP = re.compile(r"[/,]")
_PLATFORM = re.compile(r"^(.*\d)[NS]$")  # same N/S rule as mta_alerts


def fetch(ctx: FetchContext) -> RawPayload:
    parts = []
    for name, url in (("outages", OUTAGES_URL), ("equipments", EQUIPMENTS_URL)):
        r = ctx.http.get(url)
        parts.append(RawPart(name, str(r.url), r.content, ctx.now))
    return RawPayload(SOURCE_IDS[0], tuple(parts))


def parse(raw: RawPayload) -> Batch:
    if raw.source_id not in SOURCE_IDS:
        raise ValueError(f"mta_elevators adapter does not serve {raw.source_id!r}")
    outages, equipments = raw.json("outages"), raw.json("equipments")
    if not isinstance(outages, list) or not isinstance(equipments, list):
        raise ValueError("outages and equipments must be JSON arrays")  # noqa: TRY004 (contract)
    batch = Batch(complete=frozenset({"events", "entities"}))
    equipment: dict[str, dict] = {}
    for row in equipments:
        entity = _entity(raw.source_id, row)
        if entity is None or entity.entity_id in equipment:
            continue
        equipment[entity.entity_id] = row
        batch.entities.append(entity)
    seen: set[str] = set()
    for row in outages:
        event = _event(raw.source_id, row, equipment)
        if event is None or event.event_id in seen:
            continue
        seen.add(event.event_id)
        batch.events.append(event)
    return batch


def stop_ids(value: Any) -> list[str]:
    """`elevatorsgtfsstopid` ("A31/L01", "232, R28") to parent station ids."""
    out = []
    for s in _STOP_SEP.split(str(value or "")):
        s = s.strip()
        if s:
            m = _PLATFORM.match(s)
            out.append(m.group(1) if m else s)
    return out


def _s(row: dict, key: str) -> str:
    return str(row.get(key) or "").strip()


def _flag(value: Any) -> bool | None:
    s = str(value or "").strip().upper()
    return {"Y": True, "N": False}.get(s)


def _entity(sid: str, row: Any) -> Entity | None:
    if not isinstance(row, dict) or not _s(row, "equipmentno"):
        return None
    eq = _s(row, "equipmentno")
    station = _s(row, "station")
    what = _s(row, "serving") or _s(row, "shortdescription")
    name = f"{station}: {what}" if station and what else station or what or eq
    return Entity(
        source=sid,
        kind=KIND,
        entity_id=eq,
        name=name,
        lat=None,
        lon=None,
        borough=borough_code(row.get("borough")),
        props={
            "equipmenttype": _s(row, "equipmenttype") or None,
            "elevatorsgtfsstopid": _s(row, "elevatorsgtfsstopid") or None,
            "stationcomplexid": _s(row, "stationcomplexid") or None,
            "ADA": _flag(row.get("ADA")),
            "isactive": _flag(row.get("isactive")),
        },
    )


def _event(sid: str, row: Any, equipment: dict[str, dict]) -> Event | None:
    if not isinstance(row, dict) or not _s(row, "equipment") or not _s(row, "outagedate"):
        return None
    eq = _s(row, "equipment")
    try:
        starts_at = local_to_utc(_s(row, "outagedate"), DATE_FMT)
    except ValueError:
        return None
    try:
        est = _s(row, "estimatedreturntoservice")
        est_return = local_to_utc(est, DATE_FMT).isoformat() if est else None
    except ValueError:
        est_return = None
    refs = {f"{KIND}:{eq}"}
    match = equipment.get(eq)
    if match is not None:
        refs.update(f"subway_station:{s}" for s in stop_ids(match.get("elevatorsgtfsstopid")))
    etype = _s(row, "equipmenttype")
    serving = _s(row, "serving")
    station = _s(row, "station")
    detail = " ".join(x for x in (etype, serving or eq) if x)
    borough = borough_code(row.get("borough"))
    if borough is None and match is not None:
        borough = borough_code(match.get("borough"))
    return Event(
        source=sid,
        event_id=f"{eq}:{starts_at.isoformat()}",
        category=CATEGORY,
        title=f"{station}: {detail}" if station else detail,
        starts_at=starts_at,
        ends_at=None,
        subtype=etype or None,
        borough=borough,
        entity_refs=tuple(sorted(refs)),
        props={
            "est_return": est_return,
            "upcoming": _flag(row.get("isupcomingoutage")) is True,
            "maintenance": _flag(row.get("ismaintenanceoutage")) is True,
            "reason": _s(row, "reason") or None,
            "serving": serving or None,
            "ADA": _flag(row.get("ADA")),
        },
    )

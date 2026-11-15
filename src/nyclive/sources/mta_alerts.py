"""MTA subway service alerts, GTFS-realtime rendered as JSON (mta_subway_alerts).

One GET returns the full current alert set (`header.incrementality` FULL_DATASET), so alerts that
drop out of it are closed by the pipeline. The feed holds live incidents ("Delays") and planned
work weeks ahead.

Quirks: MTA's "Mercury" extension sits under the literal key `transit_realtime.mercury_alert`
(alert_type, created_at, updated_at as epoch seconds). Text comes in `en` and `en-html`
translations; we use the plain `en` one. An active period may lack an `end` (open-ended), and
then the event has no end either. Informed stops can be platform ids with an N/S direction
suffix ("R30N"); they are pinned to the parent station ("R30"). Empty repeated fields are
omitted in proto JSON, so a quiet feed may have no `entity` key at all.
"""

from __future__ import annotations

import json
import re
from datetime import datetime
from typing import Any

from nyclive.model import PROPS_MAX_BYTES, Event
from nyclive.sources.base import Batch, FetchContext, RawPart, RawPayload
from nyclive.timeutil import from_epoch

SOURCE_IDS = ("mta_subway_alerts",)

URL = "https://api-endpoint.mta.info/Dataservice/mtagtfsfeeds/camsys%2Fsubway-alerts.json"
MERCURY = "transit_realtime.mercury_alert"
CATEGORY = "service_alert"
_SEVERE = re.compile(r"suspend|no trains", re.IGNORECASE)
_PLATFORM = re.compile(r"^(.*\d)[NS]$")  # "R30N" -> "R30"; parent ids never end in N/S
_ELLIPSIS = "…"


def fetch(ctx: FetchContext) -> RawPayload:
    r = ctx.http.get(URL)
    return RawPayload(SOURCE_IDS[0], (RawPart("body", str(r.url), r.content, ctx.now),))


def parse(raw: RawPayload) -> Batch:
    if raw.source_id not in SOURCE_IDS:
        raise ValueError(f"mta_alerts adapter does not serve {raw.source_id!r}")
    doc = raw.json("body")
    if not isinstance(doc, dict) or not isinstance(doc.get("header"), dict):
        raise ValueError("expected a GTFS-rt FeedMessage with a header")  # noqa: TRY004 (contract)
    if not isinstance(doc.get("entity"), list) or not doc["entity"]:
        # The feed always carries planned work; an empty set is a glitch, and treating it as
        # complete would close every open alert (review finding 2026-11-15).
        raise ValueError("GTFS-rt feed has no alerts; refusing to treat it as complete")
    batch = Batch(complete=frozenset({"events"}))
    seen: set[str] = set()
    for entity in doc.get("entity", []):
        event = _event(raw.source_id, entity)
        if event is None or event.event_id in seen:
            continue
        seen.add(event.event_id)
        batch.events.append(event)
    return batch


def station_id(stop_id: str) -> str:
    """GTFS platform id to its parent station id: strip a trailing N/S direction."""
    s = stop_id.strip()
    m = _PLATFORM.match(s)
    return m.group(1) if m else s


def _event(sid: str, entity: Any) -> Event | None:
    if not isinstance(entity, dict) or not isinstance(entity.get("alert"), dict):
        return None
    eid = str(entity.get("id") or "").strip()
    if not eid:
        return None
    a = entity["alert"]
    m = a.get(MERCURY) if isinstance(a.get(MERCURY), dict) else {}
    periods = [p for p in a.get("active_period") or [] if isinstance(p, dict)]
    try:
        created = _epoch(m.get("created_at"))
        updated = _epoch(m.get("updated_at"))
        starts = [t for p in periods if (t := _epoch(p.get("start"))) is not None]
        ends = [_epoch(p.get("end")) for p in periods]
    except (TypeError, ValueError):
        return None
    starts_at = min(starts) if starts else created
    if starts_at is None:
        return None
    # An event ends only if every period does; one open-ended period keeps it open.
    closed = [e for e in ends if e is not None]
    ends_at = max(closed) if closed and len(closed) == len(ends) else None
    if ends_at is not None and ends_at < starts_at:
        return None
    alert_type = str(m.get("alert_type") or "").strip() or None
    props: dict[str, Any] = {
        "alert_type": alert_type,
        "active_periods": len(periods),
        "created_at": created.isoformat() if created else None,
        "updated_at": updated.isoformat() if updated else None,
        "description": _text(a.get("description_text")),
    }
    return Event(
        source=sid,
        event_id=eid,
        category=CATEGORY,
        title=_text(a.get("header_text")) or alert_type or "Subway service alert",
        starts_at=starts_at,
        ends_at=ends_at,
        subtype=alert_type,
        severity=2 if alert_type and _SEVERE.search(alert_type) else 1,
        entity_refs=_refs(a.get("informed_entity")),
        props=_fit(props),
    )


def _epoch(value: Any) -> datetime | None:
    """Proto JSON epoch seconds (int or string); absent or 0 means unset."""
    if value in (None, "", 0, "0"):
        return None
    return from_epoch(value)


def _text(ts: Any) -> str | None:
    """The plain English translation of a GTFS-rt TranslatedString."""
    if not isinstance(ts, dict):
        return None
    tr = [t for t in ts.get("translation") or [] if isinstance(t, dict) and t.get("text")]
    for lang in ("en", None, ""):
        for t in tr:
            if t.get("language") == lang and str(t["text"]).strip():
                return str(t["text"]).strip()
    return None


def _refs(informed: Any) -> tuple[str, ...]:
    refs: set[str] = set()
    for ie in informed if isinstance(informed, list) else []:
        if not isinstance(ie, dict):
            continue
        if str(ie.get("route_id") or "").strip():
            refs.add(f"subway_route:{str(ie['route_id']).strip()}")
        if str(ie.get("stop_id") or "").strip():
            refs.add(f"subway_station:{station_id(str(ie['stop_id']))}")
    return tuple(sorted(refs))


def _fit(props: dict[str, Any]) -> dict[str, Any]:
    """Trim the description until the props fit PROPS_MAX_BYTES; deterministic."""
    while (over := _size(props) - PROPS_MAX_BYTES) > 0 and props["description"]:
        text = props["description"].rstrip(_ELLIPSIS)
        keep = max(0, len(text) - over - len(_ELLIPSIS))
        props["description"] = text[:keep].rstrip() + _ELLIPSIS if keep else None
    return props


def _size(props: dict) -> int:
    return len(json.dumps(props, ensure_ascii=False, allow_nan=False).encode("utf-8"))

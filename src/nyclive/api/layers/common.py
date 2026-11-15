"""Shared pieces for the per-layer builders: context, result, time and ref helpers."""

from __future__ import annotations

import json
import sqlite3
from dataclasses import dataclass, field
from datetime import UTC, datetime, timedelta
from typing import TYPE_CHECKING, Any

if TYPE_CHECKING:
    from nyclive.api.app import Services


@dataclass
class Ctx:
    conn: sqlite3.Connection
    now: datetime
    services: Services
    layer: dict[str, Any]
    params: dict[str, str] = field(default_factory=dict)  # server filter values, defaults filled

    @property
    def now_text(self) -> str:
        return ts_text(self.now)


@dataclass
class LayerResult:
    features: list[dict[str, Any]]
    data_as_of: str | None = None
    window: dict[str, str] | None = None
    unlocated: int = 0
    note: str | None = None


# ------------------------------------------------------------------------------------ time
def ts_text(dt: datetime) -> str:
    """The storage text form (state.ts): ISO UTC with microseconds, sortable as text."""
    return dt.astimezone(UTC).isoformat(timespec="microseconds")


def parse_ts(text: str | None) -> datetime | None:
    if not text or not isinstance(text, str):
        return None
    try:
        dt = datetime.fromisoformat(text)
    except ValueError:
        return None
    return dt.replace(tzinfo=UTC) if dt.tzinfo is None else dt.astimezone(UTC)


def iso(value: str | datetime | None) -> str | None:
    """API output form: ISO 8601 UTC, second precision, Z suffix."""
    if value is None or value == "":
        return None
    dt = value if isinstance(value, datetime) else parse_ts(value)
    if dt is None:
        return None
    return dt.astimezone(UTC).strftime("%Y-%m-%dT%H:%M:%SZ")


WINDOWS = {"h": "hours", "d": "days"}


def window_delta(value: str) -> timedelta:
    """'24h' / '7d' -> timedelta."""
    return timedelta(**{WINDOWS[value[-1]]: int(value[:-1])})


def anchor(conn: sqlite3.Connection, source: str, now_text: str) -> str | None:
    """data_as_of for windowed event layers: the newest starts_at at or before now."""
    row = conn.execute(
        "SELECT MAX(starts_at) FROM events WHERE source = ? AND starts_at <= ?", (source, now_text)
    ).fetchone()
    return row[0] if row else None


def window_bounds(
    conn: sqlite3.Connection, source: str, now_text: str, value: str
) -> tuple[str | None, str | None]:
    """(from, to) storage texts for a window ending at the source's newest record."""
    to = anchor(conn, source, now_text)
    if to is None:
        return None, None
    return ts_text(parse_ts(to) - window_delta(value)), to


def event_status(starts_at: str, ends_at: str | None, now_text: str) -> str:
    if ends_at is not None and ends_at <= now_text:
        return "ended"
    if starts_at > now_text:
        return "upcoming"
    return "active"


# ---------------------------------------------------------------------------------- shapes
def loads(text: str | None, default: Any = None) -> Any:
    if not text:
        return {} if default is None else default
    try:
        return json.loads(text)
    except ValueError:
        return {} if default is None else default


def feature(fid: str, borough: str | None, geometry: dict, **props: Any) -> dict[str, Any]:
    return {
        "type": "Feature",
        "geometry": geometry,
        "properties": {"id": str(fid), "borough": borough, **props},
    }


def num(v: Any, digits: int = 3) -> float | None:
    return None if v is None else round(float(v), digits)


def as_int(v: Any) -> int | None:
    return None if v is None else round(float(v))


def latest_by_entity(conn: sqlite3.Connection, kind: str) -> dict[str, dict[str, tuple]]:
    """entity_id -> metric -> (value, observed_at) from `latest`."""
    out: dict[str, dict[str, tuple]] = {}
    for eid, metric, value, observed in conn.execute(
        "SELECT entity_id, metric, value, observed_at FROM latest WHERE kind = ?", (kind,)
    ):
        out.setdefault(eid, {})[metric] = (value, observed)
    return out


def entities(conn: sqlite3.Connection, kind: str) -> list[sqlite3.Row]:
    return conn.execute(
        "SELECT entity_id, source, name, lat, lon, geometry_wkt, borough, props, last_seen"
        " FROM entities WHERE kind = ? ORDER BY entity_id",
        (kind,),
    ).fetchall()


def entity_index(conn: sqlite3.Connection, kind: str) -> dict[str, sqlite3.Row]:
    return {r["entity_id"]: r for r in entities(conn, kind)}


def refs_of(row: sqlite3.Row | dict, kind: str) -> list[str]:
    """Ids of `kind` referenced in an event's entity_refs, in order."""
    prefix = kind + ":"
    return [r[len(prefix) :] for r in loads(row["entity_refs"], []) if r.startswith(prefix)]


def first_resolved(
    row: sqlite3.Row | dict, kind: str, index: dict[str, sqlite3.Row]
) -> sqlite3.Row | None:
    for ref in refs_of(row, kind):
        hit = index.get(ref)
        if hit is not None and hit["lat"] is not None:
            return hit
    return None


def last_success(conn: sqlite3.Connection, sources: list[str]) -> str | None:
    if not sources:
        return None
    marks = ",".join("?" for _ in sources)
    row = conn.execute(
        f"SELECT MAX(last_success) FROM source_state WHERE source IN ({marks})", sources
    ).fetchone()
    return row[0] if row else None

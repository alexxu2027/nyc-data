"""The only place publisher timestamps become datetimes.

Everything returned here is tz-aware UTC (CLAUDE.md: store UTC, render America/New_York).
Adapters must build times through these helpers so naive local strings can't sneak in.
"""

from __future__ import annotations

import math
from datetime import UTC, datetime
from zoneinfo import ZoneInfo

NY = ZoneInfo("America/New_York")

_EPOCH_DIVISORS = {"s": 1, "ms": 1_000, "us": 1_000_000}


def now_utc() -> datetime:
    """Current time, for the pipeline and CLI. Adapters get `ctx.now` instead."""
    return datetime.now(UTC)


def ensure_utc(dt: datetime) -> datetime:
    """Convert an aware datetime to UTC. A naive one is a bug, so it raises."""
    if dt.tzinfo is None or dt.utcoffset() is None:
        raise ValueError(f"naive datetime {dt!r}: use local_to_utc() for local times")
    return dt.astimezone(UTC)


def parse_iso_utc(s: str) -> datetime:
    """Parse an ISO 8601 string that carries an offset or `Z`.

    A string with no offset raises: Socrata and MTA publish New York local times without one,
    and those must go through `local_to_utc` so the conversion is explicit.
    """
    dt = datetime.fromisoformat(s.strip())
    if dt.tzinfo is None:
        raise ValueError(f"{s!r} has no UTC offset; use local_to_utc()")
    return dt.astimezone(UTC)


def parse_rfc2822_utc(s: str) -> datetime:
    """Parse an RSS `pubDate` ("Thu, 12 Feb 2026 01:10:35 GMT"); it must carry a zone."""
    from email.utils import parsedate_to_datetime

    dt = parsedate_to_datetime(s.strip())
    if dt.tzinfo is None:
        raise ValueError(f"{s!r} has no zone")
    return dt.astimezone(UTC)


def parse_naive_utc(s: str, fmt: str | None = None) -> datetime:
    """Parse a string that is UTC but carries no offset (NOAA with `time_zone=gmt` sends
    "2026-11-15 01:06"). Use only when the source documents the time as UTC."""
    s = s.strip()
    dt = datetime.strptime(s, fmt) if fmt else datetime.fromisoformat(s)
    if dt.tzinfo is not None:
        return dt.astimezone(UTC)
    return dt.replace(tzinfo=UTC)


def from_epoch(value: float | str, unit: str = "s") -> datetime:
    """Unix epoch (seconds by default; `ms` or `us` for finer units) to UTC."""
    if unit not in _EPOCH_DIVISORS:
        raise ValueError(f"unit must be one of {sorted(_EPOCH_DIVISORS)}")
    x = float(value)
    if not math.isfinite(x):
        raise ValueError(f"epoch value {value!r} is not finite")
    return datetime.fromtimestamp(x / _EPOCH_DIVISORS[unit], UTC)


def local_to_utc(s: str, fmt: str | None = None) -> datetime:
    """Parse a New York local time string and return UTC.

    `fmt` is a `strptime` format (e.g. "%m/%d/%Y %I:%M:%S %p" for MTA elevators); without it the
    string is read as ISO 8601 (Socrata's "2026-11-14T18:12:06.000").

    DST: an ambiguous time (the repeated 1-2 AM in November) takes the first occurrence (EDT). A
    time skipped in March is read with the pre-transition offset (EST), so 2:30 AM becomes
    07:30 UTC. If the string already carries an offset, that offset is respected.
    """
    s = s.strip()
    dt = datetime.strptime(s, fmt) if fmt else datetime.fromisoformat(s)
    if dt.tzinfo is not None:
        return dt.astimezone(UTC)
    return dt.replace(tzinfo=NY, fold=0).astimezone(UTC)


def to_ny(dt: datetime) -> datetime:
    """For display only: an aware datetime in America/New_York."""
    return ensure_utc(dt).astimezone(NY)

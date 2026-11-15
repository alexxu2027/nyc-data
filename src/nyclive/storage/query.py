"""Read-only history queries over the Parquet archive (DuckDB), for the API.

Every read dedupes on the natural key (archive.DEDUPE). The hourly compaction can delete a part
file between listing and reading, so each query retries once with a fresh file list; a second
failure raises and the caller degrades (null / empty), never a 500.
"""

from __future__ import annotations

from collections.abc import Callable, Iterable
from datetime import UTC, date, datetime, timedelta
from pathlib import Path

import duckdb

from nyclive.storage.archive import _read_sql, partition_files
from nyclive.timeutil import ensure_utc

Point = tuple[datetime, float]


def _days(start: date, end: date) -> list[date]:
    n = (end - start).days
    return [start + timedelta(days=i) for i in range(max(n, 0) + 1)]


def _files(archive_dir: Path, source: str, days: Iterable[date]) -> list[Path]:
    return [f for d in days for f in partition_files(archive_dir, source, "observations", d)]


def _with_retry[T](fn: Callable[[], T]) -> T:
    try:
        return fn()
    except duckdb.Error:
        return fn()  # a part file vanished mid-read (compaction): list again and retry once


def _query(files: list[Path], kind: str, entity_id: str, metrics: list[str], extra: str, params):
    where = "WHERE kind = $kind AND entity_id = $eid AND metric IN (SELECT unnest($metrics))"
    inner = _read_sql(files, "observations", where)
    sql = f"""
        SELECT metric, epoch_ms(observed_at) AS ms, value FROM ({inner})
        {extra}
        ORDER BY metric, ms
    """
    with duckdb.connect() as con:
        rows = con.execute(
            sql, {"kind": kind, "eid": entity_id, "metrics": metrics, **params}
        ).fetchall()
    return [(m, datetime.fromtimestamp(ms / 1000, UTC), v) for m, ms, v in rows]


def series(
    archive_dir: Path,
    source: str,
    kind: str,
    entity_id: str,
    metrics: list[str],
    start: datetime,
    end: datetime,
    now: datetime,
) -> dict[str, list[Point]]:
    """Readings per metric in [start, end], ascending, plus the last reading before `start`
    (returned with its time clamped to `start`). Partitions from date(start) - 1 day to
    date(now) are read: the daily keyframe puts every current value in each day, and future
    predictions (tide) were fetched in the past."""
    start, end, now = ensure_utc(start), ensure_utc(end), ensure_utc(now)

    def run() -> dict[str, list[Point]]:
        files = _files(archive_dir, source, _days(start.date() - timedelta(days=1), now.date()))
        out: dict[str, list[Point]] = {m: [] for m in metrics}
        if not files:
            return out
        rows = _query(files, kind, entity_id, metrics, "", {})
        before: dict[str, Point] = {}
        for metric, t, v in rows:
            t = ensure_utc(t)
            if t < start:
                before[metric] = (start, v)
            elif t <= end:
                out[metric].append((t, v))
        for m, p in before.items():
            if not out[m] or out[m][0][0] > start:
                out[m].insert(0, p)
        return out

    return _with_retry(run)


def value_at(
    archive_dir: Path,
    source: str,
    kind: str,
    entity_id: str,
    metric: str,
    t: datetime,
    *,
    tolerance: timedelta | None = None,
    days_back: int = 2,
) -> Point | None:
    """The reading of one metric at `t`.

    With `tolerance`, the reading whose observed_at is nearest to `t` within ±tolerance;
    without, the last reading at or before `t`. Reads partitions date(t) back `days_back` days
    (and date(t) + 1 for late fetches)."""
    t = ensure_utc(t)

    def run() -> Point | None:
        days = _days(t.date() - timedelta(days=days_back), t.date() + timedelta(days=1))
        files = _files(archive_dir, source, days)
        if not files:
            return None
        if tolerance is None:
            extra = "WHERE observed_at <= $t"
        else:
            extra = "WHERE observed_at BETWEEN $lo AND $hi"
        rows = _query(
            files,
            kind,
            entity_id,
            [metric],
            extra,
            {"t": t} if tolerance is None else {"lo": t - tolerance, "hi": t + tolerance},
        )
        if not rows:
            return None
        if tolerance is None:
            _, ot, v = rows[-1]
        else:
            _, ot, v = min(rows, key=lambda r: abs((ensure_utc(r[1]) - t).total_seconds()))
        return ensure_utc(ot), v

    return _with_retry(run)

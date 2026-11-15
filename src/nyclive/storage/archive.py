"""The Parquet archive: append-only history, partitioned source=/table=/date= (ADR-004, ADR-011).

Write path: one small `part-HHMMSS-<run id>.parquet` per table per run, written to a temp name
and renamed, so readers never see half a file. `compact` merges a closed day into one deduped
`compacted.parquet`. Every read dedupes on the natural key, because a crash between the Parquet
write and the SQLite commit can leave a duplicate part (ADR-011 step 6).

DuckDB results are returned as Arrow tables (fetching TIMESTAMPTZ as Python objects would need
pytz).
"""

from __future__ import annotations

import json
import logging
import os
import uuid
from collections.abc import Iterable
from datetime import date, datetime, timedelta
from pathlib import Path
from typing import Any

import duckdb
import pyarrow as pa
import pyarrow.parquet as pq

from nyclive.model import SCHEMAS, Entity, Event, Observation
from nyclive.timeutil import ensure_utc

log = logging.getLogger(__name__)

COMPACTED = "compacted.parquet"
RUNS_SOURCE = "_collector"
# Natural key per table, plus the column that picks the winner among duplicates.
DEDUPE = {
    "observations": (("kind", "entity_id", "metric", "observed_at"), "fetched_at"),
    "entities": (("kind", "entity_id", "payload_hash"), "last_seen"),
    "events": (("source", "event_id", "payload_hash"), "updated_at"),
    "runs": (("run_id",), "finished_at"),
}
# A day counts as closed this long after UTC midnight, so slow runs that started before midnight
# have finished writing to it.
CLOSE_GRACE = timedelta(hours=1)


# --------------------------------------------------------------------------------- row shapes
def props_json(props: Any) -> str:
    return json.dumps(props, ensure_ascii=False, sort_keys=True, separators=(",", ":"))


def entity_row(e: Entity, payload_hash: str, first_seen: datetime, last_seen: datetime) -> dict:
    return {
        "source": e.source, "kind": e.kind, "entity_id": e.entity_id, "name": e.name,
        "lat": e.lat, "lon": e.lon, "geometry_wkt": e.geometry_wkt, "borough": e.borough,
        "props": props_json(e.props), "first_seen": first_seen, "last_seen": last_seen,
        "payload_hash": payload_hash,
    }  # fmt: skip


def observation_row(o: Observation) -> dict:
    return {
        "source": o.source, "kind": o.kind, "entity_id": o.entity_id, "metric": o.metric,
        "observed_at": o.observed_at, "value": o.value, "fetched_at": o.fetched_at,
    }  # fmt: skip


def event_row(ev: Event, payload_hash: str, updated_at: datetime) -> dict:
    return {
        "source": ev.source, "event_id": ev.event_id, "category": ev.category,
        "subtype": ev.subtype, "title": ev.title, "starts_at": ev.starts_at,
        "ends_at": ev.ends_at, "severity": ev.severity, "lat": ev.lat, "lon": ev.lon,
        "geometry_wkt": ev.geometry_wkt, "borough": ev.borough,
        "entity_refs": list(ev.entity_refs), "props": props_json(ev.props),
        "payload_hash": payload_hash, "updated_at": updated_at,
    }  # fmt: skip


# -------------------------------------------------------------------------------------- paths
def partition_dir(archive_dir: Path, source: str, table: str, day: date) -> Path:
    return archive_dir / f"source={source}" / f"table={table}" / f"date={day.isoformat()}"


def partition_files(archive_dir: Path, source: str, table: str, day: date) -> list[Path]:
    d = partition_dir(archive_dir, source, table, day)
    return sorted(d.glob("*.parquet")) if d.is_dir() else []


# -------------------------------------------------------------------------------------- write
def write_part(
    archive_dir: Path,
    source: str,
    table: str,
    rows: list[dict],
    fetched_at: datetime,
    run_id: str,
) -> Path | None:
    """Write one part file for a run. The partition is the UTC date of `fetched_at`."""
    if not rows:
        return None
    fetched_at = ensure_utc(fetched_at)
    d = partition_dir(archive_dir, source, table, fetched_at.date())
    d.mkdir(parents=True, exist_ok=True)
    final = d / f"part-{fetched_at:%H%M%S}-{run_id}.parquet"
    tmp = d / f".{final.name}.{uuid.uuid4().hex[:6]}.tmp"
    pq.write_table(pa.Table.from_pylist(rows, schema=SCHEMAS[table]), tmp, compression="zstd")
    os.replace(tmp, final)
    return final


# --------------------------------------------------------------------------------------- read
def _read_sql(files: Iterable[Path], table: str, where: str = "") -> str:
    keys, winner = DEDUPE[table]
    file_list = ", ".join("'" + str(f).replace("'", "''") + "'" for f in files)
    return f"""
        SELECT * EXCLUDE (_rn) FROM (
            SELECT *, row_number() OVER (
                PARTITION BY {", ".join(keys)} ORDER BY {winner} DESC) AS _rn
            FROM read_parquet([{file_list}], union_by_name = true, hive_partitioning = false)
            {where}
        ) WHERE _rn = 1
    """


def read_table(archive_dir: Path, source: str, table: str, days: Iterable[date]) -> pa.Table:
    """All rows of a table for the given days, deduped on the natural key."""
    files = [f for d in days for f in partition_files(archive_dir, source, table, d)]
    if not files:
        return SCHEMAS[table].empty_table()
    with duckdb.connect() as con:
        return con.sql(_read_sql(files, table)).to_arrow_table()


def as_of_observations(archive_dir: Path, source: str, t: datetime) -> pa.Table:
    """State of every (kind, entity_id, metric) of a source as of `t` (ADR-011 step 2).

    Reads the partitions for date(t) and date(t)+1 only: the daily keyframe guarantees every
    current value appears in date(t), and date(t)+1 catches readings fetched after midnight.
    """
    t = ensure_utc(t)
    files = [
        f
        for d in (t.date(), t.date() + timedelta(days=1))
        for f in partition_files(archive_dir, source, "observations", d)
    ]
    if not files:
        return SCHEMAS["observations"].empty_table()
    deduped = _read_sql(files, "observations", where="WHERE observed_at <= $t")
    sql = f"""
        SELECT kind, entity_id, metric, value, observed_at FROM ({deduped})
        QUALIFY row_number() OVER (
            PARTITION BY kind, entity_id, metric ORDER BY observed_at DESC, fetched_at DESC) = 1
        ORDER BY kind, entity_id, metric
    """
    with duckdb.connect() as con:
        return con.sql(sql, params={"t": t}).to_arrow_table()


# ------------------------------------------------------------------------------------ compact
def closed_before(now: datetime) -> date:
    """Days strictly before this date are closed and may be compacted."""
    return (ensure_utc(now) - CLOSE_GRACE).date()


def compact_partition(d: Path, table: str) -> bool:
    """Merge a partition's files into one deduped compacted.parquet. Returns True if it wrote.

    Idempotent: a partition holding only compacted.parquet is left alone; leftover parts (from a
    file that couldn't be deleted, or a late writer) are merged in on the next run.
    """
    files = sorted(d.glob("*.parquet"))
    if not files or (len(files) == 1 and files[0].name == COMPACTED):
        return False
    tmp = d / f".compacted.{uuid.uuid4().hex[:6]}.tmp"
    target = str(tmp).replace("'", "''")
    with duckdb.connect() as con:
        con.execute(
            f"COPY ({_read_sql(files, table)}) TO '{target}' (FORMAT parquet, COMPRESSION zstd)"
        )
    os.replace(tmp, d / COMPACTED)
    for f in files:
        if f.name == COMPACTED:
            continue
        try:
            f.unlink()
        except PermissionError:  # Windows: a reader still has it open; next compact retries
            log.warning("compact: could not delete %s yet", f)
    return True


def compact(archive_dir: Path, now: datetime, include_open: bool = False) -> list[Path]:
    """Compact day partitions under the archive. Returns the partitions written.

    By default only closed days. `include_open=True` also compacts today's (and the grace
    period's) partitions; the scheduler does that hourly, under the write lock, so an open day
    holds a few dozen files instead of ~1,440 (as-of over 1,440 parts measured 2.9 s vs 0.3 s).
    Safe because compaction only deletes the files it merged and every read dedupes.
    """
    cutoff = date.max if include_open else closed_before(now)
    done = []
    for d in sorted(archive_dir.glob("source=*/table=*/date=*")):
        if not d.is_dir():
            continue
        table = d.parent.name.removeprefix("table=")
        try:
            day = date.fromisoformat(d.name.removeprefix("date="))
        except ValueError:
            continue
        if table in DEDUPE and day < cutoff and compact_partition(d, table):
            done.append(d)
    return done


def export_runs(archive_dir: Path, day: date, runs: list[dict[str, Any]]) -> Path | None:
    """Write a closed day's runs (from state.db) as source=_collector/table=runs (ADR-011)."""
    d = partition_dir(archive_dir, RUNS_SOURCE, "runs", day)
    if (d / COMPACTED).exists() or not runs:
        return None
    rows = [
        {
            **r,
            "ok": bool(r["ok"]),
            "started_at": datetime.fromisoformat(r["started_at"]),
            "finished_at": datetime.fromisoformat(r["finished_at"]),
        }
        for r in runs
    ]
    d.mkdir(parents=True, exist_ok=True)
    tmp = d / f".runs.{uuid.uuid4().hex[:6]}.tmp"
    pq.write_table(pa.Table.from_pylist(rows, schema=SCHEMAS["runs"]), tmp, compression="zstd")
    os.replace(tmp, d / COMPACTED)
    return d / COMPACTED

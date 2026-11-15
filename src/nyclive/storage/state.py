"""`state.db`: the current state of everything, for the live map and for change detection.

SQLite in WAL mode (ADR-003): one writer at a time (the pipeline holds a lock), many readers.
Timestamps are stored as ISO 8601 UTC strings with microseconds, so they sort as text.
Archive history lives in Parquet (storage/archive.py); this file only holds "now".
"""

from __future__ import annotations

import sqlite3
import threading
from collections.abc import Iterable
from dataclasses import dataclass, field
from datetime import date, datetime
from pathlib import Path
from typing import Any, Self

from nyclive.timeutil import ensure_utc

SCHEMA_VERSION = 2  # v2: events.last_seen (2026-11-15)

_DDL = """
CREATE TABLE IF NOT EXISTS entities (
    kind TEXT NOT NULL, entity_id TEXT NOT NULL, source TEXT NOT NULL, name TEXT,
    lat REAL, lon REAL, geometry_wkt TEXT, borough TEXT, props TEXT,
    payload_hash TEXT, first_seen TEXT, last_seen TEXT,
    PRIMARY KEY (kind, entity_id)
);
CREATE INDEX IF NOT EXISTS entities_source ON entities (source);

CREATE TABLE IF NOT EXISTS latest (
    kind TEXT NOT NULL, entity_id TEXT NOT NULL, metric TEXT NOT NULL, source TEXT NOT NULL,
    value REAL NOT NULL, observed_at TEXT NOT NULL, fetched_at TEXT NOT NULL,
    PRIMARY KEY (kind, entity_id, metric)
);
CREATE INDEX IF NOT EXISTS latest_source ON latest (source);

CREATE TABLE IF NOT EXISTS events (
    source TEXT NOT NULL, event_id TEXT NOT NULL, category TEXT, subtype TEXT, title TEXT,
    starts_at TEXT, ends_at TEXT, severity INTEGER, lat REAL, lon REAL, geometry_wkt TEXT,
    borough TEXT, entity_refs TEXT, props TEXT, payload_hash TEXT,
    first_seen TEXT, updated_at TEXT, last_seen TEXT,
    PRIMARY KEY (source, event_id)
);
CREATE INDEX IF NOT EXISTS events_ends ON events (source, ends_at);

CREATE TABLE IF NOT EXISTS source_state (
    source TEXT PRIMARY KEY, cursor TEXT, keyframe_date TEXT,
    last_attempt TEXT, last_success TEXT, last_error TEXT,
    consecutive_failures INTEGER NOT NULL DEFAULT 0, rows_last_run INTEGER, lag_s REAL
);

CREATE TABLE IF NOT EXISTS runs (
    run_id TEXT PRIMARY KEY, source TEXT NOT NULL, started_at TEXT NOT NULL,
    finished_at TEXT NOT NULL, ok INTEGER NOT NULL, bytes INTEGER, rows_written INTEGER,
    error TEXT
);
CREATE INDEX IF NOT EXISTS runs_started ON runs (started_at);
CREATE INDEX IF NOT EXISTS runs_source ON runs (source, started_at);
"""

ENTITY_COLS = (
    "kind", "entity_id", "source", "name", "lat", "lon", "geometry_wkt", "borough", "props",
    "payload_hash", "first_seen", "last_seen",
)  # fmt: skip
LATEST_COLS = ("kind", "entity_id", "metric", "source", "value", "observed_at", "fetched_at")
EVENT_COLS = (
    "source", "event_id", "category", "subtype", "title", "starts_at", "ends_at", "severity",
    "lat", "lon", "geometry_wkt", "borough", "entity_refs", "props", "payload_hash",
    "first_seen", "updated_at", "last_seen",
)  # fmt: skip
RUN_COLS = ("run_id", "source", "started_at", "finished_at", "ok", "bytes", "rows_written", "error")


def ts(dt: datetime | None) -> str | None:
    """Canonical text form of a UTC timestamp."""
    return None if dt is None else ensure_utc(dt).isoformat(timespec="microseconds")


@dataclass
class RunCommit:
    """Everything one successful run changes in state.db, applied in one transaction."""

    source: str
    run: dict[str, Any]
    cursor: str | None
    keyframe_date: str | None
    entities: list[dict[str, Any]] = field(default_factory=list)  # full rows (ENTITY_COLS)
    seen_entities: list[tuple[str, str]] = field(default_factory=list)  # bump last_seen only
    seen_events: list[str] = field(default_factory=list)  # event_ids: bump last_seen only
    latest: list[dict[str, Any]] = field(default_factory=list)  # LATEST_COLS
    events: list[dict[str, Any]] = field(default_factory=list)  # EVENT_COLS
    lag_s: float | None = None


class StateStore:
    """Thin wrapper over one SQLite connection. Callers serialize writes (pipeline lock)."""

    def __init__(self, path: Path):
        path.parent.mkdir(parents=True, exist_ok=True)
        self.path = path
        self._conn = sqlite3.connect(path, check_same_thread=False, isolation_level=None)
        self._conn.row_factory = sqlite3.Row
        self._lock = threading.RLock()
        with self._lock:
            c = self._conn
            c.execute("PRAGMA journal_mode=WAL")
            c.execute("PRAGMA synchronous=NORMAL")
            c.execute("PRAGMA busy_timeout=10000")
            version = c.execute("PRAGMA user_version").fetchone()[0]
            if version > SCHEMA_VERSION:
                raise RuntimeError(
                    f"{path} has schema v{version}; this code knows v{SCHEMA_VERSION}"
                )
            if version == 1:  # v1 -> v2: events.last_seen, backfilled from updated_at
                c.execute("ALTER TABLE events ADD COLUMN last_seen TEXT")
                c.execute("UPDATE events SET last_seen = updated_at")
            c.executescript(_DDL)
            c.execute(f"PRAGMA user_version={SCHEMA_VERSION}")

    def close(self) -> None:
        with self._lock:
            self._conn.close()

    def __enter__(self) -> Self:
        return self

    def __exit__(self, *exc: object) -> None:
        self.close()

    # ------------------------------------------------------------------------------- reads
    def _all(self, sql: str, args: Iterable[Any] = ()) -> list[sqlite3.Row]:
        with self._lock:
            return self._conn.execute(sql, tuple(args)).fetchall()

    def source_state(self, source: str) -> dict[str, Any] | None:
        rows = self._all("SELECT * FROM source_state WHERE source = ?", (source,))
        return dict(rows[0]) if rows else None

    def all_source_states(self) -> dict[str, dict[str, Any]]:
        return {r["source"]: dict(r) for r in self._all("SELECT * FROM source_state")}

    def latest_for(self, source: str) -> dict[tuple[str, str, str], tuple[float, str]]:
        """(kind, entity_id, metric) -> (value, observed_at) for one source."""
        rows = self._all(
            "SELECT kind, entity_id, metric, value, observed_at FROM latest WHERE source = ?",
            (source,),
        )
        return {(r[0], r[1], r[2]): (r[3], r[4]) for r in rows}

    def entities_for(self, source: str) -> dict[tuple[str, str], dict[str, Any]]:
        rows = self._all("SELECT * FROM entities WHERE source = ?", (source,))
        return {(r["kind"], r["entity_id"]): dict(r) for r in rows}

    def events_for(self, source: str, open_only: bool = False) -> dict[str, dict[str, Any]]:
        sql = "SELECT * FROM events WHERE source = ?"
        if open_only:
            sql += " AND ends_at IS NULL"
        return {r["event_id"]: dict(r) for r in self._all(sql, (source,))}

    def runs_between(self, start: str, end: str) -> list[dict[str, Any]]:
        rows = self._all(
            "SELECT * FROM runs WHERE started_at >= ? AND started_at < ? ORDER BY started_at",
            (start, end),
        )
        return [dict(r) for r in rows]

    def run_days_before(self, cutoff: str) -> list[date]:
        """UTC days (before `cutoff`, an ISO date) that have runs in state.db."""
        rows = self._all(
            "SELECT DISTINCT substr(started_at, 1, 10) FROM runs WHERE started_at < ? ORDER BY 1",
            (cutoff,),
        )
        return [date.fromisoformat(r[0]) for r in rows]

    def count(self, table: str, source: str | None = None) -> int:
        if table not in {"entities", "latest", "events", "runs", "source_state"}:
            raise ValueError(table)
        sql, args = f"SELECT COUNT(*) FROM {table}", ()
        if source:
            sql, args = sql + " WHERE source = ?", (source,)
        return self._all(sql, args)[0][0]

    # ------------------------------------------------------------------------------ writes
    def commit_run(self, c: RunCommit) -> None:
        """Apply a successful run atomically (ADR-011 step 6: after the Parquet parts)."""
        run = c.run
        with self._lock:
            conn = self._conn
            conn.execute("BEGIN IMMEDIATE")
            try:
                _upsert(conn, "entities", ENTITY_COLS, ("kind", "entity_id"), c.entities)
                if c.seen_entities:
                    conn.executemany(
                        "UPDATE entities SET last_seen = ? WHERE kind = ? AND entity_id = ?",
                        [(run["finished_at"], k, i) for k, i in c.seen_entities],
                    )
                _upsert(conn, "latest", LATEST_COLS, ("kind", "entity_id", "metric"), c.latest)
                _upsert(conn, "events", EVENT_COLS, ("source", "event_id"), c.events)
                if c.seen_events:
                    conn.executemany(
                        "UPDATE events SET last_seen = ? WHERE source = ? AND event_id = ?",
                        [(run["finished_at"], c.source, e) for e in c.seen_events],
                    )
                _insert_run(conn, run)
                conn.execute(
                    """INSERT INTO source_state (source, cursor, keyframe_date, last_attempt,
                           last_success, last_error, consecutive_failures, rows_last_run, lag_s)
                       VALUES (?, ?, ?, ?, ?, NULL, 0, ?, ?)
                       ON CONFLICT(source) DO UPDATE SET
                           cursor = excluded.cursor,
                           keyframe_date = COALESCE(excluded.keyframe_date,
                                                    source_state.keyframe_date),
                           last_attempt = excluded.last_attempt,
                           last_success = excluded.last_success,
                           last_error = NULL, consecutive_failures = 0,
                           rows_last_run = excluded.rows_last_run,
                           lag_s = COALESCE(excluded.lag_s, source_state.lag_s)""",
                    (
                        c.source,
                        c.cursor,
                        c.keyframe_date,
                        run["started_at"],
                        run["finished_at"],
                        run["rows_written"],
                        c.lag_s,
                    ),
                )
                conn.execute("COMMIT")
            except BaseException:
                conn.execute("ROLLBACK")
                raise

    def record_failure(self, source: str, run: dict[str, Any]) -> int:
        """Log a failed run; returns the new consecutive failure count."""
        with self._lock:
            conn = self._conn
            conn.execute("BEGIN IMMEDIATE")
            try:
                _insert_run(conn, run)
                conn.execute(
                    """INSERT INTO source_state (source, last_attempt, last_error,
                           consecutive_failures)
                       VALUES (?, ?, ?, 1)
                       ON CONFLICT(source) DO UPDATE SET
                           last_attempt = excluded.last_attempt,
                           last_error = excluded.last_error,
                           consecutive_failures = source_state.consecutive_failures + 1""",
                    (source, run["started_at"], run["error"]),
                )
                n = conn.execute(
                    "SELECT consecutive_failures FROM source_state WHERE source = ?", (source,)
                ).fetchone()[0]
                conn.execute("COMMIT")
            except BaseException:
                conn.execute("ROLLBACK")
                raise
        return n

    def prune(self, before: str) -> None:
        """Drop closed events not seen since `before`, and runs older than it (the archive
        keeps both). "Seen", not "ended": a feed that re-sends old closed events (collisions,
        FloodNet) must keep them in state, or every run would re-write them as new."""
        with self._lock:
            self._conn.execute(
                "DELETE FROM events WHERE ends_at IS NOT NULL"
                " AND COALESCE(last_seen, updated_at) < ?",
                (before,),
            )
            self._conn.execute("DELETE FROM runs WHERE started_at < ?", (before,))


def _upsert(conn, table: str, cols: tuple[str, ...], key: tuple[str, ...], rows) -> None:
    if not rows:
        return
    placeholders = ", ".join("?" for _ in cols)
    updates = ", ".join(f"{c} = excluded.{c}" for c in cols if c not in key)
    sql = (
        f"INSERT INTO {table} ({', '.join(cols)}) VALUES ({placeholders}) "
        f"ON CONFLICT({', '.join(key)}) DO UPDATE SET {updates}"
    )
    conn.executemany(sql, [tuple(r[c] for c in cols) for r in rows])


def _insert_run(conn, run: dict[str, Any]) -> None:
    conn.execute(
        f"INSERT OR REPLACE INTO runs ({', '.join(RUN_COLS)}) VALUES "
        f"({', '.join('?' for _ in RUN_COLS)})",
        tuple(run.get(c) for c in RUN_COLS),
    )

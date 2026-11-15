"""Read-only access to state.db (ADR-003: the API never writes).

One connection per request, opened with the `mode=ro` URI so a write raises
`sqlite3.OperationalError: attempt to write a readonly database`. This module must not import
`StateStore`, the pipeline or the archive writers.
"""

from __future__ import annotations

import sqlite3
from collections.abc import Iterator
from contextlib import contextmanager
from pathlib import Path

from nyclive.api.errors import ApiError


def connect_ro(path: Path) -> sqlite3.Connection:
    """Open state.db read-only. Raises ApiError 503 if it doesn't exist yet."""
    if not path.is_file():
        raise ApiError(503, "unavailable", f"no state.db at {path}; run `nyclive collect` first")
    conn = sqlite3.connect(path.resolve().as_uri() + "?mode=ro", uri=True, check_same_thread=False)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA busy_timeout=5000")
    return conn


@contextmanager
def reading(path: Path) -> Iterator[sqlite3.Connection]:
    conn = connect_ro(path)
    try:
        yield conn
    finally:
        conn.close()

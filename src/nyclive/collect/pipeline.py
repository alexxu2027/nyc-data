"""`run_once`: fetch → parse → validate → decide what changed → write (ADR-011).

Write order per run: Parquet parts first, then one SQLite transaction. A crash in between leaves
duplicate archive rows, which reads and `compact` dedupe; it never loses data, because the
cursor and change-detection state only advance in that final transaction.

What gets archived:
- observations: change-only per (kind, entity_id, metric), plus a keyframe of the newest value
  of every key on a source's first successful run of each UTC day;
- entities: new or changed (payload hash), plus the keyframe;
- events: a new version whenever the payload hash changes. If a batch is complete for events,
  open events missing from it are closed with `ends_at = fetched_at`.
"""

from __future__ import annotations

import hashlib
import json
import logging
import threading
import uuid
from collections.abc import Callable
from dataclasses import asdict, dataclass, field, replace
from datetime import datetime
from pathlib import Path
from typing import Any

from nyclive.http import Http
from nyclive.model import Entity, Event, record_problems
from nyclive.registry import Source
from nyclive.sources.base import COMPLETE_TABLES, Adapter, Batch, FetchContext
from nyclive.storage import archive
from nyclive.storage.state import RunCommit, StateStore, ts
from nyclive.timeutil import now_utc

log = logging.getLogger(__name__)

# All storage writes (any source, any thread) go through this lock: one SQLite writer at a time.
WRITE_LOCK = threading.Lock()
MAX_LOGGED_PROBLEMS = 5


@dataclass(frozen=True)
class RunResult:
    run_id: str
    source: str
    ok: bool
    rows_written: int = 0
    bytes: int = 0
    dropped: int = 0
    error: str | None = None
    consecutive_failures: int = 0


def payload_hash(record: Entity | Event) -> str:
    blob = json.dumps(asdict(record), sort_keys=True, default=str, ensure_ascii=False)
    return hashlib.sha1(blob.encode("utf-8")).hexdigest()[:16]


def clean_batch(batch: Batch, source_id: str) -> tuple[Batch, list[str]]:
    """Drop invalid records and in-batch duplicate keys (last one wins). Returns the problems.

    A bad record shouldn't stop a whole source; the run still counts, and the problems are
    logged and put in the run's error field so `status` shows them.
    """
    if not batch.complete <= COMPLETE_TABLES:
        raise ValueError(f"Batch.complete must be a subset of {sorted(COMPLETE_TABLES)}")
    problems: list[str] = []
    out = {}
    for table in ("entities", "observations", "events"):
        kept: dict[tuple, Any] = {}
        for i, r in enumerate(getattr(batch, table)):
            p = record_problems(r)
            if r.source != source_id:
                p.append(f"source {r.source!r} != {source_id!r}")
            if p:
                problems.append(f"{table}[{i}]: {'; '.join(p)}")
                continue
            if r.key in kept:
                problems.append(f"{table}[{i}]: duplicate key {r.key}")
            kept[r.key] = r
        out[table] = list(kept.values())
    return replace(batch, **out), problems


def run_once(
    source: Source,
    adapter: Adapter,
    http: Http,
    store: StateStore,
    archive_dir: Path,
    *,
    now: Callable[[], datetime] = now_utc,
    after_archive: Callable[[], None] | None = None,
) -> RunResult:
    """One collection run for one source. Never raises for feed or parse errors: they are
    recorded as a failed run. `after_archive` is a test hook to simulate a crash."""
    run_id = uuid.uuid4().hex[:12]
    started = now()
    try:
        state = store.source_state(source.id) or {}
        ctx = FetchContext(source=source, http=http, cursor=state.get("cursor"), now=started)
        raw = adapter.fetch(ctx)
        nbytes = sum(len(p.content) for p in raw.parts)
        batch, problems = clean_batch(adapter.parse(raw), source.id)
        dropped = len(problems)
        for msg in problems[:MAX_LOGGED_PROBLEMS]:
            log.warning("%s: dropped %s", source.id, msg)
        fetched_at = raw.fetched_at
        with WRITE_LOCK:
            rows = _write(source.id, batch, fetched_at, run_id, store, archive_dir, state)
            if after_archive:
                after_archive()
            finished = now()
            run = {
                "run_id": run_id, "source": source.id, "started_at": ts(started),
                "finished_at": ts(finished), "ok": 1, "bytes": nbytes,
                "rows_written": rows.total,
                "error": f"dropped {dropped} invalid record(s)" if dropped else None,
            }  # fmt: skip
            store.commit_run(
                RunCommit(
                    source=source.id,
                    run=run,
                    cursor=batch.cursor if batch.cursor is not None else state.get("cursor"),
                    # Only a keyframe that wrote something counts; an empty run retries it.
                    keyframe_date=(
                        fetched_at.date().isoformat() if rows.keyframe and len(batch) else None
                    ),
                    entities=rows.entity_state,
                    seen_entities=rows.seen_entities,
                    latest=rows.latest_state,
                    events=rows.event_state,
                    lag_s=_lag_s(batch, fetched_at),
                )
            )
        return RunResult(run_id, source.id, True, rows.total, nbytes, dropped)
    except SimulatedCrash:
        raise
    except Exception as e:  # noqa: BLE001 - a run must never take the collector down
        error = f"{type(e).__name__}: {e}"[:500]
        log.warning("%s: run failed: %s", source.id, error)
        run = {
            "run_id": run_id, "source": source.id, "started_at": ts(started),
            "finished_at": ts(now()), "ok": 0, "bytes": None, "rows_written": 0, "error": error,
        }  # fmt: skip
        with WRITE_LOCK:
            n = store.record_failure(source.id, run)
        return RunResult(run_id, source.id, False, error=error, consecutive_failures=n)


class SimulatedCrash(Exception):
    """Raised by tests from `after_archive` to stop a run between the archive and the commit."""


# ------------------------------------------------------------------------------------ internals
@dataclass
class _Rows:
    keyframe: bool = False
    total: int = 0
    entity_state: list = field(default_factory=list)
    seen_entities: list = field(default_factory=list)
    latest_state: list = field(default_factory=list)
    event_state: list = field(default_factory=list)


def _write(
    sid: str,
    batch: Batch,
    fetched_at: datetime,
    run_id: str,
    store: StateStore,
    archive_dir: Path,
    state: dict,
) -> _Rows:
    keyframe = state.get("keyframe_date") != fetched_at.date().isoformat()
    out = _Rows(keyframe=keyframe)

    # Entities: new, changed, or keyframe → archive; state gets the full row either way.
    known = store.entities_for(sid)
    ent_rows = []
    for e in batch.entities:
        h = payload_hash(e)
        prev = known.get(e.key)
        first_seen = datetime.fromisoformat(prev["first_seen"]) if prev else fetched_at
        if prev and prev["payload_hash"] == h and not keyframe:
            out.seen_entities.append(e.key)
            continue
        row = archive.entity_row(e, h, first_seen, fetched_at)
        ent_rows.append(row)
        out.entity_state.append({**row, "first_seen": ts(first_seen), "last_seen": ts(fetched_at)})

    # Observations: change-only per key, oldest first; keyframe adds the newest of every key.
    stored = store.latest_for(sid)  # (kind, id, metric) -> (value, observed_at) before this run
    running = dict(stored)  # updated as this batch's readings are walked oldest-first
    obs_rows, newest_by_key = [], {}
    for o in sorted(batch.observations, key=lambda o: o.observed_at):
        k = (o.kind, o.entity_id, o.metric)
        prev, t = running.get(k), ts(o.observed_at)
        if prev is None:
            changed = True
        elif t > prev[1]:
            changed = o.value != prev[0]
        else:  # an older reading is ignored; the same reading with a new value is a revision
            changed = t == prev[1] and o.value != prev[0]
        if changed:
            obs_rows.append(o)
        if prev is None or t >= prev[1]:
            running[k] = (o.value, t)
        newest_by_key[k] = o
    if keyframe:
        written = {id(o) for o in obs_rows}
        obs_rows += [o for o in newest_by_key.values() if id(o) not in written]
    # state.latest = the newest reading per key (never moves backwards in time)
    for k, o in newest_by_key.items():
        value, t = running[k]
        if k in stored and t == stored[k][1] and value == stored[k][0]:
            continue  # nothing new for this key
        out.latest_state.append(
            {"kind": k[0], "entity_id": k[1], "metric": k[2], "source": sid,
             "value": value, "observed_at": t, "fetched_at": ts(o.fetched_at)}
        )  # fmt: skip

    # Events: a version per payload change; close open events that left a complete feed.
    known_ev = store.events_for(sid)
    ev_rows = []
    in_batch = set()
    for ev in batch.events:
        in_batch.add(ev.event_id)
        h = payload_hash(ev)
        prev = known_ev.get(ev.event_id)
        if prev and prev["payload_hash"] == h:
            continue
        row = archive.event_row(ev, h, fetched_at)
        ev_rows.append(row)
        out.event_state.append(_event_state(row, prev, fetched_at))
    if "events" in batch.complete:
        for eid, prev in known_ev.items():
            if eid in in_batch or prev["ends_at"] is not None:
                continue
            closed = _closed_version(prev, fetched_at)
            ev_rows.append(closed)
            out.event_state.append(_event_state(closed, prev, fetched_at))

    for table, rows in (
        ("entities", ent_rows),
        ("observations", [archive.observation_row(o) for o in obs_rows]),
        ("events", ev_rows),
    ):
        archive.write_part(archive_dir, sid, table, rows, fetched_at, run_id)
        out.total += len(rows)
    return out


def _event_state(row: dict, prev: dict | None, fetched_at: datetime) -> dict:
    return {
        **row,
        "starts_at": ts(row["starts_at"]),
        "ends_at": ts(row["ends_at"]),
        "updated_at": ts(row["updated_at"]),
        "entity_refs": json.dumps(row["entity_refs"]),
        "first_seen": prev["first_seen"] if prev else ts(fetched_at),
    }


def _closed_version(prev: dict, fetched_at: datetime) -> dict:
    """Archive row for an open event that disappeared from a complete feed."""
    props = json.loads(prev["props"] or "{}")
    props["closed_reason"] = "left_feed"
    row = {
        "source": prev["source"], "event_id": prev["event_id"], "category": prev["category"],
        "subtype": prev["subtype"], "title": prev["title"],
        "starts_at": datetime.fromisoformat(prev["starts_at"]), "ends_at": fetched_at,
        "severity": prev["severity"], "lat": prev["lat"], "lon": prev["lon"],
        "geometry_wkt": prev["geometry_wkt"], "borough": prev["borough"],
        "entity_refs": json.loads(prev["entity_refs"] or "[]"),
        "props": archive.props_json(props), "updated_at": fetched_at,
    }  # fmt: skip
    row["payload_hash"] = hashlib.sha1(
        json.dumps(row, sort_keys=True, default=str).encode()
    ).hexdigest()[:16]
    return row


def _lag_s(batch: Batch, fetched_at: datetime) -> float | None:
    """How old the newest data in the batch is (observations, else event starts)."""
    times = [o.observed_at for o in batch.observations if o.observed_at <= fetched_at]
    if not times:
        times = [e.starts_at for e in batch.events if e.starts_at <= fetched_at]
    return (fetched_at - max(times)).total_seconds() if times else None

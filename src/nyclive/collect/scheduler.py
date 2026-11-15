"""`nyclive collect`: run every collected source on its cadence (ARCHITECTURE §3).

- One APScheduler 3.x job per source: thread pool of 4, `coalesce=True`, `max_instances=1`.
- Isolation: each run is `pipeline.run_once`, which never raises for feed problems.
- Failure policy: after 3 consecutive failures a source is `degraded` and backs off
  exponentially (cadence x 2^(n-2), capped at 30 min). One success resets it.
- Maintenance at startup and daily at 01:15 UTC: compact closed days, export their `runs`,
  prune old rows from state.db. Hourly at :07, today's partitions are compacted too.
- A lock file stops two collectors from writing the same data dir.
"""

from __future__ import annotations

import logging
import logging.handlers
import os
import sys
import time
from collections.abc import Callable, Iterable
from datetime import UTC, datetime, timedelta
from pathlib import Path
from typing import Self

from nyclive.collect.pipeline import WRITE_LOCK, RunResult, run_once
from nyclive.http import Http
from nyclive.registry import Registry, Source
from nyclive.settings import Settings
from nyclive.sources.base import Adapter, load_adapter
from nyclive.storage import archive
from nyclive.storage.state import StateStore, ts
from nyclive.timeutil import now_utc

log = logging.getLogger("nyclive.collect")

DEGRADED_AFTER = 3
MAX_BACKOFF_S = 30 * 60
STATE_RETENTION = timedelta(days=7)
POOL_SIZE = 4
STAGGER_S = 3  # spread first runs so startup isn't a burst


def backoff_s(cadence_s: int, failures: int) -> float:
    """Extra wait before the next attempt of a failing source."""
    if failures < DEGRADED_AFTER:
        return 0.0
    return float(min(MAX_BACKOFF_S, cadence_s * 2 ** (failures - 2)))


class Collector:
    def __init__(
        self,
        reg: Registry,
        settings: Settings,
        only: Iterable[str] | None = None,
        *,
        adapters: dict[str, Adapter] | None = None,
        http: Http | None = None,
        store: StateStore | None = None,
        now: Callable[[], datetime] = now_utc,
    ):
        collected = {s.id: s for s in reg.sources.values() if s.adapter}
        wanted = list(only) if only else sorted(collected)
        unknown = [i for i in wanted if i not in reg.sources]
        not_collected = [i for i in wanted if i in reg.sources and i not in collected]
        if unknown or not_collected:
            raise SystemExit(
                f"cannot collect {unknown + not_collected}: "
                + ("unknown ids " if unknown else "")
                + ("no adapter yet" if not_collected else "")
            )
        self.sources: dict[str, Source] = {i: collected[i] for i in wanted}
        self.adapters = adapters or {i: load_adapter(s.adapter) for i, s in self.sources.items()}
        self.settings = settings
        self.now = now
        settings.ensure_dirs()
        self.http = http or Http(settings.user_agent, host_headers=settings.host_headers())
        self.store = store or StateStore(settings.state_db)

    # --------------------------------------------------------------------------------- runs
    def should_run(self, sid: str) -> bool:
        st = self.store.source_state(sid)
        if not st or not st["consecutive_failures"] or not st["last_attempt"]:
            return True
        wait = backoff_s(self.sources[sid].cadence_s, st["consecutive_failures"])
        last = datetime.fromisoformat(st["last_attempt"])
        return (self.now() - last).total_seconds() >= wait

    def run_source(self, sid: str) -> RunResult | None:
        if not self.should_run(sid):
            log.debug("%s: backing off", sid)
            return None
        r = run_once(
            self.sources[sid],
            self.adapters[sid],
            self.http,
            self.store,
            self.settings.archive_dir,
            now=self.now,
        )
        _log_result(r)
        return r

    def run_all_once(self) -> list[RunResult]:
        """Run every source once, ignoring backoff (for `collect --once`)."""
        results = []
        for sid, src in self.sources.items():
            r = run_once(
                src, self.adapters[sid], self.http, self.store, self.settings.archive_dir,
                now=self.now,
            )  # fmt: skip
            _log_result(r)
            results.append(r)
        return results

    # -------------------------------------------------------------------------- maintenance
    def maintenance(self) -> None:
        now = self.now()
        cutoff = archive.closed_before(now)
        with WRITE_LOCK:
            for day in self.store.run_days_before(cutoff.isoformat()):
                runs = self.store.runs_between(day.isoformat(), (day + timedelta(1)).isoformat())
                archive.export_runs(self.settings.archive_dir, day, runs)
            written = archive.compact(self.settings.archive_dir, now)
            self.store.prune(ts(now - STATE_RETENTION))
        if written:
            log.info("maintenance: compacted %d partition(s)", len(written))

    def compact_open(self) -> None:
        """Hourly: compact today's partitions too, so open-day reads stay fast."""
        with WRITE_LOCK:
            written = archive.compact(self.settings.archive_dir, self.now(), include_open=True)
        log.debug("compact_open: %d partition(s)", len(written))

    # ------------------------------------------------------------------------------ forever
    def run_forever(self) -> None:
        from apscheduler.executors.pool import ThreadPoolExecutor
        from apscheduler.schedulers.blocking import BlockingScheduler

        self.maintenance()
        sched = BlockingScheduler(
            executors={"default": ThreadPoolExecutor(POOL_SIZE)},
            job_defaults={"coalesce": True, "max_instances": 1},
            timezone=UTC,
        )
        start = datetime.now(UTC)
        for i, (sid, src) in enumerate(self.sources.items()):
            sched.add_job(
                self.run_source,
                "interval",
                args=[sid],
                id=sid,
                seconds=src.cadence_s,
                next_run_time=start + timedelta(seconds=i * STAGGER_S),
                misfire_grace_time=src.cadence_s,
            )
        sched.add_job(self.maintenance, "cron", hour=1, minute=15, id="_maintenance")
        sched.add_job(self.compact_open, "cron", minute=7, id="_compact_open")
        log.info("collecting %d source(s): %s", len(self.sources), ", ".join(self.sources))
        try:
            sched.start()
        except (KeyboardInterrupt, SystemExit):
            log.info("stopping")
        finally:
            if sched.running:
                sched.shutdown(wait=True)

    def close(self) -> None:
        self.http.close()
        self.store.close()


# ---------------------------------------------------------------------------------- helpers
def _log_result(r: RunResult) -> None:
    if r.ok:
        extra = f", dropped {r.dropped} invalid" if r.dropped else ""
        log.info("%s: ok, %d rows, %d KB%s", r.source, r.rows_written, r.bytes // 1024, extra)
    elif r.consecutive_failures >= DEGRADED_AFTER:
        log.warning(
            "%s: degraded (%d failures in a row): %s", r.source, r.consecutive_failures, r.error
        )
    # single failures are already logged by the pipeline


class SingleInstance:
    """An OS-level exclusive lock on `<data dir>/collect.lock`, released when the process ends."""

    def __init__(self, path: Path):
        self.path = path
        self._fh = None

    def __enter__(self) -> Self:
        self.path.parent.mkdir(parents=True, exist_ok=True)
        fh = open(self.path, "a+")
        try:
            if os.name == "nt":
                import msvcrt

                fh.seek(0)
                msvcrt.locking(fh.fileno(), msvcrt.LK_NBLCK, 1)
            else:
                import fcntl

                fcntl.flock(fh.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
        except OSError:
            fh.close()
            raise SystemExit(f"another collector is already running ({self.path})") from None
        self._fh = fh
        return self

    def __exit__(self, *exc: object) -> None:
        if self._fh:
            if os.name == "nt":
                import msvcrt

                self._fh.seek(0)
                try:
                    msvcrt.locking(self._fh.fileno(), msvcrt.LK_UNLCK, 1)
                except OSError:
                    pass
            self._fh.close()


def keep_awake() -> bool:
    """Ask Windows not to sleep while this process runs. Returns False elsewhere."""
    if os.name != "nt":
        return False
    import ctypes

    es_continuous, es_system_required = 0x80000000, 0x00000001
    return bool(ctypes.windll.kernel32.SetThreadExecutionState(es_continuous | es_system_required))


def setup_logging(logs_dir: Path, verbose: bool = False) -> None:
    for stream in (sys.stdout, sys.stderr):
        if hasattr(stream, "reconfigure"):
            stream.reconfigure(encoding="utf-8", errors="replace")
    logs_dir.mkdir(parents=True, exist_ok=True)
    fmt = logging.Formatter("%(asctime)s %(levelname)s %(name)s: %(message)s")
    fmt.converter = time.gmtime  # log timestamps in UTC
    file_handler = logging.handlers.TimedRotatingFileHandler(
        logs_dir / "collect.log", when="midnight", utc=True, backupCount=14, encoding="utf-8"
    )
    console = logging.StreamHandler(sys.stdout)
    root = logging.getLogger()
    root.handlers.clear()
    for h in (file_handler, console):
        h.setFormatter(fmt)
        root.addHandler(h)
    root.setLevel(logging.DEBUG if verbose else logging.INFO)
    for noisy in ("httpx", "httpcore", "apscheduler"):
        logging.getLogger(noisy).setLevel(logging.WARNING)

"""The shared, polite HTTP client. Adapters touch the network only through `Http.get`.

Rules (ARCHITECTURE §3, CLAUDE.md):
- one request at a time per host, with a minimum gap between requests to that host;
- retries with exponential backoff on network errors, 429 and 5xx, honoring `Retry-After`;
- a User-Agent that identifies the project;
- other 4xx fail fast; the caller never has to check the status code.

Callers read `response.content`. Never branch on `Content-Type`: some feeds send a broken one.
"""

from __future__ import annotations

import logging
import threading
import time
from collections.abc import Callable, Mapping
from datetime import UTC, datetime
from email.utils import parsedate_to_datetime
from typing import Self

import httpx

log = logging.getLogger(__name__)

RETRY_STATUSES = frozenset({429, 500, 502, 503, 504})


class HttpError(Exception):
    """A GET that failed for good (after retries, or a non-retryable status)."""

    def __init__(self, url: str, reason: str, status: int | None = None, attempts: int = 1):
        super().__init__(f"GET {url} failed after {attempts} attempt(s): {reason}")
        self.url = url
        self.reason = reason
        self.status = status
        self.attempts = attempts


class Http:
    def __init__(
        self,
        user_agent: str,
        *,
        timeout_s: float = 25.0,
        min_gap_s: float = 2.0,
        retries: int = 3,
        backoff_s: float = 2.0,
        max_wait_s: float = 120.0,
        host_headers: Mapping[str, Mapping[str, str]] | None = None,
        transport: httpx.BaseTransport | None = None,
        sleep: Callable[[float], None] = time.sleep,
        clock: Callable[[], float] = time.monotonic,
    ):
        """`retries` is the number of extra attempts after the first. `max_wait_s` caps any
        single wait (backoff or Retry-After). `sleep` and `clock` are injectable for tests."""
        self._client = httpx.Client(
            timeout=timeout_s,
            follow_redirects=True,
            headers={"User-Agent": user_agent},
            transport=transport,
        )
        self.min_gap_s = min_gap_s
        self.retries = retries
        self.backoff_s = backoff_s
        self.max_wait_s = max_wait_s
        self._host_headers = {h.lower(): dict(v) for h, v in (host_headers or {}).items()}
        self._sleep = sleep
        self._clock = clock
        self._registry_lock = threading.Lock()
        self._host_locks: dict[str, threading.Lock] = {}
        self._last_done: dict[str, float] = {}

    # -- public -------------------------------------------------------------------------------
    def get(
        self,
        url: str,
        *,
        params: Mapping[str, str] | None = None,
        headers: Mapping[str, str] | None = None,
    ) -> httpx.Response:
        """GET with politeness and retries. Returns a 2xx response or raises HttpError."""
        host = (httpx.URL(url).host or "").lower()
        merged = {**self._host_headers.get(host, {}), **(headers or {})}
        with self._host_lock(host):
            attempts = 0
            while True:
                attempts += 1
                self._wait_for_gap(host)
                try:
                    r = self._client.get(url, params=params, headers=merged)
                except httpx.TransportError as e:
                    reason, status, retry_after = type(e).__name__, None, None
                else:
                    if r.is_success:
                        return r
                    reason = f"HTTP {r.status_code}"
                    status = r.status_code
                    retry_after = _retry_after_s(r.headers.get("retry-after"))
                    if status not in RETRY_STATUSES:
                        raise HttpError(url, reason, status, attempts)
                finally:
                    # The gap counts from when the last request to this host finished.
                    self._last_done[host] = self._clock()

                if attempts > self.retries:
                    raise HttpError(url, reason, status, attempts)
                wait = (
                    retry_after if retry_after is not None else self.backoff_s * 2 ** (attempts - 1)
                )
                wait = min(max(wait, 0.0), self.max_wait_s)
                log.warning(
                    "GET %s: %s, retry %d/%d in %.1fs", url, reason, attempts, self.retries, wait
                )
                self._sleep(wait)

    def close(self) -> None:
        self._client.close()

    def __enter__(self) -> Self:
        return self

    def __exit__(self, *exc: object) -> None:
        self.close()

    # -- internals ----------------------------------------------------------------------------
    def _host_lock(self, host: str) -> threading.Lock:
        with self._registry_lock:
            return self._host_locks.setdefault(host, threading.Lock())

    def _wait_for_gap(self, host: str) -> None:
        last = self._last_done.get(host)
        if last is None:
            return
        remaining = self.min_gap_s - (self._clock() - last)
        if remaining > 0:
            self._sleep(remaining)


def _retry_after_s(value: str | None) -> float | None:
    """Retry-After is either delay-seconds or an HTTP date."""
    if not value:
        return None
    value = value.strip()
    try:
        return float(value)
    except ValueError:
        pass
    try:
        when = parsedate_to_datetime(value)
    except (TypeError, ValueError):
        return None
    if when.tzinfo is None:
        when = when.replace(tzinfo=UTC)
    return max(0.0, (when - datetime.now(UTC)).total_seconds())

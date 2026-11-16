"""Body + ETag cache and conditional responses (§2.1).

A layer body is reused while its sources' `(last_success, rows_last_run)` tuple is unchanged and
the entry is younger than `max(30, min(poll_s, 300))` seconds. LRU of 64 with a build lock per
key so a burst of identical requests builds once. The gzip form is computed once per entry.
"""

from __future__ import annotations

import gzip
import hashlib
import json
import threading
from collections import OrderedDict
from collections.abc import Callable, Hashable
from dataclasses import dataclass, field
from typing import Any

from fastapi import Request
from fastapi.responses import Response

GZIP_MIN = 1024


def dumps(obj: Any) -> bytes:
    return json.dumps(obj, ensure_ascii=False, separators=(",", ":"), allow_nan=False).encode()


def etag_of(body: bytes) -> str:
    return f'W/"{hashlib.sha1(body).hexdigest()[:16]}"'


@dataclass
class Entry:
    body: bytes
    etag: str
    stamp: Hashable  # sources' state when built
    built_at: float  # monotonic-ish seconds from the injected clock
    _gz: bytes | None = field(default=None, repr=False)
    _lock: threading.Lock = field(default_factory=threading.Lock, repr=False)

    def gz(self) -> bytes:
        with self._lock:
            if self._gz is None:
                self._gz = gzip.compress(self.body, compresslevel=5, mtime=0)
            return self._gz


def entry_for(
    body_obj: Any,
    stamp: Hashable = None,
    built_at: float = 0.0,
    etag_basis: Callable[[Any], Any] | None = None,
) -> Entry:
    """`etag_basis` picks the part of the body the ETag covers (default: all of it), so a
    clock-only field such as `now` doesn't change the ETag and defeat 304s."""
    body = dumps(body_obj)
    etag = etag_of(dumps(etag_basis(body_obj)) if etag_basis else body)
    return Entry(body=body, etag=etag, stamp=stamp, built_at=built_at)


class BodyCache:
    def __init__(self, size: int = 64) -> None:
        self.size = size
        self._items: OrderedDict[Hashable, Entry] = OrderedDict()
        self._lock = threading.Lock()
        self._key_locks: dict[Hashable, threading.Lock] = {}

    def get_or_build(
        self,
        key: Hashable,
        stamp: Hashable,
        now_s: float,
        max_age: float,
        build: Callable[[], Any],
        etag_basis: Callable[[Any], Any] | None = None,
    ) -> Entry:
        def fresh() -> Entry | None:
            with self._lock:
                e = self._items.get(key)
                if e is not None and e.stamp == stamp and 0 <= now_s - e.built_at < max_age:
                    self._items.move_to_end(key)
                    return e
            return None

        hit = fresh()
        if hit:
            return hit
        with self._lock:
            key_lock = self._key_locks.setdefault(key, threading.Lock())
        with key_lock:
            hit = fresh()
            if hit:
                return hit
            entry = entry_for(build(), stamp, now_s, etag_basis)
            with self._lock:
                self._items[key] = entry
                self._items.move_to_end(key)
                while len(self._items) > self.size:
                    old, _ = self._items.popitem(last=False)
                    self._key_locks.pop(old, None)
            return entry

    def clear(self) -> None:
        with self._lock:
            self._items.clear()


def _weak(tag: str) -> str:
    tag = tag.strip()
    return tag.removeprefix("W/")


def etag_matches(header: str | None, etag: str) -> bool:
    if not header:
        return False
    if header.strip() == "*":
        return True
    mine = _weak(etag)
    return any(_weak(t) == mine for t in header.split(","))


def conditional(request: Request, entry: Entry) -> Response:
    """200 with the body (pre-gzipped when accepted) or 304 with no body."""
    headers = {"ETag": entry.etag, "Cache-Control": "no-cache", "Vary": "Accept-Encoding"}
    if etag_matches(request.headers.get("if-none-match"), entry.etag):
        return Response(status_code=304, headers=headers)
    accepts = "gzip" in (request.headers.get("accept-encoding") or "").lower()
    if accepts and len(entry.body) >= GZIP_MIN:
        headers["Content-Encoding"] = "gzip"
        return Response(entry.gz(), media_type="application/json", headers=headers)
    return Response(entry.body, media_type="application/json", headers=headers)


def json_response(obj: Any) -> Response:
    """A plain (uncached) JSON response using the same encoder."""
    return Response(dumps(obj), media_type="application/json")

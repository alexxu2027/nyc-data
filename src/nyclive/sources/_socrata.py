"""Shared Socrata (SODA 2.x) helper for adapters on data.cityofnewyork.us and data.ny.gov.

Rules (ARCHITECTURE §3, DATA_SOURCES "City services"):
- always send `$select`, `$order` (with `:id` as a tiebreak so paging is stable) and
  `$limit` ≤ 5000;
- page with `$offset`, at most `max_pages` per run; the next run continues from the cursor;
- timestamps without an offset are New York local ("floating"). Cursors are stored as UTC ISO
  strings and converted with `floating()` for `$where`.

Conductor-owned: adapters import it, builders don't edit it.
"""

from __future__ import annotations

import json
import logging
from collections.abc import Iterable
from datetime import datetime

from nyclive.sources.base import FetchContext, RawPart, RawPayload
from nyclive.timeutil import NY, ensure_utc

MAX_LIMIT = 5000
log = logging.getLogger(__name__)


def floating(dt: datetime) -> str:
    """A UTC datetime as a Socrata floating timestamp literal in New York local time."""
    local = ensure_utc(dt).astimezone(NY).replace(tzinfo=None)
    return local.isoformat(timespec="milliseconds")


def fetch_pages(
    ctx: FetchContext,
    url: str,
    *,
    select: Iterable[str],
    order: str,
    where: str | None = None,
    prefix: str = "page",
    page_size: int = MAX_LIMIT,
    max_pages: int = 5,
) -> list[RawPart]:
    """GET pages until one comes back short or `max_pages` is hit. Parts are `<prefix>-000`, …

    `order` is a column (plus optional DESC); `:id` is appended as a stable tiebreak.
    """
    if not 1 <= page_size <= MAX_LIMIT:
        raise ValueError(f"page_size must be 1..{MAX_LIMIT}")
    params = {
        "$select": ",".join(select),
        "$order": f"{order},:id",
        "$limit": str(page_size),
    }
    if where:
        params["$where"] = where
    parts: list[RawPart] = []
    for i in range(max_pages):
        r = ctx.http.get(url, params={**params, "$offset": str(i * page_size)})
        parts.append(RawPart(f"{prefix}-{i:03d}", str(r.url), r.content, ctx.now))
        if len(json.loads(r.content)) < page_size:
            break
    else:
        log.warning(
            "%s: %s hit its page cap (%d x %d rows); the rest waits for the next run",
            ctx.source.id,
            prefix,
            max_pages,
            page_size,
        )
    return parts


def payload(ctx: FetchContext, parts: list[RawPart]) -> RawPayload:
    return RawPayload(ctx.source.id, tuple(parts), cursor=ctx.cursor)


def rows(raw: RawPayload, prefix: str = "page") -> list[dict]:
    """All rows from the `<prefix>-NNN` parts, in page order."""
    out: list[dict] = []
    for p in sorted(
        (p for p in raw.parts if p.name.startswith(f"{prefix}-")), key=lambda p: p.name
    ):
        out.extend(json.loads(p.content))
    return out

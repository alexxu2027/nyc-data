"""`nyclive capture`: record a raw payload as a test fixture case.

    uv run nyclive capture noaa_tide_battery                  # via the adapter's fetch()
    uv run nyclive capture citibike_station_status --trim 40  # keep 40 items of the big list
    uv run nyclive capture x --part body=https://...          # before an adapter exists

Fixtures live in tests/fixtures/<registry id>/<case>/ (docs/DATA_MODEL.md "Fixtures and tests").
Cases should stay under 256 KB; `--trim` shortens the largest JSON array and notes it in meta.json.
"""

from __future__ import annotations

import json
import shutil
from dataclasses import replace
from pathlib import Path
from typing import Any

from nyclive.http import Http
from nyclive.registry import REPO_ROOT, Registry
from nyclive.settings import Settings
from nyclive.sources.base import FetchContext, RawPart, RawPayload, load_adapter
from nyclive.timeutil import now_utc

FIXTURES_DIR = REPO_ROOT / "tests" / "fixtures"
MAX_CASE_BYTES = 256 * 1024


def capture(
    reg: Registry,
    settings: Settings,
    source_id: str,
    *,
    case: str = "real",
    parts: list[tuple[str, str]] | None = None,
    cursor: str | None = None,
    trim: int | None = None,
    note: str = "",
    force: bool = False,
    fixtures_dir: Path = FIXTURES_DIR,
    http: Http | None = None,
) -> Path:
    """Fetch and save one fixture case. Returns the case directory."""
    if source_id not in reg.sources:
        raise SystemExit(f"unknown source {source_id!r} (see `nyclive sources`)")
    src = reg.sources[source_id]
    case_dir = fixtures_dir / source_id / case
    if case_dir.exists() and not force:
        raise SystemExit(f"{case_dir} exists; pass --force to replace it")

    own_http = http is None
    http = http or Http(settings.user_agent, **settings.http_kwargs())
    try:
        if parts:
            raw = _fetch_parts(http, source_id, parts, cursor)
        elif src.adapter:
            adapter = load_adapter(src.adapter)
            ctx = FetchContext(source=src, http=http, cursor=cursor, now=now_utc())
            raw = adapter.fetch(ctx)
        elif src.probe:
            raw = _fetch_parts(http, source_id, [("body", src.probe_url())], cursor)
        else:
            raise SystemExit(f"{source_id} has no adapter and no probe URL; pass --part name=url")
    finally:
        if own_http:
            http.close()

    raw = _redacted(raw, http)
    notes = [note] if note else []
    if trim is not None:
        raw, trimmed = _trim_payload(raw, trim)
        notes += trimmed
    if case_dir.exists():
        shutil.rmtree(case_dir)
    raw.save(case_dir, note="; ".join(notes))

    size = sum(f.stat().st_size for f in case_dir.iterdir())
    print(f"saved {case_dir} ({size / 1024:.0f} KB, {len(raw.parts)} part(s))")
    if size > MAX_CASE_BYTES:
        print(f"warning: over {MAX_CASE_BYTES // 1024} KB; re-run with --trim N")
    return case_dir


def _redacted(raw: RawPayload, http: Http) -> RawPayload:
    parts = tuple(replace(p, url=http.redact(p.url)) for p in raw.parts)
    return replace(raw, parts=parts)


def _fetch_parts(
    http: Http, source_id: str, parts: list[tuple[str, str]], cursor: str | None
) -> RawPayload:
    got = []
    for name, url in parts:
        r = http.get(url)
        url = http.redact(str(r.url))  # a fixture must never hold a key (ADR-018)
        got.append(RawPart(name=name, url=url, content=r.content, fetched_at=now_utc()))
    return RawPayload(source_id=source_id, parts=tuple(got), cursor=cursor)


def parse_part_args(values: list[str] | None) -> list[tuple[str, str]]:
    out = []
    for v in values or []:
        name, sep, url = v.partition("=")
        if not sep or not name or not url.startswith(("http://", "https://")):
            raise SystemExit(f"--part must look like name=https://..., got {v!r}")
        out.append((name, url))
    return out


# ----------------------------------------------------------------------------------- trimming
def _trim_payload(raw: RawPayload, keep: int) -> tuple[RawPayload, list[str]]:
    notes, parts = [], []
    for p in raw.parts:
        try:
            doc = json.loads(p.content)
        except ValueError:
            parts.append(p)
            continue
        path, n = _largest_list(doc)
        if path is None or n <= keep:
            parts.append(p)
            continue
        _set_list(doc, path, _get(doc, path)[:keep])
        notes.append(f"{p.name}: trimmed {'/'.join(map(str, path)) or '<root>'} from {n} to {keep}")
        content = json.dumps(doc, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
        parts.append(replace(p, content=content))
    return replace(raw, parts=tuple(parts)), notes


def _largest_list(doc: Any, path: tuple = ()) -> tuple[tuple | None, int]:
    best: tuple[tuple | None, int] = (None, 0)
    if isinstance(doc, list):
        best = (path, len(doc))
        children = enumerate(doc[:50])  # don't walk every element of a huge list
    elif isinstance(doc, dict):
        children = doc.items()
    else:
        return best
    for k, v in children:
        cand = _largest_list(v, (*path, k))
        if cand[1] > best[1]:
            best = cand
    return best


def _get(doc: Any, path: tuple) -> Any:
    for k in path:
        doc = doc[k]
    return doc


def _set_list(doc: Any, path: tuple, value: list) -> None:
    if not path:
        doc[:] = value
        return
    _get(doc, path[:-1])[path[-1]] = value

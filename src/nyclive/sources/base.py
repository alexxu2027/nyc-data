"""Adapter contract v1 (docs/DATA_MODEL.md). Frozen at Gate A; change it only with an ADR.

Each adapter is a module in `nyclive.sources` that exposes:

    SOURCE_IDS: tuple[str, ...]                 # registry ids it serves
    def fetch(ctx: FetchContext) -> RawPayload  # network only, through ctx.http
    def parse(raw: RawPayload) -> Batch         # pure and deterministic

`RawPayload` is the exact bytes we received, so a fixture on disk and a live fetch look the same
to `parse`.
"""

from __future__ import annotations

import importlib
import json
import re
from collections.abc import Callable
from dataclasses import dataclass, field
from datetime import datetime
from pathlib import Path
from types import ModuleType
from typing import TYPE_CHECKING, Any

from nyclive.model import Entity, Event, Observation, record_problems
from nyclive.timeutil import ensure_utc, parse_iso_utc

if TYPE_CHECKING:
    from nyclive.http import Http
    from nyclive.registry import Source

META_FILE = "meta.json"
COMPLETE_TABLES = frozenset({"entities", "events"})
_PART_NAME = re.compile(r"^[a-z0-9][a-z0-9_.-]*$")


# ------------------------------------------------------------------------------- raw payloads
@dataclass(frozen=True)
class RawPart:
    name: str  # "body", "station_status", "page-000"
    url: str
    content: bytes  # exact response body
    fetched_at: datetime  # tz-aware UTC

    def __post_init__(self) -> None:
        if not _PART_NAME.match(self.name):
            raise ValueError(f"part name {self.name!r} must be lowercase [a-z0-9_.-]")
        ensure_utc(self.fetched_at)


@dataclass(frozen=True)
class RawPayload:
    source_id: str
    parts: tuple[RawPart, ...]
    cursor: str | None = None  # cursor this fetch started from

    def __post_init__(self) -> None:
        if not self.parts:
            raise ValueError("a RawPayload needs at least one part")
        names = [p.name for p in self.parts]
        if len(set(names)) != len(names):
            raise ValueError(f"duplicate part names: {names}")

    def part(self, name: str = "body") -> RawPart:
        for p in self.parts:
            if p.name == name:
                return p
        raise KeyError(f"{self.source_id}: no part {name!r} (have {[p.name for p in self.parts]})")

    def json(self, name: str = "body") -> Any:
        """Decode a part as JSON. Never looks at Content-Type (some feeds send a broken one)."""
        return json.loads(self.part(name).content)

    @property
    def fetched_at(self) -> datetime:
        """When the newest part arrived."""
        return max(p.fetched_at for p in self.parts)

    def save(self, case_dir: Path, note: str = "") -> None:
        """Write this payload as a fixture case: meta.json plus one file per part, exact bytes."""
        case_dir.mkdir(parents=True, exist_ok=True)
        parts_meta = []
        for p in self.parts:
            file = f"{p.name}.{_extension(p.content)}"
            (case_dir / file).write_bytes(p.content)
            parts_meta.append(
                {"name": p.name, "url": p.url, "file": file, "fetched_at": p.fetched_at.isoformat()}
            )
        meta = {
            "source_id": self.source_id,
            "captured_at": self.fetched_at.isoformat(),
            "cursor": self.cursor,
            "parts": parts_meta,
            "note": note,
        }
        # newline="\n": byte-identical meta.json on every OS (fixtures are committed as binary)
        (case_dir / META_FILE).write_text(
            json.dumps(meta, indent=2) + "\n", encoding="utf-8", newline="\n"
        )

    @classmethod
    def load(cls, case_dir: Path) -> RawPayload:
        meta = json.loads((case_dir / META_FILE).read_text(encoding="utf-8"))
        captured = meta.get("captured_at")
        parts = tuple(
            RawPart(
                name=pm["name"],
                url=pm["url"],
                content=(case_dir / pm["file"]).read_bytes(),
                fetched_at=parse_iso_utc(pm.get("fetched_at") or captured),
            )
            for pm in meta["parts"]
        )
        return cls(source_id=meta["source_id"], parts=parts, cursor=meta.get("cursor"))


def _extension(content: bytes) -> str:
    try:
        json.loads(content)
    except (ValueError, UnicodeDecodeError):
        return "bin"
    return "json"


# ------------------------------------------------------------------------- fetch and parse I/O
@dataclass(frozen=True)
class FetchContext:
    source: Source  # registry entry
    http: Http  # the only way an adapter touches the network
    cursor: str | None  # last committed cursor, None on first run
    now: datetime  # injected UTC; adapters never call datetime.now()


@dataclass
class Batch:
    entities: list[Entity] = field(default_factory=list)
    observations: list[Observation] = field(default_factory=list)
    events: list[Event] = field(default_factory=list)
    cursor: str | None = None  # committed only after the batch is stored
    complete: frozenset[str] = frozenset()  # subset of COMPLETE_TABLES: payload is the full set

    def __len__(self) -> int:
        return len(self.entities) + len(self.observations) + len(self.events)


def batch_problems(batch: Batch, source_id: str) -> list[str]:
    """Contract checks for a parsed batch. Used by the pipeline and by tests/helpers.py."""
    problems: list[str] = []
    if not isinstance(batch, Batch):
        return [f"parse() must return a Batch, got {type(batch).__name__}"]
    if not batch.complete <= COMPLETE_TABLES:
        problems.append(f"complete must be a subset of {sorted(COMPLETE_TABLES)}")
    if batch.cursor is not None and not isinstance(batch.cursor, str):
        problems.append("cursor must be a str or None")
    for table, cls in (
        ("entities", Entity),
        ("observations", Observation),
        ("events", Event),
    ):
        seen: set[tuple] = set()
        for i, r in enumerate(getattr(batch, table)):
            where = f"{table}[{i}]"
            if not isinstance(r, cls):
                problems.append(f"{where}: expected {cls.__name__}, got {type(r).__name__}")
                continue
            if r.source != source_id:
                problems.append(f"{where}: source {r.source!r} != {source_id!r}")
            problems += [f"{where}: {m}" for m in record_problems(r)]
            if r.key in seen:
                problems.append(f"{where}: duplicate key {r.key}")
            seen.add(r.key)
    return problems


# --------------------------------------------------------------------------- adapter discovery
@dataclass(frozen=True)
class Adapter:
    module: str
    source_ids: tuple[str, ...]
    fetch: Callable[[FetchContext], RawPayload]
    parse: Callable[[RawPayload], Batch]


def load_adapter(module: str) -> Adapter:
    """Import `nyclive.sources.<module>` and check it exposes the v1 contract."""
    if not re.fullmatch(r"[a-z][a-z0-9_]*", module) or module.startswith("_") or module == "base":
        raise ValueError(f"{module!r} is not an adapter module name")
    mod: ModuleType = importlib.import_module(f"nyclive.sources.{module}")
    ids = getattr(mod, "SOURCE_IDS", None)
    if not isinstance(ids, tuple) or not ids or not all(isinstance(i, str) for i in ids):
        raise TypeError(f"{mod.__name__}.SOURCE_IDS must be a non-empty tuple of str")
    for fn in ("fetch", "parse"):
        if not callable(getattr(mod, fn, None)):
            raise TypeError(f"{mod.__name__} must define {fn}()")
    return Adapter(module=module, source_ids=ids, fetch=mod.fetch, parse=mod.parse)

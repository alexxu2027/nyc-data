"""Load and validate config/sources.yaml, the single list of external feeds."""

from __future__ import annotations

import os
import re
from dataclasses import dataclass, field
from pathlib import Path

import yaml

REPO_ROOT = Path(__file__).resolve().parents[2]
DEFAULT_REGISTRY = REPO_ROOT / "config" / "sources.yaml"

SHAPES = {"entities", "observations", "events"}
STATUSES = {"verified", "partial", "unverified"}
_ENV_REF = re.compile(r"\$\{([A-Z0-9_]+)\}")


@dataclass(frozen=True)
class Source:
    id: str
    name: str
    phase: int
    shape: str
    cadence_s: int | None
    auth: str
    probe: str | None = None
    expect: str | None = None
    status: str = "unverified"
    verified_on: str | None = None
    notes: str = ""

    @property
    def key_env(self) -> str | None:
        """Env var holding this source's API key, if it needs one."""
        return self.auth.split(":", 1)[1] if self.auth.startswith("key:") else None

    def missing_env(self) -> list[str]:
        """Env vars this source needs (auth key or ${VAR} in the probe URL) that aren't set."""
        needed = set(_ENV_REF.findall(self.probe or ""))
        if self.key_env:
            needed.add(self.key_env)
        return sorted(v for v in needed if not os.environ.get(v))

    def probe_url(self) -> str | None:
        if not self.probe:
            return None
        return _ENV_REF.sub(lambda m: os.environ.get(m.group(1), ""), self.probe)


@dataclass(frozen=True)
class Registry:
    sources: dict[str, Source]
    user_agent: str = field(default="nyc-live/0.1")

    def by_phase(self, max_phase: int) -> list[Source]:
        return [s for s in self.sources.values() if s.phase <= max_phase]


def load_registry(path: Path = DEFAULT_REGISTRY) -> Registry:
    raw = yaml.safe_load(path.read_text(encoding="utf-8"))
    sources: dict[str, Source] = {}
    for sid, spec in (raw.get("sources") or {}).items():
        src = Source(id=sid, **{k: v for k, v in spec.items()})
        _validate(src)
        sources[sid] = src
    ua = os.environ.get(raw.get("user_agent_env", ""), "") or raw.get(
        "default_user_agent", "nyc-live/0.1"
    )
    return Registry(sources=sources, user_agent=ua)


def _validate(s: Source) -> None:
    problems = []
    if s.shape not in SHAPES:
        problems.append(f"shape must be one of {sorted(SHAPES)}")
    if s.status not in STATUSES:
        problems.append(f"status must be one of {sorted(STATUSES)}")
    if not (s.auth == "none" or s.auth.startswith("key:")):
        problems.append("auth must be 'none' or 'key:<ENV_VAR>'")
    if s.cadence_s is not None and s.cadence_s < 30:
        problems.append("cadence_s under 30 s is too aggressive for public feeds")
    if problems:
        raise ValueError(f"source '{s.id}': " + "; ".join(problems))

"""Shared test helpers for adapters (docs/DATA_MODEL.md "Fixtures and tests")."""

from __future__ import annotations

from pathlib import Path

from nyclive.registry import load_registry
from nyclive.sources.base import Batch, RawPayload, batch_problems, load_adapter

FIXTURES = Path(__file__).parent / "fixtures"


def fixture_dir(source_id: str, case: str = "real") -> Path:
    return FIXTURES / source_id / case


def load_fixture(source_id: str, case: str = "real") -> RawPayload:
    d = fixture_dir(source_id, case)
    if not (d / "meta.json").is_file():
        raise FileNotFoundError(f"no fixture {d}; run `uv run nyclive capture {source_id}`")
    return RawPayload.load(d)


def assert_valid_batch(batch: Batch, source_id: str) -> None:
    problems = batch_problems(batch, source_id)
    assert not problems, f"{source_id}: {len(problems)} problem(s):\n" + "\n".join(problems[:25])


def parse_fixture(source_id: str, case: str = "real") -> Batch:
    """Load a fixture, parse it with the registry's adapter twice, check it, return the batch."""
    src = load_registry().sources[source_id]
    assert src.adapter, f"{source_id} has no adapter in config/sources.yaml"
    adapter = load_adapter(src.adapter)
    assert source_id in adapter.source_ids, f"{src.adapter}.SOURCE_IDS lacks {source_id}"
    raw = load_fixture(source_id, case)
    first, second = adapter.parse(raw), adapter.parse(raw)
    assert first == second, f"{source_id}/{case}: parse() is not deterministic"
    assert_valid_batch(first, source_id)
    return first

"""Phase 1 acceptance: every collected source has fixtures and parses cleanly (ROADMAP 1)."""

import pytest
from helpers import fixture_dir, parse_fixture

from nyclive.registry import load_registry
from nyclive.sources.base import load_adapter

COLLECTED = sorted(s.id for s in load_registry().sources.values() if s.adapter)


@pytest.mark.parametrize("source_id", COLLECTED)
def test_adapter_module_serves_source(source_id):
    src = load_registry().sources[source_id]
    assert source_id in load_adapter(src.adapter).source_ids


@pytest.mark.parametrize("source_id", COLLECTED)
def test_has_real_and_edge_fixtures(source_id):
    root = fixture_dir(source_id).parent
    assert (root / "real" / "meta.json").is_file(), f"capture tests/fixtures/{source_id}/real"
    edges = [d for d in root.glob("edge_*") if (d / "meta.json").is_file()]
    assert edges, f"{source_id} needs at least one tests/fixtures/{source_id}/edge_* case"


@pytest.mark.parametrize("source_id", COLLECTED)
def test_every_case_parses(source_id):
    root = fixture_dir(source_id).parent
    for case in sorted(d.name for d in root.iterdir() if (d / "meta.json").is_file()):
        parse_fixture(source_id, case)

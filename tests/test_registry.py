import pytest

from nyclive.registry import load_registry


def test_registry_loads_and_validates():
    reg = load_registry()
    assert len(reg.sources) >= 15
    for s in reg.sources.values():
        assert s.name
        assert s.phase >= 1


def test_phases_1_to_4_are_keyless():
    """Phases 1-4 must run with zero API keys (docs/DECISIONS.md, ADR-007)."""
    reg = load_registry()
    keyed = [s.id for s in reg.by_phase(4) if s.key_env]
    assert keyed == []


def test_missing_env_detected(monkeypatch):
    monkeypatch.delenv("OPENAQ_API_KEY", raising=False)
    reg = load_registry()
    assert reg.sources["openaq_nyc"].missing_env() == ["OPENAQ_API_KEY"]


@pytest.mark.live
def test_phase1_sources_reachable():
    from nyclive.probe import run_probe

    assert run_probe(load_registry(), max_phase=1) == 0


def test_unknown_registry_field_gives_clear_error(tmp_path):
    f = tmp_path / "sources.yaml"
    f.write_text(
        "sources:\n  x:\n    name: X\n    phase: 1\n    shape: events\n    cadence_s: 60\n"
        "    auth: none\n    colour: red\n",
        encoding="utf-8",
    )
    with pytest.raises(ValueError, match="add them to Source first"):
        load_registry(f)


def test_adapter_needs_cadence(tmp_path):
    f = tmp_path / "sources.yaml"
    f.write_text(
        "sources:\n  x:\n    name: X\n    phase: 1\n    shape: events\n    cadence_s: null\n"
        "    auth: none\n    adapter: x_feed\n",
        encoding="utf-8",
    )
    with pytest.raises(ValueError, match="cadence_s"):
        load_registry(f)

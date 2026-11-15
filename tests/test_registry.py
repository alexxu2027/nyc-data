import pytest

from nyclive.registry import load_registry


def test_registry_loads_and_validates():
    reg = load_registry()
    assert len(reg.sources) >= 15
    for s in reg.sources.values():
        assert s.name
        assert s.phase >= 1


def test_every_phase1_source_is_keyless():
    """The MVP must run with zero API keys (docs/DECISIONS.md, ADR-007)."""
    reg = load_registry()
    keyed = [s.id for s in reg.by_phase(1) if s.key_env]
    assert keyed == []


def test_missing_env_detected(monkeypatch):
    monkeypatch.delenv("OPENAQ_API_KEY", raising=False)
    reg = load_registry()
    assert reg.sources["openaq_nyc"].missing_env() == ["OPENAQ_API_KEY"]


@pytest.mark.live
def test_phase1_sources_reachable():
    from nyclive.probe import run_probe

    assert run_probe(load_registry(), max_phase=1) == 0

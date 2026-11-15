import sys
import types
from datetime import UTC, datetime, timedelta

import pytest

from nyclive.model import Entity, Observation
from nyclive.sources.base import Batch, RawPart, RawPayload, batch_problems, load_adapter

T = datetime(2026, 11, 14, 18, 0, tzinfo=UTC)


def payload():
    return RawPayload(
        "citibike_station_status",
        (
            RawPart("manifest", "https://x/gbfs.json", b'{"data": 1}', T),
            RawPart(
                "station_status",
                "https://x/ss.json",
                b'{"stations": []}\n',
                T + timedelta(seconds=3),
            ),
            RawPart("blob", "https://x/b", b"\x00\xffnot json", T),
        ),
        cursor="c1",
    )


def test_part_access_json_and_fetched_at():
    raw = payload()
    assert raw.json("manifest") == {"data": 1}
    assert raw.fetched_at == T + timedelta(seconds=3)
    with pytest.raises(KeyError, match="have"):
        raw.part("body")


def test_save_load_roundtrip_is_byte_exact(tmp_path):
    raw = payload()
    raw.save(tmp_path / "real", note="captured for tests")
    assert (tmp_path / "real" / "station_status.json").read_bytes() == b'{"stations": []}\n'
    assert (tmp_path / "real" / "blob.bin").exists()
    assert RawPayload.load(tmp_path / "real") == raw


def test_payload_and_part_validation():
    with pytest.raises(ValueError):
        RawPayload("x", ())
    with pytest.raises(ValueError, match="duplicate"):
        RawPayload("x", (RawPart("a", "u", b"", T), RawPart("a", "u", b"", T)))
    with pytest.raises(ValueError):
        RawPart("Body", "u", b"", T)
    with pytest.raises(ValueError):
        RawPart("body", "u", b"", T.replace(tzinfo=None))


def test_batch_problems():
    sid = "noaa_tide_battery"
    ok = Batch(
        entities=[Entity(sid, "tide_gauge", "8518750", "The Battery", 40.7, -74.01)],
        observations=[Observation(sid, "tide_gauge", "8518750", "water_level_ft", T, 2.6, T)],
        cursor="2026-11-14T18:00:00+00:00",
        complete=frozenset({"entities"}),
    )
    assert batch_problems(ok, sid) == []
    assert len(ok) == 2

    bad = Batch(
        observations=[
            Observation("other", "tide_gauge", "1", "water_level_ft", T, 1.0, T),
            Observation(sid, "tide_gauge", "1", "water_level_ft", T, 1.0, T),
            Observation(sid, "tide_gauge", "1", "water_level_ft", T, 2.0, T),
        ],
        complete=frozenset({"observations"}),
    )
    problems = batch_problems(bad, sid)
    assert any("source 'other'" in p for p in problems)
    assert any("duplicate key" in p for p in problems)
    assert any("complete" in p for p in problems)
    assert batch_problems([], sid) == ["parse() must return a Batch, got list"]


def test_load_adapter(monkeypatch):
    mod = types.ModuleType("nyclive.sources.fake_feed")
    mod.SOURCE_IDS = ("fake_feed",)
    mod.fetch = lambda ctx: None
    mod.parse = lambda raw: Batch()
    monkeypatch.setitem(sys.modules, "nyclive.sources.fake_feed", mod)
    a = load_adapter("fake_feed")
    assert a.source_ids == ("fake_feed",)

    broken = types.ModuleType("nyclive.sources.broken_feed")
    broken.SOURCE_IDS = ["not", "a", "tuple"]
    monkeypatch.setitem(sys.modules, "nyclive.sources.broken_feed", broken)
    with pytest.raises(TypeError):
        load_adapter("broken_feed")
    for name in ("base", "_socrata", "Bad-Name"):
        with pytest.raises(ValueError):
            load_adapter(name)

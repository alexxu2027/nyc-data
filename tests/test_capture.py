import json

import httpx
import pytest

from nyclive.capture import _trim_payload, capture, parse_part_args
from nyclive.http import Http
from nyclive.registry import Registry, Source, load_registry
from nyclive.settings import load_settings
from nyclive.sources.base import RawPayload


def fake_http(body: bytes):
    return Http(
        "t", transport=httpx.MockTransport(lambda r: httpx.Response(200, content=body)), min_gap_s=0
    )


# A registry with one probe-only source, so these tests don't depend on which sources have
# adapters yet.
PROBE_ONLY = Registry(
    {"probe_only": Source("probe_only", "P", 1, "events", 60, "none", probe="https://p/x")}
)


def test_capture_probe_url_with_trim(tmp_path):
    body = json.dumps({"data": {"stations": [{"i": i} for i in range(500)]}}).encode()
    reg, st = PROBE_ONLY, load_settings(env={}, dotenv=None)
    d = capture(reg, st, "probe_only", trim=3, fixtures_dir=tmp_path, http=fake_http(body))
    raw = RawPayload.load(d)
    assert len(raw.json()["data"]["stations"]) == 3
    meta = json.loads((d / "meta.json").read_text())
    assert "from 500 to 3" in meta["note"]

    with pytest.raises(SystemExit, match="--force"):
        capture(reg, st, "probe_only", fixtures_dir=tmp_path, http=fake_http(body))
    capture(reg, st, "probe_only", fixtures_dir=tmp_path, http=fake_http(b"[]"), force=True)
    assert RawPayload.load(d).json() == []


def test_capture_explicit_parts(tmp_path):
    reg, st = load_registry(), load_settings(env={}, dotenv=None)
    d = capture(
        reg,
        st,
        "noaa_tide_battery",
        case="edge_x",
        parts=[("levels", "https://a/1"), ("predictions", "https://a/2")],
        fixtures_dir=tmp_path,
        http=fake_http(b"{}"),
    )
    assert [p.name for p in RawPayload.load(d).parts] == ["levels", "predictions"]


def test_trim_root_list_and_non_json():
    from datetime import UTC, datetime

    from nyclive.sources.base import RawPart

    t = datetime(2026, 1, 1, tzinfo=UTC)
    raw = RawPayload("x", (RawPart("body", "u", b"[1,2,3,4]", t), RawPart("img", "u", b"\xff", t)))
    out, notes = _trim_payload(raw, 2)
    assert out.json() == [1, 2] and out.part("img").content == b"\xff"
    assert notes == ["body: trimmed <root> from 4 to 2"]


def test_parse_part_args():
    assert parse_part_args(["a=https://x/y?b=1"]) == [("a", "https://x/y?b=1")]
    with pytest.raises(SystemExit):
        parse_part_args(["nourl"])


def test_unknown_source(tmp_path):
    with pytest.raises(SystemExit, match="unknown source"):
        capture(load_registry(), load_settings(env={}, dotenv=None), "nope", fixtures_dir=tmp_path)

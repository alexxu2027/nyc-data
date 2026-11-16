from datetime import UTC, datetime, timedelta

import httpx
import pytest
from helpers import load_fixture, parse_fixture

from nyclive.http import Http
from nyclive.registry import load_registry
from nyclive.sources import floodnet_live
from nyclive.sources.base import FetchContext, load_adapter

SID = "floodnet_live"
UTOPIA = "Q-utopia-pkwy-67th-ave-1lmjc0"
DITMARS = "BX-ditmars-st-hunter-ave-1kwrk0"
QUINCY = "SI-quincy-ave-iona-st-1deh00"
BLAKE = "BK-blake-ave-strauss-st-1dnks0"
WINTHROP = "BK-winthrop-st-e-94th-st-1dnt40"
END = datetime.fromtimestamp(1_794_812_256, UTC)  # newest bucket of the real capture
STEP = timedelta(seconds=864)


def _events(batch, sensor):
    return sorted(
        (e for e in batch.events if e.event_id.startswith(sensor + ":")), key=lambda e: e.starts_at
    )


def _obs(batch, sensor):
    return sorted(
        (o for o in batch.observations if o.entity_id == sensor), key=lambda o: o.observed_at
    )


def test_registry_entry_has_the_adapter():
    src = load_registry().sources[SID]
    assert src.adapter == "floodnet_live" and src.cadence_s == 1800


# ------------------------------------------------------------------------------- real
def test_real_is_depth_observations_and_episodes_only():
    b = parse_fixture(SID)
    assert not b.entities and b.complete == frozenset() and b.cursor is None
    assert len(b.observations) == 1196 and len(b.events) == 12
    assert {(o.source, o.kind, o.metric) for o in b.observations} == {
        (SID, "flood_sensor", "depth_in")
    }
    assert all(o.fetched_at == load_fixture(SID).fetched_at for o in b.observations)
    assert all(round(o.value, 1) == o.value and o.value >= 0 for o in b.observations)


def test_join_by_coordinates():
    raw = load_fixture(SID)
    stations = floodnet_live._active_stations(raw)
    sensors = floodnet_live._od_sensors(raw)
    match = floodnet_live.join_stations(stations, sensors)
    assert len(match) / len(stations) >= 0.95  # the full capture joined 433 of 435 (99.5%)
    assert len(set(match.values())) == len(match)  # one-to-one
    assert match[420] == UTOPIA and match[398] == DITMARS and match[336] == QUINCY
    assert set(match.values()) <= set(sensors)


def test_join_prefers_equal_name_then_nearest():
    def st(i, name, lon):
        return {"id": i, "name": name, "location": {"precise": [lon, 40.7]}}

    sensors = {"A": {"name": "Foo St (retired)", "lat": 40.7, "lon": -74.0}}
    one_m, ten_m = -74.0 + 1.17e-5, -74.0 + 1.17e-4
    # the near station has another name: the equal name wins even though it is 10 m away
    m = floodnet_live.join_stations([st(1, "Bar Ave", one_m), st(2, "foo  st", ten_m)], sensors)
    assert m == {2: "A"}
    # no equal name: the nearest wins; the loser is unmatched (one-to-one)
    m = floodnet_live.join_stations([st(1, "Bar", ten_m), st(2, "Baz", one_m)], sensors)
    assert m == {2: "A"}
    # more than 30 m away never joins
    far = -74.0 + 5e-4
    with pytest.raises(ValueError, match="match"):
        floodnet_live.join_stations([st(1, "Foo St", far)], sensors)


def test_depth_obs_sensor44_only():
    b = parse_fixture(SID, "edge_odd_values")
    obs = _obs(b, UTOPIA)
    # 5 real buckets + the two bad-value rows dropped, the -0.4 row clamped, the repeated
    # final bucket deduplicated; sensor 12, the future row, the 2023 row and station 99999 gone
    assert [o.value for o in obs][-5:] == [0.0, 0.0, 0.3, 2.5, 3.7]
    assert len(obs) == 24  # 23 series buckets + the clamped one
    assert [
        o.value for o in obs if o.observed_at == END - 9 * STEP - timedelta(milliseconds=1)
    ] == [0.0]
    assert obs[-1].observed_at == END
    assert all(o.observed_at <= END for o in b.observations)
    assert not any(o.value == 9.9 or o.value == 6.0 or o.value == 5.0 for o in b.observations)
    assert len({o.entity_id for o in b.observations}) == 1


def test_station_filters_and_unmatched_ignored():
    real = parse_fixture(SID)
    odd = parse_fixture(SID, "edge_odd_stations")
    assert odd.observations == real.observations and odd.events == real.events


# ----------------------------------------------------------------------------- episodes
def test_real_episode_fields():
    b = parse_fixture(SID)
    (utopia,) = _events(b, UTOPIA)
    assert utopia.event_id == f"{UTOPIA}:2026-11-14T07:40:48+00:00"
    assert utopia.category == "flood" and utopia.severity == 2 and utopia.borough == "QN"
    assert utopia.ends_at == datetime(2026, 11, 14, 18, 43, 12, tzinfo=UTC)
    assert utopia.entity_refs == (f"flood_sensor:{UTOPIA}",)
    assert utopia.props == {"max_depth_in": 7.0, "live": True}
    assert utopia.title == "Flooding at Q - Utopia Pkwy/ 67th Ave, 7 in"
    assert (utopia.lat, utopia.lon) != (None, None)
    assert len(_events(b, DITMARS)) == 6 and len(_events(b, QUINCY)) == 2
    assert all(e.ends_at is not None for e in b.events)  # nothing is wet at the capture time


def test_episode_rules():
    b = parse_fixture(SID, "edge_episodes")
    # 1.2 / 2.6 / 1.1, two dry buckets, 1.4: one merged episode, closed one bucket after the last
    (merged,) = _events(b, UTOPIA)
    assert merged.props["max_depth_in"] == 2.6 and merged.severity == 1
    assert merged.starts_at == END - 15 * STEP and merged.ends_at == END - 9 * STEP
    # a lone 1.5 is noise; a lone 2.4 counts; three dry buckets split two runs
    lone, first, second = _events(b, DITMARS)
    assert lone.props["max_depth_in"] == 2.4 and lone.ends_at == lone.starts_at + STEP
    assert (first.props["max_depth_in"], second.props["max_depth_in"]) == (1.3, 1.2)
    assert second.starts_at - first.starts_at == 5 * STEP


def test_episode_open_closed():
    b = parse_fixture(SID, "edge_episodes")
    (open_,) = _events(b, QUINCY)
    assert open_.ends_at is None and open_.props["max_depth_in"] == 4.2
    assert open_.starts_at == END - 3 * STEP and open_.severity == 2
    # last bucket wet but the sensor went quiet 5 h before the fetch: closed, not open
    (quiet,) = _events(b, WINTHROP)
    assert quiet.ends_at == END - 20 * STEP + STEP and quiet.props["max_depth_in"] == 2.2
    # closed episode: ends one bucket after the last wet one
    (closed,) = _events(parse_fixture(SID), UTOPIA)
    assert closed.ends_at is not None


def test_episode_touching_window_start_skipped():
    b = parse_fixture(SID, "edge_episodes")
    assert _events(b, BLAKE) == []  # wet from the first bucket
    assert len(_obs(b, BLAKE)) == 35  # its depth readings are still observations


# ------------------------------------------------------------------------------ rejected
@pytest.mark.parametrize("case", ["bad_stations_shape", "bad_no_match"])
def test_bad_payloads_raise(case):
    with pytest.raises(ValueError):
        floodnet_live.parse(load_fixture(SID, case))


# --------------------------------------------------------------------------------- fetch
def test_fetch_batches_active_stations():
    real = load_fixture(SID)
    seen = []

    def handler(request: httpx.Request) -> httpx.Response:
        seen.append(request.url)
        if request.url.path.endswith("/stations"):
            return httpx.Response(200, content=real.part("stations").content)
        if request.url.host == "data.cityofnewyork.us":
            return httpx.Response(200, content=real.part("sensors-000").content)
        ids = request.url.params["stations"].split(",")
        return httpx.Response(200, json={"data": [], "stations": {i: {} for i in ids}})

    http = Http("test", min_gap_s=0, transport=httpx.MockTransport(handler), sleep=lambda s: None)
    src = load_registry().sources[SID]
    ctx = FetchContext(source=src, http=http, cursor=None, now=datetime(2026, 11, 16, tzinfo=UTC))
    adapter = load_adapter("floodnet_live")
    old = floodnet_live.BATCH
    floodnet_live.BATCH = 4
    try:
        raw = adapter.fetch(ctx)
    finally:
        floodnet_live.BATCH = old
    assert [p.name for p in raw.parts] == ["stations", "sensors-000", "tail-000", "tail-001"]
    tails = [u for u in seen if u.path.endswith("/tail")]
    ids = [i for u in tails for i in u.params["stations"].split(",")]
    assert len(ids) == len(set(ids)) == 8 and all(
        len(u.params["stations"].split(",")) <= 4 for u in tails
    )

"""The city_alerts builder and Notify NYC in CHANGES (ADR-015), on real pipeline state.

The layer isn't in the catalog yet (it goes live with the registry adapter), so the builder is
called directly rather than through /api/layers.
"""

import sqlite3
from datetime import UTC, datetime, timedelta

from helpers import load_fixture

from nyclive.api.changes import change_items
from nyclive.api.layers.common import Ctx
from nyclive.api.layers.streets import city_alerts
from nyclive.collect.pipeline import run_once
from nyclive.registry import load_registry
from nyclive.sources import notify_nyc
from nyclive.sources.base import Adapter, Batch, RawPart, RawPayload
from nyclive.storage.state import StateStore

SID = "notify_nyc"
NOW = datetime(2026, 11, 16, 21, 30, tzinfo=UTC)  # 4:30 PM ET, inside the fixtures' 4-6 PM window


def _state(tmp_path, cases: list[str]):
    """One pipeline run whose batch is the union of the given fixture cases' events."""
    events = []
    for case in cases:
        events += notify_nyc.parse(load_fixture(SID, case)).events
    raw = RawPayload(SID, (RawPart("rss", "u", b"", NOW),))
    a = Adapter(
        "x", (SID,), lambda ctx: raw, lambda r: Batch(events=events, complete=frozenset({"events"}))
    )
    with StateStore(tmp_path / "state.db") as store:
        assert run_once(
            load_registry().sources[SID], a, None, store, tmp_path / "a", now=lambda: NOW
        ).ok
    conn = sqlite3.connect(tmp_path / "state.db")
    conn.row_factory = sqlite3.Row
    return conn


def test_builder_draws_local_polygons_and_counts_the_rest(tmp_path):
    conn = _state(
        tmp_path, ["edge_local_polygon", "edge_circle", "edge_update_cancel", "edge_archived_rss"]
    )
    res = city_alerts(Ctx(conn=conn, now=NOW, services=None, layer={}))
    ids = {f["properties"]["id"] for f in res.features}
    assert ids == {"900001", "900010"}  # the Bronx polygon and the Queens circle
    f = next(f for f in res.features if f["properties"]["id"] == "900001")
    assert f["geometry"]["type"] == "Polygon" and f["properties"]["borough"] == "BX"
    assert f["properties"]["event"] == "Police Activity" and f["properties"]["status"] == "active"
    # The update (no polygon) and the archived Feb alert (RSS-only) are unlocated; the Cancel
    # ended at 4:20 PM, before NOW, so it's not in effect.
    assert res.unlocated == 2


def test_changes_list_notices_skip_cancels_and_map_only_polygons(tmp_path):
    conn = _state(tmp_path, ["edge_local_polygon", "edge_update_cancel", "edge_citywide"])
    items = change_items(conn, NOW + timedelta(minutes=1), 12, 50, boroughs=None)
    by_id = {i["id"]: i for i in items}
    assert all(i["kind"] == "notice" and i["layer"] == "city_alerts" for i in items)
    assert "notify_nyc:900021" not in by_id  # the Cancel
    local = by_id["notify_nyc:900001"]
    assert local["feature"] == "900001" and local["lat"] is not None  # flies to its polygon
    citywide = by_id["notify_nyc:2625738456985519"]
    assert citywide["feature"] is None and citywide["lat"] is None  # listed, not on the map
    update = by_id["notify_nyc:900020"]
    assert update["feature"] is None and update["borough"] == "MN"  # area "New York" county

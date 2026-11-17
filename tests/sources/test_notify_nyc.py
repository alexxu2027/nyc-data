"""notify_nyc adapter (Notify NYC CAP RSS), plan .orchestrate/notify/plan.md, ADR-015.

The registry has no `adapter:` for notify_nyc yet (it goes live with the catalog entry once the
watcher's real captures settle the geometry rule), so these tests load the module directly.
"""

from datetime import UTC, datetime

import pytest
from helpers import load_fixture, parse_fixture

from nyclive.sources import notify_nyc

SID = "notify_nyc"
MOD = "notify_nyc"


def parse(case: str):
    return parse_fixture(SID, case, module=MOD)


def test_empty_channel_is_a_valid_complete_set():
    b = parse("edge_empty")
    assert b.events == [] and b.complete == {"events"}


def test_archived_rss_only_english_and_rss_fallback():
    """13 language copies of one alert, no CAP files: one event built from the RSS fields."""
    b = parse("edge_archived_rss")
    assert len(b.events) == 1
    e = b.events[0]
    assert e.title == "Traffic Delays - FDR Drive (MN)"  # "Notify NYC - " prefix dropped
    assert e.borough == "MN"  # from the title's "(MN)" tag
    assert e.geometry_wkt is None and e.ends_at is None
    assert e.starts_at == datetime(2026, 2, 12, 1, 9, 6, tzinfo=UTC)  # the English item's pubDate
    assert e.props["has_cap"] is False and e.props["rss_category"] == "Transport"
    assert e.category == "city_alert" and e.severity == 2  # no CAP: the flat Notify NYC level
    assert e.subtype == "Traffic Delays"  # from the headline


def test_citywide_alert_has_no_geometry():
    """The real Jul 14 air-quality CAP: all five counties, a city-sized polygon."""
    b = parse("edge_citywide")
    assert len(b.events) == 1  # the Spanish twin is ignored
    e = b.events[0]
    assert e.event_id == "2625738456985519"
    assert e.props["citywide"] is True and e.geometry_wkt is None and e.borough is None
    assert e.severity == 2 and e.props["severity"] == "Severe"  # generic CEM: flat level
    assert e.subtype == "Canadian Wildfires Air Quality"
    assert e.title.startswith("Canadian Wildfires Air Quality")
    assert e.ends_at is not None and e.ends_at > e.starts_at  # CAP expires
    assert e.props["description"].startswith("Notification issued")


def test_five_counties_without_a_polygon_is_not_citywide():
    """Real capture 2026-11-16: a GWB crash sent to all five counties as an Extreme CEM."""
    b = parse("edge_five_counties")
    assert len(b.events) == 1
    e = b.events[0]
    assert e.props["citywide"] is False and e.geometry_wkt is None and e.borough is None
    assert e.subtype == "Traffic Delays" and e.title == "Traffic Delays - George Washington Bridge"
    assert e.severity == 2 and e.props["severity"] == "Extreme"
    assert e.ends_at > e.starts_at


def test_five_counties_with_a_local_polygon_draws():
    """The areaDesc no longer decides citywide: a small polygon still draws."""
    from dataclasses import replace

    raw = load_fixture(SID, "edge_local_polygon")
    parts = tuple(
        replace(p, content=p.content.replace(
            b"<areaDesc>Bronx<", b"<areaDesc>Bronx,Kings,New York,Queens,Staten Island<"
        )) if p.name.startswith("cap-") else p
        for p in raw.parts
    )  # fmt: skip
    e = notify_nyc.parse(replace(raw, parts=parts)).events[0]
    assert e.props["citywide"] is False and e.geometry_wkt.startswith("POLYGON")
    assert e.borough == "BX"  # all five counties named, so the title's (BX) tag decides


def test_local_polygon_draws_in_lon_lat_order():
    b = parse("edge_local_polygon")
    assert len(b.events) == 1
    e = b.events[0]
    assert e.borough == "BX" and e.props["citywide"] is False
    assert e.geometry_wkt.startswith("POLYGON ((-73.832 40.87, ")  # CAP is lat,lon; WKT lon lat
    assert e.subtype == "Police Activity" and e.severity == 2


def test_circle_becomes_a_closed_polygon():
    e = parse("edge_circle").events[0]
    assert e.geometry_wkt.startswith("POLYGON ((")
    coords = e.geometry_wkt[len("POLYGON ((") : -2].split(", ")
    assert len(coords) == 33 and coords[0] == coords[-1]
    assert e.borough == "QN"


def test_update_keeps_references_and_cancel_ends_when_sent():
    ev = {e.event_id: e for e in parse("edge_update_cancel").events}
    upd, cancel = ev["900020"], ev["900021"]
    assert upd.props["msg_type"] == "Update" and upd.props["references"].startswith(
        "2337151014565550"
    )
    assert cancel.props["msg_type"] == "Cancel"
    assert cancel.ends_at == datetime(2026, 11, 16, 21, 20, tzinfo=UTC)  # 16:20 ET, when sent


@pytest.mark.parametrize(("case", "match"), [("bad_html", "not"), ("bad_truncated", "not XML")])
def test_bad_cases_raise(case, match):
    with pytest.raises(ValueError, match=match):
        notify_nyc.parse(load_fixture(SID, case))


def test_wrong_source_raises():
    raw = load_fixture(SID, "edge_empty")
    from dataclasses import replace

    with pytest.raises(ValueError, match="does not serve"):
        notify_nyc.parse(replace(raw, source_id="nws_alerts"))


def test_broken_cap_falls_back_to_rss():
    from dataclasses import replace

    raw = load_fixture(SID, "edge_local_polygon")
    parts = tuple(
        replace(p, content=b"<oops") if p.name.startswith("cap-") else p for p in raw.parts
    )
    e = notify_nyc.parse(replace(raw, parts=parts)).events[0]
    assert e.props["has_cap"] is False and e.geometry_wkt is None and e.borough == "BX"


def test_fetch_gets_rss_then_english_caps_only():
    from nyclive.sources.base import FetchContext

    raw = load_fixture(SID, "edge_local_polygon")
    bodies = {notify_nyc.RSS_URL: raw.part("rss").content}
    for p in raw.parts:
        if p.name.startswith("cap-"):
            bodies[p.url] = p.content
    got = []

    class Resp:
        def __init__(self, url):
            self.url, self.content = url, bodies[url]

    class FakeHttp:
        def get(self, url, **kw):
            got.append(url)
            return Resp(url)

    now = datetime(2026, 11, 16, 21, 30, tzinfo=UTC)
    out = notify_nyc.fetch(FetchContext(source=None, http=FakeHttp(), cursor=None, now=now))
    assert got[0] == notify_nyc.RSS_URL and len(got) == 2  # the Spanish twin's CAP isn't fetched
    assert [p.name for p in out.parts] == ["rss", "cap-900001"]

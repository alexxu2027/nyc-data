"""Build the notify_nyc edge fixtures (offline, deterministic).

Real inputs, kept as fixture cases of their own:
- `edge_archived_rss`: the Feb 12 2026 RSS from the Wayback Machine (13 language copies of one
  traffic alert, "Traffic Delays - FDR Drive (MN)"); its CAP files weren't archived, so this case
  exercises the RSS-only fallback.
- `edge_citywide`: a one-item RSS around the archived Jul 14 2026 CAP (a citywide air-quality
  alert whose polygon covers the five boroughs), plus its Spanish twin, which must be ignored.

Synthetic cases built from those:
- `edge_local_polygon`: a small Bronx polygon ("(BX)" alert), which must draw.
- `edge_circle`: a CAP <circle>, which becomes a polygon.
- `edge_update_cancel`: an Update (with references) and a Cancel (ends when sent).
- `bad_html`: an HTML error page instead of the RSS.
- `bad_truncated`: the RSS cut mid-tag.

    uv run --no-sync python tests/fixtures/make_edges_notify_nyc.py
"""

from __future__ import annotations

from datetime import UTC, datetime
from pathlib import Path

from nyclive.sources.base import RawPart, RawPayload
from nyclive.sources.notify_nyc import RSS_URL, cap_part

ROOT = Path(__file__).parent / "notify_nyc"
SID = "notify_nyc"
AT = datetime(2026, 11, 16, 21, 30, tzinfo=UTC)
CAP_URL = "https://feeds.everbridge.net/feeds/453003085617722/cap/{}.xml"


def rss(items: list[dict]) -> bytes:
    body = "".join(
        f"<item><title>{i['title']}</title><description>{i.get('desc', '')}</description>"
        f"<guid>{i['guid']}</guid><pubDate>{i.get('pub', 'Mon, 16 Nov 2026 21:00:00 GMT')}</pubDate>"
        f"<category>{i.get('cat', 'Transport')}</category><author>NYCEM [{i.get('lang', 'English')}]</author>"
        f'<enclosure length="1" type="application/xml" url="{CAP_URL.format(i["guid"])}"/>'
        f"<link>{CAP_URL.format(i['guid'])}</link></item>"
        for i in items
    )
    return (
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><rss version="2.0"><channel>'
        "<title>Notify NYC CAP RSS Feed</title>"
        f"<link>{RSS_URL}</link><description>Common Alerting Protocol formatted RSS feed</description>"
        f"<pubDate>Mon, 16 Nov 2026 21:30:00 GMT</pubDate>{body}</channel></rss>"
    ).encode()


def cap(
    ident: str,
    *,
    headline: str,
    event: str,
    area: str,
    polygon: str = "",
    circle: str = "",
    msg: str = "Alert",
    refs: str = "",
    severity: str = "Moderate",
    sent: str = "2026-11-16T16:00:00-05:00",
    expires: str = "2026-11-16T18:00:00-05:00",
) -> bytes:
    geo = (f"<polygon>{polygon}</polygon>" if polygon else "") + (
        f"<circle>{circle}</circle>" if circle else ""
    )
    ref = f"<references>{refs}</references>" if refs else ""
    return (
        '<?xml version="1.0" encoding="UTF-8" standalone="no"?>'
        '<alert xmlns="urn:oasis:names:tc:emergency:cap:1.2">'
        f"<identifier>{ident}</identifier><sender>{ident}</sender><sent>{sent}</sent>"
        f"<status>Actual</status><msgType>{msg}</msgType><scope>Public</scope>{ref}"
        "<info><language>en-US</language><category>Transport</category>"
        f"<event>{event}</event><urgency>Immediate</urgency><severity>{severity}</severity>"
        f"<certainty>Observed</certainty><expires>{expires}</expires>"
        f"<senderName>NYCEM [English]</senderName><headline>{headline}</headline>"
        f"<description>{headline}. Use alternate routes.</description>"
        f"<area><areaDesc>{area}</areaDesc>{geo}</area></info></alert>"
    ).encode()


def save(case: str, rss_bytes: bytes, caps: dict[str, bytes], note: str) -> None:
    parts = [RawPart("rss", RSS_URL, rss_bytes, AT)]
    parts += [RawPart(cap_part(g), CAP_URL.format(g), b, AT) for g, b in caps.items()]
    RawPayload(SID, tuple(parts)).save(ROOT / case, note=note)
    print("wrote", case)


def main() -> None:
    # Small polygon around Hutchinson River Pkwy E / Bartow Ave (lat,lon pairs, CAP order).
    bx = "40.8700,-73.8320 40.8700,-73.8240 40.8650,-73.8240 40.8650,-73.8320 40.8700,-73.8320"
    save(
        "edge_local_polygon",
        rss(
            [
                {
                    "guid": "900001",
                    "title": "Notify NYC - Police Activity - Hutchinson River Parkway East (BX)",
                },
                {
                    "guid": "900002",
                    "title": "Notify NYC - Actividad policial (BX)",
                    "lang": "Spanish",
                },
            ]
        ),
        {
            "900001": cap(
                "900001",
                headline="Notify NYC - Police Activity - Hutchinson River Parkway East (BX)",
                event="Police Activity",
                area="Bronx",
                polygon=bx,
            )
        },
        "synthetic: a local polygon in the Bronx (must draw), plus a Spanish twin to ignore",
    )
    save(
        "edge_circle",
        rss([{"guid": "900010", "title": "Notify NYC - Water Main Break - Queens (QN)"}]),
        {
            "900010": cap(
                "900010",
                headline="Notify NYC - Water Main Break - Queens (QN)",
                event="Water Main Break",
                area="Queens",
                circle="40.7420,-73.8890 0.3",
            )
        },
        "synthetic: a CAP circle (0.3 km) becomes a polygon",
    )
    save(
        "edge_update_cancel",
        rss(
            [
                {"guid": "900020", "title": "Notify NYC - Update: Traffic Delays - FDR Drive (MN)"},
                {
                    "guid": "900021",
                    "title": "Notify NYC - Cancel: Road Closure - Atlantic Ave (BK)",
                },
            ]
        ),
        {
            "900020": cap(
                "900020",
                headline="Notify NYC - Update: Traffic Delays - FDR Drive (MN)",
                event="Traffic Delays",
                area="New York",
                msg="Update",
                refs="2337151014565550,2337151014565550,2026-11-16T15:10:00-05:00",
            ),
            "900021": cap(
                "900021",
                headline="Notify NYC - Cancel: Road Closure - Atlantic Ave (BK)",
                event="Road Closure",
                area="Kings",
                msg="Cancel",
                sent="2026-11-16T16:20:00-05:00",
            ),
        },
        "synthetic: an Update (references kept) and a Cancel (ends when sent)",
    )
    html = b"<!doctype html><html><head><title>502 Bad Gateway</title></head><body>cloudflare</body></html>"
    save("bad_html", html, {}, "synthetic: an HTML error page instead of the RSS")
    good = rss([{"guid": "900030", "title": "Notify NYC - Fire - Bronx (BX)"}])
    save("bad_truncated", good[: len(good) // 2], {}, "synthetic: the RSS cut in half")


if __name__ == "__main__":
    main()

"""Notify NYC alerts (NYC Emergency Management) from its CAP RSS feed (notify_nyc), ADR-015.

The RSS (Everbridge) holds only the alerts active now, one item per language. We keep the
English items (`<author>` "NYCEM [English]") and fetch each one's CAP 1.2 file, which has the
area polygon, `expires`, severity and the full text. The RSS is the complete current set, so
alerts that leave it are closed by the pipeline. An empty channel is normal (most of the day).

Geometry: a CAP `<polygon>` (or `<circle>`) becomes WKT, unless the alert is citywide (all
five counties named, or a polygon about the size of the city). A city-sized shape would cover
every other layer, so citywide alerts have no geometry and show in the list and CHANGES. No
geocoding: places named only in text ("FDR Dr and E 10 St") stay off the map (no keyless
intersection geocoder; research 2026-11-16).

Quirks: CAP times carry offsets. The RSS `pubDate` is RFC 2822. Each language copy has its own
`guid`, so ids come from the English CAP `identifier`. A `msgType` of Cancel ends the alert
when it was sent.
"""

from __future__ import annotations

import math
import re
import xml.etree.ElementTree as ET
from typing import Any

from nyclive.model import BOROUGHS, PROPS_MAX_BYTES, Event, borough_code
from nyclive.sources._text import trim_text_fields
from nyclive.sources.base import Batch, FetchContext, RawPart, RawPayload
from nyclive.timeutil import parse_iso_utc, parse_rfc2822_utc

SOURCE_IDS = ("notify_nyc",)

RSS_URL = "https://feeds.everbridge.net/feeds/453003085617722/rss/rss.xml"
CAP = "{urn:oasis:names:tc:emergency:cap:1.2}"
ENGLISH = "[English]"
MAX_CAPS = 25  # CAP files fetched per run; alerts past that are built from their RSS fields
SEVERITY = {"Extreme": 3, "Severe": 3, "Moderate": 2, "Minor": 1}
CATEGORY = "city_alert"
TITLE_PREFIX = re.compile(r"^\s*Notify NYC\s*-\s*", re.IGNORECASE)
BOROUGH_TAG = re.compile(r"\((MN|BK|QN|BX|SI)\)\s*$")
# The five boroughs' bounding box; a polygon covering most of it is "citywide".
CITY_BBOX = (-74.26, 40.49, -73.70, 40.92)
CITYWIDE_SHARE = 0.6
_TEXT_FIELDS = ("description",)


# --------------------------------------------------------------------------------- fetch
def fetch(ctx: FetchContext) -> RawPayload:
    r = ctx.http.get(RSS_URL)
    parts = [RawPart("rss", str(r.url), r.content, ctx.now)]
    try:
        items = _english_items(r.content)
    except ValueError:
        items = []  # parse rejects the body; nothing more to fetch
    for it in items[:MAX_CAPS]:
        if not it["cap_url"]:
            continue
        c = ctx.http.get(it["cap_url"])
        parts.append(RawPart(cap_part(it["guid"]), str(c.url), c.content, ctx.now))
    return RawPayload(SOURCE_IDS[0], tuple(parts))


def cap_part(guid: str) -> str:
    return "cap-" + re.sub(r"[^a-z0-9_.-]", "-", guid.lower())


# --------------------------------------------------------------------------------- parse
def parse(raw: RawPayload) -> Batch:
    if raw.source_id not in SOURCE_IDS:
        raise ValueError(f"notify_nyc adapter does not serve {raw.source_id!r}")
    items = _english_items(raw.part("rss").content)
    names = {p.name for p in raw.parts}
    batch = Batch(complete=frozenset({"events"}))
    seen: set[str] = set()
    for it in items:
        cap = None
        part = cap_part(it["guid"])
        if part in names:
            try:
                cap = _cap(raw.part(part).content)
            except ValueError:
                cap = None  # a broken CAP file: fall back to the RSS fields
        ev = _event(raw.source_id, it, cap)
        if ev is None or ev.event_id in seen:
            continue
        seen.add(ev.event_id)
        batch.events.append(ev)
    return batch


def _english_items(rss: bytes) -> list[dict[str, Any]]:
    """The English items of a Notify NYC CAP RSS. Raises ValueError if it isn't one."""
    try:
        root = ET.fromstring(rss)
    except ET.ParseError as e:
        raise ValueError(f"not XML: {e}") from e
    channel = root.find("channel")
    title = channel.findtext("title") if channel is not None else None
    if root.tag != "rss" or channel is None or "CAP RSS Feed" not in (title or ""):
        raise ValueError(f"not the Notify NYC CAP RSS (root {root.tag!r}, title {title!r})")
    out = []
    for it in channel.findall("item"):
        if not (it.findtext("author") or "").strip().endswith(ENGLISH):
            continue
        enc = it.find("enclosure")
        out.append({
            "guid": (it.findtext("guid") or "").strip(),
            "title": (it.findtext("title") or "").strip(),
            "description": (it.findtext("description") or "").strip(),
            "category": (it.findtext("category") or "").strip() or None,
            "pub": (it.findtext("pubDate") or "").strip(),
            "cap_url": (enc.get("url") if enc is not None else None) or it.findtext("link"),
        })  # fmt: skip
    return out


def _cap(content: bytes) -> dict[str, Any]:
    try:
        root = ET.fromstring(content)
    except ET.ParseError as e:
        raise ValueError(f"CAP not XML: {e}") from e
    if root.tag != f"{CAP}alert":
        raise ValueError(f"not a CAP 1.2 alert: {root.tag!r}")
    info = root.find(f"{CAP}info")

    def t(el: ET.Element | None, tag: str) -> str | None:
        v = el.findtext(f"{CAP}{tag}") if el is not None else None
        return v.strip() if v and v.strip() else None

    area = info.find(f"{CAP}area") if info is not None else None
    return {
        "identifier": t(root, "identifier"),
        "sent": t(root, "sent"),
        "msg_type": t(root, "msgType"),
        "references": t(root, "references"),
        "category": t(info, "category"),
        "event": t(info, "event"),
        "urgency": t(info, "urgency"),
        "severity": t(info, "severity"),
        "certainty": t(info, "certainty"),
        "onset": t(info, "onset"),
        "effective": t(info, "effective"),
        "expires": t(info, "expires"),
        "headline": t(info, "headline"),
        "description": t(info, "description"),
        "area_desc": t(area, "areaDesc"),
        "polygons": [p.text for p in area.findall(f"{CAP}polygon") if p.text] if area is not None else [],
        "circles": [c.text for c in area.findall(f"{CAP}circle") if c.text] if area is not None else [],
    }  # fmt: skip


def _event(sid: str, it: dict, cap: dict | None) -> Event | None:
    c = cap or {}
    event_id = c.get("identifier") or it["guid"]
    if not event_id:
        return None
    try:
        start_s = c.get("onset") or c.get("effective") or c.get("sent")
        starts_at = parse_iso_utc(start_s) if start_s else parse_rfc2822_utc(it["pub"])
        ends_at = parse_iso_utc(c["expires"]) if c.get("expires") else None
        if c.get("msg_type") == "Cancel" and c.get("sent"):
            ends_at = parse_iso_utc(c["sent"])
    except (TypeError, ValueError):
        return None
    if ends_at is not None and ends_at < starts_at:
        ends_at = starts_at  # a cancel sent before the stated onset
    title = c.get("headline") or it["title"] or "Notify NYC alert"
    title = TITLE_PREFIX.sub("", title) or title
    boroughs = _boroughs(c.get("area_desc"), it["title"])
    citywide = len(boroughs) == len(BOROUGHS)
    wkt = None if citywide else _wkt(c.get("polygons") or [], c.get("circles") or [])
    if wkt is not None and _covers_city(wkt):
        citywide, wkt = True, None
    props = {
        "area_desc": c.get("area_desc"),
        "urgency": c.get("urgency"),
        "certainty": c.get("certainty"),
        "severity": c.get("severity"),
        "cap_category": c.get("category"),
        "rss_category": it["category"],
        "msg_type": c.get("msg_type") or "Alert",
        "references": c.get("references"),
        "citywide": citywide,
        "has_cap": cap is not None,
        "description": c.get("description") or it["description"] or None,
    }
    return Event(
        source=sid,
        event_id=event_id,
        category=CATEGORY,
        title=title,
        starts_at=starts_at,
        ends_at=ends_at,
        subtype=c.get("event") or it["category"],
        severity=SEVERITY.get(c.get("severity") or "", 0),
        geometry_wkt=wkt,
        borough=next(iter(boroughs)) if len(boroughs) == 1 else None,
        props=trim_text_fields(props, _TEXT_FIELDS, PROPS_MAX_BYTES),
    )


def _boroughs(area_desc: str | None, title: str) -> set[str]:
    """Boroughs named in the CAP areaDesc ("Bronx,Kings,…"), else the title's "(BX)" tag."""
    found = {b for b in (borough_code(x) for x in (area_desc or "").split(",")) if b}
    if not found and (m := BOROUGH_TAG.search(title)):
        found.add(m.group(1))
    return found


# --------------------------------------------------------------------------------- geometry
def _ring(text: str) -> list[tuple[float, float]] | None:
    """CAP "lat,lon lat,lon …" to [(lon, lat), …], closed; None if unusable."""
    pts = []
    for pair in text.split():
        lat_s, _, lon_s = pair.partition(",")
        try:
            lat, lon = float(lat_s), float(lon_s)
        except ValueError:
            return None
        if not (-90 <= lat <= 90 and -180 <= lon <= 180):
            return None
        pts.append((lon, lat))
    if len(pts) < 3:
        return None
    if pts[0] != pts[-1]:
        pts.append(pts[0])
    return pts if len(pts) >= 4 else None


def _circle(text: str, n: int = 32) -> list[tuple[float, float]] | None:
    """CAP "lat,lon radius_km" to a closed n-point ring."""
    try:
        center, radius = text.split()
        lat_s, _, lon_s = center.partition(",")
        lat, lon, km = float(lat_s), float(lon_s), float(radius)
    except ValueError:
        return None
    if km <= 0:
        return None
    dlat = km / 111.32
    dlon = km / (111.32 * math.cos(math.radians(lat)))
    ring = [
        (lon + dlon * math.cos(2 * math.pi * i / n), lat + dlat * math.sin(2 * math.pi * i / n))
        for i in range(n)
    ]
    return [*ring, ring[0]]


def _wkt(polygons: list[str], circles: list[str]) -> str | None:
    rings = [r for r in (*(_ring(p) for p in polygons), *(_circle(c) for c in circles)) if r]
    if not rings:
        return None
    polys = ["((" + ", ".join(f"{x!r} {y!r}" for x, y in r) + "))" for r in rings]
    return f"POLYGON {polys[0]}" if len(polys) == 1 else "MULTIPOLYGON (" + ", ".join(polys) + ")"


def _covers_city(wkt: str) -> bool:
    nums = [float(v) for v in re.findall(r"-?\d+(?:\.\d+)?", wkt)]
    xs, ys = nums[0::2], nums[1::2]
    w0, s0, e0, n0 = CITY_BBOX
    ix = max(0.0, min(max(xs), e0) - max(min(xs), w0))
    iy = max(0.0, min(max(ys), n0) - max(min(ys), s0))
    return ix * iy >= CITYWIDE_SHARE * (e0 - w0) * (n0 - s0)

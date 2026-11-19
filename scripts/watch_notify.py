"""Step 0 of the Notify NYC plan (.orchestrate/notify/plan.md): capture real alerts as fixtures.

The Notify NYC CAP RSS only holds alerts that are live now (each leaves about 2 h after it's
sent), so it is usually empty. This polls it every 2 min and, whenever the set of English
alerts changes, saves the RSS plus each English alert's CAP file as one fixture case:
tests/fixtures/notify_nyc/live_<YYYYmmdd_HHMM>/ (the RawPayload format, so `parse` reads it
directly). It never touches the collector, state.db or the archive.

Polite: one RSS request per 2 min; a CAP file is fetched once per alert; one host at a time
(the project Http client). Stops after --alerts distinct English alerts or --hours.

    uv run --no-sync python scripts/watch_notify.py            # defaults: 8 alerts, 36 h
"""

from __future__ import annotations

import argparse
import time
import xml.etree.ElementTree as ET
from pathlib import Path

from nyclive.http import Http, HttpError
from nyclive.settings import load_settings
from nyclive.sources.base import RawPart, RawPayload
from nyclive.timeutil import now_utc

SID = "notify_nyc"
RSS = "https://feeds.everbridge.net/feeds/453003085617722/rss/rss.xml"
OUT = Path(__file__).resolve().parents[1] / "tests" / "fixtures" / SID
CAP_NS = "{urn:oasis:names:tc:emergency:cap:1.2}"


def log(msg: str) -> None:
    print(f"{now_utc():%Y-%m-%d %H:%M:%S}Z {msg}", flush=True)


def english_items(rss: bytes) -> list[dict]:
    channel = ET.fromstring(rss).find("channel")
    if channel is None:
        raise ValueError("not an RSS channel")
    out = []
    for it in channel.findall("item"):
        if (it.findtext("author") or "").endswith("[English]"):
            enc = it.find("enclosure")
            out.append(
                {
                    "guid": (it.findtext("guid") or "").strip(),
                    "title": it.findtext("title") or "",
                    "cap": enc.get("url") if enc is not None else it.findtext("link"),
                }
            )
    return out


def describe(cap: bytes) -> str:
    """Where the alert says it is: what Step 0 has to count."""
    try:
        root = ET.fromstring(cap)
    except ET.ParseError:
        return "cap: unparseable"
    area = root.find(f"{CAP_NS}info/{CAP_NS}area")
    msg = root.findtext(f"{CAP_NS}msgType") or "?"
    if area is None:
        return f"{msg}, no area"
    desc = (area.findtext(f"{CAP_NS}areaDesc") or "")[:60]
    polys = area.findall(f"{CAP_NS}polygon")
    pts = sum(len((p.text or "").split()) for p in polys)
    circles = len(area.findall(f"{CAP_NS}circle"))
    return f"{msg}, area '{desc}', {len(polys)} polygon(s) / {pts} pts, {circles} circle(s)"


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    ap.add_argument("--alerts", type=int, default=8, help="stop after this many distinct alerts")
    ap.add_argument("--hours", type=float, default=36.0, help="stop after this long")
    ap.add_argument("--every", type=float, default=120.0, help="seconds between RSS polls")
    args = ap.parse_args()

    st = load_settings()
    http = Http(st.user_agent, **st.http_kwargs())
    caps: dict[str, bytes] = {}  # guid -> CAP bytes (fetched once)
    last_key: tuple[str, ...] | None = None
    deadline = time.monotonic() + args.hours * 3600
    saved_empty = (OUT / "edge_empty").exists()
    log(f"watching {RSS} every {args.every:.0f} s; stop at {args.alerts} alerts or {args.hours} h")
    try:
        while time.monotonic() < deadline and len(caps) < args.alerts:
            try:
                t = now_utc()
                rss = http.get(RSS).content
                items = english_items(rss)
                key = tuple(sorted(i["guid"] for i in items))
                if not items and not saved_empty:
                    RawPayload(SID, (RawPart("rss", RSS, rss, t),)).save(
                        OUT / "edge_empty", note="live empty channel (watch_notify.py)"
                    )
                    saved_empty = True
                    log("saved edge_empty")
                if items and key != last_key:
                    parts = [RawPart("rss", RSS, rss, t)]
                    lines = []
                    for it in items:
                        if it["guid"] not in caps and it["cap"]:
                            caps[it["guid"]] = http.get(it["cap"]).content
                        if it["guid"] in caps:
                            parts.append(
                                RawPart(f"cap-{it['guid']}", it["cap"], caps[it["guid"]], now_utc())
                            )
                            lines.append(f"{it['title']} | {describe(caps[it['guid']])}")
                    case = OUT / f"live_{t:%Y%m%d_%H%M}"
                    RawPayload(SID, tuple(parts)).save(case, note=" || ".join(lines))
                    log(
                        f"saved {case.name}: {len(items)} English alert(s), {len(caps)} distinct so far"
                    )
                    for line in lines:
                        log(f"  {line}")
                last_key = key
            except (HttpError, ET.ParseError, ValueError, OSError) as e:  # keep watching
                log(f"poll failed: {type(e).__name__}: {e}")
            time.sleep(args.every)
    finally:
        http.close()
    log(f"done: {len(caps)} distinct alert(s) captured")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

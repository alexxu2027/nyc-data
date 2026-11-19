"""Build tests/fixtures/openaq_nyc/{real,edge_*,bad_*}.

    uv run python tests/fixtures/make_cases_openaq_nyc.py --capture   # one live fetch (~47 calls)
    uv run python tests/fixtures/make_cases_openaq_nyc.py             # edges/bad only, from real

`--capture` runs the adapter's fetch through the project's Http (the key goes in a header and
never into the saved payload), then keeps a handful of stations: government monitors and
low-cost sensors, each with its `latest-<id>` part. The other cases edit `real`.
"""

from __future__ import annotations

import argparse
import json
from dataclasses import replace
from pathlib import Path

from nyclive.registry import load_registry
from nyclive.sources.base import RawPart, RawPayload

HERE = Path(__file__).parent
SOURCE_ID = "openaq_nyc"
MONITORS, LOW_COST = 4, 4


def capture() -> RawPayload:
    from nyclive.http import Http
    from nyclive.settings import load_settings
    from nyclive.sources import openaq
    from nyclive.sources.base import FetchContext
    from nyclive.timeutil import now_utc

    st = load_settings()
    with Http(st.user_agent, **st.http_kwargs()) as http:
        ctx = FetchContext(load_registry().sources[SOURCE_ID], http, None, now_utc())
        return openaq.fetch(ctx)


def trim(raw: RawPayload) -> RawPayload:
    body = raw.json("locations")
    have = {p.name.removeprefix("latest-") for p in raw.parts if p.name.startswith("latest-")}
    live = [loc for loc in body["results"] if str(loc["id"]) in have]
    mon = [x for x in live if x.get("isMonitor")][:MONITORS]
    low = [x for x in live if not x.get("isMonitor")][:LOW_COST]
    stale = [x for x in body["results"] if str(x["id"]) not in have][:2]  # listed, not fetched
    keep = mon + low + stale
    body = {**body, "results": keep, "meta": {**body.get("meta", {}), "found": len(keep)}}
    ids = {f"latest-{x['id']}" for x in mon + low}
    parts = [replace(raw.part("locations"), content=_dump(body))]
    parts += [p for p in raw.parts if p.name in ids]
    return replace(raw, parts=tuple(parts))


def _dump(obj) -> bytes:
    return (json.dumps(obj, ensure_ascii=False, indent=1) + "\n").encode("utf-8")


def edit(case: str, note: str, change) -> None:
    raw = RawPayload.load(HERE / SOURCE_ID / "real")
    change(raw).save(HERE / SOURCE_ID / case, note=note)


def odd_readings(raw: RawPayload) -> RawPayload:
    """A negative reading, an ozone sensor in ppb, an unknown parameter, a mobile station, a
    reading from the future and a latest part for a station that isn't in the list."""
    body = raw.json("locations")
    loc = dict(body["results"][0])
    lid = loc["id"]
    when = json.loads(raw.part(f"latest-{lid}").content)["results"][0]["datetime"]
    loc["sensors"] = [
        {"id": 9001, "name": "pm25", "parameter": {"id": 2, "name": "pm25", "units": "µg/m³"}},
        {"id": 9002, "name": "o3 ppb", "parameter": {"id": 3, "name": "o3", "units": "ppb"}},
        {"id": 9003, "name": "rh", "parameter": {"id": 98, "name": "relativehumidity", "units": "%"}},
        {"id": 9004, "name": "no2", "parameter": {"id": 7, "name": "no2", "units": "ppm"}},
    ]  # fmt: skip
    mobile = {**loc, "id": 999001, "name": "A mobile sensor", "isMobile": True}
    body["results"] = [loc, mobile, *body["results"][1:]]
    future = {"utc": "2099-01-01T00:00:00Z", "local": "2098-12-31T19:00:00-05:00"}
    latest = {
        "results": [
            {"datetime": when, "value": -3.0, "sensorsId": 9001, "locationsId": lid},
            {"datetime": when, "value": 41.0, "sensorsId": 9002, "locationsId": lid},
            {"datetime": when, "value": 55.0, "sensorsId": 9003, "locationsId": lid},
            {"datetime": future, "value": 0.02, "sensorsId": 9004, "locationsId": lid},
        ]
    }
    parts = [replace(raw.part("locations"), content=_dump(body))]
    for p in raw.parts[1:]:
        parts.append(replace(p, content=_dump(latest)) if p.name == f"latest-{lid}" else p)
    orphan = raw.parts[1]
    parts.append(RawPart("latest-123456789", orphan.url, orphan.content, orphan.fetched_at))
    return replace(raw, parts=tuple(parts))


def no_results(raw: RawPayload) -> RawPayload:
    parts = (replace(raw.part("locations"), content=_dump({"detail": "error"})), *raw.parts[1:])
    return replace(raw, parts=parts)


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--capture", action="store_true")
    if ap.parse_args().capture:
        raw = trim(capture())
        raw.save(
            HERE / SOURCE_ID / "real",
            note=f"OpenAQ NYC bbox, cut to {MONITORS} monitors and {LOW_COST} low-cost sensors "
            "with their latest readings, plus 2 listed stations that weren't fetched (stale)",
        )
    edit(
        "edge_odd_readings",
        "first station's sensors replaced: pm25 reads -3 (dropped), o3 in ppb (41 -> 0.041 "
        "ppm), relative humidity (ignored), no2 from 2099 (dropped); a mobile station "
        "(skipped); a latest part for a station not in the list (ignored)",
        odd_readings,
    )
    edit("bad_no_results", "locations body has no results list", no_results)


if __name__ == "__main__":
    main()

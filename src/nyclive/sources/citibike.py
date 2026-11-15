"""Citi Bike GBFS 2.3: station entities (citibike_gbfs) and live availability
(citibike_station_status).

Reference adapter (ROADMAP 1A): shows one module serving two registry ids, feed discovery from
a manifest, a complete entity set, and a sentinel timestamp.

Quirks: always discover feed URLs from the manifest (it points at gbfs.lyft.com). Inactive
stations report `last_reported: 86400`, which is a sentinel and not 1970-01-02; for those the
observation time is when we fetched it.
"""

from __future__ import annotations

import json

from nyclive.model import Entity, Observation
from nyclive.sources.base import Batch, FetchContext, RawPart, RawPayload
from nyclive.timeutil import from_epoch

SOURCE_IDS = ("citibike_gbfs", "citibike_station_status")

MANIFEST = "https://gbfs.citibikenyc.com/gbfs/2.3/gbfs.json"
FEED_FOR = {"citibike_gbfs": "station_information", "citibike_station_status": "station_status"}
LANG = "en"
SENTINEL_LAST_REPORTED = 86400
METRICS = {
    "bikes_available": "num_bikes_available",
    "ebikes_available": "num_ebikes_available",
    "docks_available": "num_docks_available",
    "is_renting": "is_renting",
}


def feed_url(manifest: dict, feed: str) -> str:
    langs = manifest["data"]
    feeds = (langs.get(LANG) or next(iter(langs.values())))["feeds"]
    for f in feeds:
        if f["name"] == feed:
            return f["url"]
    raise KeyError(f"GBFS manifest has no {feed!r} feed")


def fetch(ctx: FetchContext) -> RawPayload:
    sid = ctx.source.id
    feed = FEED_FOR[sid]
    m = ctx.http.get(MANIFEST)
    manifest_part = RawPart("manifest", str(m.url), m.content, ctx.now)
    r = ctx.http.get(feed_url(json.loads(manifest_part.content), feed))
    return RawPayload(sid, (manifest_part, RawPart(feed, str(r.url), r.content, ctx.now)))


def parse(raw: RawPayload) -> Batch:
    if raw.source_id == "citibike_gbfs":
        return _parse_information(raw)
    if raw.source_id == "citibike_station_status":
        return _parse_status(raw)
    raise ValueError(f"citibike adapter does not serve {raw.source_id!r}")


def _parse_information(raw: RawPayload) -> Batch:
    sid = raw.source_id
    batch = Batch(complete=frozenset({"entities"}))
    for s in raw.json("station_information")["data"]["stations"]:
        props = {k: s[k] for k in ("short_name", "capacity", "region_id") if s.get(k) is not None}
        batch.entities.append(
            Entity(
                source=sid,
                kind="bike_station",
                entity_id=str(s["station_id"]),
                name=s.get("name") or str(s["station_id"]),
                lat=float(s["lat"]),
                lon=float(s["lon"]),
                props=props,
            )
        )
    return batch


def _parse_status(raw: RawPayload) -> Batch:
    sid = raw.source_id
    part = raw.part("station_status")
    batch = Batch()
    for s in raw.json("station_status")["data"]["stations"]:
        reported = s.get("last_reported")
        if not reported or int(reported) <= SENTINEL_LAST_REPORTED:
            observed = part.fetched_at
        else:
            observed = min(from_epoch(reported), part.fetched_at)  # clock skew can't be future
        for metric, field in METRICS.items():
            v = s.get(field)
            if v is None:
                continue
            batch.observations.append(
                Observation(
                    sid,
                    "bike_station",
                    str(s["station_id"]),
                    metric,
                    observed,
                    float(v),
                    part.fetched_at,
                )
            )
    return batch

"""City services: complaints_311, and the static boroughs reference layer."""

from __future__ import annotations

import threading

from nyclive.api.geo import point
from nyclive.api.layers.common import Ctx, LayerResult, feature, iso, window_bounds

LIMIT_311 = 20_000
CLOSED = {"closed"}


class Classifier:
    """First case-insensitive substring match on the subtype wins; memoized per subtype."""

    def __init__(self, rules: dict[str, list[str]]) -> None:
        self.rules = list(rules.items())
        self._memo: dict[str, str] = {}
        self._lock = threading.Lock()

    def __call__(self, subtype: str | None) -> str:
        key = subtype or ""
        hit = self._memo.get(key)
        if hit is not None:
            return hit
        low = key.lower()
        group = next((g for g, subs in self.rules if any(s in low for s in subs)), "other")
        with self._lock:
            self._memo[key] = group
        return group


def complaints_311(ctx: Ctx) -> LayerResult:
    window = ctx.params.get("window", "24h")
    start, end = window_bounds(ctx.conn, "nyc_311", ctx.now_text, window)
    if end is None:
        return LayerResult([])
    classify = ctx.services.classifier("complaints_311")
    idx = ctx.services.boroughs
    rows = ctx.conn.execute(
        "SELECT event_id, subtype, starts_at, ends_at, lat, lon, borough,"
        " json_extract(props, '$.status') AS status, json_extract(props, '$.agency') AS agency"
        " FROM events WHERE source = 'nyc_311' AND starts_at > ? AND starts_at <= ?"
        " ORDER BY starts_at DESC, event_id",
        (start, end),
    ).fetchall()
    feats, unlocated = [], 0
    now_text = ctx.now_text
    for eid, subtype, starts, ends, lat, lon, borough, status, agency in rows:
        if lat is None or lon is None:
            unlocated += 1
            continue
        closed = (status or "").lower() in CLOSED or (ends is not None and ends <= now_text)
        feats.append(
            feature(
                eid,
                borough or idx.locate(lon, lat),
                point(lon, lat),
                starts_at=iso(starts),
                type=subtype or "Unknown",
                group=classify(subtype),
                status="closed" if closed else "open",
                agency=agency or "",
            )
        )
    return LayerResult(
        feats,
        data_as_of=iso(end),
        window={"from": iso(start), "to": iso(end)},
        unlocated=unlocated,
    )


def boroughs(ctx: Ctx) -> LayerResult:
    feats = []
    for f in ctx.services.boroughs.features:
        p = f["properties"]
        g = f["geometry"]
        if g["type"] == "Polygon":
            g = {"type": "MultiPolygon", "coordinates": [g["coordinates"]]}
        feats.append(
            feature(p["borough"], p["borough"], g, name=p["name"], borocode=int(p["borocode"]))
        )
    return LayerResult(feats)

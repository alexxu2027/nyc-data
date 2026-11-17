"""GET /api/layers (catalog) and GET /api/layers/{id} (one layer's FeatureCollection)."""

from __future__ import annotations

from typing import Any

from fastapi import APIRouter, Request
from fastapi.responses import Response

from nyclive.api.cache import conditional, entry_for
from nyclive.api.db import reading
from nyclive.api.errors import bad_request, not_found
from nyclive.api.geo import BBox, intersects, parse_bbox
from nyclive.api.layers import BUILDERS, LIMITS, MAX_LIMIT, trains
from nyclive.api.layers.common import Ctx, iso, last_success
from nyclive.model import BOROUGHS

router = APIRouter(prefix="/api")


@router.get("/layers", summary="Layer catalog (config/layers.yaml, defaults filled)")
def catalog(request: Request) -> Response:
    return conditional(request, request.app.state.services.catalog_entry())


def _params(request: Request, layer_id: str, services) -> dict[str, Any]:
    q = request.query_params
    out: dict[str, Any] = {"borough": None, "bbox": None, "limit": LIMITS.get(layer_id)}
    if q.get("borough"):
        codes = sorted({c.strip().upper() for c in q["borough"].split(",") if c.strip()})
        bad = [c for c in codes if c not in BOROUGHS]
        if bad:
            raise bad_request(f"borough must be a list of {','.join(BOROUGHS)}; got {bad}")
        out["borough"] = tuple(codes)
    if q.get("bbox"):
        try:
            out["bbox"] = parse_bbox(q["bbox"])
        except ValueError as e:
            raise bad_request(f"bad bbox: {e}") from None
    if "limit" in q:
        try:
            limit = int(q["limit"])
        except ValueError:
            raise bad_request("limit must be an integer") from None
        if limit < 1:
            raise bad_request("limit must be at least 1")
        out["limit"] = min(limit, MAX_LIMIT)
    given = {k[2:]: v for k, v in q.items() if k.startswith("f.")}
    try:
        out["filters"] = services.catalog.server_filter_values(layer_id, given)
    except ValueError as e:
        raise bad_request(str(e)) from None
    return out


def _keep(feat: dict, boroughs: tuple[str, ...] | None, bbox: BBox | None) -> bool:
    if boroughs is not None:
        b = feat["properties"]["borough"]
        if b is not None and b not in boroughs:
            return False
    return bbox is None or intersects(feat["geometry"], bbox)


_lines_entry: dict[int, object] = {}


@router.get("/static/subway_lines", summary="Subway track as faint lines under the trains")
def subway_lines(request: Request) -> Response:
    lines = trains.subway_lines(trains.load_static())
    entry = _lines_entry.get(id(lines))
    if entry is None:
        _lines_entry.clear()
        entry = _lines_entry[id(lines)] = entry_for(lines)
    return conditional(request, entry)


@router.get("/layers/{layer_id}", summary="One layer as a GeoJSON FeatureCollection")
def layer(request: Request, layer_id: str) -> Response:
    services = request.app.state.services
    layer_def = services.catalog.layers.get(layer_id)
    if layer_def is None or layer_def["kind"] == "raster":
        raise not_found(f"no layer {layer_id!r}")
    p = _params(request, layer_id, services)
    if not layer_def["borough_filter"]:
        p["borough"] = None
    sources = layer_def["sources"]
    key = (
        layer_id,
        p["borough"],
        p["bbox"],
        p["limit"],
        tuple(sorted(p["filters"].items())),
    )
    max_age = max(30, min(layer_def["poll_s"], 300))
    now = services.now()
    with reading(services.settings.state_db) as conn:
        stamp = _stamp(conn, sources)

        def build() -> dict[str, Any]:
            ctx = Ctx(conn=conn, now=now, services=services, layer=layer_def, params=p["filters"])
            result = BUILDERS[layer_id](ctx)
            feats = [f for f in result.features if _keep(f, p["borough"], p["bbox"])]
            total = len(feats)
            if p["limit"] is not None:
                feats = feats[: p["limit"]]
            meta = {
                "layer": layer_id,
                "count": len(feats),
                "total": total,
                "truncated": len(feats) < total,
                "unlocated": result.unlocated,
                "data_as_of": result.data_as_of,
                "updated_at": iso(last_success(conn, sources)),
                "window": result.window,
                "note": result.note,
            }
            return {"type": "FeatureCollection", "meta": meta, "features": feats}

        entry = services.cache.get_or_build(key, stamp, now.timestamp(), max_age, build)
    return conditional(request, entry)


def _stamp(conn, sources: list[str]) -> tuple:
    if not sources:
        return ()
    marks = ",".join("?" for _ in sources)
    rows = conn.execute(
        f"SELECT source, last_success, rows_last_run FROM source_state WHERE source IN ({marks})"
        " ORDER BY source",
        sources,
    ).fetchall()
    return tuple(tuple(r) for r in rows)

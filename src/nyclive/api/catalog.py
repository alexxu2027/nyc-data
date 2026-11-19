"""Load and validate config/layers.yaml (schema v1, ADR-012 + ADR-013) and fill defaults.

`Catalog.public` is what `/api/layers` serves: every layer key filled in, `classify` stripped.
`Catalog.classify` keeps the server-only 311 grouping rules.
"""

from __future__ import annotations

import copy
import re
from dataclasses import dataclass
from pathlib import Path
from typing import Any

import yaml

from nyclive.registry import REPO_ROOT

DEFAULT_LAYERS = REPO_ROOT / "config" / "layers.yaml"
DEFAULT_BOROUGHS = REPO_ROOT / "config" / "boroughs.geojson"

KINDS = {"point", "line", "polygon", "cluster", "raster"}
CHANGE_KINDS = {"point", "cluster"}
RASTER_KEYS = {"index_url", "tiles", "frames", "tile_size", "max_zoom", "opacity", "stale_s"}
FILTER_TYPES = {"enum", "select", "toggle"}
APPLY = {"client", "server"}
OPS = {"eq", "ne", "gt", "gte", "lt", "lte", "in"}
SHAPES = {"circle", "ring", "square", "line", "dash", "fill", "pulse", "glyph", "size", "text"}
SCALES = {"interpolate", "step", "match"}
TOKENS = {"ink", "paper", "muted"}
_HEX = re.compile(r"^#[0-9a-fA-F]{6}$")

LAYER_DEFAULTS: dict[str, Any] = {
    "default": False,
    "borough_filter": True,
    "list": False,
    "detail": {"type": "none"},
    "lag_note": None,
    "empty_text": None,
    "filters": [],
    "raster": None,
    "changes": None,
}
REQUIRED = ("id", "label", "short", "group", "kind", "sources", "poll_s", "z", "attribution")


def is_color(v: Any) -> bool:
    return isinstance(v, str) and (v in TOKENS or bool(_HEX.match(v)))


@dataclass(frozen=True)
class Catalog:
    public: dict[str, Any]  # the /api/layers body
    layers: dict[str, dict[str, Any]]  # id -> filled LayerDef (public)
    classify: dict[str, dict[str, list[str]]]  # layer id -> group -> substrings (server-only)

    def without(self, layer_ids: set[str]) -> Catalog:
        """The catalog minus some layers (ADR-018: a keyed layer whose key isn't set)."""
        if not layer_ids:
            return self
        layers = {k: v for k, v in self.layers.items() if k not in layer_ids}
        public = {
            **self.public,
            "layers": [v for v in self.public["layers"] if v["id"] not in layer_ids],
        }
        classify = {k: v for k, v in self.classify.items() if k not in layer_ids}
        return Catalog(public=public, layers=layers, classify=classify)

    def server_filters(self, layer_id: str) -> dict[str, dict[str, Any]]:
        return {f["key"]: f for f in self.layers[layer_id]["filters"] if f["apply"] == "server"}

    def server_filter_values(self, layer_id: str, given: dict[str, str]) -> dict[str, str]:
        """Server filter values with defaults; raises ValueError on unknown keys or values."""
        defs = self.server_filters(layer_id)
        out = {k: str(f["default"]) for k, f in defs.items()}
        for k, v in given.items():
            f = defs.get(k)
            if f is None:
                raise ValueError(f"unknown filter f.{k} for layer {layer_id!r}")
            allowed = [str(o["value"]) for o in f.get("options") or []]
            if allowed and v not in allowed:
                raise ValueError(f"f.{k} must be one of {allowed}, got {v!r}")
            out[k] = v
        return out


def load_catalog(path: Path = DEFAULT_LAYERS, registry_ids: set[str] | None = None) -> Catalog:
    raw = yaml.safe_load(path.read_text(encoding="utf-8"))
    problems: list[str] = []
    if raw.get("version") != 1:
        problems.append("version must be 1")
    groups = {g["id"] for g in raw.get("groups") or []}
    layers: dict[str, dict[str, Any]] = {}
    classify: dict[str, dict[str, list[str]]] = {}
    for spec in raw.get("layers") or []:
        layer = {**copy.deepcopy(LAYER_DEFAULTS), **copy.deepcopy(spec)}
        lid = layer.get("id", "?")
        p = [f"layer {lid}: {m}" for m in _layer_problems(layer, groups, registry_ids)]
        problems += p
        if lid in layers:
            problems.append(f"duplicate layer id {lid}")
        if layer.get("kind") == "raster":
            layer.update(borough_filter=False, list=False, filters=[], detail={"type": "none"})
            layer.setdefault("style", {"color": {"value": "muted"}})
        layer.setdefault("legend_title", layer.get("label"))
        layer["filters"] = [_fill_filter(f) for f in layer["filters"]]
        rules = layer.pop("classify", None)
        if rules:
            classify[lid] = {g: [s.lower() for s in subs] for g, subs in rules.items()}
        layers[lid] = layer
    if problems:
        raise ValueError("config/layers.yaml: " + "; ".join(problems))
    public = {
        "version": raw["version"],
        "basemaps": raw["basemaps"],
        "view": raw["view"],
        "boroughs": raw["boroughs"],
        "groups": raw["groups"],
        "layers": list(layers.values()),
    }
    return Catalog(public=public, layers=layers, classify=classify)


def _fill_filter(f: dict[str, Any]) -> dict[str, Any]:
    out = dict(f)
    if out.get("options"):
        out["options"] = [{**o, "value": str(o["value"])} for o in out["options"]]
    if out["type"] == "enum":
        out["default"] = [str(v) for v in out.get("default") or []]
    elif out["type"] == "select":
        out["default"] = str(out["default"])
    else:
        out["default"] = bool(out.get("default", False))
    return out


def _where_problems(w: Any, what: str) -> list[str]:
    if not isinstance(w, dict) or set(w) != {"prop", "op", "value"}:
        return [f"{what} must be {{prop, op, value}}"]
    return [] if w["op"] in OPS else [f"{what}.op {w['op']!r} unknown"]


def _scale_problems(s: Any, what: str, color: bool) -> list[str]:
    if not isinstance(s, dict):
        return [f"{what} must be a mapping"]
    out = []
    if "zoom" in s:
        return [] if isinstance(s["zoom"], list) else [f"{what}.zoom must be a list"]
    if "value" in s:
        values = [s["value"]]
    else:
        if s.get("scale") not in SCALES or "prop" not in s or not s.get("stops"):
            return [f"{what} needs value, zoom, or prop + scale + stops"]
        values = [y for _, y in s["stops"]] + [s[k] for k in ("base", "default") if k in s]
    for v in values:
        if color and not is_color(v):
            out.append(f"{what}: {v!r} is not #rrggbb or ink|paper|muted")
        if not color and not isinstance(v, int | float):
            out.append(f"{what}: {v!r} is not a number")
    return out


def _layer_problems(layer: dict, groups: set[str], registry_ids: set[str] | None) -> list[str]:
    p = [f"missing {k}" for k in REQUIRED if k not in layer]
    if p:
        return p
    if layer["kind"] not in KINDS:
        p.append(f"kind {layer['kind']!r} unknown")
    if layer["group"] not in groups:
        p.append(f"group {layer['group']!r} unknown")
    if len(layer["short"]) > 12:
        p.append("short is over 12 chars")
    if registry_ids is not None:
        p += [f"source {s!r} not in registry" for s in layer["sources"] if s not in registry_ids]
    a = layer["attribution"]
    if not (isinstance(a, dict) and a.get("text") and a.get("url")):
        p.append("attribution needs text and url")
    if not layer.get("legend"):
        p.append("legend is empty")
    for item in layer.get("legend") or []:
        if item.get("shape") not in SHAPES:
            p.append(f"legend shape {item.get('shape')!r} unknown")
        if "color" in item and not is_color(item["color"]):
            p.append(f"legend colour {item['color']!r} invalid")
    style = layer.get("style") or {}
    if layer["kind"] == "raster" and not style:
        style = {"color": {"value": "muted"}}
    if "color" not in style:
        p.append("style.color is required")
    else:
        p += _scale_problems(style["color"], "style.color", color=True)
    for k in ("radius", "width"):
        if k in style:
            p += _scale_problems(style[k], f"style.{k}", color=False)
    if isinstance(style.get("radius"), dict) and "zoom" in style["radius"]:
        # The client already scales point radii by zoom (styleToPaint ZOOM_FACTOR); a zoom
        # radius would nest one zoom curve in another, which MapLibre rejects (draws nothing).
        p.append("style.radius can't be a zoom scale: point radii are already scaled by zoom")
    for k in ("hollow", "pulse", "dash", "fade"):
        if k in style:
            p += _where_problems(style[k], f"style.{k}")
    if layer["kind"] == "raster":
        p += _raster_problems(layer)
    elif layer.get("raster") is not None:
        p.append("raster block is only for kind: raster")
    ch = layer.get("changes")
    if ch is not None:
        if layer["kind"] not in CHANGE_KINDS:
            p.append("changes is only for point or cluster layers")
        if not (
            isinstance(ch, dict)
            and set(ch) == {"props", "new"}
            and isinstance(ch["props"], list)
            and all(isinstance(x, str) for x in ch["props"])
            and isinstance(ch["new"], bool)
        ):
            p.append("changes must be {props: [str], new: bool}")
    detail = layer["detail"]
    if detail.get("type") not in {"entity", "event", "none"}:
        p.append("detail.type must be entity|event|none")
    for f in layer["filters"]:
        if f.get("type") not in FILTER_TYPES or f.get("apply") not in APPLY or "key" not in f:
            p.append(f"filter {f.get('key')!r}: needs key, type and apply")
            continue
        if f["type"] == "toggle":
            p += _where_problems(f.get("where"), f"filter {f['key']}.where")
        elif not f.get("options"):
            p.append(f"filter {f['key']}: needs options")
        if f["type"] == "enum" and f["apply"] == "client" and not f.get("prop"):
            p.append(f"filter {f['key']}: enum needs prop")
        if "default" not in f:
            p.append(f"filter {f['key']}: needs default")
    return p


def _raster_problems(layer: dict) -> list[str]:
    r = layer.get("raster")
    if not isinstance(r, dict) or set(r) != RASTER_KEYS:
        return [f"raster must have exactly {sorted(RASTER_KEYS)}"]
    p = []
    if not (isinstance(r["index_url"], str) and r["index_url"].startswith("https://")):
        p.append("raster.index_url must be https")
    if not all(f"{{{k}}}" in r["tiles"] for k in ("host", "path", "z", "x", "y")):
        p.append("raster.tiles needs {host}{path}{z}{x}{y}")
    if not (isinstance(r["frames"], str) and r["frames"]):
        p.append("raster.frames must be a dotted path")
    if r["tile_size"] not in (256, 512):
        p.append("raster.tile_size must be 256 or 512")
    if not isinstance(r["max_zoom"], int) or isinstance(r["max_zoom"], bool):
        p.append("raster.max_zoom must be an int")
    if not (isinstance(r["opacity"], int | float) and 0 <= r["opacity"] <= 1):
        p.append("raster.opacity must be 0..1")
    if not (isinstance(r["stale_s"], int | float) and r["stale_s"] > 0):
        p.append("raster.stale_s must be > 0")
    return p

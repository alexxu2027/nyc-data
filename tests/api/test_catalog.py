"""Group 1: the layer catalog and its builders."""

from nyclive.api.catalog import TOKENS, is_color, load_catalog
from nyclive.api.layers import BUILDERS
from nyclive.registry import load_registry

REG = load_registry()


def _colors(obj):
    """Every colour value in a style (scales: value, stops' outputs, base, default)."""
    if not isinstance(obj, dict):
        return
    if "zoom" in obj:
        return
    if "value" in obj and isinstance(obj["value"], str):
        yield obj["value"]
    for _, y in obj.get("stops") or []:
        yield y
    for k in ("base", "default"):
        if k in obj:
            yield obj[k]


def test_catalog_is_valid_and_complete():
    cat = load_catalog(registry_ids=set(REG.sources))
    layers = cat.public["layers"]
    ids = [layer["id"] for layer in layers]
    assert len(ids) >= 12
    assert len(set(ids)) == len(ids)
    built = {layer["id"] for layer in layers if layer["kind"] != "raster"}
    assert built == set(BUILDERS), "a builder for every non-raster id and no extras"
    for layer in layers:
        assert all(s in REG.sources for s in layer["sources"]), layer["id"]
        assert layer["legend"], layer["id"]
        assert layer["attribution"]["text"] and layer["attribution"]["url"], layer["id"]
        assert "classify" not in layer
        for c in _colors(layer["style"]["color"]):
            assert is_color(c), (layer["id"], c)
        for item in layer["legend"]:
            if "color" in item:
                assert is_color(item["color"]), (layer["id"], item)
    assert "complaints_311" in cat.classify
    assert TOKENS == {"ink", "paper", "muted"}


def test_api_layers_fills_defaults(client):
    body = client.get("/api/layers").json()
    assert body["version"] == 1
    assert {b["id"] for b in body["boroughs"]} == {"MN", "BK", "QN", "BX", "SI"}
    keys = {
        "id", "label", "short", "group", "kind", "sources", "default", "poll_s", "z",
        "borough_filter", "list", "detail", "attribution", "lag_note", "empty_text",
        "legend_title", "filters", "style", "legend", "raster", "changes",
    }  # fmt: skip
    for layer in body["layers"]:
        assert keys <= set(layer), keys - set(layer)
        assert "classify" not in layer
        for f in layer["filters"]:
            assert {"key", "label", "type", "apply", "default"} <= set(f)
    by_id = {layer["id"]: layer for layer in body["layers"]}
    assert by_id["boroughs"]["borough_filter"] is False
    assert by_id["cameras"]["list"] is False and by_id["subway_alerts"]["list"] is True
    assert by_id["citibike"]["lag_note"] is None

"""FastAPI app for the live map (plan Interfaces §2). Read-only over state.db and the archive.

`create_app(settings, now=..., layers_path=..., boroughs_path=..., web_dist=...)` builds the
app; `nyclive serve` runs it with uvicorn. With a built `web/dist`, the same process serves the
web app and falls back to index.html for client routes.
"""

from __future__ import annotations

import os
from collections.abc import Callable
from dataclasses import dataclass, field
from datetime import datetime
from pathlib import Path

from fastapi import FastAPI, Request
from fastapi.middleware.gzip import GZipMiddleware
from fastapi.responses import FileResponse, HTMLResponse

from nyclive.api import errors
from nyclive.api.cache import BodyCache, Entry, entry_for
from nyclive.api.catalog import DEFAULT_BOROUGHS, DEFAULT_LAYERS, Catalog, load_catalog
from nyclive.api.geo import BoroughIndex
from nyclive.api.layers import BUILDERS
from nyclive.api.layers.city import Classifier
from nyclive.api.tide import TideCache
from nyclive.registry import REPO_ROOT, Registry, load_registry
from nyclive.settings import Settings, load_settings
from nyclive.timeutil import now_utc

DEFAULT_WEB_DIST = REPO_ROOT / "web" / "dist"

BUILD_HINT = """<!doctype html><meta charset="utf-8"><title>NYC Live API</title>
<body style="font-family:monospace;max-width:60ch;margin:3em auto">
<p>NYC LIVE: the API is running, but the web app is not built.</p>
<p>Build it with <code>cd web &amp;&amp; npm ci &amp;&amp; npm run build</code>, then reload,
or run <code>npm run dev</code> for the dev server on port 5173.</p>
<p>API docs: <a href="/api/docs">/api/docs</a></p></body>"""


@dataclass
class Services:
    settings: Settings
    catalog: Catalog
    boroughs: BoroughIndex
    registry: Registry
    now: Callable[[], datetime]
    cache: BodyCache = field(default_factory=BodyCache)
    tide: TideCache = field(default_factory=TideCache)
    _classifiers: dict[str, Classifier] = field(default_factory=dict)
    _catalog_entry: Entry | None = None

    def classifier(self, layer_id: str) -> Classifier:
        c = self._classifiers.get(layer_id)
        if c is None:
            c = self._classifiers[layer_id] = Classifier(self.catalog.classify.get(layer_id, {}))
        return c

    def catalog_entry(self) -> Entry:
        if self._catalog_entry is None:
            self._catalog_entry = entry_for(self.catalog.public)
        return self._catalog_entry

    def layers_of(self, source: str) -> list[str]:
        return [lid for lid, d in self.catalog.layers.items() if source in d["sources"]]


def create_app(
    settings: Settings | None = None,
    *,
    now: Callable[[], datetime] = now_utc,
    layers_path: Path = DEFAULT_LAYERS,
    boroughs_path: Path = DEFAULT_BOROUGHS,
    web_dist: Path | None = DEFAULT_WEB_DIST,
) -> FastAPI:
    settings = settings or load_settings()
    registry = load_registry()
    catalog = load_catalog(layers_path, set(registry.sources))
    built = {lid for lid, d in catalog.layers.items() if d["kind"] != "raster"}
    missing = built ^ set(BUILDERS)
    if missing:
        raise ValueError(f"layers without a builder or builders without a layer: {missing}")
    # A layer fed only by keyed sources whose keys aren't set is left out (ADR-018), so a clone
    # without .env shows no empty Buses layer.
    catalog = catalog.without(
        {
            lid
            for lid, d in catalog.layers.items()
            if d["sources"]
            and not any(settings.has_key_for(registry.sources[s]) for s in d["sources"])
        }
    )
    services = Services(settings, catalog, BoroughIndex(boroughs_path), registry, now)

    app = FastAPI(
        title="NYC Live API",
        version="1",
        docs_url="/api/docs",
        openapi_url="/api/openapi.json",
        redoc_url=None,
    )
    app.state.services = services
    app.add_middleware(GZipMiddleware, minimum_size=1024, compresslevel=6)
    errors.install(app)

    from nyclive.api import (
        routes_changes,
        routes_entities,
        routes_events,
        routes_health,
        routes_layers,
    )

    for mod in (routes_health, routes_layers, routes_entities, routes_events, routes_changes):
        app.include_router(mod.router)
    _mount_web(app, web_dist)
    return app


def _mount_web(app: FastAPI, dist: Path | None) -> None:
    """Static files from web/dist with an index.html fallback; /api/* stays JSON."""
    root = dist.resolve() if dist is not None else None

    @app.get("/{path:path}", include_in_schema=False)
    def web(path: str, request: Request):
        if path == "api" or path.startswith("api/"):
            raise errors.not_found(f"no API route {request.url.path}")
        if root is None or not (root / "index.html").is_file():
            return HTMLResponse(BUILD_HINT)
        if path:
            target = (root / path).resolve()
            if target.is_file() and target.is_relative_to(root):
                return FileResponse(target)
        return FileResponse(root / "index.html", headers={"Cache-Control": "no-cache"})


def app_from_env() -> FastAPI:
    """Factory for `uvicorn --factory` (used by `nyclive serve --reload`)."""
    no_web = os.environ.get("NYCLIVE_NO_WEB") == "1"
    return create_app(web_dist=None if no_web else DEFAULT_WEB_DIST)

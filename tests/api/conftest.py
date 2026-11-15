"""Seed a temp data dir with the real pipeline, then build the API on it.

Every collected source runs once through `run_once` with a canned-fetch Adapter over
`tests/fixtures/<id>/real` (`nws_alerts/edge_no_ends` for an active polygon). Fixtures are
trimmed, so cross-source joins may not line up; small synthetic records are appended for a
resolvable and an unresolvable ref, a null-borough point, an NJ point, a zone-only NWS alert
and ids containing ':' and '/'.
"""

from __future__ import annotations

from dataclasses import replace
from datetime import UTC, datetime, timedelta
from pathlib import Path

import pytest
from fastapi.testclient import TestClient
from helpers import load_fixture

from nyclive.api.app import create_app
from nyclive.collect.pipeline import run_once
from nyclive.model import Entity, Event, Observation
from nyclive.registry import load_registry
from nyclive.settings import Settings
from nyclive.sources.base import Adapter, Batch, RawPayload, load_adapter
from nyclive.storage.state import StateStore

NOW = datetime(2026, 11, 15, 3, 30, tzinfo=UTC)
RAN_AT = NOW - timedelta(minutes=2)
REG = load_registry()
COLLECTED = sorted(s.id for s in REG.sources.values() if s.adapter)
CASES = {"nws_alerts": "edge_no_ends"}

# Synthetic ids
NULL_BK = "syn-null-bk"  # bike station in Brooklyn with no borough column
NJ = "syn-nj"  # bike station in Jersey City -> "XX"
CAM = "syn:cam/1"  # entity id with ':' and '/'
ZONE_ALERT = "syn-zone-alert"  # NWS alert with no polygon, only SAME codes
BAD_REF = "NOPE"
TIDE_PREDICTED = 5.0  # synthetic prediction 2 min after the newest fixture level


def first_id(source: str, kind: str) -> str:
    parse = load_adapter(REG.sources[source].adapter).parse
    return next(e.entity_id for e in parse(load_fixture(source)).entities if e.kind == kind)


def _extras(sid: str, batch: Batch, fetched: datetime) -> Batch:
    """Append synthetic records to a real fixture batch."""
    ents, obs, evs = [], [], []
    if sid == "citibike_gbfs":
        ents = [
            Entity(sid, "bike_station", NULL_BK, "Synthetic BK", 40.6782, -73.9442,
                   props={"capacity": 20}),
            Entity(sid, "bike_station", NJ, "Synthetic NJ", 40.7178, -74.0431,
                   props={"capacity": 30}),
        ]  # fmt: skip
    elif sid == "citibike_station_status":
        for eid, bikes, docks in ((NULL_BK, 0.0, 20.0), (NJ, 2.0, 28.0)):
            for metric, v in (
                ("bikes_available", bikes),
                ("ebikes_available", 0.0),
                ("docks_available", docks),
                ("is_renting", 1.0),
            ):
                obs.append(Observation(sid, "bike_station", eid, metric, fetched, v, fetched))
    elif sid == "dot_cameras":
        ents = [
            Entity(sid, "camera", CAM, "Synthetic cam", 40.75, -73.98, borough="MN",
                   props={"imageUrl": "https://example.invalid/cam.jpg", "isOnline": False}),
        ]  # fmt: skip
    elif sid == "mta_subway_alerts":
        station = first_id("mta_subway_stations", "subway_station")
        evs = [
            Event(sid, "syn:alert:ok", "service_alert", "Synthetic delay", NOW - timedelta(hours=1),
                  subtype="Delays", severity=2,
                  entity_refs=("subway_route:A", f"subway_station:{station}"),
                  props={"description": "x" * 900}),
            Event(sid, "syn:alert:bad", "service_alert", "Synthetic lost", NOW - timedelta(hours=1),
                  subtype="Delays", severity=1, entity_refs=(f"subway_station:{BAD_REF}",)),
        ]  # fmt: skip
    elif sid == "mta_elevator_outages":
        station = first_id("mta_subway_stations", "subway_station")
        evs = [
            Event(sid, "SYN/1:2026", "elevator_outage", "Synthetic outage", NOW - timedelta(days=1),
                  subtype="EL", entity_refs=("elevator:SYN1", f"subway_station:{station}"),
                  props={"ADA": True, "upcoming": False, "est_return": "2026-11-16T10:00:00+00:00",
                         "reason": "Repair"}),
            Event(sid, "SYN2:2026", "elevator_outage", "Synthetic lost outage",
                  NOW - timedelta(days=1), subtype="ES",
                  entity_refs=("elevator:SYN2", f"subway_station:{BAD_REF}"),
                  props={"ADA": False, "upcoming": False}),
        ]  # fmt: skip
    elif sid == "floodnet_events":
        sensor = first_id("floodnet_sensors", "flood_sensor")
        newest = max(e.starts_at for e in batch.events)
        evs = [
            Event(sid, f"{sensor}:syn", "flood", "Synthetic flood", newest - timedelta(hours=1),
                  ends_at=newest - timedelta(minutes=30), severity=2,
                  entity_refs=(f"flood_sensor:{sensor}",),
                  props={"max_depth_inches": 7.5, "duration_mins": 30.0}),
            Event(sid, "syn:lost-flood", "flood", "Synthetic lost flood",
                  newest - timedelta(hours=2), ends_at=newest - timedelta(hours=1), severity=1,
                  entity_refs=(f"flood_sensor:{BAD_REF}",), props={"max_depth_inches": 2.0}),
        ]  # fmt: skip
    elif sid == "noaa_tide_battery":
        # The trimmed fixture's levels end a day before its predictions start: add predictions
        # around the newest level (one within ±6 min, one decoy outside it).
        levels = [o for o in batch.observations if o.metric == "water_level_ft"]
        t = max(o.observed_at for o in levels)
        for dt, v in ((timedelta(minutes=2), TIDE_PREDICTED), (timedelta(minutes=-9), 9.9)):
            obs.append(
                Observation(sid, "tide_gauge", "8518750", "predicted_ft", t + dt, v, fetched)
            )
    elif sid == "nws_alerts":
        evs = [
            Event(sid, ZONE_ALERT, "weather_alert", "Synthetic wind advisory",
                  NOW - timedelta(hours=1), ends_at=NOW + timedelta(hours=6),
                  subtype="Wind Advisory", severity=2,
                  props={"areaDesc": "Kings; Queens", "nyc_same": ["036047", "036081"],
                         "instruction": "Secure loose objects."}),
        ]  # fmt: skip
    return replace(
        batch,
        entities=batch.entities + ents,
        observations=batch.observations + obs,
        events=batch.events + evs,
    )


def canned(sid: str, raw: RawPayload, extras: bool = True, tweak=None) -> Adapter:
    parse = load_adapter(REG.sources[sid].adapter).parse

    def do_parse(r: RawPayload) -> Batch:
        b = parse(r)
        b = _extras(sid, b, r.fetched_at) if extras else b
        return tweak(b) if tweak else b

    return Adapter("canned", (sid,), lambda ctx: raw, do_parse)


def seed(
    data_dir: Path,
    sources=COLLECTED,
    ran_at: datetime = RAN_AT,
    extras: bool = True,
    cases: dict[str, str] | None = None,
    tweak=None,
) -> Settings:
    """Run each source once through the real pipeline into `data_dir`; close the store."""
    settings = Settings(data_dir=data_dir, user_agent="t")
    cases = {**CASES, **(cases or {})}
    with StateStore(settings.state_db) as store:
        for sid in sources:
            raw = load_fixture(sid, cases.get(sid, "real"))
            r = run_once(
                REG.sources[sid],
                canned(sid, raw, extras, tweak),
                None,
                store,
                settings.archive_dir,
                now=lambda: ran_at,
            )
            assert r.ok, (sid, r.error)
    return settings


@pytest.fixture(scope="session")
def data_dir(tmp_path_factory) -> Path:
    d = tmp_path_factory.mktemp("apidata")
    seed(d)
    return d


@pytest.fixture(scope="session")
def settings(data_dir) -> Settings:
    return Settings(data_dir=data_dir, user_agent="t")


@pytest.fixture(scope="session")
def client(settings) -> TestClient:
    return TestClient(create_app(settings, now=lambda: NOW, web_dist=None))

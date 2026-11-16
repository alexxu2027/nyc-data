"""FloodNet live depth (floodnet_live): the FieldKit API behind the FloodNet dashboard.

ADR-010 (FloodNet team OK'd polling 2026-11-16): every 30 min, 25 stations per request, depth
only. Each tail response carries the last 48 h as 864 s buckets (avg/min/max/last), so a missed
run loses nothing. Observations are change-only downstream.

Parts: `stations` (GET api.fieldkit.org/projects/174/stations), `sensors-000...` (Open Data
kb2e-tjy3: id, name, lat/lon) and `tail-000...` (GET /sensors/data/tail?stations=<ids>).

Quirks:
- FieldKit station ids are not Open Data sensor ids (and names collide), so parse joins them by
  coordinates: OD sensors within 30 m, an equal normalised name first, then the nearest, greedy
  and one-to-one. Observations and events are keyed by the Open Data sensor id, so they land on
  the existing `flood_sensor` entities.
- Sensor 44 is `wh.floodnet.depth` (inches); other sensor ids in a tail are ignored.
- Hidden and retired stations are not polled.
- Episodes (events) are derived from the 48 h window: see `_episodes`.
"""

from __future__ import annotations

import json
import logging
import math
import time
from datetime import datetime, timedelta

from nyclive.model import Event, Observation, borough_code
from nyclive.sources import _socrata
from nyclive.sources.base import Batch, FetchContext, RawPart, RawPayload
from nyclive.sources.floodnet import SENSORS_URL, _severity
from nyclive.timeutil import from_epoch

SOURCE_IDS = ("floodnet_live",)
log = logging.getLogger(__name__)

STATIONS_URL = "https://api.fieldkit.org/projects/174/stations"
TAIL_URL = "https://api.fieldkit.org/sensors/data/tail"
BATCH = 25  # stations per tail request (50 took 15.0-15.2 s of the 25 s timeout on 2026-11-16)
DEPTH_SENSOR_ID = 44
BUCKET_S = 864
WET_IN = 1.0
PEAK_IN = 2.0
MAX_DRY_GAP = 2  # dry buckets that still merge two wet runs into one episode
JOIN_M = 30.0
MIN_MATCH_RATIO = 0.5
FUTURE_SLACK = timedelta(minutes=5)
WINDOW = timedelta(hours=48)
STALE_OPEN = timedelta(hours=2)  # an episode is only "open" while its sensor still reports


# ---------------------------------------------------------------------------------- fetch
def _station_lat_lon(st: dict) -> tuple[float, float] | None:
    precise = (st.get("location") or {}).get("precise")
    if isinstance(precise, list) and len(precise) == 2:
        try:
            lon, lat = float(precise[0]), float(precise[1])
        except (TypeError, ValueError):
            return None
        if math.isfinite(lat) and math.isfinite(lon) and not (lat == 0 and lon == 0):
            return lat, lon
    return None


def _is_active(st: dict) -> bool:
    if st.get("hidden") or str(st.get("status") or "").lower() == "retired":
        return False
    attrs = (st.get("attributes") or {}).get("attributes") or []
    if any(isinstance(a, dict) and a.get("name") == "Date Retired" for a in attrs):
        return False
    return isinstance(st.get("id"), int) and _station_lat_lon(st) is not None


def fetch(ctx: FetchContext) -> RawPayload:
    r = ctx.http.get(STATIONS_URL)
    parts = [RawPart("stations", str(r.url), r.content, ctx.now)]
    parts += _socrata.fetch_pages(
        ctx,
        SENSORS_URL,
        select=("sensor_id", "sensor_name", "latitude", "longitude"),
        order="sensor_id",
        prefix="sensors",
        max_pages=2,
    )
    listed = json.loads(r.content).get("stations")
    if not isinstance(listed, list):
        raise ValueError("floodnet_live: stations response has no 'stations' list")  # noqa: TRY004
    ids = sorted(st["id"] for st in listed if isinstance(st, dict) and _is_active(st))
    for i in range(0, len(ids), BATCH):
        t0 = time.monotonic()
        t = ctx.http.get(TAIL_URL, params={"stations": ",".join(map(str, ids[i : i + BATCH]))})
        log.info(
            "floodnet_live: tail %d took %.1f s (%d KB)",
            i // BATCH,
            time.monotonic() - t0,
            len(t.content) // 1024,
        )
        parts.append(RawPart(f"tail-{i // BATCH:03d}", str(t.url), t.content, ctx.now))
    return RawPayload(ctx.source.id, tuple(parts), cursor=ctx.cursor)


# ---------------------------------------------------------------------------------- join
def _norm(name: object) -> str:
    s = str(name or "").lower().replace("(retired)", "")
    return " ".join(s.split())


def _metres(a: tuple[float, float], b: tuple[float, float]) -> float:
    dlat = math.radians(b[0] - a[0])
    dlon = math.radians(b[1] - a[1]) * math.cos(math.radians((a[0] + b[0]) / 2))
    return 6371000.0 * math.hypot(dlat, dlon)


def _float(v: object) -> float | None:
    try:
        x = float(v)  # type: ignore[arg-type]
    except (TypeError, ValueError):
        return None
    return x if math.isfinite(x) else None


def _active_stations(raw: RawPayload) -> list[dict]:
    body = raw.json("stations")
    listed = body.get("stations") if isinstance(body, dict) else None
    if not isinstance(listed, list) or not listed:
        raise ValueError("floodnet_live: stations response has no 'stations' list")
    return [st for st in listed if isinstance(st, dict) and _is_active(st)]


def _od_sensors(raw: RawPayload) -> dict[str, dict]:
    out: dict[str, dict] = {}
    for r in _socrata.rows(raw, "sensors"):
        if not isinstance(r, dict):
            raise ValueError("floodnet_live: sensors pages must be JSON lists of objects")  # noqa: TRY004
        sid = str(r.get("sensor_id") or "").strip()
        lat, lon = _float(r.get("latitude")), _float(r.get("longitude"))
        if sid and lat is not None and lon is not None and sid not in out:
            out[sid] = {"name": str(r.get("sensor_name") or sid), "lat": lat, "lon": lon}
    return out


def join_stations(stations: list[dict], sensors: dict[str, dict]) -> dict[int, str]:
    """FieldKit station id -> Open Data sensor id. Greedy and one-to-one; raises if < half match."""
    pairs: list[tuple[bool, float, int, str]] = []
    for st in stations:
        pos = _station_lat_lon(st)
        if pos is None:
            continue
        for sid, s in sensors.items():
            d = _metres(pos, (s["lat"], s["lon"]))
            if d <= JOIN_M:
                same = _norm(st.get("name")) == _norm(s["name"])
                pairs.append((not same, d, st["id"], sid))
    pairs.sort()
    matched: dict[int, str] = {}
    used: set[str] = set()
    for _, _, station_id, sid in pairs:
        if station_id not in matched and sid not in used:
            matched[station_id] = sid
            used.add(sid)
    if not matched or len(matched) < MIN_MATCH_RATIO * len(stations):
        raise ValueError(
            f"floodnet_live: only {len(matched)} of {len(stations)} FieldKit stations match an "
            "Open Data sensor within 30 m; the coordinates or sensor list changed"
        )
    return matched


# ---------------------------------------------------------------------------------- parse
def _tail_rows(raw: RawPayload) -> list[dict]:
    rows: list[dict] = []
    for p in sorted((p for p in raw.parts if p.name.startswith("tail-")), key=lambda p: p.name):
        body = json.loads(p.content)
        data = body.get("data") if isinstance(body, dict) else None
        if not isinstance(data, list):
            raise ValueError(f"floodnet_live: {p.name} has no 'data' list")  # noqa: TRY004
        rows += [r for r in data if isinstance(r, dict)]
    return rows


def parse(raw: RawPayload) -> Batch:
    stations = _active_stations(raw)
    sensors = _od_sensors(raw)
    match = join_stations(stations, sensors)
    fetched = raw.fetched_at
    newest_ok = fetched + FUTURE_SLACK
    oldest_ok = fetched - WINDOW - timedelta(hours=1)  # stale sensors replay old buckets

    series: dict[str, dict[datetime, float]] = {}  # od sensor id -> {bucket time: max depth}
    for r in _tail_rows(raw):
        if r.get("sensorId") != DEPTH_SENSOR_ID:
            continue
        sid = match.get(r.get("stationId"))  # type: ignore[arg-type]
        t, depth = _float(r.get("time")), _float(r.get("max"))
        if sid is None or t is None or depth is None:
            continue
        when = from_epoch(t, "ms")
        if when > newest_ok or when < oldest_ok:
            continue
        series.setdefault(sid, {})[when] = round(max(depth, 0.0), 1)

    # Complete for events once any sensor answered: an open episode that is no longer emitted
    # (it outgrew the window, or its station stopped being polled) is closed instead of staying
    # "flooding" for up to 45 days (review 2026-11-16, #5). An all-empty answer closes nothing.
    batch = Batch(complete=frozenset({"events"}) if series else frozenset())
    for sid in sorted(series):
        buckets = sorted(series[sid].items())
        for when, depth in buckets:
            batch.observations.append(
                Observation("floodnet_live", "flood_sensor", sid, "depth_in", when, depth, fetched)
            )
        batch.events += _episodes(sid, sensors[sid], buckets, fetched)
    return batch


def _episodes(
    sid: str, od: dict, buckets: list[tuple[datetime, float]], fetched: datetime
) -> list[Event]:
    """Flood episodes in one sensor's 48 h series (ascending (time, max_in) buckets).

    wet = max >= 1 in; up to 2 dry buckets merge two wet runs; an episode needs a 2 in peak or
    2+ wet buckets. It is open (ends_at None) while the newest bucket is wet and recent, else it
    ends one bucket after the last wet one. Episodes that may have begun before the oldest
    bucket seen are skipped: that is anything within MAX_DRY_GAP + 1 buckets of it, since the
    wet run before the gap may have slid out of the window (review 2026-11-16, #4: the tail of
    a merged flood came back two days later as a "new" episode with a new id).
    """
    step = timedelta(seconds=BUCKET_S)
    wet = [i for i, (_, d) in enumerate(buckets) if d >= WET_IN]
    if not wet:
        return []
    runs: list[list[int]] = [[wet[0]]]
    for i in wet[1:]:
        gap = round((buckets[i][0] - buckets[runs[-1][-1]][0]).total_seconds() / BUCKET_S) - 1
        if gap <= MAX_DRY_GAP:
            runs[-1].append(i)
        else:
            runs.append([i])
    window_start = fetched - WINDOW + step
    events = []
    for run in runs:
        first, last = buckets[run[0]][0], buckets[run[-1]][0]
        lookback = first - (MAX_DRY_GAP + 1) * step  # the earliest bucket that could merge in
        if run[0] == 0 or first <= window_start or lookback < buckets[0][0]:
            continue  # may have started before the window: its true start (and id) is unknown
        peak = max(buckets[i][1] for i in run)
        if peak < PEAK_IN and len(run) < 2:
            continue  # one shallow reading is noise
        is_open = run[-1] == len(buckets) - 1 and fetched - last <= STALE_OPEN
        events.append(
            Event(
                source="floodnet_live",
                event_id=f"{sid}:{first.isoformat()}",
                category="flood",
                title=f"Flooding at {od['name']}, {peak:g} in",
                starts_at=first,
                ends_at=None if is_open else last + step,
                severity=_severity(peak),
                lat=od["lat"],
                lon=od["lon"],
                borough=borough_code(sid.split("-", 1)[0]),
                entity_refs=(f"flood_sensor:{sid}",),
                props={"max_depth_in": peak, "live": True},
            )
        )
    return events

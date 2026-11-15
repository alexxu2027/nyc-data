"""Tide gauge derived values: prediction at the observation time, surge, trend, next high/low.

`latest.predicted_ft` holds the newest prediction, about 24 h AHEAD, so the prediction for the
current reading comes from the archive (nearest within ±6 min of the latest water-level time).
Cached 300 s per reading; any archive failure gives nulls, never an error.
"""

from __future__ import annotations

import logging
import sqlite3
import threading
from datetime import datetime, timedelta
from pathlib import Path
from typing import Any

from nyclive.api.layers.common import iso, parse_ts
from nyclive.storage import query

log = logging.getLogger(__name__)

SOURCE = "noaa_tide_battery"
KIND = "tide_gauge"
TOLERANCE = timedelta(minutes=6)
TREND_LAG = timedelta(minutes=30)
TREND_FT = 0.05
TTL_S = 300.0

EMPTY = {"predicted_ft": None, "surge_ft": None, "trend": None, "next_high": None, "next_low": None}


class TideCache:
    def __init__(self) -> None:
        self._lock = threading.Lock()
        self._items: dict[tuple, tuple[float, dict]] = {}

    def get(
        self, archive_dir: Path, entity_id: str, level: float, observed_at: str, now: datetime
    ) -> dict[str, Any]:
        key = (entity_id, observed_at, level)
        now_s = now.timestamp()
        with self._lock:
            hit = self._items.get(key)
            if hit and 0 <= now_s - hit[0] < TTL_S:
                return hit[1]
        try:
            value = derive(archive_dir, entity_id, level, parse_ts(observed_at), now)
        except Exception as e:  # noqa: BLE001 - degrade to nulls (plan §2.3 "Tide")
            log.warning("tide: archive read failed: %s", e)
            value = dict(EMPTY)
        with self._lock:
            self._items = {k: v for k, v in self._items.items() if now_s - v[0] < TTL_S}
            self._items[key] = (now_s, value)
        return value


def _extremes(points: list[tuple[datetime, float]], now: datetime) -> tuple[dict | None, ...]:
    high = low = None
    for (_, a), (t, b), (_, c) in zip(points, points[1:], points[2:], strict=False):
        if t <= now:
            continue
        if high is None and b > a and b >= c:
            high = {"at": iso(t), "ft": round(b, 3)}
        if low is None and b < a and b <= c:
            low = {"at": iso(t), "ft": round(b, 3)}
        if high and low:
            break
    return high, low


def derive(
    archive_dir: Path, entity_id: str, level: float, at: datetime, now: datetime
) -> dict[str, Any]:
    if not archive_dir.is_dir():
        return dict(EMPTY)
    pred = query.value_at(
        archive_dir, SOURCE, KIND, entity_id, "predicted_ft", at, tolerance=TOLERANCE
    )
    predicted = round(pred[1], 3) if pred else None
    earlier = query.value_at(archive_dir, SOURCE, KIND, entity_id, "water_level_ft", at - TREND_LAG)
    trend = None
    if earlier is not None and at - earlier[0] <= TREND_LAG + TOLERANCE:
        d = level - earlier[1]
        trend = "rising" if d > TREND_FT else "falling" if d < -TREND_FT else "steady"
    ahead = query.series(
        archive_dir, SOURCE, KIND, entity_id, ["predicted_ft"], now, now + timedelta(hours=26), now
    )["predicted_ft"]
    high, low = _extremes(ahead, now)
    return {
        "predicted_ft": predicted,
        "surge_ft": None if predicted is None else round(level - predicted, 3),
        "trend": trend,
        "next_high": high,
        "next_low": low,
    }


def tide_for(services, conn: sqlite3.Connection, entity_id: str, now: datetime) -> dict[str, Any]:
    """Level, observed_at and the derived values for one gauge (nulls when unknown)."""
    row = conn.execute(
        "SELECT value, observed_at FROM latest WHERE kind = ? AND entity_id = ?"
        " AND metric = 'water_level_ft'",
        (KIND, entity_id),
    ).fetchone()
    if row is None:
        return {"water_level_ft": None, "observed_at": None, **EMPTY}
    level, observed = row
    d = services.tide.get(services.settings.archive_dir, entity_id, level, observed, now)
    return {"water_level_ft": round(level, 3), "observed_at": iso(observed), **d}

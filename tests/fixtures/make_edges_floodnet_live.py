"""Regenerate the hand-derived edge_* and bad_* cases for floodnet_live from its real case.

    uv run python tests/fixtures/make_edges_floodnet_live.py

Every case copies `real` (parts stations, sensors-000, tail-000) with documented changes (see
each case's meta.json note). Series are synthesised on the real station ids and the real last
bucket time, so they stay inside the 48 h window of the capture.
"""

from __future__ import annotations

import json
from dataclasses import replace
from pathlib import Path

from nyclive.sources.base import RawPayload

HERE = Path(__file__).parent
SOURCE = "floodnet_live"
STEP_MS = 864_000
END_MS = 1_794_812_256_000  # newest bucket of the real capture (about 1 h before it was taken)
UTOPIA, DITMARS, QUINCY, BLAKE, WINTHROP = 420, 398, 336, 341, 340


def dump(o) -> bytes:
    return json.dumps(o, separators=(",", ":"), ensure_ascii=False).encode()


def series(station: int, values: list, end_ms: int = END_MS) -> list[dict]:
    """One depth row per value, ascending, the last one at `end_ms`. None = missing bucket."""
    n = len(values)
    return [
        {
            "time": end_ms - (n - 1 - i) * STEP_MS,
            "stationId": station,
            "sensorId": 44,
            "avg": v,
            "min": v,
            "max": v,
            "last": v,
        }
        for i, v in enumerate(values)
        if v is not None
    ]


def derive(case: str, note: str, tail=None, stations=None, sensors=None) -> None:
    raw = RawPayload.load(HERE / SOURCE / "real")
    parts = []
    for p in raw.parts:
        if p.name == "tail-000" and tail is not None:
            body = json.loads(p.content)
            body["data"] = tail
            p = replace(p, content=dump(body))
        elif p.name == "stations" and stations is not None:
            p = replace(p, content=dump(stations(json.loads(p.content))))
        elif p.name == "sensors-000" and sensors is not None:
            p = replace(p, content=dump(sensors(json.loads(p.content))))
        parts.append(p)
    replace(raw, parts=tuple(parts)).save(HERE / SOURCE / case, note=note)


DRY = [0.0] * 10

# ----------------------------------------------------------------------------- episodes
episodes = (
    # Utopia: 1.2, 2.6, 1.1, two dry, 1.4 merge into one episode (peak 2.6), closed
    series(UTOPIA, DRY * 3 + [1.2, 2.6, 1.1, 0.0, 0.0, 1.4] + DRY)
    # Ditmars: a lone 1.5 reading (noise, skipped), a lone 2.4 (kept), then two wet runs split
    # by 3 dry buckets (two episodes)
    + series(DITMARS, DRY + [1.5] + DRY + [2.4] + DRY + [1.2, 1.3, 0.0, 0.0, 0.0, 1.1, 1.2] + DRY)
    # Quincy: newest bucket is wet, so the episode is open
    + series(QUINCY, DRY * 3 + [0.4, 1.1, 2.0, 3.5, 4.2])
    # Blake: wet from the first bucket of the window, so it is skipped
    + series(BLAKE, [1.5, 2.5, 3.0, 2.2, 1.0] + DRY * 3)
    # Winthrop: wet when the sensor went quiet 5 h before the fetch, so it is closed, not open
    + series(WINTHROP, DRY * 2 + [1.1, 1.8, 2.2], end_ms=END_MS - 20 * STEP_MS)
)
derive(
    "edge_episodes",
    "synthetic series on real stations, real last bucket: 420 [1.2,2.6,1.1,0,0,1.4] merges into "
    "one episode (peak 2.6); 398 lone 1.5 (skipped), lone 2.4 (kept), 1.2/1.3 + 3 dry + 1.1/1.2 "
    "(two episodes); 336 newest bucket wet (open); 341 wet from the first bucket (skipped); 340 "
    "last bucket wet but 5 h before capture (closed)",
    tail=episodes,
)

# ------------------------------------------------------------------------ odd values
odd = series(UTOPIA, DRY * 2 + [0.3, 2.5, 3.1])
odd += [
    {**odd[-1], "sensorId": 12, "max": 9.9, "time": END_MS},  # not the depth sensor
    {**odd[-1], "max": None, "time": END_MS - 7 * STEP_MS - 1},  # no value
    {**odd[-1], "max": "n/a", "time": END_MS - 8 * STEP_MS - 1},
    {**odd[-1], "max": -0.4, "time": END_MS - 9 * STEP_MS - 1},  # clamped to 0.0
    {**odd[-1], "max": 6.0, "time": END_MS + 3_600_000},  # an hour in the future: dropped
    {**odd[-1], "max": 5.0, "time": 1_697_037_696_000},  # 2023: older than the window, dropped
    {**odd[-1], "max": 3.7, "time": END_MS},  # same bucket again: the later row wins
    {**odd[-1], "stationId": 99999, "time": END_MS},  # not a project station
]
derive(
    "edge_odd_values",
    "real station 420, five buckets plus: a sensorId 12 row, max null and 'n/a', max -0.4 "
    "(clamped to 0.0), a row 1 h in the future and a 2023 row (both dropped), a repeated final "
    "bucket (3.7 replaces 3.1) and an unknown stationId",
    tail=odd,
)


# ----------------------------------------------------------------------------- stations
def odd_stations(body):
    first = body["stations"][0]
    far = {**first, "id": 9001, "name": "NOWHERE - far from every sensor"}
    far["location"] = {"precise": [-73.5, 40.9]}
    hidden = {**first, "id": 9002, "name": "hidden", "hidden": True}
    hidden["location"] = {"precise": [-73.6, 40.9]}
    retired = {**first, "id": 9003, "name": "retired", "status": "retired"}
    retired["location"] = {"precise": [-73.7, 40.9]}
    dated = {**first, "id": 9004, "name": "dated"}
    dated["attributes"] = {"attributes": [{"name": "Date Retired", "stringValue": "2025-01-01"}]}
    dated["location"] = {"precise": [-73.8, 40.9]}
    nowhere = {k: v for k, v in first.items() if k != "location"} | {"id": 9005}
    body["stations"] += [far, hidden, retired, dated, nowhere]
    return body


derive(
    "edge_odd_stations",
    "real plus five stations: 9001 active with no Open Data sensor within 30 m (unmatched, "
    "ignored), 9002 hidden, 9003 status retired, 9004 with a Date Retired attribute, 9005 with "
    "no location (none of the last four are active)",
    stations=odd_stations,
)

# ----------------------------------------------------------------------------- rejected
derive(
    "bad_stations_shape",
    "stations part is an object with 'stations' as a string, not a list",
    stations=lambda body: {"stations": "maintenance"},
)
derive(
    "bad_no_match",
    "every Open Data sensor moved 0.01 degrees north (about 1.1 km): no station joins",
    sensors=lambda rows: [{**r, "latitude": str(float(r["latitude"]) + 0.01)} for r in rows],
)

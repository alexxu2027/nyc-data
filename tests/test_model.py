from datetime import UTC, datetime, timedelta, timezone

import pyarrow as pa
import pytest

from nyclive.model import (
    BOROUGHS,
    SCHEMAS,
    Entity,
    Event,
    Observation,
    borough_code,
    record_problems,
)

T = datetime(2026, 11, 14, 18, 0, tzinfo=UTC)


@pytest.mark.parametrize(
    "raw, code",
    [
        ("Manhattan", "MN"),
        ("MANHATTAN", "MN"),
        ("New York", "MN"),
        ("M", "MN"),
        ("Bk", "BK"),
        ("Kings", "BK"),
        ("  queens ", "QN"),
        ("Q", "QN"),
        ("Bx", "BX"),
        ("The Bronx", "BX"),
        ("036005", "BX"),
        ("Staten  Island", "SI"),
        ("Richmond", "SI"),
        ("36085", "SI"),
        ("MN", "MN"),
        ("", None),
        ("Unspecified", None),
        (None, None),
    ],
)
def test_borough_code(raw, code):
    assert borough_code(raw) == code


def test_valid_records_have_no_problems():
    e = Entity(
        "noaa_tide_battery",
        "tide_gauge",
        "8518750",
        "The Battery",
        40.7006,
        -74.0142,
        borough="MN",
        props={"datum": "MLLW"},
    )
    o = Observation("noaa_tide_battery", "tide_gauge", "8518750", "water_level_ft", T, 2.68, T)
    ev = Event(
        "nws_alerts",
        "urn:1",
        "weather_alert",
        "Flood Watch",
        T,
        T + timedelta(hours=6),
        severity=2,
        entity_refs=("subway_station:A27", "subway_route:A"),
    )
    for r in (e, o, ev):
        assert record_problems(r) == [], r


@pytest.mark.parametrize(
    "record, expected",
    [
        (Entity("s", "spaceship", "1", "x", None, None), "kind"),
        (Entity("s", "camera", "1", "x", -74.0, 40.7), "outside the NYC bounding box"),
        (Entity("s", "camera", "1", "x", 40.7, None), "both be set"),
        (Entity("s", "camera", "1", "x", None, None, borough="Manhattan"), "borough"),
        (Entity("s", "camera", "1", "", None, None), "name"),
        (Entity("s", "camera", "1", "x", None, None, props={"t": T}), "JSON"),
        (Entity("s", "camera", "1", "x", None, None, props={"x": "y" * 5000}), "bytes"),
        (Observation("s", "camera", "1", "speed_kph", T, 1.0, T), "metric"),
        (Observation("s", "camera", "1", "count_car", T, 3, T), "finite float"),
        (Observation("s", "camera", "1", "count_car", T, float("nan"), T), "finite float"),
        (
            Observation("s", "camera", "1", "count_car", T.replace(tzinfo=None), 1.0, T),
            "observed_at",
        ),
        (
            Observation(
                "s", "camera", "1", "count_car", T.astimezone(timezone(timedelta(hours=-5))), 1.0, T
            ),
            "observed_at",
        ),
        (Event("s", "1", "party", "x", T), "category"),
        (Event("s", "1", "flood", "x", T, T - timedelta(1)), "before"),
        (Event("s", "1", "flood", "x", T, severity=4), "severity"),
        (Event("s", "1", "flood", "x", T, severity=True), "severity"),
        (Event("s", "1", "flood", "x", T, entity_refs=["camera:1"]), "tuple"),
        (Event("s", "1", "flood", "x", T, entity_refs=("A27",)), "entity_ref"),
        (Event("s", "1", "flood", "x", T, entity_refs=("planet:1",)), "entity_ref"),
    ],
)
def test_record_problems_catch_mistakes(record, expected):
    problems = record_problems(record)
    assert any(expected in p for p in problems), problems


def test_arrow_schemas_are_utc_and_cover_every_record_field():
    for table, cls in (("entities", Entity), ("observations", Observation), ("events", Event)):
        names = set(SCHEMAS[table].names)
        assert set(cls.__dataclass_fields__) <= names, table
        for f in SCHEMAS[table]:
            if pa.types.is_timestamp(f.type):
                assert f.type.tz == "UTC", f.name
    assert BOROUGHS == ("MN", "BK", "QN", "BX", "SI")

from datetime import UTC, datetime, timedelta, timezone

import pytest

from nyclive.timeutil import ensure_utc, from_epoch, local_to_utc, parse_iso_utc, to_ny


def utc(*a):
    return datetime(*a, tzinfo=UTC)


@pytest.mark.parametrize(
    "s, expected",
    [
        ("2026-11-14T18:12:06Z", utc(2026, 11, 14, 18, 12, 6)),
        ("2026-11-14T13:12:06-05:00", utc(2026, 11, 14, 18, 12, 6)),
        ("2026-11-14T18:12:06.123+00:00", utc(2026, 11, 14, 18, 12, 6, 123000)),
    ],
)
def test_parse_iso_utc(s, expected):
    got = parse_iso_utc(s)
    assert got == expected
    assert got.tzinfo is UTC


def test_parse_iso_utc_rejects_naive():
    with pytest.raises(ValueError, match="local_to_utc"):
        parse_iso_utc("2026-11-14T18:12:06.000")


def test_from_epoch_units():
    assert from_epoch(1_763_150_000) == utc(2025, 11, 14, 19, 53, 20)
    assert from_epoch("1763150000000", unit="ms") == utc(2025, 11, 14, 19, 53, 20)
    with pytest.raises(ValueError):
        from_epoch(float("nan"))
    with pytest.raises(ValueError):
        from_epoch(1, unit="days")


def test_local_to_utc_socrata_iso():
    # Socrata data_as_of: NY local, no offset. Nov 14 is EST (UTC-5).
    assert local_to_utc("2026-11-14T18:12:06.000") == utc(2026, 11, 14, 23, 12, 6)


def test_local_to_utc_mta_format_summer():
    # MTA elevator style; July is EDT (UTC-4).
    got = local_to_utc("07/04/2026 10:00:00 PM", "%m/%d/%Y %I:%M:%S %p")
    assert got == utc(2026, 7, 5, 2, 0)


def test_local_to_utc_ambiguous_takes_first_occurrence():
    # 2026-11-01 01:30 happens twice in NY; first is EDT -> 05:30 UTC.
    assert local_to_utc("2026-11-01T01:30:00") == utc(2026, 11, 1, 5, 30)


def test_local_to_utc_skipped_time_uses_pre_transition_offset():
    # 2026-03-08 02:30 doesn't exist in NY; read as EST -> 07:30 UTC.
    assert local_to_utc("2026-03-08T02:30:00") == utc(2026, 3, 8, 7, 30)


def test_local_to_utc_respects_explicit_offset():
    assert local_to_utc("2026-11-14T18:00:00+00:00") == utc(2026, 11, 14, 18)


def test_ensure_utc_and_to_ny():
    plus2 = datetime(2026, 1, 1, 12, tzinfo=timezone(timedelta(hours=2)))
    assert ensure_utc(plus2) == utc(2026, 1, 1, 10)
    with pytest.raises(ValueError):
        ensure_utc(datetime(2026, 1, 1))
    assert to_ny(utc(2026, 1, 1, 17)).hour == 12


def test_parse_naive_utc_for_noaa_gmt():
    from nyclive.timeutil import parse_naive_utc

    assert parse_naive_utc("2026-11-15 01:06") == utc(2026, 11, 15, 1, 6)
    assert parse_naive_utc("2026-11-15T01:06:00-05:00") == utc(2026, 11, 15, 6, 6)

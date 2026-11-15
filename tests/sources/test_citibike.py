from helpers import parse_fixture

from nyclive.sources import citibike


def test_station_information_is_a_complete_entity_set():
    b = parse_fixture("citibike_gbfs")
    assert b.complete == frozenset({"entities"})
    assert b.entities and not b.observations
    assert all(e.kind == "bike_station" and e.lat for e in b.entities)


def test_missing_optional_fields():
    b = parse_fixture("citibike_gbfs", "edge_missing_optional")
    first = b.entities[0]
    assert "region_id" not in first.props
    assert first.name == first.entity_id  # empty name falls back to the id


def test_status_metrics():
    b = parse_fixture("citibike_station_status")
    stations = {o.entity_id for o in b.observations}
    assert len(b.observations) == 4 * len(stations)
    assert {o.metric for o in b.observations} == set(citibike.METRICS)


def test_sentinel_missing_field_and_future_time():
    raw_b = parse_fixture("citibike_station_status", "edge_sentinel")
    ids = []
    for o in raw_b.observations:
        if o.entity_id not in ids:
            ids.append(o.entity_id)
    by = {i: [o for o in raw_b.observations if o.entity_id == i] for i in ids[:3]}
    sentinel, missing, future = by.values()
    assert all(o.observed_at == o.fetched_at for o in sentinel)
    assert {o.metric for o in missing} == set(citibike.METRICS) - {"ebikes_available"}
    assert all(o.observed_at <= o.fetched_at for o in future)


def test_feed_url_from_manifest():
    m = {"data": {"en": {"feeds": [{"name": "station_status", "url": "https://x/ss.json"}]}}}
    assert citibike.feed_url(m, "station_status") == "https://x/ss.json"

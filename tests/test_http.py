import itertools
import threading
import time

import httpx
import pytest

from nyclive.http import Http, HttpError, _retry_after_s


class FakeTime:
    """A clock that only moves when the client sleeps."""

    def __init__(self):
        self.now = 1000.0
        self.sleeps: list[float] = []

    def clock(self):
        return self.now

    def sleep(self, s):
        self.sleeps.append(round(s, 3))
        self.now += s


def make(handler, **kw):
    ft = FakeTime()
    http = Http(
        "test-ua/1", transport=httpx.MockTransport(handler), sleep=ft.sleep, clock=ft.clock, **kw
    )
    return http, ft


def test_sets_user_agent_and_host_headers():
    seen = {}

    def handler(req):
        seen.update(req.headers)
        return httpx.Response(200, content=b"ok")

    http, _ = make(handler, host_headers={"data.ny.gov": {"X-App-Token": "t"}})
    r = http.get("https://data.ny.gov/resource/x.json", params={"$limit": "1"})
    assert r.content == b"ok"
    assert seen["user-agent"] == "test-ua/1"
    assert seen["x-app-token"] == "t"


def test_host_headers_only_for_their_host():
    seen = {}

    def handler(req):
        seen.update(req.headers)
        return httpx.Response(200)

    http, _ = make(handler, host_headers={"data.ny.gov": {"X-App-Token": "t"}})
    http.get("https://api.weather.gov/alerts")
    assert "x-app-token" not in seen


def test_min_gap_per_host_not_across_hosts():
    http, ft = make(lambda req: httpx.Response(200), min_gap_s=2.0)
    http.get("https://a.example/1")
    http.get("https://b.example/1")  # different host: no wait
    assert ft.sleeps == []
    http.get("https://a.example/2")  # same host, no time passed: waits the full gap
    assert ft.sleeps == [2.0]
    ft.now += 5
    http.get("https://a.example/3")  # gap already elapsed
    assert ft.sleeps == [2.0]


def test_retries_5xx_with_exponential_backoff_then_succeeds():
    calls = []

    def handler(req):
        calls.append(1)
        return httpx.Response(503) if len(calls) < 3 else httpx.Response(200, content=b"x")

    http, ft = make(handler, min_gap_s=0, backoff_s=2.0)
    assert http.get("https://a.example/").content == b"x"
    assert ft.sleeps == [2.0, 4.0]


def test_gives_up_after_retries():
    http, ft = make(lambda req: httpx.Response(500), min_gap_s=0, retries=2, backoff_s=1)
    with pytest.raises(HttpError) as ei:
        http.get("https://a.example/")
    assert ei.value.status == 500
    assert ei.value.attempts == 3
    assert ft.sleeps == [1.0, 2.0]


def test_4xx_fails_fast():
    calls = []

    def handler(req):
        calls.append(1)
        return httpx.Response(404)

    http, ft = make(handler, min_gap_s=0)
    with pytest.raises(HttpError) as ei:
        http.get("https://a.example/")
    assert ei.value.status == 404 and len(calls) == 1 and ft.sleeps == []


def test_honors_retry_after_capped():
    responses = iter(
        [
            httpx.Response(429, headers={"Retry-After": "7"}),
            httpx.Response(429, headers={"Retry-After": "9999"}),
            httpx.Response(200),
        ]
    )
    http, ft = make(lambda req: next(responses), min_gap_s=0, max_wait_s=60)
    http.get("https://a.example/")
    assert ft.sleeps == [7.0, 60.0]


def test_transport_errors_are_retried():
    calls = []

    def handler(req):
        calls.append(1)
        if len(calls) == 1:
            raise httpx.ConnectTimeout("slow", request=req)
        return httpx.Response(200)

    http, ft = make(handler, min_gap_s=0, backoff_s=1)
    assert http.get("https://a.example/").status_code == 200
    assert ft.sleeps == [1.0]


def test_transport_error_exhausted_raises_httperror():
    def handler(req):
        raise httpx.ConnectError("down", request=req)

    http, _ = make(handler, min_gap_s=0, retries=1, backoff_s=0)
    with pytest.raises(HttpError) as ei:
        http.get("https://a.example/")
    assert ei.value.status is None and "ConnectError" in ei.value.reason


def test_retry_after_parsing():
    assert _retry_after_s("12") == 12.0
    assert _retry_after_s(None) is None
    assert _retry_after_s("garbage") is None
    assert _retry_after_s("Wed, 21 Oct 2015 07:28:00 GMT") == 0.0  # in the past


def test_one_request_at_a_time_per_host_across_threads():
    """Real clock: two threads hitting one host must not overlap and must keep the gap."""
    active = []
    spans = []
    lock = threading.Lock()

    def handler(req):
        with lock:
            active.append(1)
            assert len(active) == 1, "concurrent requests to one host"
        start = time.monotonic()
        time.sleep(0.02)
        spans.append((start, time.monotonic()))
        with lock:
            active.pop()
        return httpx.Response(200)

    http = Http("ua", transport=httpx.MockTransport(handler), min_gap_s=0.1)
    threads = [threading.Thread(target=http.get, args=("https://a.example/",)) for _ in range(3)]
    for t in threads:
        t.start()
    for t in threads:
        t.join()
    spans.sort()
    assert len(spans) == 3
    for (_, end), (start, _) in itertools.pairwise(spans):
        assert start - end >= 0.09

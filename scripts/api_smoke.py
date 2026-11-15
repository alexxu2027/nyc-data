"""Smoke-test the API in-process against a real data dir (read-only).

    uv run python scripts/api_smoke.py --data-dir C:\\Users\\alexx\\nyc-live\\data

Prints id, count, bytes, cold ms and warm ms per layer, then checks: cold < 2 s, warm < 150 ms,
the default 311 body <= 5 MB raw, Citi Bike count >= 2,000 and a 304 on revalidate. Opens
state.db read-only through the API, so it is safe next to a running collector.
"""

from __future__ import annotations

import argparse
import sys
import time
from pathlib import Path

from fastapi.testclient import TestClient

from nyclive.api.app import create_app
from nyclive.settings import Settings

COLD_MS = 2000
WARM_MS = 150
MAX_311_BYTES = 5_000_000
MIN_CITIBIKE = 2000


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--data-dir", type=Path, required=True)
    args = ap.parse_args(argv)
    if not (args.data_dir / "state.db").is_file():
        print(f"no state.db in {args.data_dir}")
        return 2
    app = create_app(Settings(data_dir=args.data_dir, user_agent="api-smoke"), web_dist=None)
    client = TestClient(app)
    failures: list[str] = []

    t0 = time.perf_counter()
    cat = client.get("/api/layers")
    ms_cat = (time.perf_counter() - t0) * 1000
    if cat.status_code != 200:
        print("catalog failed", cat.status_code, cat.text[:300])
        return 1
    layers = [entry["id"] for entry in cat.json()["layers"]]
    print(f"catalog: {len(layers)} layers in {ms_cat:.0f} ms")
    print(
        f"{'layer':<18}{'count':>7}{'total':>7}{'unloc':>6}{'bytes':>10}{'cold ms':>9}{'warm ms':>9}"
    )
    for lid in layers:
        t0 = time.perf_counter()
        r = client.get(f"/api/layers/{lid}", headers={"accept-encoding": "identity"})
        cold = (time.perf_counter() - t0) * 1000
        if r.status_code != 200:
            failures.append(f"{lid}: status {r.status_code} {r.text[:200]}")
            continue
        size = len(r.content)
        meta = r.json()["meta"]
        t0 = time.perf_counter()
        w = client.get(f"/api/layers/{lid}")
        warm = (time.perf_counter() - t0) * 1000
        print(
            f"{lid:<18}{meta['count']:>7}{meta['total']:>7}{meta['unlocated']:>6}"
            f"{size:>10}{cold:>9.0f}{warm:>9.0f}"
        )
        if w.status_code != 200:
            failures.append(f"{lid}: warm status {w.status_code}")
        if cold >= COLD_MS:
            failures.append(f"{lid}: cold {cold:.0f} ms >= {COLD_MS}")
        if warm >= WARM_MS:
            failures.append(f"{lid}: warm {warm:.0f} ms >= {WARM_MS}")
        if lid == "complaints_311" and size > MAX_311_BYTES:
            failures.append(f"311 body {size} bytes > {MAX_311_BYTES}")
        if lid == "citibike" and meta["count"] < MIN_CITIBIKE:
            failures.append(f"citibike count {meta['count']} < {MIN_CITIBIKE}")
        if lid == "citibike":
            again = client.get(f"/api/layers/{lid}", headers={"if-none-match": r.headers["etag"]})
            print(f"  revalidate citibike: {again.status_code}")
            if again.status_code != 304:
                failures.append(f"citibike revalidate gave {again.status_code}, not 304")

    h = client.get("/api/health")
    if h.status_code == 200:
        s = h.json()
        print(
            f"health: collector {s['collector']['state']}, {len(s['sources'])} sources, {s['summary']}"
        )
    else:
        failures.append(f"health: {h.status_code}")

    if failures:
        print("\nFAIL")
        for f in failures:
            print(" -", f)
        return 1
    print("\nOK: all thresholds met")
    return 0


if __name__ == "__main__":
    sys.exit(main())

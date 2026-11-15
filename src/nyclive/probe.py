"""`nyclive probe`: check that every registered feed is reachable and looks right.

Makes one GET per source, run sequentially so we stay polite. Prints a table and can
write a JSON report (handy for keeping docs/DATA_SOURCES.md honest).
"""

from __future__ import annotations

import json
import time
from dataclasses import asdict, dataclass
from datetime import UTC, datetime
from pathlib import Path

import httpx

from nyclive.registry import Registry, Source


@dataclass
class ProbeResult:
    id: str
    ok: bool
    status: str  # HTTP code, "skipped", or "error"
    ms: int | None = None
    bytes: int | None = None
    content_type: str | None = None
    detail: str = ""


def probe_source(client: httpx.Client, src: Source) -> ProbeResult:
    if not src.probe:
        return ProbeResult(src.id, ok=True, status="skipped", detail="no probe URL")
    missing = src.missing_env()
    if missing:
        return ProbeResult(src.id, ok=True, status="skipped", detail=f"needs {', '.join(missing)}")
    t0 = time.perf_counter()
    try:
        r = client.get(src.probe_url())
    except httpx.HTTPError as e:
        return ProbeResult(src.id, ok=False, status="error", detail=type(e).__name__)
    ms = int((time.perf_counter() - t0) * 1000)
    ok = r.status_code == 200
    detail = ""
    if ok and src.expect and src.expect not in r.text[:2_000_000]:
        ok, detail = False, f"missing expected text {src.expect!r}"
    elif not ok:
        detail = r.text[:120].replace("\n", " ")
    return ProbeResult(
        src.id, ok, str(r.status_code), ms, len(r.content), r.headers.get("content-type"), detail
    )


def run_probe(
    reg: Registry, max_phase: int = 99, only: list[str] | None = None, json_out: Path | None = None
) -> int:
    sources = [s for s in reg.by_phase(max_phase) if not only or s.id in only]
    headers = {"User-Agent": reg.user_agent}
    with httpx.Client(timeout=25, follow_redirects=True, headers=headers) as client:
        results = [probe_source(client, s) for s in sources]

    width = max(len(r.id) for r in results) if results else 10
    print(f"{'source':<{width}}  ok   status  ms     bytes      detail")
    for r in results:
        mark = "yes" if r.ok else "NO "
        print(
            f"{r.id:<{width}}  {mark}  {r.status:<6}  {r.ms or '':<5}  "
            f"{r.bytes or '':<9}  {r.detail}"
        )
    failed = [r for r in results if not r.ok]
    print(f"\n{len(results) - len(failed)}/{len(results)} healthy")

    if json_out:
        json_out.parent.mkdir(parents=True, exist_ok=True)
        payload = {
            "probed_at": datetime.now(UTC).isoformat(timespec="seconds"),
            "results": [asdict(r) for r in results],
        }
        json_out.write_text(json.dumps(payload, indent=2), encoding="utf-8")
        print(f"wrote {json_out}")
    return 1 if failed else 0

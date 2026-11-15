"""Command-line entry point: `uv run nyclive <command>`.

Commands planned per docs/ROADMAP.md:
  probe     check every registered feed (available now)
  sources   list the registry (available now)
  collect   run collectors on their schedules          (available now)
  status    per-source health from state.db            (available now)
  compact   merge closed days in the archive           (available now)
  capture   record a fixture payload for tests         (available now)
  serve     run the read-only API and web app          (available now)
  cv        run the camera counting worker             (Phase 4)
"""

from __future__ import annotations

import argparse
import sys
from pathlib import Path

from nyclive.registry import load_registry


def main(argv: list[str] | None = None) -> int:
    p = argparse.ArgumentParser(prog="nyclive")
    sub = p.add_subparsers(dest="cmd", required=True)

    pr = sub.add_parser("probe", help="check that registered feeds are reachable")
    pr.add_argument(
        "--phase", type=int, default=99, help="only sources used by this phase or earlier"
    )
    pr.add_argument("--only", nargs="*", help="source ids to probe")
    pr.add_argument("--json", type=Path, help="write a JSON report here")

    sub.add_parser("sources", help="list registered sources")

    ca = sub.add_parser("capture", help="record a raw payload as a test fixture")
    ca.add_argument("source", help="registry id")
    ca.add_argument("--case", default="real", help="fixture case name (default: real)")
    ca.add_argument("--part", action="append", metavar="NAME=URL", help="fetch these URLs instead")
    ca.add_argument("--cursor", help="cursor to pass to the adapter's fetch()")
    ca.add_argument("--trim", type=int, metavar="N", help="keep N items of the largest JSON list")
    ca.add_argument("--note", default="", help="note stored in meta.json")
    ca.add_argument("--force", action="store_true", help="replace an existing case")

    co = sub.add_parser("collect", help="run collectors on their schedules")
    co.add_argument("--only", nargs="+", metavar="ID", help="collect only these sources")
    co.add_argument("--once", action="store_true", help="run each source once and exit")
    co.add_argument("--keep-awake", action="store_true", help="stop Windows sleeping meanwhile")
    co.add_argument("-v", "--verbose", action="store_true")

    sub.add_parser("status", help="per-source health from state.db")
    sub.add_parser("compact", help="compact closed days and export their runs")

    se = sub.add_parser("serve", help="run the read-only API (and web/dist if built)")
    se.add_argument("--host", default="127.0.0.1")
    se.add_argument("--port", type=int, default=8000)
    se.add_argument("--reload", action="store_true", help="restart on code changes (dev)")
    se.add_argument("--no-web", action="store_true", help="serve /api only, not web/dist")

    args = p.parse_args(argv)
    if args.cmd == "serve":
        return _serve(args)
    reg = load_registry()

    if args.cmd in {"collect", "status", "compact"}:
        return _storage_command(args, reg)

    if args.cmd == "capture":
        from nyclive.capture import capture, parse_part_args
        from nyclive.settings import load_settings

        if args.case != "real" and not args.case.startswith("edge_"):
            raise SystemExit("--case must be 'real' or start with 'edge_'")
        capture(
            reg,
            load_settings(),
            args.source,
            case=args.case,
            parts=parse_part_args(args.part),
            cursor=args.cursor,
            trim=args.trim,
            note=args.note,
            force=args.force,
        )
        return 0

    if args.cmd == "probe":
        from nyclive.probe import run_probe

        return run_probe(reg, max_phase=args.phase, only=args.only, json_out=args.json)

    if args.cmd == "sources":
        for s in sorted(reg.sources.values(), key=lambda s: (s.phase, s.id)):
            cadence = f"{s.cadence_s}s" if s.cadence_s else "on demand"
            print(f"P{s.phase}  {s.id:<26} {s.shape:<12} {cadence:<10} {s.status:<10} {s.name}")
        return 0
    return 2


def _storage_command(args, reg) -> int:
    from nyclive.collect.scheduler import Collector, SingleInstance, keep_awake, setup_logging
    from nyclive.settings import load_settings
    from nyclive.storage.state import StateStore
    from nyclive.timeutil import now_utc

    settings = load_settings()
    if args.cmd == "status":
        from nyclive.status import render, source_rows

        _utf8_console()
        if not settings.state_db.exists():
            print(f"no state yet at {settings.state_db}; run `nyclive collect` first")
            return 1
        with StateStore(settings.state_db) as store:
            print(render(source_rows(reg, store, now_utc())))
        return 0

    setup_logging(settings.logs_dir, verbose=getattr(args, "verbose", False))
    with SingleInstance(settings.data_dir / "collect.lock"):
        collector = Collector(reg, settings, only=getattr(args, "only", None))
        try:
            if args.cmd == "compact":
                collector.maintenance()
                return 0
            if args.once:
                results = collector.run_all_once()
                return 0 if all(r.ok for r in results) else 1
            if args.keep_awake and not keep_awake():
                print("--keep-awake only works on Windows; continuing without it")
            collector.run_forever()
            return 0
        finally:
            collector.close()


def _serve(args) -> int:
    try:
        import fastapi  # noqa: F401
        import uvicorn
    except ImportError:
        print("`nyclive serve` needs the api extra: run `uv sync --extra api`", file=sys.stderr)
        return 1
    import os

    if args.no_web:
        os.environ["NYCLIVE_NO_WEB"] = "1"
    print(f"NYC Live API on http://{args.host}:{args.port}/  (docs at /api/docs)")
    uvicorn.run(
        "nyclive.api.app:app_from_env",
        factory=True,
        host=args.host,
        port=args.port,
        reload=args.reload,
        log_level="info",
    )
    return 0


def _utf8_console() -> None:
    for stream in (sys.stdout, sys.stderr):
        if hasattr(stream, "reconfigure"):
            stream.reconfigure(encoding="utf-8", errors="replace")


if __name__ == "__main__":
    sys.exit(main())

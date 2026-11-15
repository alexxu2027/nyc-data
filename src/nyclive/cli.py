"""Command-line entry point: `uv run nyclive <command>`.

Commands planned per docs/ROADMAP.md:
  probe     check every registered feed (available now)
  sources   list the registry (available now)
  collect   run collectors on their schedules          (Phase 1)
  capture   record a fixture payload for tests         (Phase 1)
  serve     run the API                                (Phase 2)
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

    args = p.parse_args(argv)
    reg = load_registry()

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


if __name__ == "__main__":
    sys.exit(main())

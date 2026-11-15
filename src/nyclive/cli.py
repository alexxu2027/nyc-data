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

    args = p.parse_args(argv)
    reg = load_registry()

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

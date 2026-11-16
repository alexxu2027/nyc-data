"""Shared text helpers for adapters whose props carry long free text (alerts)."""

from __future__ import annotations

import json
from collections.abc import Sequence
from typing import Any

ELLIPSIS = "…"


def props_size(props: dict[str, Any]) -> int:
    return len(json.dumps(props, ensure_ascii=False, allow_nan=False).encode("utf-8"))


def trim_text_fields(
    props: dict[str, Any], fields: Sequence[str], max_bytes: int
) -> dict[str, Any]:
    """Trim the longest of `fields` (ending it with an ellipsis) until `props` fits `max_bytes`.

    Deterministic for a given input. If nothing is left to trim, props stay oversize and
    `record_problems` reports them.
    """
    while (over := props_size(props) - max_bytes) > 0:
        k = max(fields, key=lambda f: len(props.get(f) or ""))
        text = props.get(k) or ""
        if not text:
            break
        keep = max(0, len(text.rstrip(ELLIPSIS)) - over - len(ELLIPSIS))
        props[k] = text[:keep].rstrip() + ELLIPSIS if keep else None
    return props

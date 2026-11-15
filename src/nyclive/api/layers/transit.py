"""Transit layers: citibike, subway_stations, subway_alerts, elevator_outages."""

from __future__ import annotations

from datetime import timedelta

from nyclive.api.geo import point
from nyclive.api.layers.common import (
    Ctx,
    LayerResult,
    entities,
    entity_index,
    event_status,
    feature,
    iso,
    latest_by_entity,
    loads,
    parse_ts,
    refs_of,
    ts_text,
)

ALERT_HORIZON = timedelta(days=7)


# -------------------------------------------------------------------------------- citibike
def bike_state(bikes: int, docks: int, renting: bool) -> str:
    if not renting:
        return "offline"
    if bikes == 0:
        return "empty"
    if docks == 0:
        return "full"
    if bikes <= 3:
        return "low"
    return "ok"


def bike_derived(m: dict[str, tuple]) -> dict:
    bikes = int(m["bikes_available"][0]) if "bikes_available" in m else 0
    docks = int(m["docks_available"][0]) if "docks_available" in m else 0
    renting = m["is_renting"][0] > 0 if "is_renting" in m else True
    pct = round(bikes / (bikes + docks), 3) if bikes + docks > 0 else None
    return {"pct": pct, "state": bike_state(bikes, docks, renting), "bikes": bikes, "docks": docks}


def citibike(ctx: Ctx) -> LayerResult:
    latest = latest_by_entity(ctx.conn, "bike_station")
    idx = ctx.services.boroughs
    feats, newest, unlocated, no_status = [], None, 0, 0
    for e in entities(ctx.conn, "bike_station"):
        m = latest.get(e["entity_id"])
        if e["lat"] is None:
            unlocated += 1
            continue
        if not m or "bikes_available" not in m:
            no_status += 1
            continue
        d = bike_derived(m)
        observed = m["bikes_available"][1]
        newest = observed if newest is None or observed > newest else newest
        cap = loads(e["props"]).get("capacity")
        feats.append(
            feature(
                e["entity_id"],
                idx.resolve(e["borough"], e["lon"], e["lat"]),
                point(e["lon"], e["lat"]),
                name=e["name"],
                capacity=None if cap is None else int(cap),
                bikes=d["bikes"],
                ebikes=int(m["ebikes_available"][0]) if "ebikes_available" in m else 0,
                docks=d["docks"],
                pct=d["pct"],
                state=d["state"],
                observed_at=iso(observed),
            )
        )
    note = f"{no_status} stations have no status reading yet" if no_status else None
    return LayerResult(feats, data_as_of=iso(newest), unlocated=unlocated, note=note)


# ------------------------------------------------------------------------- subway stations
def routes_of(props: dict) -> str:
    return " ".join(str(props.get("daytime_routes") or "").split())


def subway_stations(ctx: Ctx) -> LayerResult:
    idx = ctx.services.boroughs
    feats, newest = [], None
    for e in entities(ctx.conn, "subway_station"):
        if e["lat"] is None:
            continue
        p = loads(e["props"])
        newest = e["last_seen"] if newest is None or e["last_seen"] > newest else newest
        feats.append(
            feature(
                e["entity_id"],
                idx.resolve(e["borough"], e["lon"], e["lat"]),
                point(e["lon"], e["lat"]),
                name=e["name"],
                routes=routes_of(p),
                ada=int(p.get("ada") or 0),
                line=p.get("line") or "",
                structure=p.get("structure") or "",
            )
        )
    return LayerResult(feats, data_as_of=iso(newest))


# -------------------------------------------------------------------------- subway alerts
def alert_events(ctx: Ctx, source: str) -> list[dict]:
    """Events of a source that are in effect or start within 7 days, with `status` set."""
    horizon = ts_text(ctx.now + ALERT_HORIZON)
    rows = ctx.conn.execute(
        "SELECT * FROM events WHERE source = ? AND (ends_at IS NULL OR ends_at > ?)"
        " AND starts_at <= ?",
        (source, ctx.now_text, horizon),
    ).fetchall()
    out = []
    for r in rows:
        d = dict(r)
        d["status"] = event_status(d["starts_at"], d["ends_at"], ctx.now_text)
        out.append(d)
    return out


def _rank(ev: dict) -> tuple:
    return (0 if ev["status"] in ("active", "current") else 1, -(ev["severity"] or 0))


def is_unplanned(ev: dict) -> bool:
    return not (ev["subtype"] or "").startswith("Planned")


def subway_alerts(ctx: Ctx) -> LayerResult:
    stations = entity_index(ctx.conn, "subway_station")
    idx = ctx.services.boroughs
    by_station: dict[str, list[dict]] = {}
    unlocated, newest = 0, None
    for ev in alert_events(ctx, "mta_subway_alerts"):
        if ev["status"] == "active":
            newest = ev["starts_at"] if newest is None or ev["starts_at"] > newest else newest
        hits = [s for s in dict.fromkeys(refs_of(ev, "subway_station")) if s in stations]
        hits = [s for s in hits if stations[s]["lat"] is not None]
        if not hits:
            unlocated += 1
            continue
        for s in hits:
            by_station.setdefault(s, []).append(ev)
    feats = []
    for sid in sorted(by_station):
        evs = sorted(by_station[sid], key=lambda e: (*_rank(e), e["starts_at"]))
        st = stations[sid]
        active = [e for e in evs if e["status"] == "active"]
        top = evs[0]
        feats.append(
            feature(
                sid,
                idx.resolve(st["borough"], st["lon"], st["lat"]),
                point(st["lon"], st["lat"]),
                name=st["name"],
                routes=routes_of(loads(st["props"])),
                status="active" if active else "upcoming",
                n=len(evs),
                active=len(active),
                upcoming=len(evs) - len(active),
                unplanned=sum(1 for e in active if is_unplanned(e)),
                severity=max(e["severity"] or 0 for e in evs),
                top_title=top["title"],
                top_subtype=top["subtype"],
            )
        )
    note = (
        f"{unlocated} alerts name no mappable station (line-wide); see the list"
        if unlocated
        else None
    )
    return LayerResult(feats, data_as_of=iso(newest), unlocated=unlocated, note=note)


# ------------------------------------------------------------------------ elevator outages
def outage_status(ev: dict, now_text: str) -> str:
    upcoming = loads(ev["props"]).get("upcoming") is True or ev["starts_at"] > now_text
    return "upcoming" if upcoming else "current"


def open_outages(ctx: Ctx) -> list[dict]:
    rows = ctx.conn.execute(
        "SELECT * FROM events WHERE source = 'mta_elevator_outages'"
        " AND (ends_at IS NULL OR ends_at > ?)",
        (ctx.now_text,),
    ).fetchall()
    out = []
    for r in rows:
        d = dict(r)
        d["status"] = outage_status(d, ctx.now_text)
        out.append(d)
    return out


def elevator_outages(ctx: Ctx) -> LayerResult:
    stations = entity_index(ctx.conn, "subway_station")
    idx = ctx.services.boroughs
    by_station: dict[str, list[dict]] = {}
    unlocated, newest = 0, None
    for ev in open_outages(ctx):
        if ev["starts_at"] <= ctx.now_text:
            newest = ev["starts_at"] if newest is None or ev["starts_at"] > newest else newest
        sid = next(
            (
                s
                for s in refs_of(ev, "subway_station")
                if s in stations and stations[s]["lat"] is not None
            ),
            None,
        )
        if sid is None:
            unlocated += 1
            continue
        by_station.setdefault(sid, []).append(ev)
    feats = []
    for sid in sorted(by_station):
        evs = sorted(by_station[sid], key=lambda e: (*_rank(e), e["starts_at"]))
        st = stations[sid]
        current = [e for e in evs if e["status"] == "current"]
        top = evs[0]
        props = [loads(e["props"]) for e in evs]
        est = parse_ts(loads(top["props"]).get("est_return"))
        feats.append(
            feature(
                sid,
                idx.resolve(st["borough"], st["lon"], st["lat"]),
                point(st["lon"], st["lat"]),
                name=st["name"],
                routes=routes_of(loads(st["props"])),
                status="current" if current else "upcoming",
                n=len(evs),
                current=len(current),
                upcoming=len(evs) - len(current),
                elevators=sum(1 for e in evs if e["subtype"] == "EL"),
                escalators=sum(1 for e in evs if e["subtype"] == "ES"),
                ada=any(p.get("ADA") is True for p in props),
                top_title=top["title"],
                est_return=iso(est),
            )
        )
    return LayerResult(feats, data_as_of=iso(newest), unlocated=unlocated)

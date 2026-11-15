# NYC Live

**One map for New York City's open data — live and replayable — with traffic cameras turned into sensors.**

Toggle layers for Citi Bike docks, subway alerts, street-level flood sensors, tides, weather alerts,
311 complaints, crashes and road speeds. Click a DOT camera to see what it sees, and (from Phase 4)
how many cars, people and bikes a vision model is counting there. Later, drag a time slider back
over a storm and watch the city react.

> Status: **Phase 0 — foundations.** Docs, source registry and the feed probe are done; collectors are next.
> See [`HANDOFF.md`](HANDOFF.md) for exactly where things stand.

## Why this exists
NYC publishes an enormous amount of data, but it lives in a dozen formats on a dozen sites, most of
it is "live only" (gone if nobody saves it), and none of it is shown together. NYC Live collects it,
archives it, and puts it on one map so you can see how the pieces relate — e.g. *rain rate → tide
surge → FloodNet sensor depth → 311 "street flooding" complaints → what the nearest camera shows.*

It's also a portfolio piece: a real data-engineering pipeline (polling, normalization, archival,
replay), a real map UI, and applied computer vision on low-quality public video.

## Documentation
| Doc | What's in it |
|---|---|
| [docs/PRD.md](docs/PRD.md) | Product requirements: goals, users, features, success criteria, risks |
| [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) | Components, data flow, storage, API, frontend, CV pipeline, deployment |
| [docs/DATA_SOURCES.md](docs/DATA_SOURCES.md) | Every feed: endpoint, cadence, auth, quirks, verification status |
| [docs/DATA_MODEL.md](docs/DATA_MODEL.md) | Entities / observations / events schemas and storage layout |
| [docs/ROADMAP.md](docs/ROADMAP.md) | Phases with tasks and acceptance criteria |
| [docs/DECISIONS.md](docs/DECISIONS.md) | Architecture decision records (why X over Y) |
| [docs/DEV_SETUP.md](docs/DEV_SETUP.md) | Setting up on this laptop (Windows on ARM) and later the RTX 3050 PC |
| [config/sources.yaml](config/sources.yaml) | Machine-readable source registry (the source of truth) |

## Quickstart
```bash
uv sync                      # Python 3.12 env + deps
uv run nyclive sources       # list every registered feed
uv run nyclive probe         # check they're all reachable right now
uv run pytest                # offline tests (add -m live for network tests)
```
No API keys are needed for anything in Phases 1–4.

## Data & ethics
All sources are public. NYC Live counts and aggregates; it does **not** do face or license-plate
recognition or track individuals, and camera frames are kept only briefly (see PRD §8).
Data belongs to its publishers — NYC DOT, NYC Open Data, MTA, Lyft/Citi Bike, NOAA, NWS,
FloodNet (NYU/CUNY/NYC), Open-Meteo and others; attribution is shown in the app.

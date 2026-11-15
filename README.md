# NYC Live

**One map for New York City's open data — live and replayable — with traffic cameras turned into sensors.**

Toggle layers for Citi Bike docks, subway alerts, street-level flood sensors, tides, weather alerts,
311 complaints, crashes and road speeds. Click a DOT camera to see what it sees, and (from Phase 4)
how many cars, people and bikes a vision model is counting there. Later, drag a time slider back
over a storm and watch the city react.

> **Status: early.** Working today: the source registry (22 feeds), a feed health probe, and tests.
> In progress: collectors and the archive (Phase 1). Not built yet: the map, replay and camera
> counting. See [docs/ROADMAP.md](docs/ROADMAP.md) for the plan and [`HANDOFF.md`](HANDOFF.md) for
> exactly where things stand.

The paragraph above the status box describes the goal, not what exists yet.

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
| [docs/DEV_SETUP.md](docs/DEV_SETUP.md) | Setup (Windows on ARM laptop now, RTX 3050 PC later) |
| [config/sources.yaml](config/sources.yaml) | Machine-readable source registry (the source of truth) |

## Quickstart
Prerequisites: [uv](https://docs.astral.sh/uv/) and git. uv installs Python 3.12 for you.
```bash
git clone https://github.com/alexxu2027/nyc-data && cd nyc-data
uv sync                      # Python 3.12 env + deps
uv run nyclive sources       # list every registered feed
uv run nyclive probe         # check they're all reachable right now
uv run nyclive collect       # start collecting (Ctrl+C to stop); data goes to ./data
uv run nyclive status        # health of each collected source
uv run pytest                # offline tests (add -m live for network tests)
```
No API keys are needed for anything in Phases 1–4.

## Data & ethics
All sources are public. NYC Live counts and aggregates; it does **not** do face or license-plate
recognition or track individuals, and camera frames are kept only briefly (see PRD §8).
Data belongs to its publishers — NYC DOT, NYC Open Data, MTA, Lyft/Citi Bike, NOAA, NWS,
FloodNet (NYU/CUNY/NYC), Open-Meteo and others; attribution is shown in the app.

## License
Code is [MIT](LICENSE). Data and fixture samples belong to their publishers.

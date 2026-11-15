# NYC Live: Product Requirements Document

| | |
|---|---|
| Owner | Alex |
| Status | Draft v1, 2026-11-14 |
| Type | Personal portfolio project (solo) |
| Related | [ARCHITECTURE](ARCHITECTURE.md) · [DATA_SOURCES](DATA_SOURCES.md) · [ROADMAP](ROADMAP.md) · [DECISIONS](DECISIONS.md) |

---

## 1. Summary
NYC Live is a web map that pulls New York City's public real-time and near-real-time feeds into a
single place. Every feed is a layer you can switch on or off and filter by place and by time.
Collectors archive each feed from day one, which makes the "live" map replayable later. NYC DOT's
traffic cameras appear in two ways: as viewable feeds, and (once a vision model is counting
vehicles and pedestrians on them) as sensors.

## 2. Problem
- **Fragmented.** The city's data is spread across a dozen systems: NYC Open Data/Socrata, MTA
  GTFS-rt, GBFS, NOAA, NWS, FloodNet/FieldKit, DOT's camera API. Each has its own format, time
  conventions and quirks.
- **Ephemeral.** Most live feeds (Citi Bike docks, subway alerts, camera frames, tide readings) keep
  no history. Anything not captured today is lost.
- **Siloed.** Nothing shows how these relate. During a cloudburst, the rain rate, tide surge,
  FloodNet street depth, 311 flooding complaints, subway alerts and the nearest camera are all
  relevant, but no single place shows them together.

## 3. Goals
1. **G1, Unify:** at least 12 sources on one map with a consistent layer, filter and detail experience.
2. **G2, Preserve:** archive every Phase 1 source continuously so any past moment can be replayed.
3. **G3, See:** turn cameras into numeric sensors (vehicle, person and bike counts) using CV that
   runs on a laptop CPU.
4. **G4, Explain:** at least two "modes" or stories that combine layers to answer a real question
   (e.g. *Storm mode*).
5. **G5, Show off:** a public demo link, a clean README with a GIF, an architecture diagram and a
   short write-up of one finding. Good enough to put on a resume.

### Non-goals
- No face recognition, license-plate reading, or tracking of individual people or vehicles across
  cameras.
- No alerting product, push notifications, or anything people should rely on for safety. NYC
  Live is not an emergency tool.
- No trading or betting functionality. Kalshi data is displayed only.
- No mobile app. The responsive web layout should work on a phone, but desktop is primary.
- No multi-user accounts, auth or user-generated content.
- No paid data sources.

## 4. Users
| User | Need | What success looks like |
|---|---|---|
| **Portfolio reviewer** (recruiter, interviewer, engineer) | Understand within 60 s what this is and why it's impressive | Opens the link, something is visibly live, toggles a layer, opens a camera, reads the README |
| **Alex (builder/analyst)** | A playground for NYC data, CV and PyTorch | Can ask "what happened at X during Y" and answer it with the replay and a notebook |
| **Curious New Yorker** | See what's going on in their neighborhood right now | Neighborhood card shows bikes, alerts, flooding and cams nearby |

## 5. User stories (prioritized)
**P0, MVP (Phases 1–2)**
- As a viewer, I see a dark map of NYC with a layer panel grouped by theme, and each layer shows
  whether its data is fresh.
- I can toggle Citi Bike stations, colored by bikes available, and filter to empty, full or e-bikes.
- I can toggle DOT cameras, filter by borough, and click one to see its latest frame refresh.
- I can see FloodNet sensors and recent flood events, the Battery tide (observed vs. predicted),
  current weather and active NWS alerts for NYC.
- I can see MTA subway alerts and elevator/escalator outages on their stations.
- I can see 311 complaints (filter by type and recency), crashes (filter by severity) and DOT road
  speeds (colored segments).
- I can filter everything by borough, and the URL captures my layers and filters so I can share a view.
- A health panel shows every source's last successful fetch and current lag.

**P1 (Phases 3–4)**
- I can switch from LIVE to a time slider, scrub to any archived moment, and press play to replay
  at 60× or 600×.
- The slider shows a sparkline of activity (complaints, alerts, flood depth) so I can find
  interesting moments.
- On watchlisted cameras I can see live counts of cars, people, bikes and buses, plus a chart of
  the last 24 h.
- A camera-derived layer colors cameras by "busier or quieter than usual for this hour".

**P2 (Phase 5)**
- **Storm mode:** one click shows rain, tide surge, FloodNet, 311 flooding, NWS alerts and cams in
  flood zones.
- **Commute mode:** subway alerts, outages, Citi Bike availability and road speeds.
- **Neighborhood card:** click an area and get a live summary plus 7-day trends.
- **Anomaly flags:** "this station / camera / sensor is far from normal for this hour and weekday".
- **Kalshi panel:** NYC daily-high-temperature market prices next to the live temperature and forecast.
- Subway trains on the map, aircraft over the city, air quality.

**P3 (stretch)**
- A custom PyTorch model on DOT frames (e.g. "street flooded?" or "raining?") as its own layer.
- Exportable dataset snapshots and a public notebook with one analysis.

## 6. Functional requirements
| ID | Requirement | Phase |
|---|---|---|
| F1 | Source registry (`config/sources.yaml`) lists every feed with cadence, auth, shape and status | 0 ✅ |
| F2 | `nyclive probe` checks every feed and reports health | 0 ✅ |
| F3 | Collectors poll each Phase 1 source on its cadence, isolated so one failing source can't stop the others | 1 |
| F4 | Every fetch is normalized into the entities, observations or events shape and archived append-only | 1 |
| F5 | Latest state per source is queryable in under 50 ms for the live map | 1 |
| F6 | Collectors are restart-safe: dedupe on natural keys, with no duplicate rows after a crash or restart | 1 |
| F7 | API serves layers as GeoJSON, filtered by bbox, borough, time and layer-specific filters | 2 |
| F8 | Web map with layer panel, legends, filters, detail drawer and URL-encoded state | 2 |
| F9 | Health endpoint and panel: last success, lag, error count per source | 2 |
| F10 | Replay: state at time *t* for any archived layer, plus a timeline summary | 3 |
| F11 | CV worker counts objects on watchlisted cameras on a fixed interval; counts become observations | 4 |
| F12 | Modes are saved presets of layers, filters and map view | 5 |
| F13 | Static demo build: a recorded day, served without the backend | 6 |

## 7. Non-functional requirements
- **Runs on Alex's laptop.** Snapdragon X Elite, 32 GB RAM, CPU only. Collectors under 5% CPU on
  average; CV for 20 cams uses at most 2 cores.
- **No keys for Phases 1–4.** Everything in the MVP is keyless (verified 2026-11-14). Keys are
  optional extras only.
- **Polite.** Never poll faster than a feed's TTL or cadence. Sequential requests per host,
  timeouts, exponential backoff, and a clear User-Agent.
- **Storage budget.** At most 1 GB/day total (see ARCHITECTURE §5). Camera frames are kept only
  for the watchlist, with 3-day retention.
- **Testable offline.** Parsers are tested against recorded fixtures, and `pytest` never touches
  the network (live tests are opt-in with `-m live`).
- **Observable.** Structured logs per source, a health endpoint, and a probe report history in
  `data/probe/`.
- **Portable.** The same code runs on the laptop, the RTX 3050 PC (CUDA for CV) and a small VPS.
- **Accessible UI.** Keyboard reachable, color-blind-safe palettes, legends on every layer, and a
  respected dark/light preference.

## 8. Privacy, ethics & licensing
- Camera frames are low resolution (352×240). Even so, NYC Live only **counts**. No identification,
  no re-identification across cameras, no faces or plates.
- Raw frames are stored only for watchlisted cameras, for 3 days. Counts are kept indefinitely.
  The public demo shows live frames by linking to DOT, not by rehosting archives.
- 311 and collision data are already public, but displays aggregate by default; point-level detail
  appears only on zoom.
- Every layer carries source attribution in its legend and the "About" panel.
- Open-Meteo, OpenSky and Socrata terms are non-commercial or rate-limited. This is a
  non-commercial project. Re-check terms before any change in that status.

## 9. Success metrics
| Metric | Target |
|---|---|
| Sources live on the map | ≥ 12 by end of Phase 2 |
| Collector uptime (laptop or PC) | ≥ 95% of hours captured over a 2-week window |
| Live map time to first useful render | < 3 s on broadband |
| Replay coverage | ≥ 30 continuous days archived by end of Phase 3 |
| CV count accuracy on watchlist cams (vs. 100 hand-labeled frames) | Vehicles: mean absolute error ≤ 2 per frame |
| Portfolio | Public demo link, README with GIF, one written finding |

## 10. Milestones
See [ROADMAP.md](ROADMAP.md). In summary: **P0** foundations ✅ → **P1** collectors and archive →
**P2** live map → **P3** replay → **P4** camera CV → **P5** modes and extras → **P6** ship the
portfolio.
Start Phase 1 right away, because history starts accruing only when collectors run.

## 11. Risks & mitigations
| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| Laptop sleeps, so gaps in history | High | Med | Accept gaps early (the health panel shows them). Move collectors to the 3050 PC or a $5 VPS in Phase 3 |
| A feed changes format or URL (DOT cam API is undocumented) | Med | Med | Probe in CI/cron, fixture tests, per-source isolation, `status` in the registry |
| FloodNet live endpoint undocumented | Med | Low | Phase 1 spike. Fall back to Open Data events (≈2-week lag), clearly labeled |
| Storage growth (Citi Bike ≈1M rows/hr if stored naively) | Med | Med | Store changed rows only, compact Parquet nightly, image retention |
| CV too slow or inaccurate on grainy frames | Med | Med | Count per frame (no tracking), ROI crops, `imgsz=1280`, small watchlist. Fine-tune on the 3050 later |
| Scope creep (22 sources, 5 modes) | High | High | Strict phase gates with acceptance criteria. MVP = Phase 1 + 2 sources only |
| Licensing or terms surprises on public demo | Low | Med | Link rather than rehost camera images, attribute everything, no commercial use |

## 12. Open questions
1. Public hosting: home PC with Cloudflare Tunnel, or a small VPS? (Decide in Phase 3; see ADR-009.)
2. Is the FieldKit live endpoint usable and acceptable to poll? (Phase 1 spike.)
3. Which ~20 cameras go on the CV watchlist? (Pick by image quality and proximity to FloodNet
   sensors and busy Citi Bike stations.)
4. Final name: "NYC Live" is a working title (repo is `nyc-data` for now).

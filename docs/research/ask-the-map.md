# "Ask the map": a question bar over the live data (parked design note, 2026-11-16)

Idea (Alex): a bar where you type a question, e.g. "why is traffic backed up by two bridges?",
and the map answers. Parked as a **Phase 5 extra**, to build after Notify NYC is live and
Phase 3 replay exists. Not started.

## Shape
- **UI:** a one-line bar (transcript style; `ASK:` prompt, typed answer). The answer is 2–4
  lines with a source and age per fact ("DOT speeds, 2 h old"). It highlights or flies to the
  features it used, and leaves follow-ups in the bar.
- **Server:** `POST /api/ask` runs a short Claude tool-use loop. Tools wrap **our own API only**
  (no web):
  - `layer(id, bbox?, filters?)`: features plus meta (`data_as_of`, unlocated);
  - `events(layer, status)`, `event(source, id)`, `changes(hours)`;
  - `entity(kind, id)` and `series(kind, id, hours)`: an entity's detail and its history;
  - `health()`: freshness per feed;
  - `place(name)`: a gazetteer (bridges, tunnels, neighbourhoods/NTAs, stations, landmarks)
    to a bbox. Ambiguous names ("Two Bridges", the area, vs two bridges) get a clarifying
    question, or default to the current map view.
  - Later, with Phase 3: `as_of(t)` for "what happened at 5 PM yesterday?".
- **Grounding rules** (in the system prompt and checked in tests):
  - Every claim cites a tool result and its age. Data older than its layer's lag limit is
    called out.
  - **Never invent a cause.** "Speeds were slow at X as of 2 h ago; no current alert explains
    it" is a correct answer.
  - Name what we can't see (late feeds, no camera counts yet).

## What it can answer, by data
| Question | Today | With Notify NYC | With 511NY / camera counts |
|---|---|---|---|
| Flooding / weather alerts / subway line status / empty Citi Bike docks / what changed | good (live data) | good | good |
| "Why is traffic backed up at X?" | weak: speeds are 2–4 h late, few live causes | better: closures, police activity, disruptions | good: live crashes and closures, and current camera vehicle counts |
| "What happened at 5 PM yesterday?" | no | no | yes, after Phase 3 replay |

## Constraints
- **Key:** needs an Anthropic API key, so it's an **optional extra under ADR-007**. The bar only
  appears when the key is in `.env`; the rest of the site stays keyless.
- **Cost and abuse** (public site):
  - per-IP rate limit, a daily token or spend cap, short contexts (tool results are API
    summaries, not raw archives), and max tool calls per question;
  - a cheap model for routing and simple questions, a stronger one only when needed.
- **Privacy:** questions aren't stored beyond a short rate-limit window, and the logs keep no
  question text by default.

## Effort
About 1–2 days once the prerequisites exist: the endpoint and tool loop, the gazetteer (static
GeoJSON of bridges, tunnels and NTAs), the bar UI with citations and highlights, the caps, and
tests with recorded tool transcripts (no live model calls in pytest).

## Prerequisites
Notify NYC live (ADR-015), and ideally Phase 3 replay. 511NY (key) or Phase 4 camera counts
make "why is traffic …" questions answerable well.

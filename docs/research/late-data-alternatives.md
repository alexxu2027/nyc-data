# Faster alternatives to late city data (2026-11-16)

Question (Alex): the city publishes some layers late (311 1–2 days, collisions ~3 days, road
speeds 2–4 h, FloodNet events ~2 weeks). Are there faster sources, "maybe something like the
Citizen app"? Checked live on 2026-11-16 with polite single requests.

## Summary

| Late layer | Faster source | Verdict |
|---|---|---|
| Floods (~2 weeks) | FloodNet live depth (`floodnet_live`, FieldKit) | **Done.** Built in Phase 2.5; the FloodNet team OK'd polling. Starts with the post-soak collector restart. |
| (new) emergencies, traffic, transit, outages | **Notify NYC** CAP RSS (NYC Emergency Management via Everbridge) | **Build it.** Keyless, official, near real time. Plan: `.orchestrate/notify/plan.md`; ROADMAP Phase 2.5 follow-ups. |
| Collisions (~3 d), road speeds (2–4 h) | **511NY** developer API (NYSDOT) | **Phase 5 extra only** (needs a free key; ADR-007 keeps Phases 1–4 keyless). |
| 311 (1–2 d) | NYC 311 Public API (api-portal.nyc.gov) | **No.** Looks up one known SR number at a time; no "new requests" listing; needs a subscription key. Open Data stays the source. |
| Road speeds | DOT `LinkSpeedQuery.txt` (old real-time text feed) | **Dead.** `207.251.86.229` timed out. |
| (anything) | Citizen app | **No.** No public API or developer program; scraping breaks its terms, and it republishes crime reports and user video at exact addresses, against this project's privacy rules. |

## Notify NYC

- **Feed:** `https://feeds.everbridge.net/feeds/453003085617722/rss/rss.xml`, linked from the
  Notify NYC site and FAQ. RSS 2.0, "Notify NYC CAP RSS Feed" (the title has also been seen
  as "NotifyNYC CAP RSS Feed"). Keyless, served via Cloudflare.
- **What's in it:** only the alerts that are **active now**. Each alert is posted once per
  language: English plus Arabic, Bengali, Chinese, French, Haitian Creole, Italian, Korean,
  Polish, Russian, Spanish, Urdu and Yiddish. `<author>` is `NYCEM [English]` and so on.
  Each item has a title, description, `guid` (different per language), `pubDate`,
  `<category>` (Transport, Infra, Safety…), and an `<enclosure>`/`<link>` to a **CAP 1.2 XML**
  file.
- **CAP file** (one archived example, 2026-07-14):
  - `identifier`, `sent`, `status`, `msgType` (Alert / Update / Cancel), `scope`;
  - `info`: language, category, event, urgency, severity, certainty, a SAME `eventCode`
    (`CEM`), `expires` (2 h after sent here), `senderName`, `headline`, `description`;
  - `area`: `areaDesc` ("Bronx,Kings,New York,Queens,Staten Island") and a **polygon**
    (lat,lon pairs).
  - The example polygon covered the whole city.
- **Volume:** the website's "Recent Notifications" listed alerts the same day (e.g. 12:21 PM
  police activity, Hutchinson River Pkwy E and Bartow Ave, BX; 11:27 AM 4 train restored), yet
  the RSS was empty at 4 PM. So items leave the feed when they expire: poll often enough
  (every 2 min, like NWS) to catch them. The FAQ says RSS "may lag behind email and text
  messages" (minutes).
- **Unknowns to settle with live captures:**
  - whether local alerts carry a small polygon (or `circle`) or only a citywide/borough
    polygon with the place in the text;
  - how Update/Cancel reference earlier alerts;
  - whether the CAP `identifier` is stable across languages.

## 511NY

- **Docs:** `511ny.org/developers/doc` (a JS app; read through search snippets). Events at
  `https://511ny.org/api/getevents?key={key}&format=json` (another page shows `/api/v2/get/event`).
  Fields include Latitude, Longitude, LastUpdated, PlannedEndDate. Throttle: 10 calls per
  60 s.
- **Access:** a free 511NY account, then a developer key after approval. The Developer's Access
  Agreement allows giving the data to end users, asks you to pass on its disclaimer, and
  forbids using the logo in a way that implies endorsement. One secondhand source says it covers
  state-maintained roads only (unverified, and it matters for city streets).
- The data.ny.gov copies ("511 NY Events: Beginning 2010", `ah74-pg4w` and siblings) were last
  updated 2024-07-18: dead.
- **Fit:** an optional Phase 5 layer with `auth: key:NY511_API_KEY` (registry), off when the key
  is missing.

## NYC 311 Public API

- **Portal:** `api-portal.nyc.gov` (account plus subscription). Per BetaNYC's `nyc-311-mcp`
  wrapper it offers a city-services calendar, status alerts and **service-request lookup by
  number** (`311-XXXXXXXX`, single or batch). It doesn't search by area or time.
- The 311 website's map shows requests from the last 5 days, but it isn't a public API.

## Sources
- Notify NYC FAQ: https://a858-nycnotify.nyc.gov/NotifyNYC/Home/FAQ
- 511NY: https://511ny.org/developers/doc, https://511ny.org/developers/help, https://511ny.org/developers/daa
- BetaNYC nyc-311-mcp: https://github.com/BetaNYC/nyc-311-mcp
- NYC API portal: https://api-portal.nyc.gov/
- API Tracker (Citizen): https://apitracker.io/a/citizen

# 3D buildings, the sun and shadows: plan (2026-11-17)

Idea (Alex): make the buildings 3D, place the sun in the sky, and show the shadows it casts.
Built as a Phase 5 mode (ADR-017). Keyless: no new data source, nothing to download.

## Research
- **Building heights:** the basemap tiles we already load (OpenFreeMap, OpenMapTiles schema,
  vector source `openmaptiles`, source layer `building`, tiles to z14, overzoomed beyond) carry
  `render_height`, `render_min_height` (m) and `hide_3d` (a building outline whose parts are
  mapped separately) for every footprint. NYC's OSM buildings came from the city's footprint
  import, so heights are broadly right. Checked 2026-11-17 against the live TileJSON.
- **MapLibre 6.18:**
  - `fill-extrusion` draws the buildings.
  - The style `light` is `{anchor: 'map', position: [r, azimuth°, polar°], color, intensity}`.
    The azimuth is clockwise from north and the polar angle is from straight up, so a real sun
    is `[r, sun azimuth, 90° − sun altitude]`.
  - `ImageSource.updateImage({image: canvas, coordinates})` takes a canvas directly: no PNG
    encode, no network.
  - There are **no cast shadows** in MapLibre. Mapbox GL v3 has them, but it's keyed and not
    open. ShadeMap needs a commercial key. deck.gl's shadows are experimental and a large
    dependency. So we compute shadows ourselves.
- **The sun:** its position is astronomy, not data. NOAA's "General Solar Position
  Calculations" (fractional year → equation of time and declination → hour angle → zenith and
  azimuth; sunrise and sunset at zenith 90.833°) is good to well under 0.5° for this use. The
  tests cross-check it against an independent formula (Astronomy Answers / SunCalc style) and
  known NYC values.

## Design
1. **3D toggle** (map control `3D`, URL `3d=1`): shows a `fill-extrusion` layer from zoom 14
   (`render_min_height` → `render_height`, skipping `hide_3d`), in paper tones so data still
   leads. The map tilts to 50° (off: back to 0° and north up). The layer is added by basemap
   `postProcess` with `visibility: none`, so a theme switch keeps it.
2. **Sun toggle** (map control `SUN`, URL `sun=1`):
   - `core/sun.ts` gives the azimuth, altitude, sunrise and sunset for the map centre at the
     clock time. It's recomputed every 60 s, and later from the Phase 3 replay time.
   - The style light follows the sun, so building faces light and shade correctly. At night
     it's a dim, high light.
   - A readout under the controls: `SUN 23° UP · SW · SETS 4:35 PM`, or
     `SUN DOWN · RISES 6:41 AM`.
3. **Shadows** (with SUN, from zoom 15):
   - Buildings come from `querySourceFeatures('openmaptiles', {sourceLayer: 'building'})`.
   - A building part of footprint P and height h, with the sun at altitude α, casts the ground
     shadow P swept from offset 0 to h·k. Here k = cot α in the direction away from the sun.
     Parts are swept from the ground even when they start higher: sweeping each slab of a
     stacked tower only over its own band left anti-aliased seams where the bands met
     (One Vanderbilt, seen in the browser). Only sky bridges over-shade a little.
   - It's drawn on a canvas covering the view, in Web Mercator, as one path per building: P
     at both offsets plus a quad per edge, all wound the same way, so `nonzero` fill unions
     them.
   - **Overlaps merge for free:** the canvas is one colour and one alpha, and the map shows it
     as a raster at a fixed opacity. Separate translucent polygons would darken where they
     overlap.
   - **Roofs:** buildings are drawn from shortest to tallest. Each one draws its shadow, then
     erases its own footprint, so a roof is shaded only by taller buildings.
   - **When it reruns:** after a move settles (once tiles are in), and every 60 s.
   - **Limits:** cot α is capped at sun altitude 3°; shadows are off at night and below zoom
     15. The shadow layer sits above roads and parks, below the extrusions and all data layers.
4. **Limits, said in the readout's tooltip and the About text:** OSM heights aren't surveyed;
   no trees or terrain; shadows fall on the ground and on lower roofs, not up walls. In 3D the
   extrusions hide the shadow on roofs.

## Revised: 3D follows the tilt (2026-11-17)
The `3D` button is gone (Alex: "like Apple Maps, where a gesture tilts the camera and the
buildings appear"):
- **Tilt is the switch:** buildings fade in from 8° of tilt to solid at 25°
  (`scene.buildingOpacity`), and fade out as the map flattens.
- **Desktop gestures:** browsers expose no trackpad tilt or rotate gesture (Safari only rotates),
  so tilt and rotate use modifiers:
  - Alt/Option + scroll tilts; Shift + scroll rotates;
  - Option + arrows (Apple Maps' rotate keys);
  - right- or Ctrl-drag does both (Google Maps' Ctrl+drag).
- **Touch:** standard (two fingers up tilts, twist rotates).
- **Hint:** a one-time card at zoom ≥ 15 names the gestures for the device.

## Zoom lag fix (2026-11-17)
Zooming a tilted map lagged. MapLibre 6 runs **one** worker outside Safari
(`WorkerPool.workerCount = isSafari ? min(cores/2, 3) : 1`). So every tile went through one
thread:
- the 3D building geometry, re-cut at each zoom level past the tiles' z14;
- the trains' 30 fps GeoJSON updates.

The map now runs half the cores, 2–4 (`controller.workerCountFor`; 4 on Alex's 12-core laptop).
Buildings also fade in and grow over z14 → z15 instead of popping in. Frame timings couldn't be
measured through the Chrome extension: a background window is throttled to about 1 fps.

## Built (2026-11-17)
All 7 steps are done. Measured in Chrome in Midtown at z15.8, 1900×1300 px canvas:
- **Shadow recompute:** 30–51 ms for 7.5–9.3k building parts, once per settled move and per
  minute.
- **3D:** smooth at 50° tilt.

The hatching seen near Penn Station and Grand Central is the basemap's rail tracks, not
shadows. Debug hook: `window.__nlSunTime = <epoch ms>` draws the sun for that moment, e.g.
shadows at night. `performance.getEntriesByName('nl-shadows')` gives the recompute timings.

## Steps
| # | Unit | Notes |
|---|---|---|
| 1 | `core/sun.ts` + tests | NOAA position and sunrise/sunset; cross-checked against an independent formula and NYC solstice/equinox values. |
| 2 | Store + URL | `scene: {threeD, sun}`, `3d=1` / `sun=1`. |
| 3 | Basemap layers | Extrusion + shadow image source and raster layer in `postProcess`, hidden. |
| 4 | `map/scene.ts` | Toggles, pitch, light from the sun, the 60 s clock, recompute on `moveend` / `idle`. |
| 5 | `map/shadows.ts` + tests | Pure rasteriser: offsets, winding, height order, footprint erase. |
| 6 | Controls + readout | `3D` and `SUN` chips (pressed state), the sun line. Phone layout. |
| 7 | Perf check | Midtown at z15–16 with pitch: recompute time, frame rate. Lower resolution or the building count if needed. |

## Later
- Replay (Phase 3): the time bar drives the sun, so shadows sweep as you scrub.
- "Sunny side" route hints, or a shade share for parks (needs the same shadow raster per area).

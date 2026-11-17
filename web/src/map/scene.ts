// 3D buildings and the sun over the basemap (ADR-017).
//
// 3D follows the tilt, as in Apple Maps (2026-11-17, no button): tilt past TILT_3D_FROM and the
// buildings from basemap postProcess fade in, solid by TILT_3D_FULL; flatten and they fade out.
// SUN: the style light follows the real sun at the map centre, and from zoom 15 the shadow
// raster is recomputed after each settled move and every 60 s (map/shadows.ts). Both are
// re-applied after a style reload (theme switch).
import type { ImageSource, LightSpecification, Map as MlMap, MapSourceDataEvent } from 'maplibre-gl';
import { useApp, type Scene } from '../core/store';
import { SUN_CLOCK_EVENT, sunClock, sunPosition, type SunPosition } from '../core/sun';
import { BUILDINGS_3D, OMT_SOURCE, SHADOW } from './basemap';
import { drawShadows, partsFrom, type Frame } from './shadows';

/** From this zoom the shadows are computed (fewer, nearer buildings; a readable scale). */
export const SHADOW_MIN_ZOOM = 15;
/** Buildings start to show at this tilt (degrees)… */
export const TILT_3D_FROM = 8;
/** …and are solid from this one. */
export const TILT_3D_FULL = 25;
export const BUILDING_OPACITY = 0.9;
/** Buildings fade in and grow over this zoom range (heights in basemap.sceneLayers). */
export const ZOOM_3D_FROM = 14;
export const ZOOM_3D_FULL = 15;

/** Building opacity for a tilt: 0 when flat, easing up to BUILDING_OPACITY. */
export function buildingOpacity(pitch: number): number {
  const k = Math.min(1, Math.max(0, (pitch - TILT_3D_FROM) / (TILT_3D_FULL - TILT_3D_FROM)));
  return Math.round(k * k * (3 - 2 * k) * BUILDING_OPACITY * 100) / 100;
}
const SUN_TICK_MS = 60_000;
const RECOMPUTE_DEBOUNCE_MS = 200;
/** Canvas side cap (px): enough for a street-scale view, bounded memory and draw time. */
const MAX_CANVAS = 2048;
/** Extra ground around the view (share of its size) so shadows from just outside reach in. */
const MARGIN = 0.25;

const DEFAULT_LIGHT: LightSpecification = { anchor: 'viewport', position: [1.15, 210, 30], color: '#ffffff', intensity: 0.5 };
/** Light: the shade, in ink. Dark: the sunlit ground, a warm glow (drawShadows `invert`). */
const SHADOW_INK = { light: '#1d1d1b', dark: '#ffe2b0' } as const;

/** The style light for a sun position: from its azimuth, as high as it is (dim when it's down). */
export function sunLight(sun: SunPosition): LightSpecification {
  const up = sun.altitude > 0;
  return {
    anchor: 'map',
    position: [1.5, sun.azimuth, up ? Math.min(85, Math.max(5, 90 - sun.altitude)) : 30],
    color: up ? '#fffaf0' : '#c8d0e0',
    intensity: up ? 0.55 : 0.2,
  };
}

export class SceneView {
  private readonly map: MlMap;
  private applied: Scene | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;
  private debounce: ReturnType<typeof setTimeout> | null = null;
  private canvas: HTMLCanvasElement | null = null;
  private readonly unsub: () => void;
  /** Wall clock, overridable later by replay (Phase 3). */
  now: () => number = sunClock;

  constructor(map: MlMap) {
    this.map = map;
    map.on('style.load', this.onStyle);
    map.on('moveend', this.schedule);
    map.on('sourcedata', this.onSourceData);
    map.on('pitch', this.onPitch);
    window.addEventListener(SUN_CLOCK_EVENT, this.tick);
    this.unsub = useApp.subscribe((s, prev) => {
      if (s.scene !== prev.scene || s.theme !== prev.theme) this.apply(s.scene);
    });
  }

  private ready(): boolean {
    return !!this.map.getLayer(BUILDINGS_3D) && !!this.map.getLayer(SHADOW);
  }

  private readonly onStyle = () => {
    // A new style starts with the defaults: re-apply.
    this.applied = null;
    this.lastOpacity = -1;
    this.onPitch();
    this.apply(useApp.getState().scene);
  };

  private lastOpacity = -1;

  /** Buildings fade in as the map tilts and out as it flattens. */
  private readonly onPitch = (): void => {
    if (!this.map.getLayer(BUILDINGS_3D)) return;
    const o = buildingOpacity(this.map.getPitch());
    if (o === this.lastOpacity) return;
    const was = this.lastOpacity;
    this.lastOpacity = o;
    // Fade in with the zoom too, as the buildings grow (basemap: heights ramp z14 → z15), so
    // they never pop in when the first building tiles arrive.
    const byZoom = ['interpolate', ['linear'], ['zoom'], ZOOM_3D_FROM, 0, ZOOM_3D_FULL, o];
    this.map.setPaintProperty(BUILDINGS_3D, 'fill-extrusion-opacity', o > 0 ? (byZoom as never) : 0, { validate: false });
    if ((o > 0) !== (was > 0)) this.map.setLayoutProperty(BUILDINGS_3D, 'visibility', o > 0 ? 'visible' : 'none');
  };

  /** Show or hide the sun and its shadows. */
  apply(scene: Scene): void {
    this.applied = scene;
    if (!this.ready()) return;
    const map = this.map;
    if (scene.sun) {
      if (!this.timer) this.timer = setInterval(this.tick, SUN_TICK_MS);
      this.tick();
    } else {
      if (this.timer) clearInterval(this.timer);
      this.timer = null;
      map.setLight(DEFAULT_LIGHT);
      map.setLayoutProperty(SHADOW, 'visibility', 'none');
    }
  }

  private sun(): SunPosition {
    const c = this.map.getCenter();
    return sunPosition(this.now(), c.lat, c.lng);
  }

  private readonly tick = (): void => {
    if (!this.applied?.sun || !this.ready()) return;
    this.map.setLight(sunLight(this.sun()));
    this.recompute();
  };

  private readonly schedule = (): void => {
    if (!this.applied?.sun) return;
    if (this.debounce) clearTimeout(this.debounce);
    this.debounce = setTimeout(() => {
      this.debounce = null;
      this.tick();
    }, RECOMPUTE_DEBOUNCE_MS);
  };

  private readonly onSourceData = (e: MapSourceDataEvent): void => {
    // New building tiles arrived for the current view.
    if (e.sourceId === OMT_SOURCE && e.isSourceLoaded && e.tile) this.schedule();
  };

  /** Redraw the shadow raster for the current view (hidden below SHADOW_MIN_ZOOM or at night). */
  recompute(): void {
    const map = this.map;
    if (!this.ready()) return;
    const sun = this.sun();
    if (map.getZoom() < SHADOW_MIN_ZOOM || sun.altitude <= 0) {
      map.setLayoutProperty(SHADOW, 'visibility', 'none');
      return;
    }
    const b = map.getBounds();
    const dx = (b.getEast() - b.getWest()) * MARGIN;
    const dy = (b.getNorth() - b.getSouth()) * MARGIN;
    const el = map.getCanvas();
    const scale = Math.min(1, MAX_CANVAS / Math.max(el.clientWidth * (1 + 2 * MARGIN), el.clientHeight * (1 + 2 * MARGIN), 1));
    const frame: Frame = {
      west: b.getWest() - dx,
      east: b.getEast() + dx,
      south: b.getSouth() - dy,
      north: b.getNorth() + dy,
      width: Math.max(1, Math.round(el.clientWidth * (1 + 2 * MARGIN) * scale)),
      height: Math.max(1, Math.round(el.clientHeight * (1 + 2 * MARGIN) * scale)),
    };
    const t0 = performance.now();
    const canvas = (this.canvas ??= document.createElement('canvas'));
    canvas.width = frame.width;
    canvas.height = frame.height;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    const parts = partsFrom(map.querySourceFeatures(OMT_SOURCE, { sourceLayer: 'building' }) as never);
    const theme = useApp.getState().theme;
    drawShadows(ctx, parts, sun, frame, SHADOW_INK[theme], theme === 'dark');
    const src = map.getSource(SHADOW) as ImageSource | undefined;
    src?.updateImage({
      image: canvas,
      coordinates: [
        [frame.west, frame.north],
        [frame.east, frame.north],
        [frame.east, frame.south],
        [frame.west, frame.south],
      ],
    });
    map.setLayoutProperty(SHADOW, 'visibility', 'visible');
    // Readable in devtools: performance.getEntriesByName('nl-shadows').
    performance.measure('nl-shadows', { start: t0, detail: { parts: parts.length, px: [frame.width, frame.height] } });
  }

  destroy(): void {
    this.unsub();
    if (this.timer) clearInterval(this.timer);
    if (this.debounce) clearTimeout(this.debounce);
    this.map.off('style.load', this.onStyle);
    this.map.off('moveend', this.schedule);
    this.map.off('sourcedata', this.onSourceData);
    this.map.off('pitch', this.onPitch);
    window.removeEventListener(SUN_CLOCK_EVENT, this.tick);
  }
}

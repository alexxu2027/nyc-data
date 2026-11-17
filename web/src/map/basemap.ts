// Basemap post-processing (plan §7.3): paper background, muted colours, no POI or shield icons.
// The OpenFreeMap / OpenMapTiles / OpenStreetMap attribution comes from the TileJSON and stays.
import type { LayerSpecification, StyleSpecification } from 'maplibre-gl';
import type { Theme } from '../types';
import type { ThemeTokens } from './styleToPaint';

/** Used until the catalog arrives (same URLs as config/layers.yaml). */
export const FALLBACK_BASEMAPS: Record<Theme, string> = {
  light: 'https://tiles.openfreemap.org/styles/positron',
  dark: 'https://tiles.openfreemap.org/styles/dark',
};

/** 3D buildings and the shadow raster (ADR-017): added hidden; map/scene.ts shows them. */
export const BUILDINGS_3D = 'nl-buildings-3d';
export const SHADOW = 'nl-shadow';
/** The OpenMapTiles vector source of the OpenFreeMap styles (buildings live in it). */
export const OMT_SOURCE = 'openmaptiles';
/** A 1×1 transparent PNG: the shadow image before the first computed frame. */
const BLANK_PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=';
/** Paper-toned buildings, so the data stays in front. */
export const BUILDING_COLOR = { light: '#dbd9d0', dark: '#2c2c2a' } as const;
/**
 * The shadow raster's strength (its canvas is one solid colour, see map/shadows.ts). Light mode
 * draws the shade; dark mode draws the sunlit ground as a faint warm glow instead, because
 * darker-than-dark didn't show (2026-11-17).
 */
export const SHADOW_OPACITY = { light: 0.2, dark: 0.16 } as const;

/** Light mode: the basemap's pure white comes out as this (every colour scales toward it). */
export const LIGHT_WHITE: [number, number, number] = [244, 242, 236];

const HEX = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i;
const FUNC = /^(rgba?|hsla?)\(\s*([^)]+)\)$/i;

function hslToRgb(h: number, s: number, l: number): [number, number, number] {
  const k = (n: number) => (n + h / 30) % 12;
  const a = s * Math.min(l, 1 - l);
  const f = (n: number) => l - a * Math.max(-1, Math.min(k(n) - 3, 9 - k(n), 1));
  return [f(0) * 255, f(8) * 255, f(4) * 255];
}

/** Parse a CSS colour (hex, rgb[a], hsl[a]); null for anything else (named colours, expressions). */
export function parseColor(c: string): [number, number, number, number] | null {
  const s = c.trim();
  const h = HEX.exec(s);
  if (h) {
    const x = h[1].length === 3 ? h[1].replace(/./g, (d) => d + d) : h[1];
    return [parseInt(x.slice(0, 2), 16), parseInt(x.slice(2, 4), 16), parseInt(x.slice(4, 6), 16), 1];
  }
  const m = FUNC.exec(s);
  if (!m) return null;
  const parts = m[2].split(/[\s,/]+/).filter(Boolean).map((p) => parseFloat(p));
  if (parts.length < 3 || parts.some((p) => !Number.isFinite(p))) return null;
  const alpha = parts.length > 3 ? parts[3] : 1;
  if (m[1].toLowerCase().startsWith('rgb')) return [parts[0], parts[1], parts[2], alpha];
  const [r, g, b] = hslToRgb(parts[0], parts[1] / 100, parts[2] / 100);
  return [r, g, b, alpha];
}

/** A colour scaled toward LIGHT_WHITE: white becomes the warm off-white, black stays black. */
export function dimColor(c: string): string {
  const p = parseColor(c);
  if (!p) return c;
  const [r, g, b, a] = p;
  const out = [r, g, b].map((v, i) => Math.round((Math.max(0, Math.min(255, v)) / 255) * LIGHT_WHITE[i]));
  return `rgba(${out[0]},${out[1]},${out[2]},${Math.round(a * 1000) / 1000})`;
}

/** Dim every colour in a paint value (plain strings and colours inside expressions). */
function dimValue(v: unknown): unknown {
  if (typeof v === 'string') return dimColor(v);
  if (Array.isArray(v)) return v.map((x) => (typeof x === 'string' ? dimColor(x) : Array.isArray(x) ? dimValue(x) : x));
  return v;
}

/** Light mode: dim the basemap's colour paint so its whites don't glare (2026-11-17). */
function dimPaint(paint: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(paint)) out[k] = k.endsWith('color') ? dimValue(v) : v;
  return out;
}

/** The scene layers, inserted after the basemap's last non-label layer (above roads). */
export function sceneLayers(theme: Theme): LayerSpecification[] {
  return [
    {
      id: SHADOW,
      type: 'raster',
      source: SHADOW,
      layout: { visibility: 'none' },
      paint: { 'raster-opacity': SHADOW_OPACITY[theme], 'raster-fade-duration': 0, 'raster-resampling': 'linear' },
    },
    {
      id: BUILDINGS_3D,
      type: 'fill-extrusion',
      source: OMT_SOURCE,
      'source-layer': 'building',
      minzoom: 14,
      filter: ['!=', ['get', 'hide_3d'], true],
      layout: { visibility: 'none' },
      paint: {
        'fill-extrusion-color': BUILDING_COLOR[theme],
        // Grow up from the ground over a whole zoom level (and fade in, map/scene.ts) instead
        // of popping in when the first building tiles arrive.
        'fill-extrusion-height': ['interpolate', ['linear'], ['zoom'], 14, 0, 15, ['coalesce', ['get', 'render_height'], 0]],
        'fill-extrusion-base': ['interpolate', ['linear'], ['zoom'], 14, 0, 15, ['coalesce', ['get', 'render_min_height'], 0]],
        'fill-extrusion-opacity': 0, // set from the tilt (map/scene.ts)
        'fill-extrusion-vertical-gradient': true,
      },
    } as LayerSpecification,
  ];
}

/** The one font family OpenFreeMap serves. */
export const MAP_FONT = ['Noto Sans Regular'];

/** Symbol layers whose icons we drop: road shields, one-way arrows, airport and POI icons. */
const ICON_LAYER = /shield|oneway|poi|airport|aerodrome/i;

function isPlaceLabel(l: LayerSpecification): boolean {
  return l.type === 'symbol' && 'source-layer' in l && l['source-layer'] === 'place';
}

/** The id of the basemap's first `place` label layer: data layers go below it. */
export function firstPlaceLayer(layers: Array<{ id: string; type: string; 'source-layer'?: string }>): string | undefined {
  return layers.find((l) => l.type === 'symbol' && l['source-layer'] === 'place')?.id;
}

/** Bump a basemap colour toward the paper so the data colours carry the map. */
function soften(paint: Record<string, unknown>, key: string, theme: Theme) {
  const v = paint[key];
  if (typeof v !== 'string') return;
  // Dark: lift water a touch so coastlines read under dark markers.
  if (theme === 'dark' && key === 'fill-color' && /27\s*,\s*27\s*,\s*29/.test(v)) paint[key] = 'rgb(30,33,38)';
}

/** A minimal style used if the basemap cannot be fetched: data still draws on paper. */
export function offlineStyle(t: ThemeTokens): StyleSpecification {
  return {
    version: 8,
    glyphs: 'https://tiles.openfreemap.org/fonts/{fontstack}/{range}.pbf',
    sources: {},
    layers: [{ id: 'background', type: 'background', paint: { 'background-color': t.paper } }],
  };
}

export function postProcess(style: StyleSpecification, theme: Theme, t: ThemeTokens): StyleSpecification {
  const dimmed = theme === 'light' ? style.layers.map((l) => (l.paint ? ({ ...l, paint: dimPaint(l.paint as Record<string, unknown>) } as LayerSpecification) : l)) : style.layers;
  const layers = dimmed.flatMap((l): LayerSpecification[] => {
    if (l.type === 'background') {
      return [{ ...l, paint: { ...(l.paint ?? {}), 'background-color': t.paper } }];
    }
    if (l.type === 'raster') return []; // Natural Earth relief at z < 6: noise at city scale.
    if (l.type === 'symbol' && ICON_LAYER.test(l.id) && !isPlaceLabel(l)) {
      return [{ ...l, layout: { ...(l.layout ?? {}), visibility: 'none' } }];
    }
    if (l.type === 'symbol' && l.layout && 'icon-image' in l.layout && !('text-field' in l.layout)) {
      return [{ ...l, layout: { ...l.layout, visibility: 'none' } }];
    }
    if (l.type === 'symbol' && l.layout && 'icon-image' in l.layout) {
      // Text with an icon (e.g. a town dot): keep the text, lose the icon.
      const layout = { ...l.layout } as Record<string, unknown>;
      delete layout['icon-image'];
      return [{ ...l, layout } as LayerSpecification];
    }
    if (l.type === 'fill' && l.paint) {
      const paint = { ...l.paint } as Record<string, unknown>;
      soften(paint, 'fill-color', theme);
      return [{ ...l, paint } as LayerSpecification];
    }
    return [l];
  });
  const sources: StyleSpecification['sources'] = { ...style.sources };
  for (const [id, s] of Object.entries(sources)) if (s.type === 'raster') delete sources[id];
  if (!sources[OMT_SOURCE]) return { ...style, sources, layers };
  sources[SHADOW] = {
    type: 'image',
    url: BLANK_PNG,
    coordinates: [
      [-74.3, 40.95],
      [-73.65, 40.95],
      [-73.65, 40.45],
      [-74.3, 40.45],
    ],
  };
  let at = -1;
  layers.forEach((l, i) => {
    if (l.type !== 'symbol') at = i;
  });
  layers.splice(at + 1, 0, ...sceneLayers(theme));
  return { ...style, sources, layers };
}

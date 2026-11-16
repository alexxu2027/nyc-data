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
  const layers = style.layers.flatMap((l): LayerSpecification[] => {
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
  const sources = { ...style.sources };
  for (const [id, s] of Object.entries(sources)) if (s.type === 'raster') delete sources[id];
  return { ...style, sources, layers };
}

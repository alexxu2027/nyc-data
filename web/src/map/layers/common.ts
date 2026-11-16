// Building blocks shared by the per-layer renderers (plan §7.3).
import type {
  ExpressionSpecification,
  FilterSpecification,
  GeoJSONSourceSpecification,
  LayerSpecification,
  Map as MlMap,
} from 'maplibre-gl';
import type { FeatureCollection } from 'geojson';
import type { LayerDef, LayerFeature } from '../../types';
import { glyphImageId } from '../icons';
import { MAP_FONT } from '../basemap';
import type { PulseTarget } from '../pulse';
import { pulsePaint, PULSE_REST } from '../pulse';
import { HOVER, SELECTED, hoverScaled, resolveColor, zoomRadius, type Paint, type ThemeTokens, type Value } from '../styleToPaint';
import type { GlyphName } from '../../ui';

type Expr = ExpressionSpecification;

export interface RenderCtx {
  def: LayerDef;
  paint: Paint;
  t: ThemeTokens;
  /** GeoJSON source id: `nl-<id>`. */
  source: string;
}

export interface ExtraSource {
  id: string;
  build(features: LayerFeature[]): FeatureCollection;
  /** Extra options for this source (e.g. `{promoteId: 'id'}`). */
  spec?: Partial<GeoJSONSourceSpecification>;
}

/** What the controller hands a renderer's `live` hook (ADR-013 item 6). */
export interface LiveCtx {
  map: MlMap;
  def: LayerDef;
  /** GeoJSON source id: `nl-<id>` (not added for raster layers). */
  source: string;
  beforeId: string | undefined;
  reducedMotion(): boolean;
}

export interface LiveHandle {
  /** Called on every features or visibility change (raster layers: `update([], visible)`). */
  update(features: LayerFeature[], visible: boolean): void;
  /** Remove any sources and layers the hook added, if they still exist. */
  destroy(): void;
}

export interface Rendered {
  /** Drawn in this order, below the basemap's place labels. */
  layers: LayerSpecification[];
  /** Selection halos: drawn above every data layer. Opacity follows feature-state `selected`. */
  halo: LayerSpecification[];
  /** MapLibre layer ids that answer hover and click. */
  hit: string[];
  pulse: PulseTarget[];
  /** Extra options for the layer's own source (clustering). */
  source?: Partial<GeoJSONSourceSpecification>;
  /** Derived helper sources (e.g. borough label points). */
  extra?: ExtraSource[];
  /** Rendered as HTML chip markers instead of canvas layers. */
  chips?: boolean;
  /** Per-frame or client-only work (animated trains, radar tiles). */
  live?: (ctx: LiveCtx) => LiveHandle;
}

export const emptyRendered = (): Rendered => ({ layers: [], halo: [], hit: [], pulse: [] });

export const lid = (def: LayerDef, part: string): string => `nl-${def.id}-${part}`;

/** Loose builder: MapLibre's layer types are very strict about expression tuples. */
export function L(spec: Record<string, unknown>): LayerSpecification {
  return spec as unknown as LayerSpecification;
}

const TRANSPARENT = 'rgba(0,0,0,0)';

/** Fill colour: paper when hollow, else the data colour. */
export function fillColor(p: Paint, color: Value = p.color): Value {
  return p.hasHollow ? (['case', p.hollow, p.t.paper, color] as Expr) : color;
}

/** Stroke colour: the data colour when hollow, else theme ink. */
export function strokeColor(p: Paint, color: Value = p.color, ink: string = p.t.ink): Value {
  return p.hasHollow ? (['case', p.hollow, color, ink] as Expr) : ink;
}

/** 1 px ink, 1.5 px when hollow, 2.5 px while hovered. */
export function strokeWidth(p: Paint): Value {
  return p.hasHollow ? (['case', HOVER, 2.5, p.hollow, 1.5, 1] as Expr) : (['case', HOVER, 2.5, 1] as Expr);
}

export interface CircleOpts {
  part?: string;
  /** Base radius (data-driven allowed, not zoom-driven); multiplied by the zoom factor. */
  radius?: Value;
  filter?: FilterSpecification;
  minzoom?: number;
  maxzoom?: number;
  sortKey?: Value | null;
  color?: Value;
  ink?: string;
}

/** The standard marker: data colour fill, 1 px ink stroke; hollow = paper fill, colour stroke. */
export function circle(ctx: RenderCtx, o: CircleOpts = {}): LayerSpecification {
  const p = ctx.paint;
  const color = o.color ?? p.color;
  const sortKey = o.sortKey === undefined ? p.sortKey : o.sortKey;
  return L({
    id: lid(ctx.def, o.part ?? 'circle'),
    type: 'circle',
    source: ctx.source,
    ...(o.filter ? { filter: o.filter } : {}),
    ...(o.minzoom !== undefined ? { minzoom: o.minzoom } : {}),
    ...(o.maxzoom !== undefined ? { maxzoom: o.maxzoom } : {}),
    layout: sortKey !== null && sortKey !== undefined ? { 'circle-sort-key': sortKey } : {},
    paint: {
      'circle-radius': zoomRadius(hoverScaled(o.radius ?? p.radius)),
      'circle-color': fillColor(p, color),
      'circle-stroke-color': strokeColor(p, color, o.ink),
      'circle-stroke-width': strokeWidth(p),
      'circle-pitch-alignment': 'map',
    },
  });
}

/**
 * Selection halo for points: a paper knockout and a 2 px ink ring at the marker radius + 6 px,
 * both centred. (No offset shadow: on a thin ring it reads as a stray second line.) `radius` is the zoomed px radius expression.
 */
export function pointHalo(ctx: RenderCtx, radius: Value, filter?: FilterSpecification): LayerSpecification[] {
  const shown: Expr = ['case', SELECTED, 1, 0];
  const base = {
    type: 'circle',
    source: ctx.source,
    ...(filter ? { filter } : {}),
  };
  const ring = (part: string, color: string, width: number) =>
    L({
      ...base,
      id: lid(ctx.def, part),
      paint: {
        'circle-radius': radius,
        'circle-color': TRANSPARENT,
        'circle-opacity': 0,
        'circle-stroke-color': color,
        'circle-stroke-width': width,
        'circle-stroke-opacity': shown,
      },
    });
  return [ring('halo-knock', ctx.t.paper, 5), ring('halo', ctx.t.ink, 2)];
}

/** Expanding ring under the marker, for features matching the catalog `pulse` where. */
export function pulseCircle(ctx: RenderCtx, extraFilter?: FilterSpecification): { layer: LayerSpecification; target: PulseTarget } {
  const id = lid(ctx.def, 'pulse');
  const rest = pulsePaint('circle', PULSE_REST);
  const filter = extraFilter ? (['all', extraFilter, ctx.paint.pulse] as Expr) : ctx.paint.pulse;
  return {
    layer: L({
      id,
      type: 'circle',
      source: ctx.source,
      filter,
      paint: {
        'circle-radius': rest['circle-radius'],
        'circle-color': TRANSPARENT,
        'circle-opacity': 0,
        'circle-stroke-color': ctx.paint.color,
        'circle-stroke-width': 2,
        'circle-stroke-opacity': rest['circle-stroke-opacity'],
      },
    }),
    target: { id, kind: 'circle' },
  };
}

/** A glyph drawn inside a circle marker: paper on a filled marker, data colour on a hollow one. */
export function glyphInCircle(
  ctx: RenderCtx,
  glyph: GlyphName,
  radius: Value,
  minzoom: number,
  filter?: FilterSpecification,
): LayerSpecification {
  const p = ctx.paint;
  return L({
    id: lid(ctx.def, 'glyph'),
    type: 'symbol',
    source: ctx.source,
    minzoom,
    ...(filter ? { filter } : {}),
    layout: {
      'icon-image': glyphImageId(glyph),
      // Glyph box = 1.2 × radius (the circle's diameter × 0.6), in 16 px units.
      'icon-size': zoomRadius(['*', radius, 1.2 / 16] as Expr),
      'icon-allow-overlap': true,
      'icon-ignore-placement': true,
      ...(p.sortKey ? { 'symbol-sort-key': p.sortKey } : {}),
    },
    paint: {
      'icon-color': p.hasHollow ? (['case', p.hollow, p.color, p.t.paper] as Expr) : p.t.paper,
    },
  });
}

export interface LabelOpts {
  prop: string;
  minzoom?: number;
  maxzoom?: number;
  size?: Value;
  upper?: boolean;
  offset?: [number, number];
  anchor?: string;
  color?: string;
  spacing?: number;
  source?: string;
  part?: string;
  placement?: 'point' | 'line';
}

export function label(ctx: RenderCtx, o: LabelOpts): LayerSpecification {
  const field: Expr = o.upper ? ['upcase', ['to-string', ['get', o.prop]]] : ['to-string', ['get', o.prop]];
  return L({
    id: lid(ctx.def, o.part ?? 'label'),
    type: 'symbol',
    source: o.source ?? ctx.source,
    ...(o.minzoom !== undefined && o.minzoom > 0 ? { minzoom: o.minzoom } : {}),
    ...(o.maxzoom !== undefined ? { maxzoom: o.maxzoom } : {}),
    layout: {
      'text-field': field,
      'text-font': MAP_FONT,
      'text-size': o.size ?? 11,
      'text-letter-spacing': o.spacing ?? 0.02,
      'text-max-width': 12,
      'text-optional': true,
      ...(o.placement ? { 'symbol-placement': o.placement } : {}),
      ...(o.offset ? { 'text-offset': o.offset } : {}),
      ...(o.anchor ? { 'text-anchor': o.anchor } : {}),
    },
    paint: {
      'text-color': o.color ?? ctx.t.ink,
      'text-halo-color': ctx.t.paper,
      'text-halo-width': 1.5,
    },
  });
}

/** Categories of a `match` colour scale: [[value, colour]…] (colours already resolved). */
export function matchCategories(ctx: RenderCtx): Array<[string, string]> {
  const c = ctx.def.style.color;
  if (c.scale !== 'match' || !c.prop) return [];
  return (c.stops ?? []).map(([v, col]) => [String(v), resolveColor(typeof col === 'string' ? col : undefined, ctx.t)]);
}

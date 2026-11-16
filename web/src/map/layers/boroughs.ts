// Borough outlines, the borough-filter mask and the name labels (plan §7.3).
import type { Feature, FeatureCollection, Point, Position } from 'geojson';
import type { LayerFeature } from '../../types';
import { HOVER, scaleToExpr } from '../styleToPaint';
import { L, emptyRendered, label, lid, type RenderCtx, type Rendered } from './common';

/** Mask opacity on boroughs outside the active filter. */
export const MASK_OPACITY = 0.55;

function ringArea(r: Position[]): number {
  let a = 0;
  for (let i = 0, j = r.length - 1; i < r.length; j = i++) a += (r[j][0] + r[i][0]) * (r[j][1] - r[i][1]);
  return Math.abs(a / 2);
}

function ringCentroid(r: Position[]): Position {
  let x = 0;
  let y = 0;
  let a = 0;
  for (let i = 0, j = r.length - 1; i < r.length; j = i++) {
    const f = r[j][0] * r[i][1] - r[i][0] * r[j][1];
    x += (r[j][0] + r[i][0]) * f;
    y += (r[j][1] + r[i][1]) * f;
    a += f;
  }
  if (a === 0) return r[0];
  return [x / (3 * a), y / (3 * a)];
}

/** One label point per borough: the centroid of its largest ring. */
export function labelPoints(features: LayerFeature[]): FeatureCollection<Point> {
  const out: Array<Feature<Point>> = [];
  for (const f of features) {
    const g = f.geometry;
    const polys: Position[][][] = g?.type === 'Polygon' ? [g.coordinates] : g?.type === 'MultiPolygon' ? g.coordinates : [];
    let best: Position[] | null = null;
    let bestA = -1;
    for (const p of polys) {
      const a = p[0] ? ringArea(p[0]) : 0;
      if (a > bestA) {
        bestA = a;
        best = p[0];
      }
    }
    if (!best) continue;
    let c = ringCentroid(best);
    // Brooklyn's centroid lands fine; nudge Queens east of the airports' water.
    if (f.properties.id === 'QN') c = [c[0] + 0.02, c[1] + 0.005];
    out.push({ type: 'Feature', geometry: { type: 'Point', coordinates: c }, properties: { id: f.properties.id, name: f.properties.name ?? f.properties.id } });
  }
  return { type: 'FeatureCollection', features: out };
}

export function boroughs(ctx: RenderCtx): Rendered {
  const r = emptyRendered();
  const t = ctx.t;
  const width = scaleToExpr(ctx.def.style.width, 'number', t, 1);
  const labelSource = `${ctx.source}-label`;
  r.layers.push(
    L({
      id: lid(ctx.def, 'mask'),
      type: 'fill',
      source: ctx.source,
      paint: {
        'fill-color': t.paper,
        'fill-opacity': ['case', ['boolean', ['feature-state', 'masked'], false], MASK_OPACITY, 0],
        'fill-antialias': false,
      },
    }),
    L({
      id: lid(ctx.def, 'line'),
      type: 'line',
      source: ctx.source,
      layout: { 'line-join': 'round' },
      paint: { 'line-color': scaleToExpr(ctx.def.style.color, 'color', t, 'ink'), 'line-width': width, 'line-opacity': ['case', HOVER, 1, 0.85] },
    }),
  );
  const lab = ctx.def.style.label;
  if (lab) {
    r.layers.push(
      label(ctx, {
        prop: 'name',
        source: labelSource,
        minzoom: lab.min_zoom,
        maxzoom: 11.01,
        upper: true,
        spacing: 0.35,
        size: ['interpolate', ['linear'], ['zoom'], 9, 10, 11, 13],
        color: t.muted,
      }),
    );
  }
  r.extra = [{ id: labelSource, build: labelPoints }];
  return r;
}

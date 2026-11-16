// Clustered points (311). Clusters are paper discs with a hard ink offset shadow, a ring in the
// dominant category's colour and the count; `clusterProperties` sums each category (plan §7.3).
import type { ExpressionSpecification } from 'maplibre-gl';
import { MAP_FONT } from '../basemap';
import { zoomRadius } from '../styleToPaint';
import { L, circle, emptyRendered, lid, matchCategories, pointHalo, type RenderCtx, type Rendered } from './common';

type Expr = ExpressionSpecification;

/** Cluster property holding the count of one category. */
export const catKey = (v: string): string => `n_${v.replace(/[^A-Za-z0-9_]/g, '_')}`;

/** `clusterProperties` for a match-coloured layer: one running sum per category. */
export function clusterProperties(prop: string, cats: string[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const c of cats) out[catKey(c)] = ['+', ['case', ['==', ['to-string', ['get', prop]], c], 1, 0]];
  return out;
}

/** Colour of the category with the largest count in a cluster (first wins on ties). */
export function dominantColor(cats: Array<[string, string]>, fallback: string): Expr | string {
  if (!cats.length) return fallback;
  const n = (c: string): Expr => ['to-number', ['get', catKey(c)], 0];
  const max: Expr = cats.length === 1 ? n(cats[0][0]) : (['max', ...cats.map(([c]) => n(c))] as Expr);
  const branches = cats.flatMap(([c, col]) => [['==', n(c), max], col]);
  return ['case', ...branches, fallback] as Expr;
}

/** Cluster disc radius in px, stepped by count: 14 / 18 / 24 / 30 at 10 / 100 / 1,000. */
export const CLUSTER_RADIUS: Expr = ['step', ['get', 'point_count'], 14, 10, 18, 100, 24, 1000, 30];

export function clusters(ctx: RenderCtx): Rendered {
  const r = emptyRendered();
  const t = ctx.t;
  const cats = matchCategories(ctx);
  const prop = ctx.def.style.color.prop ?? '';
  const cl = ctx.def.style.cluster ?? { radius: 46, max_zoom: 13 };
  r.source = {
    cluster: true,
    clusterRadius: cl.radius,
    clusterMaxZoom: cl.max_zoom,
    ...(prop && cats.length ? { clusterProperties: clusterProperties(prop, cats.map(([c]) => c)) } : {}),
  };
  const isCluster: Expr = ['has', 'point_count'];
  const notCluster: Expr = ['!', ['has', 'point_count']];
  const disc = (part: string, paint: Record<string, unknown>) =>
    L({ id: lid(ctx.def, part), type: 'circle', source: ctx.source, filter: isCluster, paint });

  r.layers.push(
    circle(ctx, { part: 'point', filter: notCluster }),
    disc('cluster-shadow', { 'circle-radius': ['+', CLUSTER_RADIUS, 1], 'circle-color': t.ink, 'circle-translate': [2, 2] }),
    disc('cluster', {
      'circle-radius': CLUSTER_RADIUS,
      'circle-color': t.paper,
      'circle-stroke-color': dominantColor(cats, t.muted),
      'circle-stroke-width': 4,
    }),
    disc('cluster-edge', {
      'circle-radius': ['+', CLUSTER_RADIUS, 1],
      'circle-color': 'rgba(0,0,0,0)',
      'circle-opacity': 0,
      'circle-stroke-color': t.ink,
      'circle-stroke-width': 1,
    }),
    L({
      id: lid(ctx.def, 'count'),
      type: 'symbol',
      source: ctx.source,
      filter: isCluster,
      layout: {
        'text-field': ['get', 'point_count_abbreviated'],
        'text-font': MAP_FONT,
        'text-size': ['step', ['get', 'point_count'], 11, 100, 12, 1000, 13],
        'text-allow-overlap': true,
        'text-ignore-placement': true,
      },
      paint: { 'text-color': t.ink },
    }),
  );
  r.hit.push(lid(ctx.def, 'cluster'), lid(ctx.def, 'point'));
  r.halo.push(...pointHalo(ctx, zoomRadius(ctx.paint.radius, 6), notCluster));
  return r;
}

// Road speed segments: ink casing under a speed-stepped line, round caps, dashed gray with no
// reading, faded when stale; slow roads draw on top (plan §7.3).
import type { ExpressionSpecification } from 'maplibre-gl';
import { SELECTED, widthPlus, widthWithHover, type Value } from '../styleToPaint';
import { L, emptyRendered, lid, type RenderCtx, type Rendered } from './common';

type Expr = ExpressionSpecification;

export function speedLines(ctx: RenderCtx): Rendered {
  const r = emptyRendered();
  const p = ctx.paint;
  const solid: Expr = ['!', p.dash];
  const opacity: Value = p.hasFade ? (['case', p.fade, 0.45, 1] as Expr) : 1;
  // Slow traffic on top: sort by -speed (no reading at the bottom).
  const sort: Expr = ['-', 0, ['to-number', ['coalesce', ['get', 'speed_mph'], 999]]];
  const w = p.width;
  const line = (part: string, spec: Record<string, unknown>) => L({ id: lid(ctx.def, part), type: 'line', source: ctx.source, ...spec });

  r.layers.push(
    line('casing', {
      filter: solid,
      layout: { 'line-cap': 'round', 'line-join': 'round', 'line-sort-key': sort },
      paint: { 'line-color': ctx.t.ink, 'line-width': widthWithHover(widthPlus(w, 2), 2), 'line-opacity': opacity },
    }),
    line('line', {
      filter: solid,
      layout: { 'line-cap': 'round', 'line-join': 'round', 'line-sort-key': sort },
      paint: { 'line-color': p.color, 'line-width': widthWithHover(w, 2), 'line-opacity': opacity },
    }),
    line('dash', {
      filter: p.dash,
      layout: { 'line-cap': 'butt', 'line-join': 'round' },
      paint: { 'line-color': p.color, 'line-width': widthWithHover(widthPlus(w, -0.5), 2), 'line-dasharray': [1.2, 1], 'line-opacity': opacity },
    }),
    // Generous transparent hit target so thin segments are easy to hover and tap.
    line('hit', { paint: { 'line-color': 'rgba(0,0,0,0)', 'line-width': 14 } }),
  );
  r.hit.push(lid(ctx.def, 'hit'));

  const shown: Expr = ['case', SELECTED, 1, 0];
  const ring = (part: string, color: string, width: number, translate?: [number, number]) =>
    line(part, {
      layout: { 'line-cap': 'round', 'line-join': 'round' },
      paint: {
        'line-color': color,
        'line-width': width,
        'line-gap-width': widthPlus(w, 4),
        'line-opacity': shown,
        ...(translate ? { 'line-translate': translate } : {}),
      },
    });
  r.halo.push(ring('halo-knock', ctx.t.paper, 4), ring('halo', ctx.t.ink, 2));
  return r;
}

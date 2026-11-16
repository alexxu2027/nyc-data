// NWS alert polygons: severity fill, ink-cased outline, dashed when upcoming, outline pulse at
// severity 3, event label (plan §7.3).
import type { ExpressionSpecification } from 'maplibre-gl';
import { pulsePaint, PULSE_REST } from '../pulse';
import { HOVER, SELECTED, widthPlus, widthWithHover } from '../styleToPaint';
import { L, emptyRendered, label, lid, type RenderCtx, type Rendered } from './common';

type Expr = ExpressionSpecification;

export function polygonAlerts(ctx: RenderCtx): Rendered {
  const r = emptyRendered();
  const p = ctx.paint;
  const solid: Expr = ['!', p.dash];
  const line = (part: string, extra: Record<string, unknown>) => L({ id: lid(ctx.def, part), type: 'line', source: ctx.source, ...extra });

  r.layers.push(
    L({
      id: lid(ctx.def, 'fill'),
      type: 'fill',
      source: ctx.source,
      paint: { 'fill-color': p.color, 'fill-opacity': ['case', HOVER, Math.min(1, p.fillOpacity + 0.14), p.fillOpacity] },
    }),
  );
  if (p.hasPulse) {
    const id = lid(ctx.def, 'pulse');
    const rest = pulsePaint('line', PULSE_REST);
    r.layers.push(line('pulse', { filter: p.pulse, layout: { 'line-join': 'round' }, paint: { 'line-color': p.color, ...rest } }));
    r.pulse.push({ id, kind: 'line' });
  }
  r.layers.push(
    line('casing', {
      filter: solid,
      layout: { 'line-join': 'round' },
      paint: { 'line-color': ctx.t.ink, 'line-width': widthPlus(p.width, 2) },
    }),
    line('outline', {
      filter: solid,
      layout: { 'line-join': 'round' },
      paint: { 'line-color': p.color, 'line-width': widthWithHover(p.width, 1) },
    }),
    line('dash', {
      filter: p.dash,
      paint: { 'line-color': ctx.t.ink, 'line-width': p.width, 'line-dasharray': [2, 1.5] },
    }),
  );
  const lab = ctx.def.style.label;
  if (lab) r.layers.push(label(ctx, { prop: lab.prop, minzoom: lab.min_zoom, upper: true, spacing: 0.12, size: 11 }));
  r.hit.push(lid(ctx.def, 'fill'));

  const shown: Expr = ['case', SELECTED, 1, 0];
  r.halo.push(
    line('halo-shadow', { paint: { 'line-color': ctx.t.ink, 'line-width': 3, 'line-translate': [2, 2], 'line-opacity': shown } }),
    line('halo', { layout: { 'line-join': 'round' }, paint: { 'line-color': ctx.t.ink, 'line-width': 3, 'line-opacity': shown } }),
  );
  return r;
}

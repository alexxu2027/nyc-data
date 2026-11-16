// Circle-marker layers: subway stations, flood sensors, Citi Bike, collisions, elevator outages,
// subway alerts, flood events (plan §7.3), plus the camera badge renderer.
import type { ExpressionSpecification } from 'maplibre-gl';
import { isGlyph } from '../../ui';
import { glyphImageId, iconSizeFor } from '../icons';
import { HOVER, ZOOM_FACTOR, zoomRadius, type Value } from '../styleToPaint';
import { L, circle, emptyRendered, glyphInCircle, label, lid, pointHalo, pulseCircle, type RenderCtx, type Rendered } from './common';

type Expr = ExpressionSpecification;

export interface PointOpts {
  /** Zoom at which the catalog `icon` glyph appears inside the marker. */
  glyphMinZoom?: number;
  /** Overrides the catalog sort (null = none). */
  sortKey?: Value | null;
  /** Label text offset (ems) and anchor. */
  labelOffset?: [number, number];
}

export function points(ctx: RenderCtx, o: PointOpts = {}): Rendered {
  const r = emptyRendered();
  const p = ctx.paint;
  if (p.hasPulse) {
    const pc = pulseCircle(ctx);
    r.layers.push(pc.layer);
    r.pulse.push(pc.target);
  }
  r.layers.push(circle(ctx, { sortKey: o.sortKey }));
  r.hit.push(lid(ctx.def, 'circle'));
  const icon = ctx.def.style.icon;
  if (isGlyph(icon)) r.layers.push(glyphInCircle(ctx, icon, p.radius, o.glyphMinZoom ?? 12));
  const lab = ctx.def.style.label;
  if (lab) {
    r.layers.push(
      label(ctx, {
        prop: lab.prop,
        minzoom: lab.min_zoom,
        size: 11,
        offset: o.labelOffset ?? [0.8, 0],
        anchor: 'left',
      }),
    );
  }
  r.halo.push(...pointHalo(ctx, zoomRadius(p.radius, 6)));
  return r;
}

/** Citi Bike: viridis on pct, radius on capacity; the emptiest stations draw on top. */
export function bikeStations(ctx: RenderCtx): Rendered {
  const sort: Expr = ['-', 1, ['to-number', ['coalesce', ['get', 'pct'], 1]]];
  return points(ctx, { sortKey: sort });
}

/** Zoom where the camera dot becomes a badge with a glyph. */
export const BADGE_ZOOM = 11.5;
/** Badge box in CSS px by zoom. */
const BADGE_PX: Array<[number, number]> = [
  [BADGE_ZOOM, 15],
  [14, 19],
  [17, 24],
];

/**
 * Cameras: a plain dot below z 11.5, then an ink square badge with a paper camera glyph.
 * Offline cameras are muted and hollow at every zoom. The tooltip is text only.
 */
export function cameras(ctx: RenderCtx): Rendered {
  const r = emptyRendered();
  const p = ctx.paint;
  const t = ctx.t;
  const dotR = 3;
  const offline = p.hollow;
  r.layers.push(
    circle(ctx, {
      part: 'dot',
      radius: dotR,
      maxzoom: BADGE_ZOOM,
      color: p.hasHollow ? (['case', offline, t.muted, p.color] as Expr) : p.color,
      ink: t.paper,
    }),
  );
  const badgeSize: Expr = ['interpolate', ['linear'], ['zoom'], ...BADGE_PX.flatMap(([z, px]) => [z, iconSizeFor(px)])] as Expr;
  const glyphSize: Expr = ['interpolate', ['linear'], ['zoom'], ...BADGE_PX.flatMap(([z, px]) => [z, iconSizeFor(px * 0.72)])] as Expr;
  const sym = (part: string, image: string, size: Expr, paint: Record<string, unknown>) =>
    L({
      id: lid(ctx.def, part),
      type: 'symbol',
      source: ctx.source,
      minzoom: BADGE_ZOOM,
      layout: {
        'icon-image': image,
        'icon-size': size,
        'icon-allow-overlap': true,
        'icon-ignore-placement': true,
        'symbol-sort-key': p.hasHollow ? (['case', offline, 0, 1] as Expr) : 1,
      },
      paint,
    });
  const hoverHalo: Expr = ['case', HOVER, 2.5, offline, 1.5, 1];
  r.layers.push(
    sym('badge', glyphImageId('badge'), badgeSize, {
      'icon-color': p.hasHollow ? (['case', offline, t.paper, p.color] as Expr) : p.color,
      'icon-halo-color': p.hasHollow ? (['case', offline, t.muted, HOVER, p.color, t.paper] as Expr) : t.paper,
      'icon-halo-width': hoverHalo,
    }),
    sym('glyph', glyphImageId('camera'), glyphSize, {
      'icon-color': p.hasHollow ? (['case', offline, t.muted, t.paper] as Expr) : t.paper,
    }),
  );
  r.hit.push(lid(ctx.def, 'dot'), lid(ctx.def, 'badge'));

  // Halo radius: dot radius × zoom factor below the badge zoom, half the badge diagonal above.
  const dotStops = ZOOM_FACTOR.filter(([z]) => z < BADGE_ZOOM).map(([z, k]) => [z, dotR * k + 6]);
  const haloR: Expr = [
    'interpolate',
    ['linear'],
    ['zoom'],
    ...dotStops.flat(),
    BADGE_ZOOM - 0.01,
    dotR * 0.85 + 6,
    ...BADGE_PX.flatMap(([z, px]) => [z, Math.round(px * 0.62 + 5)]),
  ] as Expr;
  r.halo.push(...pointHalo(ctx, haloR));
  return r;
}

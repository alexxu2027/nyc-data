// One renderer per catalog layer (plan §7.3). Unknown future layers fall back by kind.
import type { LayerDef } from '../../types';
import { styleToPaint, type ThemeTokens } from '../styleToPaint';
import { boroughs } from './boroughs';
import { clusters } from './clusters';
import { emptyRendered, type RenderCtx, type Rendered } from './common';
import { polygonAlerts } from './nwsAlerts';
import { bikeStations, cameras, points } from './points';
import { speedLines } from './roadSpeeds';

export type Renderer = (ctx: RenderCtx) => Rendered;

const chips: Renderer = () => ({ ...emptyRendered(), chips: true });

export const RENDERERS: Record<string, Renderer> = {
  boroughs,
  nws_alerts: polygonAlerts,
  road_speeds: speedLines,
  complaints_311: clusters,
  subway_stations: (ctx) => points(ctx, { labelOffset: [0.7, 0] }),
  flood_sensors: points,
  citibike: bikeStations,
  cameras,
  collisions: points,
  elevator_outages: (ctx) => points(ctx, { glyphMinZoom: 12 }),
  subway_alerts: (ctx) => points(ctx, { glyphMinZoom: 12 }),
  flood_events: points,
  weather: chips,
  tide_gauge: chips,
};

export function rendererFor(def: LayerDef): Renderer {
  const r = RENDERERS[def.id];
  if (r) return r;
  if (def.style.marker === 'chip') return chips;
  if (def.kind === 'cluster') return clusters;
  if (def.kind === 'line') return speedLines;
  if (def.kind === 'polygon') return polygonAlerts;
  return points;
}

export const sourceId = (layer: string): string => `nl-${layer}`;

export function renderLayer(def: LayerDef, t: ThemeTokens): Rendered {
  return rendererFor(def)({ def, paint: styleToPaint(def, t), t, source: sourceId(def.id) });
}

export { type Rendered } from './common';

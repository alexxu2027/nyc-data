import { createExpression, featureFilter, validateStyleMin, type StyleSpecification } from '@maplibre/maplibre-gl-style-spec';
import { describe, expect, it } from 'vitest';
import { matchesWhere } from '../core';
import type { Catalog, FeatureProps, LayerDef, Scale, Where } from '../types';
import { renderLayer, sourceId } from './layers';
import {
  DARK_TOKENS,
  LIGHT_TOKENS,
  resolveColor,
  scaleToExpr,
  styleToPaint,
  whereToExpr,
  widthWithHover,
  zoomRadius,
  type Value,
} from './styleToPaint';
import rawCatalog from './test/catalog.json';

const catalog = rawCatalog as unknown as Catalog;
const def = (id: string): LayerDef => {
  const d = catalog.layers.find((l) => l.id === id);
  if (!d) throw new Error(`no layer ${id}`);
  return d;
};

type Spec = Parameters<typeof createExpression>[2];
const COLOR: Spec = { type: 'color', 'property-type': 'data-driven', expression: { interpolated: true, parameters: ['zoom', 'feature', 'feature-state'] } } as unknown as Spec;
const NUMBER: Spec = { type: 'number', 'property-type': 'data-driven', expression: { interpolated: true, parameters: ['zoom', 'feature', 'feature-state'] } } as unknown as Spec;

/** Evaluate a paint value the way MapLibre would. */
function evaluate(v: Value, spec: Spec, props: Record<string, unknown> = {}, zoom = 12, state: Record<string, unknown> = {}): unknown {
  const r = createExpression(v, 'test', spec);
  if (r.result !== 'success') throw new Error(JSON.stringify(r.value));
  return r.value.evaluate({ zoom }, { type: 'Point', properties: props } as never, state as never);
}

const hex = (c: unknown): string => {
  const { r, g, b } = c as { r: number; g: number; b: number };
  const h = (x: number) => Math.round(x * 255).toString(16).padStart(2, '0');
  return `#${h(r)}${h(g)}${h(b)}`;
};
const color = (v: Value, props: Record<string, unknown> = {}) => hex(evaluate(v, COLOR, props));
const number = (v: Value, props: Record<string, unknown> = {}, zoom = 12, state: Record<string, unknown> = {}) =>
  evaluate(v, NUMBER, props, zoom, state) as number;

describe('colour tokens', () => {
  it('resolve per theme', () => {
    expect(resolveColor('ink', LIGHT_TOKENS)).toBe(LIGHT_TOKENS.ink);
    expect(resolveColor('ink', DARK_TOKENS)).toBe('#f2f2f2');
    expect(resolveColor('paper', LIGHT_TOKENS)).toBe(LIGHT_TOKENS.paper);
    expect(resolveColor('paper', DARK_TOKENS)).toBe('#0a0a0a');
    expect(resolveColor('muted', DARK_TOKENS)).toBe('#a6a6a6');
    expect(resolveColor('#d55e00', DARK_TOKENS)).toBe('#d55e00');
  });

  it('constant scales use the theme', () => {
    expect(scaleToExpr({ value: 'ink' }, 'color', LIGHT_TOKENS, 'ink')).toBe(LIGHT_TOKENS.ink);
    expect(scaleToExpr({ value: 'ink' }, 'color', DARK_TOKENS, 'ink')).toBe('#f2f2f2');
    expect(styleToPaint(def('subway_stations'), DARK_TOKENS).color).toBe('#f2f2f2');
    expect(styleToPaint(def('flood_sensors'), DARK_TOKENS).color).toBe('#0072b2');
  });

  it('tokens inside data scales resolve too', () => {
    const s: Scale = { prop: 'k', scale: 'match', stops: [['a', 'ink'], ['b', 'paper']], default: 'muted' };
    const light = scaleToExpr(s, 'color', LIGHT_TOKENS, 'ink');
    const dark = scaleToExpr(s, 'color', DARK_TOKENS, 'ink');
    expect(color(light, { k: 'a' })).toBe(LIGHT_TOKENS.ink);
    expect(color(dark, { k: 'a' })).toBe('#f2f2f2');
    expect(color(dark, { k: 'b' })).toBe('#0a0a0a');
    expect(color(dark, { k: 'zzz' })).toBe('#a6a6a6');
  });
});

describe('scales', () => {
  it('constant number', () => {
    expect(scaleToExpr({ value: 3.5 }, 'number', LIGHT_TOKENS, 4)).toBe(3.5);
    expect(scaleToExpr(undefined, 'number', LIGHT_TOKENS, 4)).toBe(4);
  });

  it('interpolate (citibike pct colour, capacity radius) with default for null', () => {
    const p = styleToPaint(def('citibike'), LIGHT_TOKENS);
    expect(color(p.color, { pct: 0 })).toBe('#440154');
    expect(color(p.color, { pct: 1 })).toBe('#fde725');
    expect(color(p.color, { pct: 0.4 })).toBe('#21918c');
    expect(color(p.color, { pct: null })).toBe('#8a8a8a');
    expect(color(p.color, {})).toBe('#8a8a8a');
    expect(number(p.radius, { capacity: 20 })).toBeCloseTo(4.5);
    expect(number(p.radius, { capacity: 30 })).toBeCloseTo(5.5);
    expect(number(p.radius, { capacity: 500 })).toBeCloseTo(9.5);
    expect(number(p.radius, { capacity: null })).toBeCloseTo(4.5);
  });

  it('step (road speeds) with base and default', () => {
    const p = styleToPaint(def('road_speeds'), LIGHT_TOKENS);
    expect(color(p.color, { speed_mph: 4 })).toBe('#d73027');
    expect(color(p.color, { speed_mph: 10 })).toBe('#fc8d59');
    expect(color(p.color, { speed_mph: 25 })).toBe('#fee090');
    expect(color(p.color, { speed_mph: 49.9 })).toBe('#91bfdb');
    expect(color(p.color, { speed_mph: 60 })).toBe('#4575b4');
    expect(color(p.color, { speed_mph: null })).toBe('#9a9a9a');
  });

  it('step without default (subway alert severity)', () => {
    const p = styleToPaint(def('subway_alerts'), LIGHT_TOKENS);
    expect(color(p.color, { severity: 0 })).toBe('#999999');
    expect(color(p.color, { severity: 1 })).toBe('#e69f00');
    expect(color(p.color, { severity: 2 })).toBe('#d55e00');
    expect(number(p.radius, { n: 6 })).toBeCloseTo(10);
  });

  it('match on strings (311 groups) and on numbers (NWS severity, collision radius)', () => {
    const c311 = styleToPaint(def('complaints_311'), LIGHT_TOKENS).color;
    expect(color(c311, { group: 'noise' })).toBe('#e69f00');
    expect(color(c311, { group: 'water' })).toBe('#0072b2');
    expect(color(c311, { group: 'nope' })).toBe('#999999');
    const nws = styleToPaint(def('nws_alerts'), LIGHT_TOKENS).color;
    expect(color(nws, { severity: 3 })).toBe('#d55e00');
    expect(color(nws, { severity: 0 })).toBe('#9e9e9e');
    expect(color(nws, { severity: 9 })).toBe('#9e9e9e');
    const col = styleToPaint(def('collisions'), LIGHT_TOKENS);
    expect(number(col.radius, { severity: 3 })).toBe(8);
    expect(number(col.radius, { severity: 1 })).toBe(3);
    expect(color(col.color, { severity: 2 })).toBe('#e66101');
  });

  it('zoom width (borough outline, road speeds) is linear in zoom', () => {
    const w = styleToPaint(def('boroughs'), LIGHT_TOKENS).width;
    expect(number(w, {}, 8)).toBeCloseTo(0.6);
    expect(number(w, {}, 10)).toBeCloseTo(0.9);
    expect(number(w, {}, 15)).toBeCloseTo(2);
    const r = styleToPaint(def('road_speeds'), LIGHT_TOKENS).width;
    expect(number(r, {}, 12)).toBeCloseTo(3.5);
    // Hover adds 2 px at every zoom, keeping zoom at the top level.
    const hw = widthWithHover(r, 2);
    expect(number(hw, {}, 12, { hover: true })).toBeCloseTo(5.5);
    expect(number(hw, {}, 12, { hover: false })).toBeCloseTo(3.5);
  });

  it('point radii take the zoom factor (8 → 0.45, 13 → 1, 16 → 1.7)', () => {
    expect(number(zoomRadius(4), {}, 8)).toBeCloseTo(1.8);
    expect(number(zoomRadius(4), {}, 13)).toBeCloseTo(4);
    expect(number(zoomRadius(4), {}, 16)).toBeCloseTo(6.8);
    expect(number(zoomRadius(4, 6), {}, 13)).toBeCloseTo(10);
    const p = styleToPaint(def('collisions'), LIGHT_TOKENS);
    expect(number(zoomRadius(p.radius), { severity: 3 }, 16)).toBeCloseTo(13.6);
  });

  it('sort keys', () => {
    expect(number(styleToPaint(def('collisions'), LIGHT_TOKENS).sortKey as Value, { severity: 3 })).toBe(3);
    const desc = styleToPaint({ ...def('collisions'), style: { ...def('collisions').style, sort: { prop: 'severity', order: 'desc' } } }, LIGHT_TOKENS);
    expect(number(desc.sortKey as Value, { severity: 3 })).toBe(-3);
  });
});

describe('whereToExpr', () => {
  const props: FeatureProps[] = [
    { id: 'a', borough: 'MN', status: 'closed', n: 3, ada: 0, tidal: true, stale: false, depth: 12.5 },
    { id: 'b', borough: 'BK', status: 'open', n: '3', ada: 2, tidal: false, depth: null },
    { id: 'c', borough: null, n: 0 },
  ];
  const wheres: Where[] = [
    { prop: 'status', op: 'eq', value: 'closed' },
    { prop: 'status', op: 'ne', value: 'closed' },
    { prop: 'n', op: 'eq', value: 3 },
    { prop: 'tidal', op: 'eq', value: true },
    { prop: 'stale', op: 'eq', value: true },
    { prop: 'ada', op: 'gt', value: 0 },
    { prop: 'ada', op: 'eq', value: 0 },
    { prop: 'depth', op: 'gte', value: 12 },
    { prop: 'depth', op: 'lt', value: 12 },
    { prop: 'depth', op: 'lte', value: 12.5 },
    { prop: 'status', op: 'in', value: ['open', 'closed'] },
    { prop: 'n', op: 'in', value: [0, 7] },
    { prop: 'missing', op: 'eq', value: 'x' },
    { prop: 'missing', op: 'ne', value: 'x' },
  ];
  for (const w of wheres) {
    it(`${w.prop} ${w.op} ${JSON.stringify(w.value)} agrees with core matchesWhere`, () => {
      const f = featureFilter(whereToExpr(w), 'test');
      for (const p of props) {
        // Core coerces numeric strings for ordering ops; the API serves numbers, so skip those.
        if (['gt', 'gte', 'lt', 'lte'].includes(w.op) && typeof p[w.prop] === 'string') continue;
        expect(f.filter({ zoom: 12 }, { type: 1, properties: p } as never), JSON.stringify(p)).toBe(matchesWhere(p, w));
      }
    });
  }

  it('absent where never matches', () => {
    const f = featureFilter(whereToExpr(undefined), 'test');
    expect(f.filter({ zoom: 12 }, { type: 1, properties: { id: 'a' } } as never)).toBe(false);
  });
});

describe('rendered layers', () => {
  // Every renderer, in both themes, must produce a style MapLibre accepts.
  for (const [theme, t] of [
    ['light', LIGHT_TOKENS],
    ['dark', DARK_TOKENS],
  ] as const) {
    it(`all 14 layers validate (${theme})`, () => {
      const style: StyleSpecification = { version: 8, glyphs: 'https://example.org/{fontstack}/{range}.pbf', sources: {}, layers: [] };
      for (const d of catalog.layers) {
        const r = renderLayer(d, t);
        if (r.chips) continue;
        style.sources[sourceId(d.id)] = { type: 'geojson', data: { type: 'FeatureCollection', features: [] }, promoteId: 'id', ...(r.source ?? {}) } as never;
        for (const x of r.extra ?? []) style.sources[x.id] = { type: 'geojson', data: { type: 'FeatureCollection', features: [] } };
        style.layers.push(...r.layers, ...r.halo);
        expect(r.hit.length, d.id).toBeGreaterThanOrEqual(d.id === 'boroughs' ? 0 : 1);
        for (const h of r.hit) expect(r.layers.some((l) => l.id === h), `${d.id} hit ${h}`).toBe(true);
        for (const l of [...r.layers, ...r.halo]) expect(l.id.startsWith(`nl-${d.id}-`)).toBe(true);
      }
      const errors = validateStyleMin(style).map((e) => e.message);
      expect(errors).toEqual([]);
      expect(new Set(style.layers.map((l) => l.id)).size).toBe(style.layers.length);
    });
  }

  it('weather and tide render as HTML chips', () => {
    expect(renderLayer(def('weather'), LIGHT_TOKENS).chips).toBe(true);
    expect(renderLayer(def('tide_gauge'), LIGHT_TOKENS).chips).toBe(true);
  });

  it('pulse targets exist on flood events, subway alerts and NWS alerts', () => {
    for (const id of ['flood_events', 'subway_alerts', 'nws_alerts']) {
      const r = renderLayer(def(id), LIGHT_TOKENS);
      expect(r.pulse.length, id).toBe(1);
      expect(r.layers.some((l) => l.id === r.pulse[0].id)).toBe(true);
    }
  });

  it('311 source is clustered with per-group sums', () => {
    const r = renderLayer(def('complaints_311'), LIGHT_TOKENS);
    expect(r.source?.cluster).toBe(true);
    expect(r.source?.clusterMaxZoom).toBe(13);
    expect(Object.keys(r.source?.clusterProperties ?? {})).toHaveLength(8);
  });
});

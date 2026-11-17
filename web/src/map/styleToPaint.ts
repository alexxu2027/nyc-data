// Catalog StyleDef -> MapLibre expressions (plan §1 "Style", §7.3). Pure: no map, no DOM.
// Colours come only from here; the tokens ink | paper | muted resolve per theme.
import type { ExpressionSpecification } from 'maplibre-gl';
import type { ColorValue, LayerDef, Scale, Where } from '../types';

export interface ThemeTokens {
  ink: string;
  paper: string;
  muted: string;
  faint: string;
}

/** Fallbacks that match styles/tokens.css, used when the DOM cannot tell us (tests). */
export const LIGHT_TOKENS: ThemeTokens = { ink: '#1d1d1b', paper: '#ecebe4', muted: '#57564f', faint: '#cfcdc4' }; // = styles/tokens.css
export const DARK_TOKENS: ThemeTokens = { ink: '#f2f2f2', paper: '#0a0a0a', muted: '#a6a6a6', faint: '#3d3d3d' };

/** A paint value: a literal or an expression. */
export type Value = ExpressionSpecification | string | number | boolean;
type Expr = ExpressionSpecification;

/** `#rrggbb` passes through; `ink | paper | muted` read the theme. Anything else (or nothing) is ink. */
export function resolveColor(c: ColorValue | number | undefined | null, t: ThemeTokens): string {
  if (c === 'ink' || c === undefined || c === null || typeof c === 'number') return t.ink;
  if (c === 'paper') return t.paper;
  if (c === 'muted') return t.muted;
  if (c === 'faint') return t.faint;
  return c;
}

type Kind = 'color' | 'number';

function out(v: number | ColorValue | undefined, kind: Kind, t: ThemeTokens, fallback: number | string): string | number {
  if (v === undefined || v === null) return fallback;
  if (kind === 'color') return resolveColor(v, t);
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) ? n : fallback;
}

function numericStops(s: Scale): Array<[number, number | ColorValue]> {
  return (s.stops ?? [])
    .map(([x, y]) => [Number(x), y] as [number, number | ColorValue])
    .filter(([x]) => Number.isFinite(x))
    .sort((a, b) => a[0] - b[0])
    .filter((st, i, arr) => i === 0 || st[0] !== arr[i - 1][0]);
}

const get = (prop: string): Expr => ['get', prop];
const isNumber = (prop: string): Expr => ['==', ['typeof', get(prop)], 'number'];

/**
 * One catalog Scale as a paint value.
 * - `{value}`: a constant (colours resolved).
 * - `{prop, scale: interpolate | step | match, stops, base?, default?}`: data-driven; a missing
 *   or non-numeric value takes `default` for interpolate and step.
 * - `{zoom: [[z, w]…]}`: linear in zoom.
 * `fallback` is used when the scale is absent or empty.
 */
export function scaleToExpr(s: Scale | undefined, kind: Kind, t: ThemeTokens, fallback: number | string): Value {
  if (!s) return kind === 'color' ? resolveColor(fallback as string, t) : fallback;
  if (s.zoom && s.zoom.length) {
    const stops = [...s.zoom].sort((a, b) => a[0] - b[0]);
    if (stops.length === 1) return stops[0][1];
    return ['interpolate', ['linear'], ['zoom'], ...stops.flat()] as Expr;
  }
  if (!s.prop || !s.scale) return out(s.value ?? s.default ?? s.base, kind, t, kind === 'color' ? resolveColor(fallback as string, t) : fallback);

  const fb = kind === 'color' ? resolveColor(fallback as string, t) : fallback;
  const dflt = s.default !== undefined ? out(s.default, kind, t, fb) : undefined;

  if (s.scale === 'match') {
    const pairs: Array<string | number> = [];
    const seen = new Set<string>();
    for (const [x, y] of s.stops ?? []) {
      const label = String(x);
      if (seen.has(label)) continue;
      seen.add(label);
      pairs.push(label, out(y, kind, t, fb));
    }
    const otherwise = dflt ?? (s.base !== undefined ? out(s.base, kind, t, fb) : fb);
    if (!pairs.length) return otherwise;
    return ['match', ['to-string', get(s.prop)], ...pairs, otherwise] as Expr;
  }

  const stops = numericStops(s);
  if (s.scale === 'step') {
    const base = s.base !== undefined ? out(s.base, kind, t, fb) : stops.length ? out(stops[0][1], kind, t, fb) : fb;
    const body: Value = stops.length
      ? (['step', ['to-number', get(s.prop)], base, ...stops.flatMap(([x, y]) => [x, out(y, kind, t, fb)])] as Expr)
      : base;
    return dflt !== undefined ? (['case', isNumber(s.prop), body, dflt] as Expr) : body;
  }

  // interpolate
  if (!stops.length) return dflt ?? fb;
  if (stops.length === 1) {
    const only = out(stops[0][1], kind, t, fb);
    return dflt !== undefined ? (['case', isNumber(s.prop), only, dflt] as Expr) : only;
  }
  const interp: Expr = [
    'interpolate',
    ['linear'],
    ['to-number', get(s.prop)],
    ...stops.flatMap(([x, y]) => [x, out(y, kind, t, fb)]),
  ] as Expr;
  return dflt !== undefined ? (['case', isNumber(s.prop), interp, dflt] as Expr) : interp;
}

/**
 * A catalog `where` as a boolean expression, with the same semantics as core `matchesWhere`:
 * eq / ne / in compare as strings (so 3 matches "3", true matches "true"); ordering ops need a
 * number and never match a missing value.
 */
export function whereToExpr(w: Where | undefined | null): Expr {
  if (!w) return ['boolean', false];
  const g = get(w.prop);
  const str: Expr = ['to-string', g];
  const has: Expr = ['!=', ['typeof', g], 'null'];
  switch (w.op) {
    case 'eq':
      return ['all', has, ['==', str, String(w.value)]];
    case 'ne':
      return ['any', ['!', has], ['!=', str, String(w.value)]];
    case 'in': {
      const vals = (Array.isArray(w.value) ? w.value : [w.value]).map(String);
      return ['all', has, ['in', str, ['literal', vals]]];
    }
    case 'gt':
    case 'gte':
    case 'lt':
    case 'lte': {
      const op = { gt: '>', gte: '>=', lt: '<', lte: '<=' }[w.op] as '>' | '>=' | '<' | '<=';
      const v = Number(w.value);
      if (!Number.isFinite(v)) return ['boolean', false];
      return ['case', isNumber(w.prop), [op, ['to-number', g], v], false] as Expr;
    }
    default:
      return ['boolean', false];
  }
}

/** Point radii multiply by this zoom factor (plan §7.3). */
export const ZOOM_FACTOR: Array<[number, number]> = [
  [8, 0.45],
  [11, 0.8],
  [13, 1],
  [16, 1.7],
];

function mul(a: Value, k: number): Value {
  if (typeof a === 'number') return Math.round(a * k * 1000) / 1000;
  if (k === 1) return a;
  return ['*', a, k] as Expr;
}

function add(a: Value, k: number): Value {
  if (k === 0) return a;
  if (typeof a === 'number') return Math.round((a + k) * 1000) / 1000;
  return ['+', a, k] as Expr;
}

/**
 * Radius scaled by zoom: `['interpolate', linear, zoom, 8, r×0.45, …]`, then `plus` px added
 * at every stop (for halos). `r` may itself be data-driven (but not zoom-driven).
 */
export function zoomRadius(r: Value, plus = 0): Expr {
  return ['interpolate', ['linear'], ['zoom'], ...ZOOM_FACTOR.flatMap(([z, k]) => [z, add(mul(r, k), plus)])] as Expr;
}

/** Feature-state flags used by the renderers. */
export const HOVER: Expr = ['boolean', ['feature-state', 'hover'], false];
export const SELECTED: Expr = ['boolean', ['feature-state', 'selected'], false];

/** `r` grows ×1.25 while hovered. */
export function hoverScaled(r: Value): Value {
  return ['*', r, ['case', HOVER, 1.25, 1]] as Expr;
}

/** A width scale (constant, data or zoom) plus `extra` px while hovered. Zoom stays top-level. */
export function widthWithHover(w: Value, extra: number): Value {
  const bump = (x: Value): Value => ['+', x, ['case', HOVER, extra, 0]] as Expr;
  if (Array.isArray(w) && w[0] === 'interpolate' && JSON.stringify(w[2]) === '["zoom"]') {
    const head = w.slice(0, 3);
    const rest = w.slice(3);
    const stops: unknown[] = [];
    for (let i = 0; i < rest.length; i += 2) stops.push(rest[i], bump(rest[i + 1] as Value));
    return [...head, ...stops] as Expr;
  }
  return bump(w);
}

/** Add `k` px to every output of a width value, keeping a zoom interpolate at the top. */
export function widthPlus(w: Value, k: number): Value {
  if (Array.isArray(w) && w[0] === 'interpolate' && JSON.stringify(w[2]) === '["zoom"]') {
    const head = w.slice(0, 3);
    const rest = w.slice(3);
    const stops: unknown[] = [];
    for (let i = 0; i < rest.length; i += 2) stops.push(rest[i], add(rest[i + 1] as Value, k));
    return [...head, ...stops] as Expr;
  }
  return add(w, k);
}

/** Everything a renderer needs from a layer's catalog style, resolved for one theme. */
export interface Paint {
  color: Value;
  radius: Value;
  width: Value;
  fillOpacity: number;
  hollow: Expr;
  pulse: Expr;
  dash: Expr;
  fade: Expr;
  hasHollow: boolean;
  hasPulse: boolean;
  hasDash: boolean;
  hasFade: boolean;
  /** circle-sort-key / symbol-sort-key, or null when the catalog sets no sort. */
  sortKey: Value | null;
  t: ThemeTokens;
}

export function styleToPaint(def: LayerDef, t: ThemeTokens): Paint {
  const s = def.style;
  let sortKey: Value | null = null;
  if (s.sort) {
    const v: Expr = ['to-number', ['get', s.sort.prop], 0];
    sortKey = s.sort.order === 'desc' ? (['-', 0, v] as Expr) : v;
  }
  return {
    color: scaleToExpr(s.color, 'color', t, 'ink'),
    radius: scaleToExpr(s.radius, 'number', t, 4),
    width: scaleToExpr(s.width, 'number', t, 1),
    fillOpacity: typeof s.fill_opacity === 'number' ? s.fill_opacity : 0.22,
    hollow: whereToExpr(s.hollow),
    pulse: whereToExpr(s.pulse),
    dash: whereToExpr(s.dash),
    fade: whereToExpr(s.fade),
    hasHollow: !!s.hollow,
    hasPulse: !!s.pulse,
    hasDash: !!s.dash,
    hasFade: !!s.fade,
    sortKey,
    t,
  };
}

/**
 * The map's theme tokens: the fixed values of styles/tokens.css. They used to be read from the
 * page's computed CSS, but the tokens now fade between themes (core/autoTheme.ts), so a read
 * mid-fade would paint the map in an in-between colour.
 */
export function readTokens(theme: 'light' | 'dark'): ThemeTokens {
  return theme === 'dark' ? DARK_TOKENS : LIGHT_TOKENS;
}

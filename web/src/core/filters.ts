// Filter semantics (plan §1 "Filter", §4). Pure functions, no store access.
import type { BoroughCode, FeatureProps, FilterDef, FilterValue, LayerDef, LayerFeature, Where } from '../types';

/** The value of every filter on a layer: the override if present, else the catalog default. */
export function effectiveFilters(
  def: LayerDef,
  overrides?: Record<string, FilterValue>,
): Record<string, FilterValue> {
  const out: Record<string, FilterValue> = {};
  for (const f of def.filters) {
    const o = overrides?.[f.key];
    out[f.key] = o !== undefined ? o : f.default;
  }
  return out;
}

function sameScalar(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (a === null || a === undefined || b === null || b === undefined) return false;
  return String(a) === String(b);
}

function toNum(v: unknown): number | null {
  if (v === null || v === undefined || v === '' || typeof v === 'boolean') return null;
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) ? n : null;
}

/** Does a feature's properties satisfy one `where` clause? Missing or null props never match
 * an ordering op; `eq`/`in` compare strictly first, then by `String()` (so 3 matches "3"). */
export function matchesWhere(props: FeatureProps, w: Where): boolean {
  const v = props[w.prop];
  switch (w.op) {
    case 'eq':
      return sameScalar(v, w.value);
    case 'ne':
      return !sameScalar(v, w.value);
    case 'in':
      return Array.isArray(w.value) ? w.value.some((x) => sameScalar(v, x)) : sameScalar(v, w.value);
    case 'gt':
    case 'gte':
    case 'lt':
    case 'lte': {
      const a = toNum(v);
      const b = toNum(w.value);
      if (a === null || b === null) return false;
      if (w.op === 'gt') return a > b;
      if (w.op === 'gte') return a >= b;
      if (w.op === 'lt') return a < b;
      return a <= b;
    }
    default:
      return false;
  }
}

type Pred = (p: FeatureProps) => boolean;

function predicateFor(f: FilterDef, value: FilterValue | undefined): Pred | null {
  if (f.apply !== 'client' || value === undefined) return null;
  if (f.type === 'enum') {
    if (!f.prop || !Array.isArray(value)) return null;
    const prop = f.prop;
    const set = new Set(value.map(String));
    // Every option selected is a no-op, so values outside the option list (or missing) still show.
    const opts = f.options ?? [];
    if (opts.length > 0 && opts.every((o) => set.has(o.value))) return null;
    return (p) => {
      const v = p[prop];
      return v !== null && v !== undefined && set.has(String(v));
    };
  }
  if (f.type === 'select') {
    const opt = f.options?.find((o) => o.value === String(value));
    const w = opt?.where;
    return w ? (p) => matchesWhere(p, w) : null;
  }
  // toggle
  const w = f.where;
  return value === true && w ? (p) => matchesWhere(p, w) : null;
}

/** Borough rule: null passes always; with any borough selected, `XX` (outside NYC) is hidden. */
export function boroughPasses(b: unknown, boroughs: readonly BoroughCode[]): boolean {
  if (boroughs.length === 0) return true;
  if (b === null || b === undefined) return true;
  return (boroughs as readonly string[]).includes(String(b));
}

/** Apply the borough rule (when `def.borough_filter`) and every client filter. Returns the input
 * array itself when nothing is filtered out. */
export function applyClientFilters(
  features: LayerFeature[],
  def: LayerDef,
  values: Record<string, FilterValue>,
  boroughs: BoroughCode[],
): LayerFeature[] {
  const preds: Pred[] = [];
  if (def.borough_filter && boroughs.length > 0) preds.push((p) => boroughPasses(p.borough, boroughs));
  for (const f of def.filters) {
    const p = predicateFor(f, values[f.key]);
    if (p) preds.push(p);
  }
  if (preds.length === 0) return features;
  const out = features.filter((ft) => {
    const props = ft.properties;
    for (const p of preds) if (!p(props)) return false;
    return true;
  });
  return out.length === features.length ? features : out;
}

/** Query params for server filters: `{'f.window': '48h'}`. Always sent (even at the default) so
 * the request is explicit. Enum values join with commas; toggles send `1` when on. */
export function serverParams(def: LayerDef, values: Record<string, FilterValue>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const f of def.filters) {
    if (f.apply !== 'server') continue;
    const v = values[f.key] ?? f.default;
    if (f.type === 'toggle') {
      if (v === true) out[`f.${f.key}`] = '1';
    } else if (Array.isArray(v)) {
      out[`f.${f.key}`] = v.join(',');
    } else {
      out[`f.${f.key}`] = String(v);
    }
  }
  return out;
}

/** True when `v` equals the filter's default (enum compares as a set). */
export function isDefaultValue(f: FilterDef, v: FilterValue): boolean {
  const d = f.default;
  if (Array.isArray(d) || Array.isArray(v)) {
    if (!Array.isArray(d) || !Array.isArray(v)) return false;
    const a = new Set(d.map(String));
    const b = new Set(v.map(String));
    return a.size === b.size && [...a].every((x) => b.has(x));
  }
  if (f.type === 'toggle') return Boolean(v) === Boolean(d);
  return String(v) === String(d);
}

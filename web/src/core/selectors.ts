// Memoised read hooks (plan §4). `useLayerView(id).features` keeps its identity until that
// layer's `rev`, its filter overrides, or (for borough-filtered layers) the boroughs change.
import type { BoroughCode, FilterValue, LayerData, LayerDef, LayerFeature, LayerMeta, SourceState } from '../types';
import { applyClientFilters, effectiveFilters } from './filters';
import { type AppState, EMPTY_LAYER_DATA, useApp } from './store';

export interface LayerView {
  def: LayerDef;
  visible: boolean;
  status: LayerData['status'];
  features: LayerFeature[];
  count: number;
  total: number;
  meta: LayerMeta | null;
  rev: number;
  error: string | null;
  fetchedAt: number | null;
  nextAt: number | null;
}

const NO_BOROUGHS: BoroughCode[] = [];

function placeholderDef(id: string): LayerDef {
  return {
    id,
    label: id,
    short: id,
    group: '',
    kind: 'point',
    sources: [],
    default: false,
    poll_s: 0,
    z: 0,
    borough_filter: false,
    list: false,
    detail: { type: 'none' },
    attribution: { text: '', url: '' },
    lag_note: null,
    empty_text: null,
    legend_title: '',
    filters: [],
    style: { color: { value: 'ink' } },
    legend: [],
    raster: null,
    changes: null,
  };
}

interface FeatCache {
  def: LayerDef;
  raw: LayerFeature[];
  boroughs: BoroughCode[];
  overrides: Record<string, FilterValue> | undefined;
  out: LayerFeature[];
}
interface ViewCache {
  def: LayerDef;
  data: LayerData;
  visible: boolean;
  features: LayerFeature[];
  out: LayerView;
}

const featCache = new Map<string, FeatCache>();
const viewCache = new Map<string, ViewCache>();
const placeholders = new Map<string, LayerDef>();

function findDef(s: AppState, id: string): LayerDef {
  const d = s.catalog?.layers.find((l) => l.id === id);
  if (d) return d;
  let p = placeholders.get(id);
  if (!p) placeholders.set(id, (p = placeholderDef(id)));
  return p;
}

/** Filtered features of a layer, memoised per layer id. */
export function selectLayerFeatures(s: AppState, id: string): LayerFeature[] {
  const def = findDef(s, id);
  const raw = (s.data[id] ?? EMPTY_LAYER_DATA).features;
  const boroughs = def.borough_filter ? s.boroughs : NO_BOROUGHS;
  const overrides = s.filters[id];
  const c = featCache.get(id);
  if (c && c.def === def && c.raw === raw && c.boroughs === boroughs && c.overrides === overrides) return c.out;
  const out = applyClientFilters(raw, def, effectiveFilters(def, overrides), boroughs);
  featCache.set(id, { def, raw, boroughs, overrides, out });
  return out;
}

/** Whole layer view, memoised so it is safe as a Zustand selector result. */
export function selectLayerView(s: AppState, id: string): LayerView {
  const def = findDef(s, id);
  const data = s.data[id] ?? EMPTY_LAYER_DATA;
  const visible = s.visible.includes(id);
  const features = selectLayerFeatures(s, id);
  const c = viewCache.get(id);
  if (c && c.def === def && c.data === data && c.visible === visible && c.features === features) return c.out;
  const out: LayerView = {
    def,
    visible,
    status: data.status,
    features,
    count: features.length,
    total: data.features.length,
    meta: data.meta,
    rev: data.rev,
    error: data.error,
    fetchedAt: data.fetchedAt,
    nextAt: data.nextAt,
  };
  viewCache.set(id, { def, data, visible, features, out });
  return out;
}

export function useLayerView(id: string): LayerView {
  return useApp((s) => selectLayerView(s, id));
}

export function useLayerDef(id: string): LayerDef | undefined {
  return useApp((s) => s.catalog?.layers.find((l) => l.id === id));
}

const RANK: Record<SourceState, number> = { ok: 0, stale: 1, never: 2, degraded: 3 };

/** Worst health state among the layer's sources. A layer with no sources (static) is `ok`;
 * `unknown` before health arrives or when a source is missing from it. */
export function selectLayerHealth(s: AppState, id: string): SourceState | 'unknown' {
  const def = s.catalog?.layers.find((l) => l.id === id);
  if (!def || !s.health) return 'unknown';
  let worst: SourceState = 'ok';
  for (const src of def.sources) {
    const h = s.health.sources.find((x) => x.id === src);
    if (!h) return 'unknown';
    if (RANK[h.state] > RANK[worst]) worst = h.state;
  }
  return worst;
}

export function useLayerHealth(id: string): SourceState | 'unknown' {
  return useApp((s) => selectLayerHealth(s, id));
}

/** Test helper. */
export function clearSelectorCache(): void {
  featCache.clear();
  viewCache.clear();
}

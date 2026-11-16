// Shell-local hooks: a shared one-second clock and the visible-layer totals.
import { useSyncExternalStore } from 'react';
import { applyClientFilters, effectiveFilters, useApp, type AppState } from '../core';
import type { BoroughCode, FilterValue, LayerDef, LayerFeature } from '../types';

// ---- One shared clock ----------------------------------------------------------------------

let nowValue = Date.now();
const listeners = new Set<() => void>();
let timer: ReturnType<typeof setInterval> | null = null;

function subscribeNow(cb: () => void): () => void {
  listeners.add(cb);
  if (!timer) {
    nowValue = Date.now();
    timer = setInterval(() => {
      // A hidden tab doesn't need a ticking clock; catch up on the next visible tick.
      if (typeof document !== 'undefined' && document.hidden) return;
      nowValue = Date.now();
      for (const l of listeners) l();
    }, 1000);
  }
  return () => {
    listeners.delete(cb);
    if (!listeners.size && timer) {
      clearInterval(timer);
      timer = null;
    }
  };
}

/** Wall-clock ms, updated once a second (one interval for the whole shell). */
export function useNow(): number {
  return useSyncExternalStore(
    subscribeNow,
    () => nowValue,
    () => nowValue,
  );
}

// ---- Totals over visible layers -----------------------------------------------------------

interface CountCache {
  def: LayerDef;
  raw: LayerFeature[];
  boroughs: BoroughCode[];
  overrides: Record<string, FilterValue> | undefined;
  count: number;
}
const counts = new Map<string, CountCache>();
const NONE: BoroughCode[] = [];

/** Same rule as `useLayerView(id).count` (borough + client filters), memoised per layer. */
function layerCount(s: AppState, def: LayerDef): number {
  const raw = s.data[def.id]?.features ?? [];
  const boroughs = def.borough_filter ? s.boroughs : NONE;
  const overrides = s.filters[def.id];
  const c = counts.get(def.id);
  if (c && c.def === def && c.raw === raw && c.boroughs === boroughs && c.overrides === overrides) return c.count;
  const count = applyClientFilters(raw, def, effectiveFilters(def, overrides), boroughs).length;
  counts.set(def.id, { def, raw, boroughs, overrides, count });
  return count;
}

/** Features drawn across visible layers (a number, so the selector result is a primitive). */
export function selectVisibleFeatures(s: AppState): number {
  if (!s.catalog) return 0;
  let sum = 0;
  for (const def of s.catalog.layers) if (s.visible.includes(def.id)) sum += layerCount(s, def);
  return sum;
}

/** Soonest scheduled refresh among visible layers, or null. */
export function selectNextRefresh(s: AppState): number | null {
  let min: number | null = null;
  for (const id of s.visible) {
    const t = s.data[id]?.nextAt ?? null;
    if (t !== null && (min === null || t < min)) min = t;
  }
  return min;
}

/** The newest successful fetch among visible layers, or null. */
export function selectLastFetch(s: AppState): number | null {
  let max: number | null = null;
  for (const id of s.visible) {
    const t = s.data[id]?.fetchedAt ?? null;
    if (t !== null && (max === null || t > max)) max = t;
  }
  return max;
}

export function useVisibleTotals(): { layers: number; features: number; nextAt: number | null; lastAt: number | null } {
  const layers = useApp((s) => s.visible.length);
  const features = useApp(selectVisibleFeatures);
  const nextAt = useApp(selectNextRefresh);
  const lastAt = useApp(selectLastFetch);
  return { layers, features, nextAt, lastAt };
}

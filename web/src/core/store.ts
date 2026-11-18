// The app store (plan §4). Units talk only through it.
import { create, type StoreApi, type UseBoundStore } from 'zustand';
import type { BoroughCode, Catalog, FeedState, FilterOverrides, FilterValue, Health, Insets, LayerData, PanelId, Selection, Theme, ThemeMode, ViewState } from '../types';
import { autoTheme } from './autoTheme';
import { sunClock } from './sun';
import { isDefaultValue } from './filters';

export interface AppState {
  catalog: Catalog | null;
  bootError: string | null;
  // URL-backed
  visible: string[];
  boroughs: BoroughCode[] /* [] = all */;
  filters: FilterOverrides;
  view: ViewState;
  viewOrigin: 'url' | 'map' | 'ui';
  selection: Selection;
  /** The theme shown now (AUTO picks it from the sun). */
  theme: Theme;
  /** The theme control: LIGHT, DARK or AUTO (URL-backed as `theme`). */
  themeMode: ThemeMode;
  panel: PanelId | null;
  /** View mode (ADR-017): the sun and its shadows. 3D buildings follow the map's tilt. */
  scene: Scene;
  // runtime
  data: Record<string, LayerData>;
  health: Health | null;
  healthError: string | null;
  hover: { layer: string; id: string } | null;
  insets: Insets;
  fly: { lng: number; lat: number; zoom?: number; nonce: number } | null;
  /** Raster layer opacity overrides (layer id -> 0..1, 0.05 steps). */
  opacity: Record<string, number>;
  feed: FeedState;
  // actions
  setLayerVisible(id: string, on: boolean): void;
  toggleLayer(id: string): void;
  setBoroughs(b: BoroughCode[]): void;
  toggleBorough(b: BoroughCode): void;
  setFilter(layer: string, key: string, value: FilterValue): void;
  resetFilters(layer: string): void;
  setView(v: ViewState, origin: 'url' | 'map' | 'ui'): void;
  flyTo(p: { lng: number; lat: number; zoom?: number }): void;
  select(s: Selection): void;
  setHover(h: { layer: string; id: string } | null): void;
  setTheme(t: Theme): void;
  setThemeMode(m: ThemeMode): void;
  setPanel(p: PanelId | null): void;
  setInsets(i: Insets): void;
  setOpacity(id: string, v: number): void;
  setScene(p: Partial<Scene>): void;
}

export interface Scene {
  sun: boolean;
}

export const SCENE_OFF: Scene = { sun: false };

export const BOROUGH_ORDER: BoroughCode[] = ['MN', 'BK', 'QN', 'BX', 'SI'];

/** Fallback view used before the catalog arrives (matches config/layers.yaml `view`). */
export const FALLBACK_VIEW: ViewState = { lng: -73.955, lat: 40.725, zoom: 10.6, bearing: 0, pitch: 0 };

export const EMPTY_LAYER_DATA: LayerData = Object.freeze({
  status: 'idle',
  features: [],
  meta: null,
  etag: null,
  rev: 0,
  fetchedAt: null,
  nextAt: null,
  error: null,
  changed: [],
  changedAt: null,
}) as LayerData;

export const EMPTY_FEED: FeedState = Object.freeze({
  status: 'idle',
  items: [],
  etag: null,
  fetchedAt: null,
  seenAt: 0,
  error: null,
}) as FeedState;

/** Layer ids in catalog order (unknown ids dropped, duplicates removed). Without a catalog the
 * input order is kept. */
export function orderLayers(ids: Iterable<string>, catalog: Catalog | null): string[] {
  const set = new Set(ids);
  if (!catalog) return [...set];
  return catalog.layers.map((l) => l.id).filter((id) => set.has(id));
}

export function orderBoroughs(b: Iterable<BoroughCode>): BoroughCode[] {
  const set = new Set(b);
  const out = BOROUGH_ORDER.filter((x) => set.has(x));
  return out.length === BOROUGH_ORDER.length ? [] : out; // all five = all
}

/** The page paper per theme (styles/tokens.css), for the browser and iPhone status-bar tint. */
export const THEME_PAPER: Record<Theme, string> = { light: '#ecebe4', dark: '#0a0a0a' };

export function applyThemeToDocument(t: Theme): void {
  if (typeof document === 'undefined') return;
  document.documentElement.dataset.theme = t;
  document.querySelector('meta[name="theme-color"]')?.setAttribute('content', THEME_PAPER[t]);
}

type Data = Omit<
  AppState,
  | 'setLayerVisible'
  | 'toggleLayer'
  | 'setBoroughs'
  | 'toggleBorough'
  | 'setFilter'
  | 'resetFilters'
  | 'setView'
  | 'flyTo'
  | 'select'
  | 'setHover'
  | 'setTheme'
  | 'setThemeMode'
  | 'setPanel'
  | 'setInsets'
  | 'setOpacity'
  | 'setScene'
>;

export function initialData(): Data {
  return {
    catalog: null,
    bootError: null,
    visible: [],
    boroughs: [],
    filters: {},
    view: FALLBACK_VIEW,
    viewOrigin: 'url',
    selection: null,
    theme: 'light',
    themeMode: 'light',
    panel: null,
    scene: SCENE_OFF,
    data: {},
    health: null,
    healthError: null,
    hover: null,
    insets: { top: 0, right: 0, bottom: 0, left: 0 },
    fly: null,
    opacity: {},
    feed: EMPTY_FEED,
  };
}

let flyNonce = 0;

export const useApp: UseBoundStore<StoreApi<AppState>> = create<AppState>()((set, get) => ({
  ...initialData(),

  setLayerVisible(id, on) {
    const s = get();
    if (s.catalog && !s.catalog.layers.some((l) => l.id === id)) return;
    const has = s.visible.includes(id);
    if (on === has) return;
    const visible = on ? orderLayers([...s.visible, id], s.catalog) : s.visible.filter((x) => x !== id);
    const patch: Partial<AppState> = { visible };
    if (!on) {
      if (s.selection && s.selection.layer === id) patch.selection = null;
      if (s.hover && s.hover.layer === id) patch.hover = null;
    }
    set(patch);
  },
  toggleLayer(id) {
    get().setLayerVisible(id, !get().visible.includes(id));
  },
  setBoroughs(b) {
    set({ boroughs: orderBoroughs(b) });
  },
  toggleBorough(b) {
    const cur = get().boroughs;
    set({ boroughs: orderBoroughs(cur.includes(b) ? cur.filter((x) => x !== b) : [...cur, b]) });
  },
  setFilter(layer, key, value) {
    const s = get();
    const def = s.catalog?.layers.find((l) => l.id === layer);
    const fdef = def?.filters.find((f) => f.key === key);
    if (s.catalog && !fdef) return;
    const cur = s.filters[layer] ?? {};
    const next = { ...cur };
    if (fdef && isDefaultValue(fdef, value)) delete next[key];
    else next[key] = value;
    const filters = { ...s.filters };
    if (Object.keys(next).length) filters[layer] = next;
    else delete filters[layer];
    set({ filters });
  },
  resetFilters(layer) {
    const s = get();
    if (!(layer in s.filters)) return;
    const filters = { ...s.filters };
    delete filters[layer];
    set({ filters });
  },
  setView(v, origin) {
    set({ view: v, viewOrigin: origin });
  },
  flyTo(p) {
    flyNonce += 1;
    set({ fly: { ...p, nonce: flyNonce } });
  },
  select(sel) {
    if (sel && !get().visible.includes(sel.layer)) return;
    set({ selection: sel });
  },
  setHover(h) {
    const cur = get().hover;
    if (cur === h || (cur && h && cur.layer === h.layer && cur.id === h.id)) return;
    set({ hover: h });
  },
  setTheme(t) {
    applyThemeToDocument(t);
    set({ theme: t });
  },
  setThemeMode(m) {
    if (m !== 'auto') {
      set({ themeMode: m });
      get().setTheme(m);
      return;
    }
    // AUTO: the theme follows the sun, and so do the light and shadows.
    const s = get();
    set({ themeMode: 'auto', scene: { ...s.scene, sun: true } });
    get().setTheme(autoTheme(sunClock(), s.view.lat, s.view.lng, s.theme));
  },
  setScene(p) {
    const cur = get().scene;
    const next = { ...cur, ...p };
    if (next.sun !== cur.sun) set({ scene: next });
  },
  setPanel(p) {
    set({ panel: p });
  },
  setInsets(i) {
    const c = get().insets;
    if (c.top === i.top && c.right === i.right && c.bottom === i.bottom && c.left === i.left) return;
    set({ insets: i });
  },
  setOpacity(id, v) {
    if (!Number.isFinite(v)) return;
    const q = Math.round(Math.min(1, Math.max(0, v)) / 0.05) * 0.05;
    const next = Math.round(q * 100) / 100;
    if (get().opacity[id] === next) return;
    set({ opacity: { ...get().opacity, [id]: next } });
  },
}));

/** Test helper: back to the initial state (actions are kept). */
export function resetStore(): void {
  useApp.setState(initialData());
}

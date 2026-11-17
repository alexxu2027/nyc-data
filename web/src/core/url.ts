// URL query format (plan §5). `parseUrl` and `serializeUrl` are pure; `startUrlSync` wires them
// to the store and `history`.
import type { BoroughCode, Catalog, FilterOverrides, FilterValue, LayerDef, PanelId, Selection, ThemeMode, ViewState } from '../types';
import { autoTheme } from './autoTheme';
import { sunClock } from './sun';
import { isDefaultValue } from './filters';
import { type AppState, BOROUGH_ORDER, applyThemeToDocument, orderBoroughs, orderLayers, useApp } from './store';

/** §5 `UrlState`, plus the reserved Phase 3 time param `t` (only `live` today), which is parsed
 * and preserved. It is optional and omitted when absent. */
export type UrlState = Pick<AppState, 'visible' | 'boroughs' | 'filters' | 'view' | 'selection' | 'panel' | 'scene'> & {
  /** The theme control (LIGHT, DARK or AUTO), not the theme AUTO happens to show. */
  theme: ThemeMode;
  t?: 'live';
};

const PANELS: PanelId[] = ['layers', 'health', 'about', 'feed'];

const round = (n: number, dp: number) => {
  const f = 10 ** dp;
  const r = Math.round(n * f) / f;
  return Object.is(r, -0) ? 0 : r;
};

function num(s: string | null): number | null {
  if (s === null || s.trim() === '') return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

function defaultView(catalog: Catalog): ViewState {
  const [lng, lat] = catalog.view.center;
  return { lng: round(lng, 5), lat: round(lat, 5), zoom: round(catalog.view.zoom, 2), bearing: 0, pitch: 0 };
}

/** Parse one `f.<layer>.<key>` value; null means invalid or default (dropped). */
function parseFilterValue(def: LayerDef, key: string, raw: string): FilterValue | null {
  const f = def.filters.find((x) => x.key === key);
  if (!f) return null;
  const opts = f.options ?? [];
  let v: FilterValue;
  if (f.type === 'enum') {
    const wanted = new Set(raw === '' ? [] : raw.split(','));
    v = opts.map((o) => o.value).filter((x) => wanted.has(x));
    if (raw !== '' && v.length === 0) return null; // all values unknown
  } else if (f.type === 'select') {
    if (!opts.some((o) => o.value === raw)) return null;
    v = raw;
  } else {
    if (raw === '1' || raw === 'true') v = true;
    else if (raw === '0' || raw === 'false') v = false;
    else return null;
  }
  return isDefaultValue(f, v) ? null : v;
}

function serializeFilterValue(def: LayerDef, key: string, v: FilterValue): string | null {
  const f = def.filters.find((x) => x.key === key);
  if (!f || isDefaultValue(f, v)) return null;
  if (f.type === 'enum') {
    if (!Array.isArray(v)) return null;
    const set = new Set(v.map(String));
    return (f.options ?? []).map((o) => o.value).filter((x) => set.has(x)).join(',');
  }
  if (f.type === 'select') return String(v);
  return v === true ? '1' : '0';
}

export function parseUrl(search: string, catalog: Catalog): UrlState {
  const q = new URLSearchParams(search.startsWith('?') ? search.slice(1) : search);
  const byId = new Map(catalog.layers.map((l) => [l.id, l]));

  const rawLayers = q.get('layers');
  const visible =
    rawLayers === null
      ? catalog.layers.filter((l) => l.default).map((l) => l.id)
      : orderLayers(rawLayers.split(',').filter((id) => byId.has(id)), catalog);

  const rawB = q.get('borough');
  const boroughs = rawB
    ? orderBoroughs(rawB.split(',').filter((b): b is BoroughCode => (BOROUGH_ORDER as string[]).includes(b)))
    : [];

  const filters: FilterOverrides = {};
  for (const [k, raw] of q) {
    if (!k.startsWith('f.')) continue;
    const rest = k.slice(2);
    const dot = rest.indexOf('.');
    if (dot <= 0) continue;
    const def = byId.get(rest.slice(0, dot));
    if (!def) continue;
    const key = rest.slice(dot + 1);
    const v = parseFilterValue(def, key, raw);
    if (v === null) continue;
    (filters[def.id] ??= {})[key] = v;
  }

  const dv = defaultView(catalog);
  const view: ViewState = { ...dv };
  const c = q.get('c')?.split(',');
  if (c && c.length === 2) {
    const lng = num(c[0]);
    const lat = num(c[1]);
    if (lng !== null && lat !== null && Math.abs(lng) <= 180 && Math.abs(lat) <= 90) {
      view.lng = round(lng, 5);
      view.lat = round(lat, 5);
    }
  }
  const z = num(q.get('z'));
  if (z !== null) view.zoom = round(Math.min(catalog.view.max_zoom, Math.max(catalog.view.min_zoom, z)), 2);
  // The map always opens top-down and north up (2026-11-17): tilt and rotation (`p`, `b` in
  // older links) are a moment's view, not part of what a link shares.

  let selection: Selection = null;
  const sel = q.get('sel');
  if (sel) {
    const i = sel.indexOf(':');
    if (i > 0) {
      const layer = sel.slice(0, i);
      const id = sel.slice(i + 1);
      if (byId.has(layer) && id !== '' && visible.includes(layer)) selection = { mode: 'feature', layer, id };
    }
  }
  const list = q.get('list');
  if (!selection && list && byId.get(list)?.list && visible.includes(list)) selection = { mode: 'list', layer: list };

  const rawTheme = q.get('theme');
  const theme: ThemeMode = rawTheme === 'dark' || rawTheme === 'auto' ? rawTheme : 'light';
  const rawPanel = q.get('panel');
  const panel = PANELS.includes(rawPanel as PanelId) ? (rawPanel as PanelId) : null;

  const scene = { sun: q.get('sun') === '1' };

  const out: UrlState = { visible, boroughs, filters, view, selection, theme, panel, scene };
  if (q.get('t') === 'live') out.t = 'live';
  return out;
}

/** Canonical query string with a leading `?`. Values are pre-encoded by hand so `,` and `:` stay
 * readable; ids are `encodeURIComponent`ed. */
export function serializeUrl(s: UrlState, catalog: Catalog): string {
  const byId = new Map(catalog.layers.map((l) => [l.id, l]));
  const parts: string[] = [];
  const add = (k: string, v: string) => parts.push(`${k}=${v}`);
  const enc = encodeURIComponent;

  add('layers', orderLayers(s.visible, catalog).join(','));
  const b = orderBoroughs(s.boroughs);
  if (b.length) add('borough', b.join(','));

  for (const layer of Object.keys(s.filters).sort()) {
    const def = byId.get(layer);
    if (!def) continue;
    const o = s.filters[layer];
    for (const key of Object.keys(o).sort()) {
      const v = serializeFilterValue(def, key, o[key]);
      if (v !== null) add(`f.${layer}.${key}`, v.split(',').map(enc).join(','));
    }
  }

  add('c', `${round(s.view.lng, 5).toFixed(5)},${round(s.view.lat, 5).toFixed(5)}`);
  add('z', round(s.view.zoom, 2).toFixed(2));

  const sel = s.selection;
  if (sel && byId.has(sel.layer)) {
    if (sel.mode === 'feature') add('sel', `${sel.layer}:${enc(sel.id)}`);
    else if (byId.get(sel.layer)?.list) add('list', sel.layer);
  }
  if (s.theme !== 'light') add('theme', s.theme);
  if (s.panel) add('panel', s.panel);
  if (s.scene.sun) add('sun', '1');
  if (s.t === 'live') add('t', 'live');
  return `?${parts.join('&')}`;
}

/** Push a parsed URL state into the store (view origin `url`). */
export function applyUrlState(u: UrlState): void {
  const prev = useApp.getState().theme;
  const theme = u.theme === 'auto' ? autoTheme(sunClock(), u.view.lat, u.view.lng, prev) : u.theme;
  applyThemeToDocument(theme);
  useApp.setState({
    visible: u.visible,
    boroughs: u.boroughs,
    filters: u.filters,
    view: u.view,
    viewOrigin: 'url',
    selection: u.selection,
    theme,
    themeMode: u.theme,
    panel: u.panel,
    scene: u.theme === 'auto' ? { ...u.scene, sun: true } : u.scene,
  });
}

export function urlStateOf(s: AppState, t?: 'live'): UrlState {
  const u: UrlState = {
    visible: s.visible,
    boroughs: s.boroughs,
    filters: s.filters,
    view: s.view,
    selection: s.selection,
    theme: s.themeMode,
    panel: s.panel,
    scene: s.scene,
  };
  if (t) u.t = t;
  return u;
}

/** Keep `location.search` in step with the store: `replaceState`, debounced 250 ms; `popstate`
 * re-applies the URL. `t` is carried over from the URL the sync started with. Returns dispose. */
export function startUrlSync(catalog: Catalog, initialT?: 'live', debounceMs = 250): () => void {
  let t = initialT;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let last = serializeUrl(urlStateOf(useApp.getState(), t), catalog);

  const write = () => {
    timer = null;
    const next = serializeUrl(urlStateOf(useApp.getState(), t), catalog);
    if (next === last && location.search === next) return;
    last = next;
    history.replaceState(history.state, '', `${location.pathname}${next}${location.hash}`);
  };

  const unsub = useApp.subscribe((s, prev) => {
    if (
      s.visible === prev.visible &&
      s.boroughs === prev.boroughs &&
      s.filters === prev.filters &&
      s.view === prev.view &&
      s.selection === prev.selection &&
      s.themeMode === prev.themeMode &&
      s.panel === prev.panel &&
      s.scene === prev.scene
    )
      return;
    if (timer) clearTimeout(timer);
    timer = setTimeout(write, debounceMs);
  });

  const onPop = () => {
    const u = parseUrl(location.search, catalog);
    t = u.t;
    last = serializeUrl(u, catalog);
    applyUrlState(u);
  };
  window.addEventListener('popstate', onPop);

  return () => {
    unsub();
    if (timer) clearTimeout(timer);
    window.removeEventListener('popstate', onPop);
  };
}

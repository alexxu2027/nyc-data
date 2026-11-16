// Pure helpers for the shell (U4). No store access, no DOM: everything here is unit-tested.
import type {
  Catalog,
  FilterDef,
  FilterValue,
  Health,
  LayerData,
  LayerDef,
  LayerFeature,
  LayerMeta,
  LegendItem,
  SourceHealth,
  SourceState,
} from '../types';
import type { FreshState } from '../ui';

// ---- Groups --------------------------------------------------------------------------------

export interface LayerGroup {
  id: string;
  label: string;
  layers: LayerDef[];
}

/**
 * Layers grouped for the panel. Groups keep catalog order; inside a group the layer drawn on
 * top of the map comes first (z descending, like a GIS layer stack), ties broken by label.
 * Layers whose group is not in the catalog land in a trailing "Other" group. Empty groups are
 * dropped.
 */
export function groupLayers(catalog: Pick<Catalog, 'groups' | 'layers'>): LayerGroup[] {
  const known = new Set(catalog.groups.map((g) => g.id));
  const byZ = (a: LayerDef, b: LayerDef) => b.z - a.z || a.label.localeCompare(b.label);
  const out: LayerGroup[] = catalog.groups.map((g) => ({
    id: g.id,
    label: g.label,
    layers: catalog.layers.filter((l) => l.group === g.id).sort(byZ),
  }));
  const orphans = catalog.layers.filter((l) => !known.has(l.group)).sort(byZ);
  if (orphans.length) out.push({ id: '_other', label: 'Other', layers: orphans });
  return out.filter((g) => g.layers.length > 0);
}

// ---- Row state -----------------------------------------------------------------------------

/** What a layer row needs from `useLayerView` (a `LayerData` plus visibility and counts). */
export interface RowInput {
  visible: boolean;
  status: LayerData['status'];
  count: number;
  total: number;
  meta: LayerMeta | null;
  error: string | null;
  rev: number;
  fetchedAt: number | null;
  nextAt: number | null;
}

export interface RowNote {
  key: 'loading' | 'error' | 'empty' | 'filtered' | 'truncated' | 'unlocated' | 'feed';
  text: string;
  /** warn = the yellow highlighter (something failed); muted = an honest caveat. */
  tone: 'warn' | 'muted';
}

export interface RowState {
  /** The FreshDot shape. */
  dot: FreshState;
  /** Accessible name / tooltip for the dot. */
  dotTitle: string;
  /** The number in the fixed-width column; null shows "--". */
  count: number | null;
  /** Lines printed under the row (only while the layer is visible). */
  notes: RowNote[];
}

const n = (x: number) => x.toLocaleString('en-US');

/** "in 2 min" / "2 min ago", coarse and never negative-zero. */
function rel(ms: number, now: number): string {
  const s = Math.round((ms - now) / 1000);
  const a = Math.abs(s);
  const t = a < 60 ? `${Math.max(a, 1)} S` : a < 3600 ? `${Math.round(a / 60)} MIN` : `${Math.round(a / 3600)} H`;
  return s >= 0 ? `IN ${t}` : `${t} AGO`;
}

const DOT_TITLES: Record<FreshState, string> = {
  ok: 'Feed fresh',
  stale: 'Feed stale',
  degraded: 'Feed failing',
  never: 'Feed has no data yet',
  loading: 'Loading',
  off: 'Layer off',
  unknown: 'Feed health unknown',
};

/**
 * The honest state of one layer row, from its data and the worst health of its sources.
 * Order of notes: what went wrong first, then caveats about what is drawn.
 */
export function rowState(
  v: RowInput,
  health: SourceState | 'unknown',
  def: Pick<LayerDef, 'empty_text' | 'list'>,
  now: number,
): RowState {
  const hasData = v.rev > 0;
  if (!v.visible) {
    return { dot: 'off', dotTitle: DOT_TITLES.off, count: hasData ? v.count : null, notes: [] };
  }
  if (!hasData && v.status === 'error') {
    const retry = v.nextAt != null ? `, RETRYING ${rel(v.nextAt, now)}` : '';
    return {
      dot: 'degraded',
      dotTitle: 'Could not load',
      count: null,
      notes: [{ key: 'error', tone: 'warn', text: `COULD NOT LOAD${retry}` }],
    };
  }
  if (!hasData) {
    return { dot: 'loading', dotTitle: DOT_TITLES.loading, count: null, notes: [{ key: 'loading', tone: 'muted', text: 'LOADING' }] };
  }

  const notes: RowNote[] = [];
  if (v.status === 'error') {
    const from = v.fetchedAt != null ? ` FROM ${rel(v.fetchedAt, now)}` : '';
    notes.push({ key: 'error', tone: 'warn', text: `UPDATE FAILED, SHOWING DATA${from}` });
  }
  if (health === 'stale' || health === 'degraded' || health === 'never') {
    const word = health === 'stale' ? 'STALE' : health === 'degraded' ? 'FAILING' : 'NOT COLLECTED YET';
    notes.push({ key: 'feed', tone: 'muted', text: `FEED ${word}: SEE HEALTH` });
  }
  if (v.total === 0) {
    notes.push({ key: 'empty', tone: 'muted', text: (def.empty_text ?? 'NOTHING TO SHOW RIGHT NOW').toUpperCase() });
  } else if (v.count === 0) {
    notes.push({ key: 'filtered', tone: 'muted', text: `NONE OF ${n(v.total)} MATCH THE FILTERS` });
  }
  if (v.meta?.truncated) {
    notes.push({ key: 'truncated', tone: 'muted', text: `SHOWING NEWEST ${n(v.meta.count)} OF ${n(v.meta.total)}` });
  }
  if (v.meta && v.meta.unlocated > 0) {
    const tail = def.list ? ' · IN LIST' : '';
    notes.push({ key: 'unlocated', tone: 'muted', text: `${n(v.meta.unlocated)} NOT ON MAP${tail}` });
  }
  const dot: FreshState = health;
  return { dot, dotTitle: DOT_TITLES[dot], count: v.count, notes };
}

// ---- Filter controls -> setFilter values ---------------------------------------------------

/** All option values of an enum / select filter, in option order. */
export function optionValues(f: FilterDef): string[] {
  return (f.options ?? []).map((o) => o.value);
}

/** The current enum selection as strings (a non-array value counts as nothing selected). */
export function enumSelected(value: FilterValue | undefined): Set<string> {
  return new Set(Array.isArray(value) ? value.map(String) : []);
}

/** Check or uncheck one enum option. The result keeps option order (what the URL writes). */
export function nextEnum(f: FilterDef, current: FilterValue | undefined, option: string, on: boolean): string[] {
  const sel = enumSelected(current);
  if (on) sel.add(option);
  else sel.delete(option);
  return optionValues(f).filter((v) => sel.has(v));
}

/** Every option of an enum selected (no filtering). */
export function allEnum(f: FilterDef): string[] {
  return optionValues(f);
}

/** True when an enum has every option selected. */
export function enumIsAll(f: FilterDef, current: FilterValue | undefined): boolean {
  const sel = enumSelected(current);
  return optionValues(f).every((v) => sel.has(v));
}

/** A select takes the chosen option's value (unknown values fall back to the default). */
export function nextSelect(f: FilterDef, option: string): string {
  return optionValues(f).includes(option) ? option : String(f.default);
}

/** A toggle is a plain boolean. */
export function nextToggle(on: boolean): boolean {
  return on;
}

/** The value a control should show: the override, else the default. */
export function controlValue(f: FilterDef, overrides: Record<string, FilterValue> | undefined): FilterValue {
  const o = overrides?.[f.key];
  return o !== undefined ? o : f.default;
}

// ---- Legend merged into enum filters ------------------------------------------------------

const norm = (s: string) => s.trim().toLowerCase().replace(/\s+/g, ' ');

export interface LegendPlan {
  /** `${filterKey}:${optionValue}` → legend item drawn on that option's row. */
  onOptions: Map<string, LegendItem>;
  /** Legend items not shown on a filter row, in legend order. */
  rest: LegendItem[];
}

/**
 * When an enum option has the same label as a legend item (311 types, collision severity,
 * camera status), the swatch moves onto the option's checkbox row so the legend and the
 * filter are one list. Everything else stays in the plain legend.
 */
export function planLegend(def: Pick<LayerDef, 'legend' | 'filters'>): LegendPlan {
  const byLabel = new Map<string, LegendItem>();
  for (const it of def.legend) if (!byLabel.has(norm(it.label))) byLabel.set(norm(it.label), it);
  const used = new Set<LegendItem>();
  const onOptions = new Map<string, LegendItem>();
  for (const f of def.filters) {
    if (f.type !== 'enum') continue;
    for (const o of f.options ?? []) {
      const it = byLabel.get(norm(o.label));
      if (it && !used.has(it)) {
        used.add(it);
        onOptions.set(`${f.key}:${o.value}`, it);
      }
    }
  }
  return { onOptions, rest: def.legend.filter((it) => !used.has(it)) };
}

/** Count features per `String(properties[prop])` (for the per-option counts). */
export function countBy(features: LayerFeature[], prop: string): Map<string, number> {
  const m = new Map<string, number>();
  for (const f of features) {
    const v = f.properties[prop];
    if (v === null || v === undefined) continue;
    const k = String(v);
    m.set(k, (m.get(k) ?? 0) + 1);
  }
  return m;
}

// ---- Health --------------------------------------------------------------------------------

const RANK: Record<SourceState, number> = { degraded: 0, never: 1, stale: 2, ok: 3 };

/** Sources worst first, then by name. */
export function sortSources(sources: SourceHealth[]): SourceHealth[] {
  return [...sources].sort((a, b) => RANK[a.state] - RANK[b.state] || a.name.localeCompare(b.name));
}

/** The worst state in a health summary (ok when everything is ok). */
export function worstState(h: Pick<Health, 'summary'> | null): FreshState {
  if (!h) return 'unknown';
  const s = h.summary;
  if (s.degraded > 0) return 'degraded';
  if (s.never > 0) return 'never';
  if (s.stale > 0) return 'stale';
  return 'ok';
}

// ---- Formatting ----------------------------------------------------------------------------

/** "45 S", "12 MIN", "3 H 20 MIN", "2 D 4 H". Null shows "--". */
export function fmtDuration(seconds: number | null | undefined): string {
  if (seconds == null || !Number.isFinite(seconds)) return '--';
  const s = Math.max(0, Math.round(seconds));
  if (s < 60) return `${s} S`;
  if (s < 3600) return `${Math.floor(s / 60)} MIN`;
  if (s < 86400) {
    const h = Math.floor(s / 3600);
    const m = Math.floor((s % 3600) / 60);
    return m ? `${h} H ${m} MIN` : `${h} H`;
  }
  const d = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  return h ? `${d} D ${h} H` : `${d} D`;
}

/** Poll cadence as the client runs it (never below 30 s; 0 means once). */
export function fmtPoll(pollS: number): string {
  if (pollS <= 0) return 'LOADED ONCE';
  return `EVERY ${fmtDuration(Math.max(30, pollS))}`;
}

/** A countdown "0:42" / "4:05" / "1:02:00"; "--:--" when unknown. Fixed shape for fixed width. */
export function fmtCountdown(ms: number | null): string {
  if (ms == null || !Number.isFinite(ms)) return '--:--';
  const t = Math.max(0, Math.ceil(ms / 1000));
  const h = Math.floor(t / 3600);
  const m = Math.floor((t % 3600) / 60);
  const s = t % 60;
  const ss = String(s).padStart(2, '0');
  return h ? `${h}:${String(m).padStart(2, '0')}:${ss}` : `${m}:${ss}`;
}

const clockFmt = new Intl.DateTimeFormat('en-US', {
  timeZone: 'America/New_York',
  hour: 'numeric',
  minute: '2-digit',
  second: '2-digit',
  hour12: true,
});

/** The top bar's feed button: "CHANGES", or "CHANGES (3 NEW)" (99+ caps the width). */
export function changesLabel(unread: number): string {
  if (!(unread > 0)) return 'CHANGES';
  return `CHANGES (${unread > 99 ? '99+' : unread} NEW)`;
}

/** "3:28:05 PM ET" (set it in a 14ch box so the status line never shifts). */
export function fmtClock(ms: number): string {
  return `${clockFmt.format(new Date(ms)).replace(/\s/g, ' ')} ET`;
}

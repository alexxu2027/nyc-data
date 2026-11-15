// Frozen shared types (plan §3). Conductor-owned: builders propose changes in their handback.
import type { Feature, Geometry } from 'geojson';
export type BoroughCode = 'MN' | 'BK' | 'QN' | 'BX' | 'SI';
export type FeatureBorough = BoroughCode | 'XX' | null;
export type LayerKind = 'point' | 'line' | 'polygon' | 'cluster';
export type SourceState = 'ok' | 'stale' | 'degraded' | 'never';
export type Theme = 'light' | 'dark';
export type PanelId = 'layers' | 'health' | 'about';
export type ColorValue = string; // '#rrggbb' | 'ink' | 'paper' | 'muted'
export type WhereOp = 'eq' | 'ne' | 'gt' | 'gte' | 'lt' | 'lte' | 'in';
export interface Where { prop: string; op: WhereOp; value: string | number | boolean | Array<string | number> }
export interface FilterOption { value: string; label: string; where?: Where }
export interface FilterDef { key: string; label: string; type: 'enum' | 'select' | 'toggle'; apply: 'client' | 'server';
  prop?: string; options?: FilterOption[]; where?: Where; default: string[] | string | boolean }
export type FilterValue = string[] | string | boolean;
export type FilterOverrides = Record<string, Record<string, FilterValue>>; // layer -> key -> non-default value
export interface Scale { value?: number | ColorValue; prop?: string; scale?: 'interpolate' | 'step' | 'match';
  stops?: Array<[number | string, number | ColorValue]>; base?: number | ColorValue; default?: number | ColorValue;
  zoom?: Array<[number, number]> }
export interface StyleDef { color: Scale; radius?: Scale; width?: Scale; fill_opacity?: number; icon?: string; marker?: 'chip';
  hollow?: Where; pulse?: Where; dash?: Where; fade?: Where; label?: { prop: string; min_zoom: number };
  cluster?: { radius: number; max_zoom: number }; sort?: { prop: string; order: 'asc' | 'desc' } }
export interface LegendItem { label: string; shape: 'circle' | 'ring' | 'square' | 'line' | 'dash' | 'fill' | 'pulse' | 'glyph' | 'size' | 'text';
  color?: ColorValue; glyph?: string }
export type DetailRef = { type: 'entity'; kind: string } | { type: 'event'; source: string } | { type: 'none' };
export interface LayerDef { id: string; label: string; short: string; group: string; kind: LayerKind; sources: string[];
  default: boolean; poll_s: number; z: number; borough_filter: boolean; list: boolean; detail: DetailRef;
  attribution: { text: string; url: string }; lag_note: string | null; empty_text: string | null; legend_title: string;
  filters: FilterDef[]; style: StyleDef; legend: LegendItem[] }
export interface Catalog { version: number; basemaps: { light: string; dark: string };
  view: { center: [number, number]; zoom: number; min_zoom: number; max_zoom: number; bounds: [number, number, number, number] };
  boroughs: Array<{ id: BoroughCode; label: string }>; groups: Array<{ id: string; label: string }>; layers: LayerDef[] }
export interface LayerMeta { layer: string; count: number; total: number; truncated: boolean; unlocated: number;
  data_as_of: string | null; updated_at: string | null; window: { from: string; to: string } | null; note: string | null }
export type FeatureProps = { id: string; borough: FeatureBorough; [k: string]: unknown };
export type LayerFeature = Feature<Geometry, FeatureProps>;
export interface LayerCollection { type: 'FeatureCollection'; meta: LayerMeta; features: LayerFeature[] }
export interface SourceHealth { id: string; name: string; state: SourceState; cadence_s: number; last_success: string | null;
  last_attempt: string | null; age_s: number | null; lag_s: number | null; consecutive_failures: number;
  rows_last_run: number | null; last_error: string | null; runs_24h: number; ok_24h: number; layers: string[] }
export interface Health { now: string; collector: { state: 'running' | 'stalled' | 'unknown'; last_attempt: string | null };
  summary: Record<SourceState, number>; sources: SourceHealth[] }
export interface EventSummary { source: string; id: string; category: string; subtype: string | null; title: string;
  starts_at: string; ends_at: string | null; severity: number; status: 'active' | 'upcoming' | 'ended';
  lat: number | null; lon: number | null; borough: FeatureBorough; routes: string[];
  stations: Array<{ id: string; name: string }>; props: Record<string, unknown> }
export interface EventDetail extends EventSummary { geometry: Geometry | null; entity_refs: string[];
  entities: Array<{ kind: string; id: string; name: string; lat: number | null; lon: number | null }> }
export interface SeriesSpec { label: string; unit: string; metrics: string[]; hours: number; ahead: number }
export interface EntityDetail { kind: string; id: string; source: string; name: string; lat: number | null; lon: number | null;
  borough: FeatureBorough; props: Record<string, unknown>; first_seen: string; last_seen: string;
  latest: Record<string, { value: number; observed_at: string }>; derived: Record<string, unknown>;
  events: EventSummary[]; series: SeriesSpec[] }
export interface SeriesResponse { kind: string; id: string; now: string; from: string; to: string;
  series: Array<{ metric: string; unit: string; points: Array<[number, number]> }> }
export interface EventsPage { layer: string; total: number; limit: number; offset: number; events: EventSummary[] }
export interface ViewState { lng: number; lat: number; zoom: number; bearing: number; pitch: number }
export type Selection = { mode: 'feature'; layer: string; id: string } | { mode: 'list'; layer: string } | null;
export interface Insets { top: number; right: number; bottom: number; left: number }
export interface LayerData { status: 'idle' | 'loading' | 'ready' | 'error'; features: LayerFeature[]; meta: LayerMeta | null;
  etag: string | null; rev: number; fetchedAt: number | null; nextAt: number | null; error: string | null }

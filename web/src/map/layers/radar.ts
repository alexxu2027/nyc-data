// Rain radar (Phase 2.5 U3, ADR-013): RainViewer raster tiles, client-only. The hook polls the
// frame index every max(poll_s, 60) s while the layer is on and the tab is shown, draws the
// newest past frame as a raster layer, and writes the layer's LayerData (no features; meta
// data_as_of = frame time, note STALE past stale_s, status error when the index fails) so the
// panel and the map label read it like any other layer.
import type { Map as MlMap, RasterTileSource } from 'maplibre-gl';
import { useApp } from '../../core';
import type { LayerData, LayerDef, LayerFeature, LayerMeta, RasterDef } from '../../types';
import { L, emptyRendered, type LiveCtx, type LiveHandle, type RenderCtx, type Rendered } from './common';

export const RADAR_SOURCE = 'nl-radar-src';
export const RADAR_LAYER = 'nl-radar-tiles';
export const MIN_POLL_S = 60;
export const STALE_NOTE = 'STALE';
/** Placeholder until the first frame arrives (the layer stays hidden, so it is never fetched). */
const NO_TILES = 'https://tilecache.rainviewer.com/none/{z}/{x}/{y}.png';
/** One shared empty list, so the layer's features keep their identity across polls. */
const NO_FEATURES: LayerFeature[] = [];
const IDLE: LayerData = {
  status: 'idle',
  features: NO_FEATURES,
  meta: null,
  etag: null,
  rev: 0,
  fetchedAt: null,
  nextAt: null,
  error: null,
  changed: [],
  changedAt: null,
};

export interface Frame {
  /** Epoch seconds. */
  time: number;
  path: string;
}

/** Read a dotted path (`radar.past`) out of the index document. */
function pick(doc: unknown, dotted: string): unknown {
  let cur: unknown = doc;
  for (const k of dotted.split('.')) {
    if (cur === null || typeof cur !== 'object') return undefined;
    cur = (cur as Record<string, unknown>)[k];
  }
  return cur;
}

/** The newest well-formed frame at `frames`, or null. */
export function newestFrame(doc: unknown, frames: string): Frame | null {
  const list = pick(doc, frames);
  if (!Array.isArray(list)) return null;
  let best: Frame | null = null;
  for (const f of list) {
    const t = (f as { time?: unknown })?.time;
    const p = (f as { path?: unknown })?.path;
    if (typeof t !== 'number' || !Number.isFinite(t) || typeof p !== 'string' || !p) continue;
    if (!best || t > best.time) best = { time: t, path: p };
  }
  return best;
}

/** The MapLibre tile template for a frame: {host} and {path} filled, {z}/{x}/{y} kept. */
export function tileUrl(r: Pick<RasterDef, 'tiles'>, host: string, frame: Frame): string {
  return r.tiles.split('{host}').join(host.replace(/\/+$/, '')).split('{path}').join(frame.path);
}

export function isStale(frameMs: number, nowMs: number, staleS: number): boolean {
  return nowMs - frameMs > staleS * 1000;
}

export function pollMs(def: Pick<LayerDef, 'poll_s'>): number {
  return Math.max(def.poll_s, MIN_POLL_S) * 1000;
}

/** The radar's LayerData after a successful index fetch. */
export function frameData(prev: LayerData, def: LayerDef, frame: Frame | null, nowMs: number): LayerData {
  const r = def.raster;
  const frameMs = frame ? frame.time * 1000 : null;
  const meta: LayerMeta = {
    layer: def.id,
    count: 0,
    total: 0,
    truncated: false,
    unlocated: 0,
    data_as_of: frameMs !== null ? new Date(frameMs).toISOString() : null,
    updated_at: new Date(nowMs).toISOString(),
    window: null,
    note: frameMs !== null && r && isStale(frameMs, nowMs, r.stale_s) ? STALE_NOTE : null,
  };
  return {
    ...prev,
    status: 'ready',
    features: NO_FEATURES,
    meta,
    etag: null,
    rev: prev.rev + 1,
    fetchedAt: nowMs,
    nextAt: nowMs + pollMs(def),
    error: null,
    changed: [],
    changedAt: null,
  };
}

/** The radar's LayerData after a failed fetch: old frame kept, status error. */
export function errorData(prev: LayerData, def: LayerDef, error: string, nowMs: number): LayerData {
  return { ...prev, status: 'error', error, nextAt: nowMs + pollMs(def) };
}

function writeData(id: string, f: (prev: LayerData) => LayerData): void {
  useApp.setState((s) => ({ data: { ...s.data, [id]: f(s.data[id] ?? IDLE) } }));
}

/** Effective raster opacity: the store override, else the catalog default. */
export function opacityFor(def: LayerDef, overrides: Record<string, number>): number {
  const o = overrides[def.id];
  return typeof o === 'number' && Number.isFinite(o) ? o : (def.raster?.opacity ?? 0.7);
}

export function radar(_ctx: RenderCtx): Rendered {
  const r = emptyRendered();
  r.live = (ctx) => new RadarHook(ctx);
  return r;
}

export interface RadarDeps {
  fetch: typeof fetch;
  now: () => number;
}

export class RadarHook implements LiveHandle {
  private readonly map: MlMap;
  private readonly def: LayerDef;
  private readonly deps: RadarDeps;
  private visible = false;
  private frame: Frame | null = null;
  private url: string | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private abort: AbortController | null = null;
  private lastFetch = 0;
  private disposed = false;
  private readonly unsub: () => void;
  private opacity: number;

  constructor(ctx: LiveCtx, deps: Partial<RadarDeps> = {}) {
    this.map = ctx.map;
    this.def = ctx.def;
    this.deps = { fetch: deps.fetch ?? ((...a) => fetch(...a)), now: deps.now ?? Date.now };
    this.opacity = opacityFor(this.def, useApp.getState().opacity);
    const r = this.def.raster;
    // Added now (hidden, placeholder tiles) so it sits at its catalog z among the data layers.
    if (r && !this.map.getSource(RADAR_SOURCE)) {
      this.map.addSource(RADAR_SOURCE, {
        type: 'raster',
        tiles: [NO_TILES],
        tileSize: r.tile_size,
        maxzoom: r.max_zoom,
        attribution: `<a href="${this.def.attribution.url}" target="_blank" rel="noreferrer">${this.def.attribution.text}</a>`,
      });
    }
    if (r && !this.map.getLayer(RADAR_LAYER)) {
      this.map.addLayer(
        L({
          id: RADAR_LAYER,
          type: 'raster',
          source: RADAR_SOURCE,
          layout: { visibility: 'none' },
          paint: {
            'raster-opacity': this.opacity,
            'raster-opacity-transition': { duration: 0, delay: 0 },
            'raster-fade-duration': 0,
          },
        }),
        ctx.beforeId,
      );
    }
    this.unsub = useApp.subscribe((s, p) => {
      if (s.opacity !== p.opacity) this.setOpacity(opacityFor(this.def, s.opacity));
    });
    if (typeof document !== 'undefined') document.addEventListener('visibilitychange', this.onVisibility);
  }

  update(_features: unknown[], visible: boolean): void {
    if (this.disposed) return;
    this.visible = visible;
    this.applyVisibility();
    if (visible) this.scheduleFromLast();
    else this.stop();
  }

  private applyVisibility(): void {
    if (!this.map.getLayer(RADAR_LAYER)) return;
    const show = this.visible && this.url !== null;
    this.map.setLayoutProperty(RADAR_LAYER, 'visibility', show ? 'visible' : 'none');
  }

  private setOpacity(v: number): void {
    if (v === this.opacity) return;
    this.opacity = v;
    if (this.map.getLayer(RADAR_LAYER)) this.map.setPaintProperty(RADAR_LAYER, 'raster-opacity', v);
  }

  /** Fetch now if a poll is overdue, else wait out the rest of the interval. */
  private scheduleFromLast(): void {
    if (this.timer || this.abort) return;
    const wait = this.lastFetch ? Math.max(0, this.lastFetch + pollMs(this.def) - this.deps.now()) : 0;
    this.schedule(wait);
  }

  private schedule(delay: number): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    if (this.disposed || !this.visible || (typeof document !== 'undefined' && document.hidden)) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.poll();
    }, delay);
  }

  /** One index fetch. Exposed for tests. */
  async poll(): Promise<void> {
    const r = this.def.raster;
    if (!r || this.disposed) return;
    this.abort?.abort();
    const ac = new AbortController();
    this.abort = ac;
    this.lastFetch = this.deps.now();
    try {
      const res = await this.deps.fetch(r.index_url, { cache: 'no-cache', signal: ac.signal });
      if (!res.ok) throw new Error(`RainViewer index HTTP ${res.status}`);
      const doc: unknown = await res.json();
      if (this.disposed || ac.signal.aborted) return;
      const frame = newestFrame(doc, r.frames);
      const host = pick(doc, 'host');
      if (frame && typeof host === 'string' && host) this.show(tileUrl(r, host, frame), frame);
      writeData(this.def.id, (prev) => frameData(prev, this.def, frame ?? this.frame, this.deps.now()));
    } catch (e) {
      if (this.disposed || (e as { name?: string })?.name === 'AbortError') return;
      writeData(this.def.id, (prev) => errorData(prev, this.def, e instanceof Error ? e.message : String(e), this.deps.now()));
    } finally {
      if (this.abort === ac) this.abort = null;
    }
    if (!this.disposed) this.schedule(pollMs(this.def));
  }

  private show(url: string, frame: Frame): void {
    this.frame = frame;
    if (url === this.url) return;
    this.url = url;
    const src = this.map.getSource(RADAR_SOURCE) as RasterTileSource | undefined;
    src?.setTiles([url]);
    this.applyVisibility();
  }

  private stop(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    if (this.abort) {
      this.abort.abort();
      this.abort = null;
      this.lastFetch = 0; // the aborted fetch did not count: fetch again on return
    }
  }

  private readonly onVisibility = (): void => {
    if (document.hidden) this.stop();
    else if (this.visible) this.scheduleFromLast();
  };

  destroy(): void {
    this.disposed = true;
    this.stop();
    this.unsub();
    if (typeof document !== 'undefined') document.removeEventListener('visibilitychange', this.onVisibility);
    try {
      if (this.map.getLayer(RADAR_LAYER)) this.map.removeLayer(RADAR_LAYER);
      if (this.map.getSource(RADAR_SOURCE)) this.map.removeSource(RADAR_SOURCE);
    } catch {
      // the style is already gone
    }
  }
}

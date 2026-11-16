// Subway trains (Phase 2.5 U3, ADR-013): each feature is a trip on the track from its previous
// stop to its next one (a LineString, or a Point at the stop), with t0 / t1 for that run. The
// map draws a dot at the position the train should have reached *now*, on a derived point source
// recomputed on a stepped tick (slower when zoomed out), paused while hidden or off. New data
// eases each train 1.5 s from where it was drawn. Reduced motion: dots move only on new data.
// Data older than 120 s freezes the dots and draws them hollow.
import type { ExpressionSpecification, GeoJSONSource, Map as MlMap } from 'maplibre-gl';
import type { Feature, FeatureCollection, Point, Position } from 'geojson';
import { useApp, type AppState } from '../../core';
import type { LayerFeature } from '../../types';
import { zoomRadius } from '../styleToPaint';
import { circle, emptyRendered, label, lid, pointHalo, type ExtraSource, type LiveCtx, type LiveHandle, type RenderCtx, type Rendered } from './common';

type Expr = ExpressionSpecification;

/** Source of the drawn train dots. */
export const POS_SUFFIX = 'pos';
/** Ease from the drawn to the newly computed position. */
export const TWEEN_MS = 1500;
/** meta.data_as_of older than this freezes the trains (hollow dots). */
export const FREEZE_AFTER_MS = 120_000;
/** The route letter appears from this zoom. */
export const LABEL_ZOOM = 13;
/** Re-check interval while no train is moving. */
const IDLE_CHECK_MS = 5000;

type LngLat = [number, number];

const posSource = (layer: string) => `nl-${layer}-${POS_SUFFIX}`;

/** Recompute interval by zoom: 1 s below z 12, 250 ms for z 12 to 14, 100 ms from z 14. */
export function tickMs(zoom: number): number {
  if (zoom < 12) return 1000;
  if (zoom < 14) return 250;
  return 100;
}

const ms = (v: unknown): number => (typeof v === 'string' ? Date.parse(v) : NaN);

interface Track {
  coords: Position[];
  /** Cumulative length at each vertex (scaled degrees). */
  cum: number[];
}

const tracks = new WeakMap<LayerFeature, Track | null>();

function trackOf(f: LayerFeature): Track | null {
  const hit = tracks.get(f);
  if (hit !== undefined) return hit;
  let t: Track | null = null;
  const g = f.geometry;
  if (g && g.type === 'LineString' && g.coordinates.length >= 2) {
    const coords = g.coordinates;
    // Equirectangular metric: longitude shrinks by cos(latitude) (fine across a few km).
    const k = Math.cos(((coords[0][1] ?? 40.7) * Math.PI) / 180);
    const cum = [0];
    for (let i = 1; i < coords.length; i++) {
      const dx = (coords[i][0] - coords[i - 1][0]) * k;
      const dy = coords[i][1] - coords[i - 1][1];
      cum.push(cum[i - 1] + Math.hypot(dx, dy));
    }
    t = { coords, cum };
  }
  tracks.set(f, t);
  return t;
}

/** Progress 0..1 along the run at `nowMs` (clamped; an unknown or zero-length run is 1). */
export function progressAt(f: LayerFeature, nowMs: number): number {
  const t0 = ms(f.properties.t0);
  const t1 = ms(f.properties.t1);
  if (!Number.isFinite(t0) || !Number.isFinite(t1) || t1 <= t0) return 1;
  return Math.min(1, Math.max(0, (nowMs - t0) / (t1 - t0)));
}

/**
 * Where a train is at `nowMs`: the start of its track at t0, the end at t1 (and after), linear
 * by distance in between. A Point feature is always at its point. Null without a geometry.
 */
export function positionAt(f: LayerFeature, nowMs: number): LngLat | null {
  const g = f.geometry;
  if (!g) return null;
  if (g.type === 'Point') return [g.coordinates[0], g.coordinates[1]];
  const tr = trackOf(f);
  if (!tr) {
    if (g.type === 'LineString' && g.coordinates.length === 1) return [g.coordinates[0][0], g.coordinates[0][1]];
    return null;
  }
  const { coords, cum } = tr;
  const total = cum[cum.length - 1];
  const p = progressAt(f, nowMs);
  if (total === 0 || p >= 1) {
    const e = coords[coords.length - 1];
    return [e[0], e[1]];
  }
  const d = p * total;
  // Binary search for the segment holding distance d.
  let lo = 0;
  let hi = cum.length - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (cum[mid] <= d) lo = mid;
    else hi = mid;
  }
  const seg = cum[hi] - cum[lo];
  const k = seg > 0 ? (d - cum[lo]) / seg : 0;
  const a = coords[lo];
  const b = coords[hi];
  return [a[0] + (b[0] - a[0]) * k, a[1] + (b[1] - a[1]) * k];
}

/** Smoothstep ease, 0..1 → 0..1. */
export function ease(k: number): number {
  const x = Math.min(1, Math.max(0, k));
  return x * x * (3 - 2 * x);
}

/** A point part-way from `from` to `to`, `elapsed` ms into a `dur` ms ease. */
export function tween(from: LngLat, to: LngLat, elapsed: number, dur: number = TWEEN_MS): LngLat {
  if (dur <= 0 || elapsed >= dur) return to;
  const k = ease(elapsed / dur);
  return [from[0] + (to[0] - from[0]) * k, from[1] + (to[1] - from[1]) * k];
}

type PosProps = Record<string, unknown> & { id: string; stale: boolean };

function pointFeature(f: LayerFeature, at: LngLat, stale: boolean): Feature<Point, PosProps> {
  const p = f.properties;
  return {
    type: 'Feature',
    id: p.id,
    geometry: { type: 'Point', coordinates: [Math.round(at[0] * 1e6) / 1e6, Math.round(at[1] * 1e6) / 1e6] },
    properties: { ...p, stale },
  };
}

/** Dots for every train at `nowMs` (features without a position are skipped). */
export function positions(features: LayerFeature[], nowMs: number, stale = false): FeatureCollection<Point, PosProps> {
  const out: Feature<Point, PosProps>[] = [];
  for (const f of features) {
    const at = positionAt(f, nowMs);
    if (at) out.push(pointFeature(f, at, stale));
  }
  return { type: 'FeatureCollection', features: out };
}

/** Newest data time: meta.data_as_of, else the newest `seen_at` among the features. */
export function dataAsOf(asOf: string | null | undefined, features: LayerFeature[]): number | null {
  const m = ms(asOf);
  if (Number.isFinite(m)) return m;
  let best: number | null = null;
  for (const f of features) {
    const s = ms(f.properties.seen_at);
    if (Number.isFinite(s) && (best === null || s > best)) best = s;
  }
  return best;
}

const STALE: Expr = ['==', ['get', 'stale'], true];

export function trains(ctx: RenderCtx): Rendered {
  const r = emptyRendered();
  const src = posSource(ctx.def.id);
  const pc: RenderCtx = {
    ...ctx,
    source: src,
    // Frozen (old data) trains are hollow: paper fill, line-colour ring.
    paint: { ...ctx.paint, hasHollow: true, hollow: STALE, sortKey: null },
  };
  r.layers.push(circle(pc, { part: 'dot' }));
  r.hit.push(lid(ctx.def, 'dot'));
  const lab = ctx.def.style.label;
  r.layers.push(
    label(pc, {
      prop: lab?.prop ?? 'route',
      minzoom: lab?.min_zoom ?? LABEL_ZOOM,
      size: 10,
      offset: [0.75, 0],
      anchor: 'left',
    }),
  );
  r.halo.push(...pointHalo(pc, zoomRadius(ctx.paint.radius, 6)));
  const extra: ExtraSource = {
    id: src,
    // The controller pushes the raw tracks here on each new poll; the live hook then owns it.
    build: (features) => positions(features, Date.now(), false),
    spec: { promoteId: 'id' },
  };
  r.extra = [extra];
  r.live = (live) => new TrainAnimator(live, src);
  return r;
}

/** Feature-state flags the controller sets on the layer's own source, mirrored onto the dots. */
type Flags = { hover: string | null; selected: string | null };

class TrainAnimator implements LiveHandle {
  private readonly map: MlMap;
  private readonly ctx: LiveCtx;
  private readonly src: string;
  private features: LayerFeature[] = [];
  private visible = false;
  private drawn = new Map<string, LngLat>();
  private tweens = new Map<string, { from: LngLat; start: number }>();
  private timer: ReturnType<typeof setTimeout> | null = null;
  private frozen = false;
  private flags: Flags = { hover: null, selected: null };
  private readonly unsub: () => void;
  private disposed = false;
  private readonly mq: MediaQueryList | null;

  constructor(ctx: LiveCtx, src: string) {
    this.ctx = ctx;
    this.map = ctx.map;
    this.src = src;
    document.addEventListener('visibilitychange', this.onVisibility);
    // Reduced motion switched off again: resume the tick (switched on: the next tick stops).
    this.mq = typeof matchMedia === 'function' ? matchMedia('(prefers-reduced-motion: reduce)') : null;
    this.mq?.addEventListener('change', this.onVisibility);
    this.map.on('zoomend', this.onZoom);
    this.unsub = useApp.subscribe((s) => this.mirror(s.hover, s.selection));
    const s = useApp.getState();
    this.mirror(s.hover, s.selection);
  }

  update(features: LayerFeature[], visible: boolean): void {
    if (this.disposed) return;
    const now = Date.now();
    if (features !== this.features) {
      const motion = !this.ctx.reducedMotion();
      this.tweens.clear();
      const next = new Set<string>();
      for (const f of features) {
        next.add(f.properties.id);
        const from = this.drawn.get(f.properties.id);
        if (motion && from) this.tweens.set(f.properties.id, { from, start: now });
      }
      this.features = features;
      for (const id of [...this.drawn.keys()]) if (!next.has(id)) this.drawn.delete(id);
      this.frozen = this.isStale(now);
    }
    this.visible = visible;
    if (!visible) {
      this.stop();
      return;
    }
    this.frame(now);
    this.schedule();
  }

  private isStale(now: number): boolean {
    const asOf = dataAsOf(useApp.getState().data[this.ctx.def.id]?.meta?.data_as_of, this.features);
    return asOf !== null && now - asOf > FREEZE_AFTER_MS;
  }

  /** Recompute and push every dot. */
  private frame(now: number): void {
    const src = this.map.getSource(this.src) as GeoJSONSource | undefined;
    if (!src) return;
    const stale = this.frozen;
    const out: Feature<Point, PosProps>[] = [];
    for (const f of this.features) {
      const id = f.properties.id;
      let at: LngLat | null;
      if (stale && this.drawn.has(id)) at = this.drawn.get(id) ?? null;
      else at = positionAt(f, now);
      if (!at) continue;
      const tw = this.tweens.get(id);
      if (tw && !stale) {
        const el = now - tw.start;
        if (el >= TWEEN_MS) this.tweens.delete(id);
        else at = tween(tw.from, at, el);
      }
      this.drawn.set(id, at);
      out.push(pointFeature(f, at, stale));
    }
    void src.setData({ type: 'FeatureCollection', features: out });
  }

  /** Whether another tick can change anything (a train still moving or easing). */
  private moving(now: number): boolean {
    if (this.tweens.size) return true;
    for (const f of this.features) {
      if (f.geometry?.type !== 'LineString') continue;
      const t1 = ms(f.properties.t1);
      if (Number.isFinite(t1) && now < t1) return true;
    }
    return false;
  }

  private schedule(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    if (this.disposed || !this.visible || document.hidden || this.ctx.reducedMotion()) return;
    const now = Date.now();
    if (!this.frozen && this.isStale(now)) {
      this.frozen = true;
      this.tweens.clear();
      this.frame(now); // redraw hollow, where they are
      return;
    }
    if (this.frozen) return;
    // Nothing moving (every train at its stop): just watch for the data going stale.
    this.timer = setTimeout(this.tick, this.moving(now) ? tickMs(this.map.getZoom()) : IDLE_CHECK_MS);
  }

  private readonly tick = (): void => {
    this.timer = null;
    if (this.disposed || !this.visible || document.hidden) return;
    this.frame(Date.now());
    this.schedule();
  };

  private stop(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  private readonly onVisibility = (): void => {
    if (document.hidden) {
      this.stop();
      return;
    }
    if (this.visible) {
      this.tweens.clear(); // jump to where the trains are now
      this.frame(Date.now());
      this.schedule();
    }
  };

  private readonly onZoom = (): void => {
    // Re-time a slow tick at once when zooming in.
    if (this.timer && this.visible) this.schedule();
  };

  /**
   * The controller sets hover / selected feature-state on the layer's own source (the tracks);
   * the dots live on the derived source, so copy those two flags across.
   */
  private mirror(hover: { layer: string; id: string } | null, sel: AppState['selection']): void {
    const layer = this.ctx.def.id;
    const next: Flags = {
      hover: hover && hover.layer === layer ? hover.id : null,
      selected: sel && sel.mode === 'feature' && sel.layer === layer ? sel.id : null,
    };
    const prev = this.flags;
    if (prev.hover === next.hover && prev.selected === next.selected) return;
    this.flags = next;
    if (!this.map.getSource(this.src)) return;
    const set = (id: string | null, state: Record<string, boolean>) => {
      if (id === null) return;
      try {
        this.map.setFeatureState({ source: this.src, id }, state);
      } catch {
        // style reloading: install() rebuilds the hook
      }
    };
    if (prev.hover !== next.hover) {
      set(prev.hover, { hover: false });
      set(next.hover, { hover: true });
    }
    if (prev.selected !== next.selected) {
      set(prev.selected, { selected: false });
      set(next.selected, { selected: true });
    }
  }

  destroy(): void {
    this.disposed = true;
    this.stop();
    this.unsub();
    document.removeEventListener('visibilitychange', this.onVisibility);
    this.mq?.removeEventListener('change', this.onVisibility);
    this.map.off('zoomend', this.onZoom);
    // The controller owns the dot layers and the derived source and removes them itself.
  }
}


// MapController: owns the MapLibre map. React feeds it per-layer data (from useLayerView); the
// rest (theme, selection, hover, borough mask, view, fly, insets) it reads from the store.
import maplibregl, {
  type GeoJSONSource,
  type LayerSpecification,
  type Map as MlMap,
  type MapGeoJSONFeature,
  type MapMouseEvent,
  type StyleSpecification,
} from 'maplibre-gl';
import type { FeatureCollection } from 'geojson';
import { useApp, type AppState } from '../core';
import type { Catalog, LayerDef, LayerFeature, Theme, ViewState } from '../types';
import { FALLBACK_BASEMAPS, firstPlaceLayer, offlineStyle, postProcess } from './basemap';
import { installIcons } from './icons';
import { renderLayer, sourceId, type Rendered } from './layers';
import { Pulse } from './pulse';
import { readTokens, type ThemeTokens } from './styleToPaint';

export interface HoverInfo {
  layer: string;
  /** Feature id, or null for a cluster. */
  id: string | null;
  props: Record<string, unknown>;
  /** Pointer position in px relative to the map container. */
  x: number;
  y: number;
}

type Listener = () => void;

/** Tiny external store for the tooltip (read with useSyncExternalStore). */
export class TooltipStore {
  private v: HoverInfo | null = null;
  private ls = new Set<Listener>();
  get = (): HoverInfo | null => this.v;
  subscribe = (l: Listener): (() => void) => {
    this.ls.add(l);
    return () => this.ls.delete(l);
  };
  set(v: HoverInfo | null): void {
    if (v === this.v || (v === null && this.v === null)) return;
    this.v = v;
    for (const l of this.ls) l();
  }
}

const EMPTY: FeatureCollection = { type: 'FeatureCollection', features: [] };

function fc(features: LayerFeature[]): FeatureCollection {
  return { type: 'FeatureCollection', features };
}

interface Want {
  visible: boolean;
  features: LayerFeature[];
}

interface Installed {
  rendered: Rendered;
  ids: string[];
  features: LayerFeature[] | null;
  visible: boolean;
}

const sameView = (a: ViewState, b: ViewState) =>
  Math.abs(a.lng - b.lng) < 1e-6 &&
  Math.abs(a.lat - b.lat) < 1e-6 &&
  Math.abs(a.zoom - b.zoom) < 1e-4 &&
  Math.abs(a.bearing - b.bearing) < 1e-3 &&
  Math.abs(a.pitch - b.pitch) < 1e-3;

export class MapController {
  readonly map: MlMap;
  readonly tooltip = new TooltipStore();
  private readonly container: HTMLElement;
  private readonly pulse: Pulse;
  private readonly ro: ResizeObserver | null;
  private readonly unsub: () => void;

  private theme: Theme;
  private basemapUrl = '';
  private tokens: ThemeTokens;
  private styleReady = false;
  private catalog: Catalog | null = null;
  private boundsApplied = false;
  private want = new Map<string, Want>();
  private installed = new Map<string, Installed>();
  private hitToLayer = new Map<string, string>();
  private hitLayers: string[] = [];
  private triedOffline = false;

  // What feature-state currently reflects.
  private appliedSel: { layer: string; id: string } | null = null;
  private appliedHover: { layer: string; id: string } | null = null;
  private appliedMask: string | null = null;
  private lastView: ViewState | null = null;
  private lastFly = 0;
  private lastInsets: AppState['insets'] | null = null;
  private moveRaf = 0;
  private pending: MapMouseEvent | null = null;

  constructor(container: HTMLElement) {
    this.container = container;
    const s = useApp.getState();
    this.theme = s.theme;
    this.tokens = readTokens(s.theme);
    const v = s.view;
    this.map = new maplibregl.Map({
      container,
      style: offlineStyle(this.tokens),
      center: [v.lng, v.lat],
      zoom: v.zoom,
      bearing: v.bearing,
      pitch: v.pitch,
      attributionControl: false,
      dragRotate: true,
      pitchWithRotate: true,
      fadeDuration: 0,
      maxPitch: 60,
      cancelPendingTileRequestsWhileZooming: true,
    });
    this.map.addControl(new maplibregl.AttributionControl({ compact: false }), 'bottom-right');
    this.lastView = v;
    this.pulse = new Pulse(this.map);

    this.map.on('style.load', this.onStyleLoad);
    this.map.on('error', this.onError);
    this.map.on('styleimagemissing', () => installIcons(this.map));
    this.map.on('mousemove', this.onMove);
    this.map.on('mouseout', this.clearHover);
    this.map.on('movestart', this.onMoveStart);
    this.map.on('click', this.onClick);
    this.map.on('moveend', this.onMoveEnd);

    this.ro = typeof ResizeObserver === 'function' ? new ResizeObserver(() => this.map.resize()) : null;
    this.ro?.observe(container);

    this.loadBasemap(s);
    this.unsub = useApp.subscribe((st) => this.sync(st));
    this.sync(useApp.getState());
  }

  destroy(): void {
    this.unsub();
    this.ro?.disconnect();
    this.pulse.destroy();
    cancelAnimationFrame(this.moveRaf);
    this.map.remove();
  }

  // ---- data from React ----------------------------------------------------------------------

  /** Called by each layer's sync component when its visibility or filtered features change. */
  setLayer(id: string, visible: boolean, features: LayerFeature[]): void {
    this.want.set(id, { visible, features });
    this.applyLayer(id);
  }

  private applyLayer(id: string): void {
    const inst = this.installed.get(id);
    const w = this.want.get(id);
    if (!inst || !w) return;
    if (w.visible && inst.features !== w.features) {
      inst.features = w.features;
      const src = this.map.getSource(sourceId(id)) as GeoJSONSource | undefined;
      void src?.setData(fc(w.features));
      for (const x of inst.rendered.extra ?? []) {
        (this.map.getSource(x.id) as GeoJSONSource | undefined)?.setData(x.build(w.features));
      }
    }
    if (inst.visible !== w.visible) {
      inst.visible = w.visible;
      const vis = w.visible ? 'visible' : 'none';
      for (const lid of inst.ids) if (this.map.getLayer(lid)) this.map.setLayoutProperty(lid, 'visibility', vis);
      if (!w.visible) this.tooltip.set(null);
      this.pulse.kick();
    }
  }

  // ---- basemap and install ------------------------------------------------------------------

  private loadBasemap(s: AppState): void {
    const url = (s.catalog?.basemaps ?? FALLBACK_BASEMAPS)[s.theme];
    if (url === this.basemapUrl && s.theme === this.theme && this.basemapUrl) return;
    const themeChanged = s.theme !== this.theme;
    this.theme = s.theme;
    this.basemapUrl = url;
    this.tokens = readTokens(s.theme);
    this.styleReady = false;
    this.triedOffline = false;
    if (themeChanged) this.container.parentElement?.setAttribute('data-map-theme', s.theme);
    const theme = s.theme;
    this.map.setStyle(url, {
      diff: false,
      transformStyle: (_prev, next) => postProcess(next as StyleSpecification, theme, readTokens(theme)),
    });
  }

  private readonly onError = (e: { error?: Error }) => {
    // The basemap could not be fetched: fall back to a paper background so data still draws.
    if (this.styleReady || this.triedOffline) return;
    const msg = String(e.error?.message ?? '');
    if (/style|Failed to fetch|NetworkError|AJAXError/i.test(msg)) {
      this.triedOffline = true;
      this.map.setStyle(offlineStyle(this.tokens), { diff: false });
    }
  };

  private readonly onStyleLoad = () => {
    // The first style.load is the inline paper placeholder; wait for the real (or offline) one.
    const layers = this.map.getStyle().layers ?? [];
    if (layers.length <= 1 && !this.triedOffline && this.basemapUrl) return;
    this.styleReady = true;
    this.tokens = readTokens(this.theme);
    this.installed.clear();
    this.hitToLayer.clear();
    this.hitLayers = [];
    this.appliedSel = null;
    this.appliedHover = null;
    this.appliedMask = null;
    this.install();
  };

  private install(): void {
    const cat = this.catalog;
    if (!cat || !this.styleReady || this.installed.size) return;
    const map = this.map;
    installIcons(map);
    const before = firstPlaceLayer((map.getStyle().layers ?? []) as Array<{ id: string; type: string; 'source-layer'?: string }>);
    const defs = [...cat.layers].sort((a, b) => a.z - b.z);
    const halos: Array<{ def: LayerDef; layer: LayerSpecification }> = [];
    const pulses: Rendered['pulse'] = [];
    for (const def of defs) {
      const rendered = renderLayer(def, this.tokens);
      const w = this.want.get(def.id);
      const visible = w?.visible ?? false;
      const features = visible && w ? w.features : null;
      const src = sourceId(def.id);
      if (!map.getSource(src)) {
        map.addSource(src, {
          type: 'geojson',
          data: features ? fc(features) : EMPTY,
          promoteId: 'id',
          buffer: 64,
          ...rendered.source,
        } as maplibregl.GeoJSONSourceSpecification);
      }
      for (const x of rendered.extra ?? []) {
        if (!map.getSource(x.id)) map.addSource(x.id, { type: 'geojson', data: features ? x.build(features) : EMPTY });
      }
      const ids: string[] = [];
      const vis = visible ? 'visible' : 'none';
      for (const layer of rendered.layers) {
        map.addLayer(withVisibility(layer, vis), before);
        ids.push(layer.id);
      }
      for (const layer of rendered.halo) {
        halos.push({ def, layer: withVisibility(layer, vis) });
        ids.push(layer.id);
      }
      for (const h of rendered.hit) this.hitToLayer.set(h, def.id);
      pulses.push(...rendered.pulse);
      this.installed.set(def.id, { rendered, ids, features, visible });
    }
    for (const { layer } of halos) map.addLayer(layer, before);
    // Hit order follows draw order, top first (queryRenderedFeatures sorts anyway).
    this.hitLayers = [...this.hitToLayer.keys()].reverse();
    this.pulse.setTargets(pulses);
    for (const id of this.installed.keys()) this.applyLayer(id);
    this.sync(useApp.getState());
  }

  // ---- store sync ---------------------------------------------------------------------------

  private sync(s: AppState): void {
    if (s.catalog && s.catalog !== this.catalog) {
      this.catalog = s.catalog;
      if (!this.boundsApplied) {
        const v = s.catalog.view;
        this.map.setMinZoom(v.min_zoom);
        this.map.setMaxZoom(v.max_zoom);
        this.map.setMaxBounds(v.bounds);
        this.boundsApplied = true;
      }
      this.installed.clear();
    }
    const url = (s.catalog?.basemaps ?? FALLBACK_BASEMAPS)[s.theme];
    if (s.theme !== this.theme || url !== this.basemapUrl) this.loadBasemap(s);
    if (this.styleReady && this.catalog && !this.installed.size) {
      this.install();
      return;
    }

    if (this.installed.size) {
      this.applySelection(s);
      this.applyHover(s);
      this.applyMask(s);
    }
    this.applyView(s);
    this.applyInsets(s);
  }

  private setState(layer: string, id: string, state: Record<string, boolean>): void {
    if (!this.installed.has(layer)) return;
    this.map.setFeatureState({ source: sourceId(layer), id }, state);
  }

  private applySelection(s: AppState): void {
    const sel = s.selection?.mode === 'feature' ? { layer: s.selection.layer, id: s.selection.id } : null;
    const a = this.appliedSel;
    if (a === sel || (a && sel && a.layer === sel.layer && a.id === sel.id)) return;
    if (a) this.setState(a.layer, a.id, { selected: false });
    if (sel) this.setState(sel.layer, sel.id, { selected: true });
    this.appliedSel = sel;
  }

  private applyHover(s: AppState): void {
    const h = s.hover;
    const a = this.appliedHover;
    if (a === h || (a && h && a.layer === h.layer && a.id === h.id)) return;
    if (a) this.setState(a.layer, a.id, { hover: false });
    if (h) this.setState(h.layer, h.id, { hover: true });
    this.appliedHover = h ? { ...h } : null;
  }

  /** Boroughs outside the active filter get the paper mask. */
  private applyMask(s: AppState): void {
    const key = s.boroughs.join(',');
    if (key === this.appliedMask || !this.installed.has('boroughs')) return;
    this.appliedMask = key;
    for (const b of this.catalog?.boroughs ?? []) {
      this.setState('boroughs', b.id, { masked: s.boroughs.length > 0 && !s.boroughs.includes(b.id) });
    }
  }

  private applyView(s: AppState): void {
    if (s.view !== this.lastView) {
      this.lastView = s.view;
      if (s.viewOrigin !== 'map' && !sameView(s.view, this.currentView())) {
        const v = s.view;
        this.map.jumpTo({ center: [v.lng, v.lat], zoom: v.zoom, bearing: v.bearing, pitch: v.pitch });
      }
    }
    if (s.fly && s.fly.nonce !== this.lastFly) {
      this.lastFly = s.fly.nonce;
      const i = s.insets;
      const f = s.fly;
      // Centre the target in the part of the map not covered by panels (never setPadding).
      this.map.flyTo({
        center: [f.lng, f.lat],
        zoom: f.zoom ?? Math.max(this.map.getZoom(), 14),
        offset: [(i.left - i.right) / 2, (i.top - i.bottom) / 2],
        speed: 1.6,
      });
    }
  }

  private applyInsets(s: AppState): void {
    if (s.insets === this.lastInsets) return;
    this.lastInsets = s.insets;
    const br = this.container.querySelector<HTMLElement>('.maplibregl-ctrl-bottom-right');
    if (br) {
      br.style.right = `${s.insets.right}px`;
      br.style.bottom = `${s.insets.bottom}px`;
    }
  }

  currentView(): ViewState {
    const c = this.map.getCenter();
    return { lng: c.lng, lat: c.lat, zoom: this.map.getZoom(), bearing: this.map.getBearing(), pitch: this.map.getPitch() };
  }

  // ---- pointer ------------------------------------------------------------------------------

  private pick(e: MapMouseEvent): MapGeoJSONFeature | null {
    const layers = this.hitLayers.filter((id) => this.map.getLayer(id));
    if (!layers.length) return null;
    const p = e.point;
    const r = 3;
    const feats = this.map.queryRenderedFeatures(
      [
        [p.x - r, p.y - r],
        [p.x + r, p.y + r],
      ],
      { layers },
    );
    return feats[0] ?? null;
  }

  private readonly onMove = (e: MapMouseEvent) => {
    this.pending = e;
    if (this.moveRaf) return;
    this.moveRaf = requestAnimationFrame(() => {
      this.moveRaf = 0;
      const ev = this.pending;
      this.pending = null;
      if (!ev) return;
      const f = this.pick(ev);
      const layer = f ? this.hitToLayer.get(f.layer.id) : undefined;
      if (!f || !layer) {
        this.clearHover();
        return;
      }
      const props = (f.properties ?? {}) as Record<string, unknown>;
      const isCluster = props.cluster === true || props.point_count !== undefined;
      const id = isCluster ? null : String(props.id ?? f.id ?? '');
      this.map.getCanvas().style.cursor = 'pointer';
      useApp.getState().setHover(id ? { layer, id } : null);
      this.tooltip.set({ layer, id, props, x: ev.point.x, y: ev.point.y });
    });
  };

  readonly clearHover = () => {
    this.map.getCanvas().style.cursor = '';
    const h = useApp.getState().hover;
    if (h && this.installed.has(h.layer) && !this.chipLayer(h.layer)) useApp.getState().setHover(null);
    this.tooltip.set(null);
  };

  private chipLayer(id: string): boolean {
    return !!this.installed.get(id)?.rendered.chips;
  }

  private readonly onMoveStart = () => {
    this.tooltip.set(null);
  };

  private readonly onClick = (e: MapMouseEvent) => {
    const target = e.originalEvent?.target as Element | null;
    if (target && typeof target.closest === 'function' && target.closest('.maplibregl-marker')) return;
    const f = this.pick(e);
    const layer = f ? this.hitToLayer.get(f.layer.id) : undefined;
    const st = useApp.getState();
    if (!f || !layer) {
      if (st.selection?.mode === 'feature') st.select(null);
      return;
    }
    const props = (f.properties ?? {}) as Record<string, unknown>;
    if (props.cluster_id !== undefined && props.point_count !== undefined) {
      const src = this.map.getSource(sourceId(layer)) as GeoJSONSource | undefined;
      const g = f.geometry;
      if (!src || g.type !== 'Point') return;
      void src.getClusterExpansionZoom(Number(props.cluster_id)).then((z) => {
        this.map.easeTo({ center: g.coordinates as [number, number], zoom: Math.min(z + 0.2, this.map.getMaxZoom()) });
      });
      return;
    }
    const id = String(props.id ?? f.id ?? '');
    if (id) st.select({ mode: 'feature', layer, id });
  };

  private readonly onMoveEnd = () => {
    const v = this.currentView();
    const s = useApp.getState();
    this.lastView = v;
    if (!sameView(v, s.view)) {
      s.setView(v, 'map');
      this.lastView = useApp.getState().view;
    }
  };

  // ---- controls -----------------------------------------------------------------------------

  zoomBy(d: number): void {
    this.map.easeTo({ zoom: this.map.getZoom() + d, duration: 200 });
  }

  resetNorth(): void {
    this.map.easeTo({ bearing: 0, pitch: 0, duration: 300 });
  }
}

function withVisibility(layer: LayerSpecification, vis: 'visible' | 'none'): LayerSpecification {
  const l = layer as LayerSpecification & { layout?: Record<string, unknown> };
  return { ...l, layout: { ...(l.layout ?? {}), visibility: vis } } as LayerSpecification;
}

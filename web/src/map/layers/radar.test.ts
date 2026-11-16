import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Map as MlMap } from 'maplibre-gl';
import { resetStore } from '../../core/store';
import { useApp } from '../../core';
import type { LayerDef } from '../../types';
import { LIGHT_TOKENS, styleToPaint } from '../styleToPaint';
import {
  RADAR_LAYER,
  RADAR_SOURCE,
  RadarHook,
  STALE_NOTE,
  isStale,
  newestFrame,
  opacityFor,
  pollMs,
  radar,
  tileUrl,
} from './radar';

const DEF = {
  id: 'radar',
  label: 'Rain radar (RainViewer)',
  short: 'Radar',
  kind: 'raster',
  poll_s: 300,
  attribution: { text: 'Radar: RainViewer', url: 'https://www.rainviewer.com/api.html' },
  style: { color: { value: 'muted' } },
  raster: {
    index_url: 'https://api.rainviewer.com/public/weather-maps.json',
    tiles: '{host}{path}/256/{z}/{x}/{y}/2/1_1.png',
    frames: 'radar.past',
    tile_size: 256,
    max_zoom: 7,
    opacity: 0.7,
    stale_s: 1800,
  },
} as unknown as LayerDef;

const INDEX = {
  version: '2.0',
  generated: 1794816024,
  host: 'https://tilecache.rainviewer.com',
  radar: {
    past: [
      { time: 1794815400, path: '/v2/radar/76335e33da99' },
      { time: 1794816000, path: '/v2/radar/0a5304bced43' },
      { time: 1794814800, path: '/v2/radar/65f973104ff1' },
    ],
    nowcast: [],
  },
};
const NEWEST_MS = 1794816000 * 1000;

describe('frame helpers', () => {
  it('picks the newest frame at the dotted path', () => {
    expect(newestFrame(INDEX, 'radar.past')).toEqual({ time: 1794816000, path: '/v2/radar/0a5304bced43' });
    expect(newestFrame(INDEX, 'radar.nowcast')).toBeNull();
    expect(newestFrame(INDEX, 'radar.nope')).toBeNull();
    expect(newestFrame({ radar: { past: [{ time: 'x', path: 1 }, null] } }, 'radar.past')).toBeNull();
  });

  it('fills host and path into the tile template, keeping z/x/y', () => {
    const f = newestFrame(INDEX, 'radar.past')!;
    expect(tileUrl(DEF.raster!, INDEX.host, f)).toBe('https://tilecache.rainviewer.com/v2/radar/0a5304bced43/256/{z}/{x}/{y}/2/1_1.png');
    expect(tileUrl(DEF.raster!, 'https://h.example/', f)).toBe('https://h.example/v2/radar/0a5304bced43/256/{z}/{x}/{y}/2/1_1.png');
  });

  it('is stale past stale_s', () => {
    expect(isStale(NEWEST_MS, NEWEST_MS + 1800_000, 1800)).toBe(false);
    expect(isStale(NEWEST_MS, NEWEST_MS + 1800_001, 1800)).toBe(true);
  });

  it('polls no faster than once a minute and reads the opacity override', () => {
    expect(pollMs(DEF)).toBe(300_000);
    expect(pollMs({ poll_s: 10 })).toBe(60_000);
    expect(opacityFor(DEF, {})).toBe(0.7);
    expect(opacityFor(DEF, { radar: 0.3 })).toBe(0.3);
  });

  it('the renderer has no canvas layers of its own, only a live hook', () => {
    const r = radar({ def: DEF, paint: styleToPaint(DEF, LIGHT_TOKENS), t: LIGHT_TOKENS, source: 'nl-radar' });
    expect(r.layers).toEqual([]);
    expect(r.hit).toEqual([]);
    expect(typeof r.live).toBe('function');
  });
});

/** Just enough of a MapLibre map for the hook. */
function fakeMap() {
  const sources = new Map<string, Record<string, unknown>>();
  const layers = new Map<string, Record<string, unknown>>();
  const setTiles = vi.fn();
  const map = {
    addSource: vi.fn((id: string, spec: Record<string, unknown>) => sources.set(id, { ...spec, setTiles })),
    getSource: (id: string) => sources.get(id),
    removeSource: (id: string) => sources.delete(id),
    addLayer: vi.fn((l: Record<string, unknown>, _before?: string) => layers.set(l.id as string, { ...l, layout: { ...(l.layout as object) }, paint: { ...(l.paint as object) } })),
    getLayer: (id: string) => layers.get(id),
    removeLayer: (id: string) => layers.delete(id),
    setLayoutProperty: (id: string, k: string, v: unknown) => {
      (layers.get(id)!.layout as Record<string, unknown>)[k] = v;
    },
    setPaintProperty: (id: string, k: string, v: unknown) => {
      (layers.get(id)!.paint as Record<string, unknown>)[k] = v;
    },
  };
  return { map: map as unknown as MlMap, sources, layers, setTiles, raw: map };
}

function okFetch(body: unknown) {
  return vi.fn(async () => ({ ok: true, status: 200, json: async () => body }) as unknown as Response);
}

describe('RadarHook', () => {
  beforeEach(() => {
    resetStore();
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  const make = (fetch: ReturnType<typeof vi.fn>, now: () => number) => {
    const fm = fakeMap();
    const hook = new RadarHook(
      { map: fm.map, def: DEF, source: 'nl-radar', beforeId: 'place', reducedMotion: () => false },
      { fetch: fetch as unknown as typeof globalThis.fetch, now },
    );
    return { fm, hook };
  };

  it('adds a hidden raster source and layer before beforeId', () => {
    const { fm } = make(okFetch(INDEX), () => NEWEST_MS);
    const src = fm.sources.get(RADAR_SOURCE)!;
    expect(src).toMatchObject({ type: 'raster', tileSize: 256, maxzoom: 7 });
    expect(String(src.attribution)).toContain('RainViewer');
    expect(fm.raw.addLayer.mock.calls[0][1]).toBe('place');
    const layer = fm.layers.get(RADAR_LAYER)!;
    expect((layer.layout as Record<string, unknown>).visibility).toBe('none');
    expect((layer.paint as Record<string, unknown>)['raster-opacity']).toBe(0.7);
  });

  it('fetches with no-cache, shows the newest frame and writes LayerData', async () => {
    const fetch = okFetch(INDEX);
    const now = NEWEST_MS + 120_000;
    const { fm, hook } = make(fetch, () => now);
    hook.update([], true);
    await vi.advanceTimersByTimeAsync(0);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(fetch.mock.calls[0]).toEqual([DEF.raster!.index_url, expect.objectContaining({ cache: 'no-cache' })]);
    expect(fm.setTiles).toHaveBeenCalledWith(['https://tilecache.rainviewer.com/v2/radar/0a5304bced43/256/{z}/{x}/{y}/2/1_1.png']);
    expect((fm.layers.get(RADAR_LAYER)!.layout as Record<string, unknown>).visibility).toBe('visible');
    const d = useApp.getState().data.radar;
    expect(d.status).toBe('ready');
    expect(d.features).toEqual([]);
    expect(d.rev).toBe(1);
    expect(d.meta?.data_as_of).toBe(new Date(NEWEST_MS).toISOString());
    expect(d.meta?.note).toBeNull();
    expect(d.fetchedAt).toBe(now);
    expect(d.nextAt).toBe(now + 300_000);

    // Next poll after max(poll_s, 60) s; the same frame does not reload tiles.
    await vi.advanceTimersByTimeAsync(300_000);
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(fm.setTiles).toHaveBeenCalledTimes(1);
    expect(useApp.getState().data.radar.rev).toBe(2);
    hook.destroy();
    expect(fm.layers.has(RADAR_LAYER)).toBe(false);
    expect(fm.sources.has(RADAR_SOURCE)).toBe(false);
  });

  it('notes STALE when the newest frame is older than stale_s', async () => {
    const { hook } = make(okFetch(INDEX), () => NEWEST_MS + 3600_000);
    hook.update([], true);
    await vi.advanceTimersByTimeAsync(0);
    expect(useApp.getState().data.radar.meta?.note).toBe(STALE_NOTE);
    hook.destroy();
  });

  it('sets status error when the index fails, keeping the old frame', async () => {
    let fail = false;
    const fetch = vi.fn(async () => {
      if (fail) throw new Error('offline');
      return { ok: true, status: 200, json: async () => INDEX } as unknown as Response;
    });
    const { fm, hook } = make(fetch, () => NEWEST_MS);
    hook.update([], true);
    await vi.advanceTimersByTimeAsync(0);
    fail = true;
    await vi.advanceTimersByTimeAsync(300_000);
    const d = useApp.getState().data.radar;
    expect(d.status).toBe('error');
    expect(d.error).toBe('offline');
    expect(d.meta?.data_as_of).toBe(new Date(NEWEST_MS).toISOString());
    expect((fm.layers.get(RADAR_LAYER)!.layout as Record<string, unknown>).visibility).toBe('visible');
    hook.destroy();
  });

  it('a non-200 index is an error; nothing polls while the layer is off', async () => {
    const fetch = vi.fn(async () => ({ ok: false, status: 503, json: async () => ({}) }) as unknown as Response);
    const { hook } = make(fetch, () => NEWEST_MS);
    hook.update([], false);
    await vi.advanceTimersByTimeAsync(600_000);
    expect(fetch).not.toHaveBeenCalled();
    hook.update([], true);
    await vi.advanceTimersByTimeAsync(0);
    expect(useApp.getState().data.radar.status).toBe('error');
    expect(useApp.getState().data.radar.error).toContain('503');
    hook.destroy();
  });

  it('follows the store opacity override', () => {
    const { fm, hook } = make(okFetch(INDEX), () => NEWEST_MS);
    useApp.getState().setOpacity('radar', 0.3);
    expect((fm.layers.get(RADAR_LAYER)!.paint as Record<string, unknown>)['raster-opacity']).toBe(0.3);
    hook.destroy();
  });
});

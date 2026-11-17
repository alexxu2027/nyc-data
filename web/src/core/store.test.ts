import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { api, ApiError } from './api';
import { resetStore, useApp } from './store';
import { applyUrlState, parseUrl, startUrlSync } from './url';
import { catalog } from './test/fixtures';

beforeEach(() => {
  resetStore();
  useApp.setState({ catalog, visible: ['citibike', 'cameras'] });
});

describe('store actions', () => {
  it('keeps visible in catalog order and clears selection / hover on hide', () => {
    const s = useApp.getState();
    s.setLayerVisible('boroughs', true);
    expect(useApp.getState().visible).toEqual(['boroughs', 'citibike', 'cameras']);
    s.setLayerVisible('nope', true);
    expect(useApp.getState().visible).toEqual(['boroughs', 'citibike', 'cameras']);
    s.select({ mode: 'feature', layer: 'cameras', id: 'c1' });
    s.setHover({ layer: 'cameras', id: 'c1' });
    s.toggleLayer('cameras');
    expect(useApp.getState().selection).toBeNull();
    expect(useApp.getState().hover).toBeNull();
  });

  it('ignores select() on a hidden layer', () => {
    useApp.getState().select({ mode: 'feature', layer: 'collisions', id: '1' });
    expect(useApp.getState().selection).toBeNull();
    useApp.getState().select({ mode: 'list', layer: 'subway_alerts' });
    expect(useApp.getState().selection).toBeNull();
    useApp.getState().select({ mode: 'feature', layer: 'citibike', id: '1' });
    expect(useApp.getState().selection).toEqual({ mode: 'feature', layer: 'citibike', id: '1' });
  });

  it('stores only non-default filter values and keeps other layers’ identity', () => {
    const s = useApp.getState();
    s.setFilter('cameras', 'status', ['online']);
    const cams = useApp.getState().filters.cameras;
    s.setFilter('citibike', 'ebikes', true);
    expect(useApp.getState().filters.cameras).toBe(cams);
    s.setFilter('citibike', 'ebikes', false);
    expect(useApp.getState().filters.citibike).toBeUndefined();
    s.setFilter('citibike', 'bogus', true);
    expect(useApp.getState().filters.citibike).toBeUndefined();
    s.resetFilters('cameras');
    expect(useApp.getState().filters).toEqual({});
  });

  it('boroughs toggle in canonical order; all five means all', () => {
    const s = useApp.getState();
    s.toggleBorough('QN');
    s.toggleBorough('MN');
    expect(useApp.getState().boroughs).toEqual(['MN', 'QN']);
    s.setBoroughs(['MN', 'BK', 'QN', 'BX', 'SI']);
    expect(useApp.getState().boroughs).toEqual([]);
  });

  it('setTheme writes data-theme; flyTo bumps a nonce; setView records origin', () => {
    const s = useApp.getState();
    s.setTheme('dark');
    expect(document.documentElement.dataset.theme).toBe('dark');
    s.flyTo({ lng: 1, lat: 2 });
    const n1 = useApp.getState().fly!.nonce;
    s.flyTo({ lng: 1, lat: 2 });
    expect(useApp.getState().fly!.nonce).toBe(n1 + 1);
    s.setView({ lng: 1, lat: 2, zoom: 12, bearing: 0, pitch: 0 }, 'map');
    expect(useApp.getState().viewOrigin).toBe('map');
  });
});

describe('startUrlSync', () => {
  afterEach(() => vi.useRealTimers());
  it('debounces replaceState by 250 ms and re-applies on popstate', () => {
    vi.useFakeTimers();
    history.replaceState(null, '', '/?layers=citibike&t=live');
    applyUrlState(parseUrl(location.search, catalog));
    const spy = vi.spyOn(history, 'replaceState');
    const stop = startUrlSync(catalog, 'live');
    useApp.getState().setBoroughs(['BK']);
    useApp.getState().setThemeMode('dark');
    vi.advanceTimersByTime(249);
    expect(spy).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(spy).toHaveBeenCalledTimes(1);
    expect(location.search).toBe('?layers=citibike&borough=BK&c=-73.95500,40.72500&z=10.60&theme=dark&t=live');

    history.pushState(null, '', '/?layers=cameras&z=13&sel=cameras:a%2Fb');
    window.dispatchEvent(new PopStateEvent('popstate'));
    const st = useApp.getState();
    expect(st.visible).toEqual(['cameras']);
    expect(st.viewOrigin).toBe('url');
    expect(st.view.zoom).toBe(13);
    expect(st.selection).toEqual({ mode: 'feature', layer: 'cameras', id: 'a/b' });
    expect(st.theme).toBe('light');
    stop();
    spy.mockRestore();
  });
});

describe('api client', () => {
  afterEach(() => vi.unstubAllGlobals());
  it('encodes ids and maps the error shape to ApiError', async () => {
    const f = vi.fn(async (url: string) => {
      void url;
      return {
        status: 404,
        ok: false,
        headers: new Headers(),
        json: async () => ({ error: { code: 'not_found', message: 'no such entity' } }),
      } as unknown as Response;
    });
    vi.stubGlobal('fetch', f);
    const err = await api.entity('camera', 'a/b:c').catch((e: unknown) => e);
    expect(f.mock.calls[0][0]).toBe('/api/entities/camera/a%2Fb%3Ac');
    expect(err).toBeInstanceOf(ApiError);
    expect(err).toMatchObject({ status: 404, code: 'not_found', message: 'no such entity' });
    await api.series('bike_station', '1', ['bikes_available', 'docks_available'], 24, 0).catch(() => null);
    expect(f.mock.calls[1][0]).toBe('/api/entities/bike_station/1/series?metrics=bikes_available%2Cdocks_available&hours=24&ahead=0');
    await api.events('subway_alerts', { status: 'all', limit: 50 }).catch(() => null);
    expect(f.mock.calls[2][0]).toBe('/api/events?layer=subway_alerts&status=all&limit=50');
    await api.event('nyc_311', 'x/y').catch(() => null);
    expect(f.mock.calls[3][0]).toBe('/api/events/nyc_311/x%2Fy');
  });
});

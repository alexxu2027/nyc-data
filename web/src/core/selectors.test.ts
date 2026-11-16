import { act, renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it } from 'vitest';
import type { LayerData } from '../types';
import { clearSelectorCache, selectLayerHealth, selectLayerView, useLayerDef, useLayerView } from './selectors';
import { resetStore, useApp } from './store';
import { catalog, collection, feat } from './test/fixtures';

function setData(id: string, ids: Array<[string, 'MN' | 'BK' | 'XX' | null, Record<string, unknown>?]>, rev: number) {
  const c = collection(id, ids.map(([i, b, p]) => feat(i, b, p)));
  const d: LayerData = { status: 'ready', features: c.features, meta: c.meta, etag: 'e', rev, fetchedAt: 1, nextAt: 2, error: null, changed: [], changedAt: null };
  useApp.setState((s) => ({ data: { ...s.data, [id]: d } }));
}

beforeEach(() => {
  resetStore();
  clearSelectorCache();
  useApp.setState({ catalog, visible: ['citibike', 'cameras'] });
  setData('citibike', [['a', 'MN', { state: 'ok' }], ['b', 'BK', { state: 'empty' }], ['c', 'XX', { state: 'ok' }]], 1);
  setData('cameras', [['x', 'MN', { status: 'online' }]], 1);
});

describe('useLayerView', () => {
  it('features identity is stable until rev, boroughs or that layer’s filters change', () => {
    const { result } = renderHook(() => useLayerView('citibike'));
    const f0 = result.current.features;
    expect(result.current.count).toBe(3);
    expect(result.current.total).toBe(3);
    expect(result.current.visible).toBe(true);

    // unrelated changes keep identity: hover, view, another layer's filter, a 304 (fetchedAt only)
    act(() => useApp.getState().setHover({ layer: 'cameras', id: 'x' }));
    act(() => useApp.getState().setView({ lng: 1, lat: 2, zoom: 3, bearing: 0, pitch: 0 }, 'map'));
    act(() => useApp.getState().setFilter('cameras', 'status', ['offline']));
    act(() => useApp.setState((s) => ({ data: { ...s.data, citibike: { ...s.data.citibike, fetchedAt: 99, nextAt: 199 } } })));
    expect(result.current.features).toBe(f0);
    expect(result.current.fetchedAt).toBe(99);

    // boroughs change -> new identity, XX hidden
    act(() => useApp.getState().setBoroughs(['BK']));
    const f1 = result.current.features;
    expect(f1).not.toBe(f0);
    expect(f1.map((f) => f.properties.id)).toEqual(['b']);
    expect(result.current.count).toBe(1);
    expect(result.current.total).toBe(3);

    // own filter change -> new identity
    act(() => useApp.getState().setBoroughs([]));
    act(() => useApp.getState().setFilter('citibike', 'state', ['ok']));
    const f2 = result.current.features;
    expect(f2.map((f) => f.properties.id)).toEqual(['a', 'c']);

    // rev change -> new identity
    act(() => setData('citibike', [['a', 'MN', { state: 'ok' }]], 2));
    expect(result.current.features).not.toBe(f2);
    expect(result.current.rev).toBe(2);
  });

  it('borough changes do not churn layers without borough_filter', () => {
    useApp.setState({ visible: ['boroughs'] });
    setData('boroughs', [['MN', 'MN'], ['BK', 'BK']], 1);
    const f0 = selectLayerView(useApp.getState(), 'boroughs').features;
    useApp.getState().setBoroughs(['BK']);
    expect(selectLayerView(useApp.getState(), 'boroughs').features).toBe(f0);
  });

  it('returns the same view object while inputs are unchanged (safe selector)', () => {
    const a = selectLayerView(useApp.getState(), 'citibike');
    useApp.getState().setPanel('about');
    expect(selectLayerView(useApp.getState(), 'citibike')).toBe(a);
  });

  it('works for a layer with no data yet and for an unknown id', () => {
    const v = selectLayerView(useApp.getState(), 'collisions');
    expect(v).toMatchObject({ status: 'idle', count: 0, total: 0, visible: false, rev: 0 });
    expect(v.def.id).toBe('collisions');
    expect(selectLayerView(useApp.getState(), 'nope').def.id).toBe('nope');
  });

  it('useLayerDef reads the catalog', () => {
    const { result } = renderHook(() => useLayerDef('cameras'));
    expect(result.current?.id).toBe('cameras');
  });
});

describe('selectLayerHealth', () => {
  const src = (id: string, state: 'ok' | 'stale' | 'degraded' | 'never') => ({
    id, name: id, state, cadence_s: 60, last_success: null, last_attempt: null, age_s: null, lag_s: null,
    consecutive_failures: 0, rows_last_run: null, last_error: null, runs_24h: 0, ok_24h: 0, layers: [],
  });
  it('is the worst state among the layer sources', () => {
    expect(selectLayerHealth(useApp.getState(), 'citibike')).toBe('unknown');
    useApp.setState({
      health: {
        now: 'n',
        collector: { state: 'running', last_attempt: null },
        summary: { ok: 1, stale: 1, degraded: 0, never: 0 },
        sources: [src('citibike_gbfs', 'ok'), src('citibike_station_status', 'stale'), src('dot_cameras', 'degraded')],
      },
    });
    expect(selectLayerHealth(useApp.getState(), 'citibike')).toBe('stale');
    expect(selectLayerHealth(useApp.getState(), 'cameras')).toBe('degraded');
    expect(selectLayerHealth(useApp.getState(), 'boroughs')).toBe('ok');
    expect(selectLayerHealth(useApp.getState(), 'collisions')).toBe('unknown');
  });
});

import { beforeEach, describe, expect, it } from 'vitest';
import { resetStore, useApp } from '../core/store';
import { catalog } from '../core/test/fixtures';
import type { ChangeItem } from '../types';
import { isNew, itemText, newestAt, openItem, sameItems, unreadCount } from './model';

function item(p: Partial<ChangeItem> & Pick<ChangeItem, 'id'>): ChangeItem {
  return {
    at: '2026-11-15T03:20:00Z',
    kind: 'alert',
    source: 'mta_subway_alerts',
    title: 'A trains delayed',
    severity: 2,
    layer: 'subway_alerts',
    feature: 'R01',
    lat: 40.75,
    lon: -73.98,
    borough: 'MN',
    ended: false,
    ...p,
  };
}

const T = (iso: string) => Date.parse(iso);

describe('unread', () => {
  const items = [
    item({ id: 'a', at: '2026-11-15T03:20:00Z' }),
    item({ id: 'b', at: '2026-11-15T03:10:00Z' }),
    item({ id: 'c', at: '2026-11-15T02:00:00Z' }),
  ];
  it('counts items first seen after seenAt', () => {
    expect(unreadCount(items, 0)).toBe(3);
    expect(unreadCount(items, T('2026-11-15T03:10:00Z'))).toBe(1);
    expect(unreadCount(items, T('2026-11-15T03:20:00Z'))).toBe(0);
    expect(unreadCount([], 0)).toBe(0);
    expect(isNew(items[1], T('2026-11-15T03:09:59Z'))).toBe(true);
  });
  it('newestAt is "seen up to" after reading', () => {
    expect(newestAt(items)).toBe(T('2026-11-15T03:20:00Z'));
    expect(newestAt([])).toBe(0);
    expect(unreadCount(items, newestAt(items))).toBe(0);
  });
  it('sameItems ignores identity, not content', () => {
    expect(sameItems(items, items.map((x) => ({ ...x })))).toBe(true);
    expect(sameItems(items, [{ ...items[0], ended: true }, items[1], items[2]])).toBe(false);
    expect(sameItems(items, items.slice(1))).toBe(false);
  });
  it('row text leads with the kind', () => {
    expect(itemText(item({ id: 'x', kind: 'flood', title: 'Flooding, 3 in' }))).toBe('FLOOD Flooding, 3 in');
  });
});

describe('openItem click sequence', () => {
  type Call = [string, unknown];
  function recorder(zoom: number) {
    const calls: Call[] = [];
    const st = {
      catalog,
      view: { lng: 0, lat: 0, zoom, bearing: 0, pitch: 0 },
      setLayerVisible: (id: string, on: boolean) => calls.push(['visible', [id, on]]),
      flyTo: (p: unknown) => calls.push(['fly', p]),
      select: (s: unknown) => calls.push(['select', s]),
    };
    return { st, calls };
  }

  it('shows the layer, flies (zoom max(cur, 14)), then selects the feature', () => {
    const { st, calls } = recorder(11);
    expect(openItem(item({ id: 'i', layer: 'subway_alerts', feature: 'R01' }), st)).toBe('feature');
    expect(calls).toEqual([
      ['visible', ['subway_alerts', true]],
      ['fly', { lng: -73.98, lat: 40.75, zoom: 14 }],
      ['select', { mode: 'feature', layer: 'subway_alerts', id: 'R01' }],
    ]);
    const deep = recorder(16.5);
    openItem(item({ id: 'i' }), deep.st);
    expect(deep.calls[1]).toEqual(['fly', { lng: -73.98, lat: 40.75, zoom: 16.5 }]);
  });

  it('no feature: the list for a list layer, else only the fly; nothing for unknown layers', () => {
    const a = recorder(11);
    expect(openItem(item({ id: 'i', feature: null, lat: null, lon: null }), a.st)).toBe('list');
    expect(a.calls).toEqual([
      ['visible', ['subway_alerts', true]],
      ['select', { mode: 'list', layer: 'subway_alerts' }],
    ]);
    const b = recorder(11);
    expect(openItem(item({ id: 'i', layer: 'citibike', feature: null }), b.st)).toBe('fly');
    expect(b.calls.map((c) => c[0])).toEqual(['visible', 'fly']);
    const c = recorder(11);
    expect(openItem(item({ id: 'i', layer: 'nope' }), c.st)).toBe('none');
    expect(c.calls).toEqual([]);
  });

  describe('against the real store', () => {
    beforeEach(() => {
      resetStore();
      useApp.setState({ catalog, visible: [] });
    });
    it('a hidden layer is turned on so the selection sticks', () => {
      openItem(item({ id: 'i' }), useApp.getState());
      const s = useApp.getState();
      expect(s.visible).toContain('subway_alerts');
      expect(s.selection).toEqual({ mode: 'feature', layer: 'subway_alerts', id: 'R01' });
      expect(s.fly).toMatchObject({ lng: -73.98, lat: 40.75, zoom: 14 });
    });
  });
});

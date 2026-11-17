import { describe, expect, it } from 'vitest';
import { parseUrl, serializeUrl, type UrlState } from './url';
import { catalog } from './test/fixtures';

const DEFAULT_VISIBLE = ['boroughs', 'nws_alerts', 'road_speeds', 'citibike', 'cameras', 'subway_alerts', 'flood_events'];
const base: UrlState = {
  visible: DEFAULT_VISIBLE,
  boroughs: [],
  filters: {},
  view: { lng: -73.955, lat: 40.725, zoom: 10.6, bearing: 0, pitch: 0 },
  selection: null,
  theme: 'light',
  panel: null,
  scene: { sun: false },
};

const states: Array<[string, UrlState]> = [
  ['defaults', base],
  ['empty layers', { ...base, visible: [] }],
  ['all five boroughs collapse to all', { ...base, boroughs: [] }],
  ['two boroughs', { ...base, boroughs: ['BK', 'QN'] }],
  [
    'enum / select / toggle overrides',
    {
      ...base,
      visible: [...DEFAULT_VISIBLE.slice(0, 3), 'complaints_311', 'citibike', 'collisions'],
      filters: {
        citibike: { state: ['empty', 'low'], ebikes: true },
        complaints_311: { window: '48h', status: [] },
        flood_events: { depth: '12' },
        collisions: { severity: ['3'] },
      },
    },
  ],
  [
    'selection id with : and /',
    { ...base, selection: { mode: 'feature', layer: 'cameras', id: 'cam:abc/def%20 x+y' } },
  ],
  ['list mode', { ...base, selection: { mode: 'list', layer: 'subway_alerts' } }],
  ['dark theme + panel', { ...base, theme: 'dark', panel: 'health' }],
  ['another centre and zoom', { ...base, view: { lng: -73.9857, lat: 40.7484, zoom: 12.35, bearing: 0, pitch: 0 } }],
  ['t=live preserved', { ...base, t: 'live' }],
];

describe('url round trip', () => {
  it.each(states)('%s', (_name, s) => {
    const q = serializeUrl(s, catalog);
    expect(parseUrl(q, catalog)).toEqual(s);
    // and serialising again is a fixed point
    expect(serializeUrl(parseUrl(q, catalog), catalog)).toBe(q);
  });

  it('writes params in canonical order', () => {
    const s: UrlState = {
      visible: ['road_speeds', 'citibike', 'complaints_311', 'cameras'],
      boroughs: ['QN', 'BK'],
      filters: { complaints_311: { window: '48h' }, citibike: { ebikes: true, state: ['low', 'empty'] } },
      view: { lng: -73.9857, lat: 40.7484, zoom: 12.35, bearing: 15, pitch: 30 },
      selection: { mode: 'feature', layer: 'cameras', id: 'a:b' },
      theme: 'dark',
      panel: 'health',
      scene: { sun: true },
      t: 'live',
    };
    expect(serializeUrl(s, catalog)).toBe(
      '?layers=road_speeds,complaints_311,citibike,cameras&borough=BK,QN&f.citibike.ebikes=1&f.citibike.state=empty,low' +
        '&f.complaints_311.window=48h&c=-73.98570,40.74840&z=12.35&sel=cameras:a%3Ab&theme=dark&panel=health&sun=1&t=live',
    );
  });

  it('omits defaults but always writes layers, c and z', () => {
    expect(serializeUrl(base, catalog)).toBe(
      '?layers=boroughs,nws_alerts,road_speeds,citibike,cameras,subway_alerts,flood_events&c=-73.95500,40.72500&z=10.60',
    );
    expect(serializeUrl({ ...base, visible: [] }, catalog)).toBe('?layers=&c=-73.95500,40.72500&z=10.60');
  });

  it('drops filter overrides equal to the default', () => {
    const s = { ...base, filters: { citibike: { state: ['offline', 'full', 'ok', 'low', 'empty'] }, complaints_311: { window: '24h' } } };
    expect(serializeUrl(s, catalog)).not.toContain('f.');
    expect(parseUrl('?f.citibike.state=empty,low,ok,full,offline&f.complaints_311.window=24h', catalog).filters).toEqual({});
  });

  it('absent layers means catalog defaults; layers= means none', () => {
    expect(parseUrl('', catalog).visible).toEqual(DEFAULT_VISIBLE);
    expect(parseUrl('?layers=', catalog).visible).toEqual([]);
  });

  it('always opens top-down and north up: tilt and rotation are neither read nor written', () => {
    const u = parseUrl('?c=-73.98,40.75&z=15&b=30&p=45&3d=1', catalog);
    expect(u.view.bearing).toBe(0);
    expect(u.view.pitch).toBe(0);
    const tilted = { ...base, view: { ...base.view, bearing: 30, pitch: 45 } };
    expect(serializeUrl(tilted, catalog)).not.toMatch(/[?&][bp]=/);
  });

  it('drops unknown layers, keys and values silently', () => {
    const u = parseUrl(
      '?layers=citibike,nope,cameras,citibike&borough=BK,XX,zz&f.nope.x=1&f.citibike.zzz=1&f.citibike.state=empty,bogus' +
        '&f.complaints_311.window=99h&f.citibike.ebikes=maybe&c=abc,40&z=wat&b=x&p=&sel=nope:1&list=citibike&theme=neon&panel=x&3d=yes&sun=2&t=1999&foo=bar',
      catalog,
    );
    expect(u).toEqual({
      visible: ['citibike', 'cameras'],
      boroughs: ['BK'],
      filters: { citibike: { state: ['empty'] } },
      view: base.view,
      selection: null,
      theme: 'light',
      panel: null,
      scene: { sun: false },
    });
  });

  it('sel splits at the first colon; sel wins over list; sel on hidden layer dropped', () => {
    expect(parseUrl('?sel=cameras:a:b:c', catalog).selection).toEqual({ mode: 'feature', layer: 'cameras', id: 'a:b:c' });
    expect(parseUrl('?sel=cameras:x&list=subway_alerts', catalog).selection).toEqual({ mode: 'feature', layer: 'cameras', id: 'x' });
    expect(parseUrl('?layers=citibike&sel=cameras:x', catalog).selection).toBeNull();
  });

  it('clamps zoom to the catalog range and rounds', () => {
    expect(parseUrl('?z=30', catalog).view.zoom).toBe(18.5);
    expect(parseUrl('?c=-73.123456789,40.987654321&z=11.239', catalog).view).toMatchObject({ lng: -73.12346, lat: 40.98765, zoom: 11.24 });
  });

  it('orders boroughs canonically and treats all five as all', () => {
    expect(parseUrl('?borough=QN,MN', catalog).boroughs).toEqual(['MN', 'QN']);
    expect(parseUrl('?borough=SI,BX,QN,BK,MN', catalog).boroughs).toEqual([]);
  });
});

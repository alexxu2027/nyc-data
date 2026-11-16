import { validateStyleMin, type StyleSpecification } from '@maplibre/maplibre-gl-style-spec';
import { describe, expect, it } from 'vitest';
import type { LayerDef, LayerFeature } from '../../types';
import { LIGHT_TOKENS, styleToPaint } from '../styleToPaint';
import { dataAsOf, ease, positionAt, positions, progressAt, tickMs, trains, tween, TWEEN_MS } from './trains';

const T0 = '2026-11-16T08:00:00Z';
const T1 = '2026-11-16T08:02:00Z';
const t0 = Date.parse(T0);
const t1 = Date.parse(T1);

function line(coords: Array<[number, number]>, props: Record<string, unknown> = {}): LayerFeature {
  return {
    type: 'Feature',
    geometry: { type: 'LineString', coordinates: coords },
    properties: { id: 'trip:1', borough: null, route: 'A', line: 'ACE', color: '#0062cf', t0: T0, t1: T1, run_s: 120, at_stop: false, seen_at: T0, ...props },
  };
}

function pt(lon: number, lat: number, props: Record<string, unknown> = {}): LayerFeature {
  return {
    type: 'Feature',
    geometry: { type: 'Point', coordinates: [lon, lat] },
    properties: { id: 'trip:2', borough: null, route: '7', line: '7', t0: T0, t1: T0, run_s: 0, at_stop: true, seen_at: T0, ...props },
  };
}

// Two equal legs at the equator: the halfway point by distance is the middle vertex.
const TRACK: Array<[number, number]> = [
  [0, 0],
  [0.01, 0],
  [0.01, 0.01],
];

describe('positionAt', () => {
  it('t0 is the start of the track', () => {
    expect(positionAt(line(TRACK), t0)).toEqual([0, 0]);
  });

  it('t1 is the end of the track', () => {
    expect(positionAt(line(TRACK), t1)).toEqual([0.01, 0.01]);
  });

  it('clamps to the end after t1 and to the start before t0', () => {
    expect(positionAt(line(TRACK), t1 + 600_000)).toEqual([0.01, 0.01]);
    expect(positionAt(line(TRACK), t0 - 60_000)).toEqual([0, 0]);
  });

  it('moves linearly by distance along the track', () => {
    const mid = positionAt(line(TRACK), (t0 + t1) / 2)!;
    expect(mid[0]).toBeCloseTo(0.01, 9);
    expect(mid[1]).toBeCloseTo(0, 9);
    const q = positionAt(line(TRACK), t0 + (t1 - t0) / 4)!;
    expect(q[0]).toBeCloseTo(0.005, 9);
    expect(q[1]).toBeCloseTo(0, 9);
  });

  it('a Point feature stays at its point; a zero-length run is at the end', () => {
    expect(positionAt(pt(-73.9, 40.7), t0 + 5000)).toEqual([-73.9, 40.7]);
    expect(progressAt(line(TRACK, { t1: T0 }), t0)).toBe(1);
    expect(progressAt(line(TRACK, { t0: 'bad' }), t0)).toBe(1);
  });
});

describe('positions', () => {
  it('turns every train into a Point feature with its props and id', () => {
    const fc = positions([line(TRACK), pt(-73.9, 40.7)], t1);
    expect(fc.features).toHaveLength(2);
    for (const f of fc.features) expect(f.geometry.type).toBe('Point');
    expect(fc.features[0].id).toBe('trip:1');
    expect(fc.features[0].properties).toMatchObject({ id: 'trip:1', route: 'A', line: 'ACE', stale: false });
    expect(fc.features[0].geometry.coordinates).toEqual([0.01, 0.01]);
    expect(positions([line(TRACK)], t1, true).features[0].properties.stale).toBe(true);
  });

  it('skips features without a geometry', () => {
    const bad = { ...line(TRACK), geometry: null } as unknown as LayerFeature;
    expect(positions([bad], t0).features).toHaveLength(0);
  });
});

describe('tween', () => {
  it('eases from the drawn position to the target over 1.5 s', () => {
    const from: [number, number] = [0, 0];
    const to: [number, number] = [1, 2];
    expect(tween(from, to, 0)).toEqual([0, 0]);
    expect(tween(from, to, TWEEN_MS / 2)).toEqual([0.5, 1]);
    expect(tween(from, to, TWEEN_MS)).toEqual(to);
    expect(tween(from, to, TWEEN_MS * 3)).toEqual(to);
    const early = tween(from, to, TWEEN_MS / 4)[0];
    expect(early).toBeGreaterThan(0);
    expect(early).toBeLessThan(0.25); // eased in, not linear
    expect(ease(-1)).toBe(0);
    expect(ease(2)).toBe(1);
  });
});

describe('tickMs', () => {
  it('steps by zoom', () => {
    expect(tickMs(10)).toBe(1000);
    expect(tickMs(11.99)).toBe(1000);
    expect(tickMs(12)).toBe(250);
    expect(tickMs(13.9)).toBe(250);
    expect(tickMs(14)).toBe(100);
    expect(tickMs(17)).toBe(100);
  });
});

describe('dataAsOf', () => {
  it('prefers meta, else the newest seen_at', () => {
    expect(dataAsOf(T1, [])).toBe(t1);
    expect(dataAsOf(null, [line(TRACK, { seen_at: T0 }), pt(0, 0, { seen_at: T1 })])).toBe(t1);
    expect(dataAsOf(null, [])).toBeNull();
  });
});

describe('trains renderer', () => {
  const def = {
    id: 'subway_trains',
    kind: 'point',
    style: {
      color: { prop: 'line', scale: 'match', stops: [['ACE', '#0062cf'], ['7', '#9a38a1']], default: '#7c858c' },
      radius: { value: 4 },
      label: { prop: 'route', min_zoom: 13 },
    },
  } as unknown as LayerDef;
  const r = trains({ def, paint: styleToPaint(def, LIGHT_TOKENS), t: LIGHT_TOKENS, source: 'nl-subway_trains' });

  it('draws dots and labels on the derived position source, with a live hook', () => {
    expect(r.extra?.map((x) => x.id)).toEqual(['nl-subway_trains-pos']);
    expect(r.extra?.[0].spec).toEqual({ promoteId: 'id' });
    expect(r.hit).toEqual(['nl-subway_trains-dot']);
    expect(typeof r.live).toBe('function');
    for (const l of [...r.layers, ...r.halo]) expect((l as { source: string }).source).toBe('nl-subway_trains-pos');
    const lab = r.layers.find((l) => l.type === 'symbol') as { minzoom?: number };
    expect(lab.minzoom).toBe(13);
  });

  it('produces a valid style', () => {
    const style: StyleSpecification = {
      version: 8,
      glyphs: 'https://example.org/{fontstack}/{range}.pbf',
      sources: {
        'nl-subway_trains': { type: 'geojson', data: { type: 'FeatureCollection', features: [] } },
        'nl-subway_trains-pos': { type: 'geojson', data: { type: 'FeatureCollection', features: [] }, promoteId: 'id' },
      },
      layers: [...r.layers, ...r.halo],
    };
    expect(validateStyleMin(style).map((e) => e.message)).toEqual([]);
  });

  it('extra build gives Point features', () => {
    const fc = r.extra![0].build([line(TRACK)]);
    expect(fc.features[0].geometry.type).toBe('Point');
  });
});

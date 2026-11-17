import { validateStyleMin, type StyleSpecification } from '@maplibre/maplibre-gl-style-spec';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { LayerDef, LayerFeature } from '../../types';
import { LIGHT_TOKENS, styleToPaint } from '../styleToPaint';
import { CATCH_UP_FLOOR, catchUp, dataAsOf, ease, FREEZE_AFTER_MS, metres, motionAt, positionAt, positions, progressAt, tickMs, TRACK_OPACITY, TRACK_URL, trains, tween, TWEEN_MS } from './trains';

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
    expect(tickMs(10)).toBe(250);
    expect(tickMs(11.99)).toBe(250);
    expect(tickMs(12)).toBe(50);
    expect(tickMs(13.9)).toBe(50);
    expect(tickMs(14)).toBe(33);
    expect(tickMs(17)).toBe(33);
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
    expect(r.extra?.map((x) => x.id)).toEqual(['nl-subway_trains-track', 'nl-subway_trains-pos']);
    expect(r.extra?.[1].spec).toEqual({ promoteId: 'id' });
    expect(r.hit).toEqual(['nl-subway_trains-dot']);
    expect(typeof r.live).toBe('function');
    for (const l of [...r.layers.slice(1), ...r.halo]) expect((l as { source: string }).source).toBe('nl-subway_trains-pos');
    const lab = r.layers.find((l) => l.type === 'symbol') as { minzoom?: number };
    expect(lab.minzoom).toBe(13);
  });

  it('draws the subway lines first (under the dots), faint, from the static track url', () => {
    const track = r.layers[0] as { id: string; type: string; source: string; paint: Record<string, unknown> };
    expect(track).toMatchObject({ id: 'nl-subway_trains-track', type: 'line', source: 'nl-subway_trains-track' });
    expect(track.paint['line-opacity']).toBe(TRACK_OPACITY);
    expect(TRACK_OPACITY).toBeLessThanOrEqual(0.4);
    expect(r.extra?.[0]).toEqual({ id: 'nl-subway_trains-track', url: TRACK_URL });
    expect(TRACK_URL).toBe('/api/static/subway_lines');
    expect(r.hit).not.toContain(track.id); // not clickable
  });

  it('produces a valid style', () => {
    const style: StyleSpecification = {
      version: 8,
      glyphs: 'https://example.org/{fontstack}/{range}.pbf',
      sources: {
        'nl-subway_trains': { type: 'geojson', data: { type: 'FeatureCollection', features: [] } },
        'nl-subway_trains-pos': { type: 'geojson', data: { type: 'FeatureCollection', features: [] }, promoteId: 'id' },
        'nl-subway_trains-track': { type: 'geojson', data: { type: 'FeatureCollection', features: [] } },
      },
      layers: [...r.layers, ...r.halo],
    };
    expect(validateStyleMin(style).map((e) => e.message)).toEqual([]);
  });

  it('extra build gives Point features', () => {
    const fc = r.extra![1].build!([line(TRACK)]);
    expect(fc.features[0].geometry.type).toBe('Point');
  });
});

describe('train animator under reduced motion', () => {
  afterEach(() => vi.useRealTimers());

  it('still turns the dots hollow when the data goes stale (review 2026-11-16, #9)', () => {
    vi.useFakeTimers();
    vi.setSystemTime(t0 + 10_000);
    const def = { id: 'subway_trains', kind: 'point', style: { radius: { value: 4 } } } as unknown as LayerDef;
    const r = trains({ def, paint: styleToPaint(def, LIGHT_TOKENS), t: LIGHT_TOKENS, source: 'nl-subway_trains' });
    const pushed: boolean[][] = [];
    const src = {
      setData: (fc: { features: Array<{ properties: { stale: boolean } }> }) => {
        pushed.push(fc.features.map((f) => f.properties.stale));
      },
    };
    // Anything else the hook calls on the map is a no-op.
    const map = new Proxy({ getSource: () => src, getZoom: () => 12 } as Record<string, unknown>, {
      get: (o, k: string) => (k in o ? o[k] : () => undefined),
    });
    const live = r.live!({ map, def, source: 'nl-subway_trains', beforeId: undefined, reducedMotion: () => true } as never);
    live.update([pt(0, 0, { seen_at: T0 })], true);
    expect(pushed.at(-1)).toEqual([false]);
    vi.advanceTimersByTime(FREEZE_AFTER_MS + 10_000);
    expect(pushed.at(-1)).toEqual([true]);
    live.destroy();
  });
});

// ---- catch-up runs (2026-11-17): late data never makes a train lurch -------------------------
const NEXT: Array<[number, number]> = [
  [0.01, 0.01],
  [0.02, 0.01],
];

describe('catchUp', () => {
  const near = (a: number[], b: number[]) => {
    expect(a[0]).toBeCloseTo(b[0], 6);
    expect(a[1]).toBeCloseTo(b[1], 6);
  };
  // The new run began 30 s before we learned of it.
  const late = (offsetS = -30, runS = 120) => {
    const s = t1 + offsetS * 1000;
    return line(NEXT, { t0: new Date(s).toISOString(), t1: new Date(s + runS * 1000).toISOString(), run_s: runS });
  };

  it('starts where the train is drawn and arrives at the scheduled t1', () => {
    const old = line(TRACK);
    const next = late();
    const from = positionAt(old, t1) as [number, number]; // waiting at the stop
    const m = catchUp(old, next, from, t1)!;
    expect(m).not.toBeNull();
    near(motionAt(m, t1), from); // no jump on arrival of the data
    expect(m.end).toBe(Date.parse(next.properties.t1 as string));
    near(motionAt(m, m.end), [0.02, 0.01]);
    // The clock alone would have put it 30 s (a quarter of the run) down the track already.
    expect(metres(positionAt(next, t1)!, from)).toBeGreaterThan(200);
  });

  it('finishes the run it was on first when it is short of the stop', () => {
    const old = line(TRACK);
    const half = t0 + 60_000;
    const from = positionAt(old, half) as [number, number]; // the middle vertex
    const m = catchUp(old, late(), from, half)!;
    near(motionAt(m, half), from);
    // The path goes through the old run's end before the new track.
    expect(m.track.coords.some((c) => c[0] === 0.01 && c[1] === 0.01)).toBe(true);
    near(motionAt(m, m.end), [0.02, 0.01]);
  });

  it('a run that does not join is left to the ease', () => {
    const far = line([
      [0.5, 0.5],
      [0.6, 0.5],
    ]);
    expect(catchUp(line(TRACK), far, [0.01, 0.01], t1)).toBeNull();
    expect(catchUp(line(TRACK), pt(0.01, 0.01), [0.01, 0.01], t1)).toBeNull();
  });

  it('never compresses a run below CATCH_UP_FLOOR of its scheduled time', () => {
    const next = late(-200, 120); // learned after it should already have arrived
    const m = catchUp(line(TRACK), next, [0.01, 0.01], t1)!;
    expect(m.end).toBe(t1 + CATCH_UP_FLOOR * 120_000);
  });
});

describe('train animator on new data', () => {
  afterEach(() => vi.useRealTimers());

  it('a train that moved on to the next run carries on without a jump', () => {
    vi.useFakeTimers();
    vi.setSystemTime(t1);
    const def = { id: 'subway_trains', kind: 'point', style: { radius: { value: 4 } } } as unknown as LayerDef;
    const r = trains({ def, paint: styleToPaint(def, LIGHT_TOKENS), t: LIGHT_TOKENS, source: 'nl-subway_trains' });
    const pushed: number[][][] = [];
    const src = {
      setData: (fc: { features: Array<{ geometry: { coordinates: number[] } }> }) => {
        pushed.push(fc.features.map((f) => f.geometry.coordinates));
      },
    };
    const map = new Proxy({ getSource: () => src, getZoom: () => 12 } as Record<string, unknown>, {
      get: (o, k: string) => (k in o ? o[k] : () => undefined),
    });
    const live = r.live!({ map, def, source: 'nl-subway_trains', beforeId: undefined, reducedMotion: () => false } as never);
    live.update([line(TRACK, { seen_at: T1 })], true);
    const before = pushed.at(-1)![0]; // at the stop
    const s = t1 - 30_000;
    live.update([line(NEXT, { t0: new Date(s).toISOString(), t1: new Date(s + 120_000).toISOString(), seen_at: T1 })], true);
    expect(metres(pushed.at(-1)![0], before)).toBeLessThan(1);
    vi.advanceTimersByTime(90_000); // the scheduled arrival
    expect(metres(pushed.at(-1)![0], [0.02, 0.01])).toBeLessThan(1);
    live.destroy();
  });
});

describe('train labels', () => {
  it('always draw and never hide other labels (no blinking, street names stay put)', () => {
    const def = { id: 'subway_trains', kind: 'point', style: { radius: { value: 4 } } } as unknown as LayerDef;
    const r = trains({ def, paint: styleToPaint(def, LIGHT_TOKENS), t: LIGHT_TOKENS, source: 'nl-subway_trains' });
    const lab = r.layers.find((l) => l.type === 'symbol') as { layout: Record<string, unknown> };
    expect(lab.layout['text-allow-overlap']).toBe(true);
    expect(lab.layout['text-ignore-placement']).toBe(true);
  });
});

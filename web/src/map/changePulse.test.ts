import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Map as MlMap } from 'maplibre-gl';
import {
  ChangeFlash,
  FLASH_MAX_IDS,
  FLASH_REST,
  FLASH_RINGS,
  FLASH_STEPS,
  FLASH_STEP_MS,
  FLASH_STILL_MS,
  flashFrames,
  flashLayer,
  flashPaint,
} from './changePulse';

type Call = [string, ...unknown[]];

function fakeMap(layers: string[]) {
  const calls: Call[] = [];
  const have = new Set(layers);
  const map = {
    getLayer: (id: string) => (have.has(id) ? { id } : undefined),
    setFilter: (id: string, f: unknown) => calls.push(['filter', id, f]),
    setPaintProperty: (id: string, k: string, v: unknown) => calls.push(['paint', id, k, v]),
  };
  return { map: map as unknown as MlMap, calls, have };
}

let reduced = false;
let hidden = false;

beforeEach(() => {
  vi.useFakeTimers();
  reduced = false;
  hidden = false;
  vi.stubGlobal('matchMedia', (q: string) => ({
    matches: q.includes('reduce') ? reduced : false,
    addEventListener() {},
    removeEventListener() {},
  }));
  Object.defineProperty(document, 'hidden', { configurable: true, get: () => hidden });
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

const opacities = (calls: Call[]) =>
  calls.filter((c) => c[0] === 'paint' && c[2] === 'circle-stroke-opacity').map((c) => c[3] as number);
const filters = (calls: Call[]) => calls.filter((c) => c[0] === 'filter').map((c) => JSON.stringify(c[2]));

describe('flash schedule', () => {
  it('steps each ring in FLASH_STEPS even steps, then hides', () => {
    const f = flashFrames(false);
    expect(f).toHaveLength(FLASH_RINGS * FLASH_STEPS + 1);
    expect(f.slice(0, FLASH_STEPS).map((x) => x.p)).toEqual([0, 1, 2, 3, 4, 5].map((s) => s / FLASH_STEPS));
    expect(f.map((x) => x.at)).toEqual(f.map((_, i) => i * FLASH_STEP_MS));
    expect(f[f.length - 1]).toEqual({ at: FLASH_RINGS * FLASH_STEPS * FLASH_STEP_MS, p: null });
  });

  it('reduced motion is one still ring, then hides', () => {
    expect(flashFrames(true)).toEqual([
      { at: 0, p: FLASH_REST },
      { at: FLASH_STILL_MS, p: null },
    ]);
  });

  it('the ring grows and fades', () => {
    const a = flashPaint(0)['circle-stroke-opacity'] as number;
    const b = flashPaint(5 / 6)['circle-stroke-opacity'] as number;
    expect(a).toBeGreaterThan(b);
    expect(b).toBeGreaterThan(0);
    const spec = flashLayer('citibike', 'nl-citibike', '#111111') as unknown as { id: string; source: string };
    expect(spec.id).toBe('nl-citibike-flash');
    expect(spec.source).toBe('nl-citibike');
  });
});

describe('ChangeFlash', () => {
  it('filters to the ids, paints each step on time, then clears the filter', () => {
    const { map, calls } = fakeMap(['nl-citibike-flash']);
    const cf = new ChangeFlash(map);
    cf.setTargets([{ layer: 'citibike', id: 'nl-citibike-flash' }]);
    cf.flash('citibike', ['a', 'b']);
    expect(filters(calls)[0]).toContain('"a","b"');
    expect(opacities(calls)).toHaveLength(1);
    vi.advanceTimersByTime(FLASH_STEP_MS - 1);
    expect(opacities(calls)).toHaveLength(1);
    vi.advanceTimersByTime(1);
    expect(opacities(calls)).toHaveLength(2);
    vi.advanceTimersByTime(FLASH_RINGS * FLASH_STEPS * FLASH_STEP_MS);
    expect(opacities(calls)).toHaveLength(FLASH_RINGS * FLASH_STEPS);
    expect(filters(calls).at(-1)).toContain('[]');
    expect(cf.active()).toEqual([]);
    cf.destroy();
  });

  it('reduced motion: one paint, held for FLASH_STILL_MS', () => {
    reduced = true;
    const { map, calls } = fakeMap(['f']);
    const cf = new ChangeFlash(map);
    cf.setTargets([{ layer: 'x', id: 'f' }]);
    cf.flash('x', ['1']);
    vi.advanceTimersByTime(FLASH_STILL_MS - 1);
    expect(opacities(calls)).toEqual([flashPaint(FLASH_REST)['circle-stroke-opacity']]);
    expect(cf.active()).toEqual(['x']);
    vi.advanceTimersByTime(1);
    expect(cf.active()).toEqual([]);
    expect(filters(calls)).toHaveLength(2);
    cf.destroy();
  });

  it('skips unknown layers, empty ids and hidden tabs; caps the id list; restarts', () => {
    const { map, calls } = fakeMap(['f']);
    const cf = new ChangeFlash(map);
    cf.flash('x', ['1']); // no targets yet
    cf.setTargets([{ layer: 'x', id: 'f' }]);
    cf.flash('x', []);
    hidden = true;
    cf.flash('x', ['1']);
    expect(calls).toEqual([]);
    hidden = false;
    const many = Array.from({ length: FLASH_MAX_IDS + 50 }, (_, i) => String(i));
    cf.flash('x', many);
    const f = JSON.parse(filters(calls)[0]) as [string, unknown, ['literal', string[]]];
    expect(f[2][1]).toHaveLength(FLASH_MAX_IDS);
    vi.advanceTimersByTime(FLASH_STEP_MS * 3);
    cf.flash('x', ['z']); // restart: clear, then the new filter
    expect(filters(calls).slice(-2)).toEqual([filters(calls).at(-2), JSON.stringify(['in', ['to-string', ['get', 'id']], ['literal', ['z']]])]);
    expect(filters(calls).at(-2)).toContain('[]');
    // Going hidden stops it at once.
    hidden = true;
    document.dispatchEvent(new Event('visibilitychange'));
    expect(cf.active()).toEqual([]);
    cf.setTargets([]);
    cf.destroy();
  });
});

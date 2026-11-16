import { describe, expect, it } from 'vitest';
import { clip, holdTo, hourTicks, niceExtent, seriesPath } from './path';

const D = { x0: 0, x1: 100, y0: 0, y1: 10 };

describe('seriesPath', () => {
  it('maps points into the box with y up', () => {
    expect(seriesPath([[0, 0], [50, 5], [100, 10]], D, 200, 50)).toBe('M0 50L100 25L200 0');
  });

  it('draws a step chart that holds each value', () => {
    expect(seriesPath([[0, 2], [50, 2], [100, 6]], D, 100, 10, { step: true })).toBe('M0 8H50H100V4');
  });

  it('breaks the line across gaps and non-finite values', () => {
    expect(seriesPath([[0, 0], [10, 0], [60, 0]], D, 100, 10, { gap: 20 })).toBe('M0 10L10 10 M60 10h0.1');
    expect(seriesPath([[0, 0], [10, 0], [60, 0], [70, 0]], D, 100, 10, { gap: 20 })).toBe('M0 10L10 10 M60 10L70 10');
    expect(seriesPath([[0, 0], [10, Number.NaN], [20, 0], [30, 0]], D, 100, 10)).toBe('M0 10h0.1 M20 10L30 10');
  });

  it('returns "" for no points and a visible tick for one', () => {
    expect(seriesPath([], D, 100, 10)).toBe('');
    expect(seriesPath([[50, 5]], D, 100, 10)).toBe('M50 5h0.1');
  });

  it('centres a flat domain instead of dividing by zero', () => {
    expect(seriesPath([[0, 3], [100, 3]], { x0: 0, x1: 100, y0: 3, y1: 3 }, 100, 10)).toBe('M0 5L100 5');
  });

  it('rounds to one decimal', () => {
    expect(seriesPath([[0, 1], [33.333, 2]], D, 100, 10)).toBe('M0 9L33.3 8');
  });
});

describe('helpers', () => {
  it('holdTo extends the last value to x', () => {
    expect(holdTo([[0, 1], [5, 2]], 9)).toEqual([[0, 1], [5, 2], [9, 2]]);
    expect(holdTo([[0, 1], [9, 2]], 9)).toEqual([[0, 1], [9, 2]]);
    expect(holdTo([], 9)).toEqual([]);
  });

  it('clip keeps points inside the range', () => {
    expect(clip([[0, 1], [5, 2], [11, 3]], 0, 10)).toEqual([[0, 1], [5, 2]]);
  });

  it('niceExtent rounds outward, pins zero and widens flat series', () => {
    expect(niceExtent([0.95, 4.47])).toEqual([0, 5]);
    expect(niceExtent([3, 7], { zero: true })).toEqual([0, 8]);
    expect(niceExtent([5, 5], { minSpan: 4 })).toEqual([3, 7]);
    expect(niceExtent([0, 0], { zero: true, minSpan: 4 })).toEqual([0, 4]);
    expect(niceExtent([])).toEqual([0, 1]);
    expect(niceExtent([Number.NaN, 2, 3])).toEqual([2, 3]);
  });

  it('hourTicks labels relative hours with NOW', () => {
    const now = 1_000_000;
    expect(hourTicks(now - 24 * 3600, now + 12 * 3600, now).map((t) => t.label)).toEqual([
      '−24 H',
      '−12 H',
      'NOW',
      '+12 H',
    ]);
    expect(hourTicks(now - 24 * 3600, now, now).map((t) => t.label)).toEqual(['−24 H', '−12 H', 'NOW']);
  });
});

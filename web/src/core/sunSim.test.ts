import { afterEach, describe, expect, it, vi } from 'vitest';
import { nlSun, nyTime } from './sunSim';
import { SUN_CLOCK_EVENT, sunClock, sunSimulated } from './sun';
import { sunLines } from '../map/Controls';

afterEach(() => {
  nlSun.live();
  vi.useRealTimers();
});

describe('nlSun: simulate the sun from the console', () => {
  it('reads New York times, EST in November and EDT in June', () => {
    expect(new Date(nyTime('2026-11-17 14:00')).toISOString()).toBe('2026-11-17T19:00:00.000Z');
    expect(new Date(nyTime('2026-06-21 12:57')).toISOString()).toBe('2026-06-21T16:57:00.000Z');
  });

  it('at() sets the clock and tells everything to redraw; live() goes back', () => {
    const seen: string[] = [];
    const on = () => seen.push('redraw');
    window.addEventListener(SUN_CLOCK_EVENT, on);
    nlSun.at('2026-11-17 14:00');
    expect(sunSimulated()).toBe(true);
    expect(sunClock()).toBe(Date.parse('2026-11-17T19:00:00Z'));
    nlSun.live();
    expect(sunSimulated()).toBe(false);
    expect(seen).toEqual(['redraw', 'redraw']);
    window.removeEventListener(SUN_CLOCK_EVENT, on);
  });

  it('timelapse() runs the span over the given seconds, then stops at the end', () => {
    vi.useFakeTimers();
    nlSun.timelapse({ from: '2026-11-17 05:00', hours: 16, seconds: 10 });
    expect(sunClock()).toBe(nyTime('2026-11-17 05:00'));
    vi.advanceTimersByTime(5000);
    expect(Math.abs(sunClock() - nyTime('2026-11-17 13:00'))).toBeLessThan(15 * 60_000);
    vi.advanceTimersByTime(6000);
    expect(sunClock()).toBe(nyTime('2026-11-17 21:00'));
  });

  it('the readout says when the sun is simulated, and what time it shows', () => {
    const l = sunLines(Date.parse('2026-11-17T19:00:00Z'), 40.75, -73.98, 16, true);
    expect(l[0]).toBe('SIMULATED NOV 17, 2:00 PM ET');
  });
});

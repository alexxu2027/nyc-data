import { describe, expect, it } from 'vitest';
import { easeOut, phaseAt, PULSE_PERIOD_MS, pulsePaint } from './pulse';

describe('alert pulse (smooth, 2026-11-17)', () => {
  it('phase runs continuously through the period, not in steps', () => {
    const phases = Array.from({ length: 24 }, (_, i) => phaseAt(i * 100));
    expect(new Set(phases).size).toBe(24);
    expect(phaseAt(PULSE_PERIOD_MS / 2)).toBeCloseTo(0.5);
    expect(phaseAt(PULSE_PERIOD_MS)).toBe(0);
  });

  it('eases out: most of the spread happens early, then it slows', () => {
    expect(easeOut(0)).toBe(0);
    expect(easeOut(1)).toBe(1);
    expect(easeOut(0.25)).toBeGreaterThan(0.5);
    const steps = [0, 0.2, 0.4, 0.6, 0.8, 1].map(easeOut);
    const gaps = steps.slice(1).map((v, i) => v - steps[i]);
    for (let i = 1; i < gaps.length; i++) expect(gaps[i]).toBeLessThan(gaps[i - 1]);
  });

  it('fades to nothing before it restarts, so the loop never pops', () => {
    expect(pulsePaint('circle', 0.999)['circle-stroke-opacity']).toBe(0);
    expect(pulsePaint('line', 0.999)['line-opacity']).toBe(0);
    expect(pulsePaint('circle', 0)['circle-stroke-opacity']).toBe(0.8);
  });
});

import { describe, expect, it } from 'vitest';
import { READOUT_LEVELS, readoutParts } from './SeriesChart';

const TIDE = [
  { glyph: '──', label: 'OBSERVED', short: 'OBS', value: '3.81 FT' },
  { glyph: '╌╌', label: 'PREDICTED', short: 'PRED', value: '3.72 FT' },
];
const line = (level: number) => {
  const p = readoutParts(level, '1:45 AM ET', TIDE);
  return [p.time, ...p.items].filter(Boolean).join('  ');
};

describe('chart hover readout: one line, shorter at each level', () => {
  it('steps from the full line down to values only', () => {
    expect(line(0)).toBe('1:45 AM ET  ── OBSERVED 3.81 FT  ╌╌ PREDICTED 3.72 FT');
    expect(line(1)).toBe('1:45 AM  ── OBSERVED 3.81 FT  ╌╌ PREDICTED 3.72 FT');
    expect(line(2)).toBe('1:45 AM  ── OBS 3.81 FT  ╌╌ PRED 3.72 FT');
    expect(line(3)).toBe('1:45 AM  OBS 3.81 FT  PRED 3.72 FT');
    expect(line(4)).toBe('1:45 AM  ── 3.81 FT  ╌╌ 3.72 FT');
    expect(line(5)).toBe('── 3.81  ╌╌ 3.72');
    expect(READOUT_LEVELS).toBe(6);
  });

  it('every level is shorter than the one before', () => {
    for (let l = 1; l < READOUT_LEVELS; l++) expect(line(l).length).toBeLessThan(line(l - 1).length);
  });

  it('a series without a short label keeps its label; units like °F drop at the end', () => {
    const p = readoutParts(5, '2:00 PM ET', [{ glyph: '──', label: 'TEMP', value: '41.2 °F' }]);
    expect(p.items).toEqual(['── 41.2']);
    expect(readoutParts(2, '2:00 PM ET', [{ glyph: '──', label: 'TEMP', value: '41.2 °F' }]).items).toEqual(['── TEMP 41.2 °F']);
  });
});

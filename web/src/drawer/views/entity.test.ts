import { describe, expect, it } from 'vitest';
import { floodDepthReadout } from './entity';

describe('floodDepthReadout', () => {
  it('shows the live depth and its time', () => {
    expect(floodDepthReadout(3.2, true, '2026-11-15T06:42:00Z')).toEqual({ k: 'DEPTH NOW', v: '3.2 IN', r: '1:42 AM ET' });
  });
  it('says when the last reading is old', () => {
    expect(floodDepthReadout(5, false, '2026-11-15T01:00:00Z')).toEqual({ k: 'DEPTH', v: 'NO READING', r: 'SINCE 8:00 PM ET' });
  });
  it('says so when depth was never collected', () => {
    expect(floodDepthReadout(null, false, null).r).toBe('LIVE DEPTH NOT COLLECTED YET');
  });
});

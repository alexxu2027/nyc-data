import { describe, expect, it } from 'vitest';
import { fmtAgo, fmtInt, fmtTime } from './time';

describe('fmtTime (America/New_York)', () => {
  it('renders ET', () => {
    expect(fmtTime('2026-11-15T08:28:00Z')).toBe('3:28 AM ET');
    expect(fmtTime('2026-11-15T08:28:00Z', 'datetime')).toBe('Nov 15, 3:28 AM ET');
    expect(fmtTime('2026-11-15T08:28:00Z', 'date')).toBe('Nov 15, 2026');
    expect(fmtTime('2026-07-04T16:05:00Z')).toBe('12:05 PM ET');
  });
  it('handles the fall-back DST boundary (2026-11-01)', () => {
    expect(fmtTime('2026-11-01T04:30:00Z')).toBe('12:30 AM ET'); // EDT
    expect(fmtTime('2026-11-01T05:30:00Z')).toBe('1:30 AM ET'); // EDT, first 1:30
    expect(fmtTime('2026-11-01T06:30:00Z')).toBe('1:30 AM ET'); // EST, second 1:30
    expect(fmtTime('2026-11-01T07:30:00Z')).toBe('2:30 AM ET'); // EST
  });
  it('handles the spring-forward DST boundary (2026-03-08)', () => {
    expect(fmtTime('2026-03-08T06:59:00Z')).toBe('1:59 AM ET');
    expect(fmtTime('2026-03-08T07:00:00Z')).toBe('3:00 AM ET');
    expect(fmtTime('2026-03-08T04:59:00Z', 'datetime')).toBe('Mar 7, 11:59 PM ET');
  });
  it('accepts epoch ms and epoch seconds; invalid gives a dash', () => {
    const ms = Date.parse('2026-11-15T08:28:00Z');
    expect(fmtTime(ms)).toBe('3:28 AM ET');
    expect(fmtTime(ms / 1000)).toBe('3:28 AM ET');
    expect(fmtTime('nope')).toBe('—');
  });
});

describe('fmtAgo / fmtInt', () => {
  const now = Date.parse('2026-11-15T12:00:00Z');
  it('formats relative times', () => {
    expect(fmtAgo(now - 2_000, now)).toBe('just now');
    expect(fmtAgo(now - 45_000, now)).toBe('45 s ago');
    expect(fmtAgo('2026-11-15T11:48:00Z', now)).toBe('12 min ago');
    expect(fmtAgo(now - 3 * 3600_000, now)).toBe('3 h ago');
    expect(fmtAgo(now - 3 * 86400_000, now)).toBe('3 d ago');
    expect(fmtAgo(now + 300_000, now)).toBe('in 5 min');
  });
  it('groups integers', () => {
    expect(fmtInt(20000)).toBe('20,000');
    expect(fmtInt(65799)).toBe('65,799');
    expect(fmtInt(NaN)).toBe('—');
  });
});

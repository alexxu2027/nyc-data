import { describe, expect, it } from 'vitest';
import { tooltipText } from './tooltipText';

describe('tooltipText flood_sensors', () => {
  it('shows live depth and time', () => {
    const t = tooltipText('flood_sensors', {
      name: 'BK - 76th St/10th Ave',
      depth_in: 3.2,
      depth_at: '2026-11-15T06:42:00Z',
      live: true,
      flooding: false,
    });
    expect(t.title).toBe('BK - 76th St/10th Ave');
    expect(t.lines).toEqual(['3.2 in · 1:42 AM ET']);
  });

  it('adds the flooding line, with the start when known', () => {
    const p = { name: 'S', depth_in: 6, depth_at: '2026-11-15T06:42:00Z', live: true, flooding: true };
    expect(tooltipText('flood_sensors', { ...p, flood_since: '2026-11-15T06:15:00Z' }).lines).toEqual([
      '6.0 in · 1:42 AM ET',
      'Flooding since 1:15 AM ET',
    ]);
    expect(tooltipText('flood_sensors', { ...p, flood_since: null }).lines[1]).toBe('Flooding now');
  });

  it('says so when there is no recent reading', () => {
    const stale = { name: 'S', depth_in: 5, depth_at: '2026-11-15T01:00:00Z', live: false, flooding: false };
    expect(tooltipText('flood_sensors', stale).lines).toEqual(['No reading in 2 h']);
    expect(tooltipText('flood_sensors', { name: 'S', depth_in: null, live: false }).lines).toEqual([
      'No reading in 2 h',
    ]);
  });
});

describe('tooltipText subway_trains', () => {
  it('names the route and destination and flags the estimate', () => {
    const t = tooltipText('subway_trains', {
      route: 'A',
      headsign: 'Far Rockaway',
      next_name: 'Broadway Junction',
      at_stop: false,
    });
    expect(t.title).toBe('A train to Far Rockaway');
    expect(t.lines).toEqual(['Next: Broadway Junction', 'Position estimated between stations']);
  });

  it('is exact at a stop and tolerates a missing headsign', () => {
    const t = tooltipText('subway_trains', { route: '7', next_name: 'Times Sq-42 St', at_stop: true });
    expect(t.title).toBe('7 train');
    expect(t.lines).toEqual(['At: Times Sq-42 St']);
  });
});

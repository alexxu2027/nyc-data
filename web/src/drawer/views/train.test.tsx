import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { api } from '../../core';
import type { EventSummary, FeatureProps } from '../../types';
import { featureTitle, trainName } from '../detail';
import { TrainView, trainWhere } from './train';

const T0 = Date.parse('2026-11-17T03:04:32Z');
const props = (over: Record<string, unknown> = {}): FeatureProps => ({
  id: '20261116:123400_F..S74R', borough: null, route: 'F', line: 'BDFM', color: '#eb6800', dir: 'S',
  headsign: 'Coney Island-Stillwell Av', next_stop: 'F30', next_name: '18 Av', prev_name: 'Ditmas Av',
  t0: '2026-11-17T03:04:32Z', t1: '2026-11-17T03:06:32Z', run_s: 120, at_stop: false,
  seen_at: '2026-11-17T03:06:16Z', ...over,
});

const alert = (id: string, routes: string[], title: string): EventSummary =>
  ({
    source: 'mta_subway_alerts', id, category: 'service_alert', subtype: 'Planned - Stops Skipped', title,
    starts_at: '2026-11-17T03:00:00Z', ends_at: null, severity: 1, status: 'active', lat: null, lon: null,
    borough: null, routes, stations: [], props: {},
  }) as EventSummary;

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(T0 + 30_000);
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('train words', () => {
  it('titles a train by route and destination, not its trip id', () => {
    expect(featureTitle(props(), 'x')).toBe('F train to Coney Island-Stillwell Av');
    expect(trainName('6X')).toBe('6 express train');
    expect(trainName('GS')).toBe('42 St shuttle');
  });

  it('says where the train is between stops, and when it is due', () => {
    expect(trainWhere(props(), T0 + 30_000)).toEqual({ now: 'Between Ditmas Av and 18 Av', due: 'About 2 min' });
    expect(trainWhere(props(), T0 + 110_000).due).toBe('Arriving now');
    expect(trainWhere(props(), T0 + 200_000)).toEqual({ now: 'At or arriving at 18 Av', due: null });
    expect(trainWhere(props({ at_stop: true, prev_name: null }), T0).now).toBe('Waiting to leave 18 Av');
  });
});

describe('TrainView', () => {
  it('reads in plain words: no colour codes, trip ids or raw times', async () => {
    vi.spyOn(api, 'events').mockResolvedValue({ layer: 'subway_alerts', total: 0, limit: 200, offset: 0, events: [] });
    const { container } = render(<TrainView props={props()} />);
    const text = container.textContent ?? '';
    expect(text).not.toMatch(/#[0-9a-f]{6}/i);
    expect(text).not.toContain('F..S74R');
    expect(text).not.toMatch(/\d{4}-\d{2}-\d{2}T/);
    expect(screen.getByText('6 Av line')).toBeTruthy();
    expect(screen.getByText('Between Ditmas Av and 18 Av')).toBeTruthy();
    expect(text).toContain('2 min between these stops');
    await waitFor(() => expect(screen.getByText('None reported right now.')).toBeTruthy());
  });

  it("lists only this route's service changes", async () => {
    vi.spyOn(api, 'events').mockResolvedValue({
      layer: 'subway_alerts', total: 2, limit: 200, offset: 0,
      events: [alert('a', ['F', 'G'], 'Coney Island-bound [F] skips 4 Av'), alert('b', ['1'], 'Downtown [1] skips 125 St')],
    });
    render(<TrainView props={props()} />);
    await waitFor(() => expect(screen.getByText(/skips 4 Av/)).toBeTruthy());
    expect(screen.queryByText(/skips 125 St/)).toBeNull();
  });
});

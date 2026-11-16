import { act, cleanup, render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { resetStore, useApp } from '../core/store';
import { catalog } from '../core/test/fixtures';
import type { Health, SourceHealth } from '../types';
import { BOOT_HOLD_MS, BOOT_KEY, BOOT_WAIT_MS, BootLog, ROLL_MS } from './BootLog';

const src = (id: string, state: SourceHealth['state']): SourceHealth => ({
  id, name: id.replace('_', ' '), state, cadence_s: 60, last_success: null, last_attempt: null, age_s: 1,
  lag_s: null, consecutive_failures: 0, rows_last_run: 1, last_error: null, runs_24h: 1, ok_24h: 1, layers: [],
});
const HEALTH: Health = {
  now: '2026-11-16T12:00:00Z',
  collector: { state: 'running', last_attempt: null },
  summary: { ok: 2, stale: 1, degraded: 0, never: 0 } as Health['summary'],
  sources: [src('citibike', 'ok'), src('noaa_tides', 'ok'), src('dot_speeds', 'stale')],
};

let reduced = false;
beforeEach(() => {
  resetStore();
  useApp.setState({ catalog, visible: [] }); // no visible data layer: the map counts as settled
  sessionStorage.clear();
  reduced = false;
  vi.stubGlobal('matchMedia', (q: string) => ({
    matches: q.includes('reduce') ? reduced : false,
    addEventListener: () => {},
    removeEventListener: () => {},
  }));
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe('BootLog', () => {
  it('prints one row per feed plus a total once health arrives, then goes when rolled up', () => {
    vi.useFakeTimers();
    const { container } = render(<BootLog />);
    expect(container.textContent).toBe('');
    act(() => useApp.setState({ health: HEALTH }));
    const rows = container.querySelectorAll('.print-row');
    expect(rows).toHaveLength(4);
    expect(container.textContent).toMatch(/DOT SPEEDS.*STALE/);
    expect(container.textContent).toMatch(/2 OF 3 FEEDS OK/);
    expect(sessionStorage.getItem(BOOT_KEY)).toBe('1');
    act(() => {
      vi.advanceTimersByTime(BOOT_HOLD_MS + ROLL_MS + 1000);
    });
    expect(container.querySelector('.boot-log')).toBeNull();
  });

  it("waits for the map's first data answer (UX review C11)", () => {
    useApp.setState({ visible: ['citibike'] }); // a visible layer that hasn't answered yet
    const { container } = render(<BootLog />);
    act(() => useApp.setState({ health: HEALTH }));
    expect(container.querySelector('.boot-log')).toBeNull();
    act(() =>
      useApp.setState((s) => ({ data: { ...s.data, citibike: { ...(s.data.citibike ?? {}), status: 'ready' } as never } })),
    );
    expect(container.querySelector('.boot-log')).not.toBeNull();
  });

  it('shows once per visit', () => {
    sessionStorage.setItem(BOOT_KEY, '1');
    useApp.setState({ health: HEALTH });
    const { container } = render(<BootLog />);
    expect(container.querySelector('.boot-log')).toBeNull();
  });

  it('is skipped under reduced motion, and when health is late', () => {
    reduced = true;
    useApp.setState({ health: HEALTH });
    const a = render(<BootLog />);
    expect(a.container.querySelector('.boot-log')).toBeNull();
    a.unmount();
    reduced = false;
    sessionStorage.clear();
    resetStore();
    useApp.setState({ catalog, visible: [] });
    vi.useFakeTimers();
    const b = render(<BootLog />);
    act(() => {
      vi.advanceTimersByTime(BOOT_WAIT_MS + 1);
    });
    act(() => useApp.setState({ health: HEALTH }));
    expect(b.container.querySelector('.boot-log')).toBeNull();
  });
});

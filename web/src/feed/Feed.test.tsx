import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { resetStore, useApp } from '../core/store';
import { catalog } from '../core/test/fixtures';
import type { ChangeItem } from '../types';
import { FeedBody, FeedTicker, useUnread } from './Feed';

const item = (id: string, at: string, p: Partial<ChangeItem> = {}): ChangeItem => ({
  id,
  at,
  kind: 'alert',
  source: 'mta_subway_alerts',
  title: `Alert ${id}`,
  severity: 1,
  layer: 'subway_alerts',
  feature: `st-${id}`,
  lat: 40.7,
  lon: -73.9,
  borough: 'MN',
  ended: false,
  ...p,
});

const ITEMS = [item('a', '2026-11-15T03:20:00Z'), item('b', '2026-11-15T03:10:00Z', { ended: true })];

function Unread() {
  return <span data-testid="unread">{useUnread()}</span>;
}

function setFeed(items: ChangeItem[], seenAt = 0) {
  useApp.setState({ feed: { status: 'ready', items, etag: 'W/"1"', fetchedAt: Date.now(), seenAt, error: null } });
}

beforeEach(() => {
  resetStore();
  useApp.setState({ catalog, visible: [] });
});
afterEach(cleanup);

describe('feed list', () => {
  it('marks unread rows, and opening the list marks them read', () => {
    setFeed(ITEMS, Date.parse('2026-11-15T03:15:00Z'));
    render(<Unread />);
    expect(screen.getByTestId('unread').textContent).toBe('1');
    render(<FeedBody />);
    // The row that was new keeps its mark while the list stays open...
    expect(screen.getAllByLabelText('New:')).toHaveLength(1);
    // ...but the reader has now seen everything up to the newest row.
    expect(screen.getByTestId('unread').textContent).toBe('0');
    expect(useApp.getState().feed.seenAt).toBe(Date.parse('2026-11-15T03:20:00Z'));
    expect(screen.getByText(/Alert b \(ENDED\)/)).toBeTruthy();
    // A newer item arriving while open is marked and read at once.
    act(() => setFeed([item('c', '2026-11-15T03:25:00Z'), ...ITEMS], useApp.getState().feed.seenAt));
    expect(screen.getAllByLabelText('New:')).toHaveLength(2);
    expect(screen.getByTestId('unread').textContent).toBe('0');
  });

  it('a click opens the item (layer on, fly, select) and calls onOpened', () => {
    setFeed(ITEMS);
    let opened = 0;
    render(<FeedBody onOpened={() => (opened += 1)} />);
    fireEvent.click(screen.getByText('Alert a'));
    const s = useApp.getState();
    expect(s.visible).toContain('subway_alerts');
    expect(s.fly).toMatchObject({ lng: -73.9, lat: 40.7 });
    expect(s.selection).toEqual({ mode: 'feature', layer: 'subway_alerts', id: 'st-a' });
    expect(opened).toBe(1);
  });

  it('empty and loading states', () => {
    render(<FeedBody />);
    expect(screen.getByText('LOADING')).toBeTruthy();
    cleanup();
    setFeed([]);
    render(<FeedBody />);
    expect(screen.getByText(/NOTHING NEW/)).toBeTruthy();
  });
});

describe('ticker', () => {
  it('shows nothing before the first load, then the newest item; a click toggles the panel', () => {
    const { container } = render(<FeedTicker />);
    expect(container.textContent).toBe('');
    act(() => setFeed(ITEMS));
    const btn = screen.getByRole('button');
    expect(btn.textContent).toContain('ALERT Alert a');
    expect(btn.textContent).toContain('* LATEST');
    fireEvent.click(btn);
    expect(useApp.getState().panel).toBe('feed');
    fireEvent.click(btn);
    expect(useApp.getState().panel).toBe(null);
  });
});

describe('feed motion', () => {
  it('rows marked NEW print when the list opens; later arrivals print; old rows never replay', () => {
    setFeed(ITEMS, Date.parse('2026-11-15T03:15:00Z')); // a is new, b is not
    const { container } = render(<FeedBody />);
    const printing = () =>
      [...container.querySelectorAll<HTMLElement>('[role=listitem]')].map((r) => (r.classList.contains('print-row') ? 'P' : '.'));
    expect(printing()).toEqual(['P', '.']);
    act(() => setFeed([item('c', '2026-11-15T03:25:00Z'), ...ITEMS], useApp.getState().feed.seenAt));
    expect(printing()).toEqual(['P', 'P', '.']);
  });

  it('the ticker types a new latest change, not the first one', () => {
    setFeed(ITEMS);
    const { container } = render(<FeedTicker />);
    expect(container.querySelector('.type-line')).toBeNull();
    act(() => setFeed([item('c', '2026-11-15T03:25:00Z'), ...ITEMS]));
    const typed = container.querySelector<HTMLElement>('.type-line');
    expect(typed?.textContent).toMatch(/Alert c/);
    expect(typed?.style.getPropertyValue('--type-n')).not.toBe('');
    expect(container.querySelector('.type-cursor')).toBeTruthy();
  });
});

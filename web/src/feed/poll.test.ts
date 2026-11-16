import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ChangesResult } from '../core/api';
import { EMPTY_LAYER_DATA, resetStore, useApp } from '../core/store';
import { catalog } from '../core/test/fixtures';
import type { ChangeItem } from '../types';
import { FEED_INTERVAL_MS, FEED_START_DELAY_MS, startFeedPolling } from './poll';

const it1: ChangeItem = {
  id: 'nws_alerts:x',
  at: '2026-11-15T03:20:00Z',
  kind: 'weather',
  source: 'nws_alerts',
  title: 'Flood watch',
  severity: 3,
  layer: 'nws_alerts',
  feature: 'x',
  lat: 40.7,
  lon: -73.9,
  borough: null,
  ended: false,
};

let replies: Array<ChangesResult | Error> = [];
let etags: Array<string | null> = [];
const fakeApi = {
  changes: vi.fn(async (etag: string | null) => {
    etags.push(etag);
    const r = replies.shift() ?? { status: 304 as const };
    if (r instanceof Error) throw r;
    return r;
  }),
};
const page = (items: ChangeItem[], etag: string): ChangesResult => ({
  status: 200,
  etag,
  body: { now: '2026-11-15T03:30:00Z', since: '2026-11-14T15:30:00Z', items },
});

let hidden = false;
let dispose: (() => void) | null = null;

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-11-15T03:30:00Z'));
  replies = [];
  etags = [];
  fakeApi.changes.mockClear();
  hidden = false;
  Object.defineProperty(document, 'hidden', { configurable: true, get: () => hidden });
  resetStore();
  useApp.setState({ catalog, visible: ['citibike'] });
});
afterEach(() => {
  dispose?.();
  dispose = null;
  vi.useRealTimers();
});

const layerReady = () =>
  useApp.setState((s) => ({ data: { ...s.data, citibike: { ...EMPTY_LAYER_DATA, status: 'ready', rev: 1 } } }));

describe('feed polling', () => {
  it('waits for the first layer and 2 s, whichever is later', async () => {
    dispose = startFeedPolling({ api: fakeApi });
    await vi.advanceTimersByTimeAsync(FEED_START_DELAY_MS + 5000);
    expect(fakeApi.changes).not.toHaveBeenCalled(); // no layer has answered yet
    replies = [page([it1], 'W/"1"')];
    layerReady();
    await vi.advanceTimersByTimeAsync(0);
    expect(fakeApi.changes).toHaveBeenCalledTimes(1);
    expect(useApp.getState().feed).toMatchObject({ status: 'ready', items: [it1], etag: 'W/"1"' });
  });

  it('a layer ready early still waits for the 2 s', async () => {
    layerReady();
    dispose = startFeedPolling({ api: fakeApi });
    await vi.advanceTimersByTimeAsync(FEED_START_DELAY_MS - 1);
    expect(fakeApi.changes).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(fakeApi.changes).toHaveBeenCalledTimes(1);
  });

  it('polls every 30 s with the ETag; a 304 or equal rows keep the items array', async () => {
    layerReady();
    replies = [page([it1], 'W/"1"'), { status: 304 }, page([{ ...it1 }], 'W/"2"')];
    dispose = startFeedPolling({ api: fakeApi });
    await vi.advanceTimersByTimeAsync(FEED_START_DELAY_MS);
    const first = useApp.getState().feed.items;
    await vi.advanceTimersByTimeAsync(FEED_INTERVAL_MS);
    await vi.advanceTimersByTimeAsync(FEED_INTERVAL_MS);
    expect(etags).toEqual([null, 'W/"1"', 'W/"1"']);
    expect(useApp.getState().feed.items).toBe(first);
    expect(useApp.getState().feed.etag).toBe('W/"2"');
  });

  it('pauses while hidden and catches up on return; errors keep the items', async () => {
    layerReady();
    replies = [page([it1], 'W/"1"'), new Error('boom')];
    dispose = startFeedPolling({ api: fakeApi });
    await vi.advanceTimersByTimeAsync(FEED_START_DELAY_MS);
    hidden = true;
    document.dispatchEvent(new Event('visibilitychange'));
    await vi.advanceTimersByTimeAsync(FEED_INTERVAL_MS * 3);
    expect(fakeApi.changes).toHaveBeenCalledTimes(1);
    hidden = false;
    document.dispatchEvent(new Event('visibilitychange'));
    await vi.advanceTimersByTimeAsync(0);
    expect(fakeApi.changes).toHaveBeenCalledTimes(2);
    expect(useApp.getState().feed).toMatchObject({ status: 'error', error: 'boom', items: [it1] });
    // Backoff: the next try is 60 s out, not 30.
    await vi.advanceTimersByTimeAsync(FEED_INTERVAL_MS);
    expect(fakeApi.changes).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(FEED_INTERVAL_MS);
    expect(fakeApi.changes).toHaveBeenCalledTimes(3);
  });

  it('with every layer off it starts after the delay', async () => {
    useApp.setState({ visible: [] });
    dispose = startFeedPolling({ api: fakeApi });
    await vi.advanceTimersByTimeAsync(FEED_START_DELAY_MS);
    expect(fakeApi.changes).toHaveBeenCalledTimes(1);
  });
});

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { startHealthPolling, startPolling } from './poll';
import { resetStore, useApp } from './store';
import { catalog, collection, feat } from './test/fixtures';

type Reply = { status: number; body?: unknown; etag?: string } | 'pending' | Error;

interface Call {
  url: string;
  init: RequestInit;
  aborted: () => boolean;
}

let calls: Call[] = [];
let replies: Record<string, Reply[]> = {};
let fallback: (url: string) => Reply = () => ({ status: 500, body: { error: { code: 'internal', message: 'boom' } } });

function layerOf(url: string): string {
  return new URL(url, 'http://x').pathname.split('/').pop() ?? '';
}

function fakeFetch(url: string, init: RequestInit = {}): Promise<Response> {
  const signal = init.signal ?? undefined;
  calls.push({ url, init, aborted: () => Boolean(signal?.aborted) });
  const q = replies[layerOf(url)];
  const r = q && q.length ? q.shift()! : fallback(url);
  return new Promise((resolve, reject) => {
    const onAbort = () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' }));
    if (signal?.aborted) return onAbort();
    signal?.addEventListener('abort', onAbort);
    if (r === 'pending') return;
    if (r instanceof Error) return reject(r);
    const headers = new Headers(r.etag ? { ETag: r.etag } : {});
    resolve({
      status: r.status,
      ok: r.status >= 200 && r.status < 300,
      headers,
      json: async () => r.body,
    } as unknown as Response);
  });
}

const ok = (layer: string, ids: string[], etag: string): Reply => ({
  status: 200,
  etag,
  body: collection(layer, ids.map((id) => feat(id, 'MN', { state: 'ok' }))),
});

let hidden = false;
function setHidden(h: boolean) {
  hidden = h;
  document.dispatchEvent(new Event('visibilitychange'));
}

const callsFor = (layer: string) => calls.filter((c) => layerOf(c.url) === layer);

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-11-15T03:30:00Z'));
  calls = [];
  replies = {};
  fallback = () => ({ status: 500, body: { error: { code: 'internal', message: 'boom' } } });
  hidden = false;
  Object.defineProperty(document, 'hidden', { configurable: true, get: () => hidden });
  vi.stubGlobal('fetch', vi.fn(fakeFetch));
  resetStore();
  useApp.setState({ catalog, visible: [] });
});

let dispose: (() => void) | null = null;
afterEach(() => {
  dispose?.();
  dispose = null;
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe('layer polling', () => {
  it('fetches on show with no-store, then every max(poll_s, 30) s; 30 s floor', async () => {
    // citibike poll_s is 60; make a copy with poll_s 5 to check the floor
    const fast = { ...catalog, layers: catalog.layers.map((l) => (l.id === 'citibike' ? { ...l, poll_s: 5 } : l)) };
    useApp.setState({ catalog: fast });
    fallback = (url) => ok(layerOf(url), ['a'], 'W/"1"');
    dispose = startPolling();
    useApp.getState().setLayerVisible('citibike', true);
    await vi.advanceTimersByTimeAsync(0);
    expect(callsFor('citibike')).toHaveLength(1);
    expect(callsFor('citibike')[0].init.cache).toBe('no-store');
    expect(callsFor('citibike')[0].url).not.toMatch(/borough|bbox/);
    expect(useApp.getState().data.citibike.status).toBe('ready');
    await vi.advanceTimersByTimeAsync(29_000);
    expect(callsFor('citibike')).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(callsFor('citibike')).toHaveLength(2);
    expect(useApp.getState().data.citibike.nextAt).toBe(Date.now() + 30_000);
  });

  it('a 304 leaves features identity and rev unchanged; sends If-None-Match', async () => {
    replies.citibike = [ok('citibike', ['a', 'b'], 'W/"abc"'), { status: 304 }];
    dispose = startPolling();
    useApp.getState().setLayerVisible('citibike', true);
    await vi.advanceTimersByTimeAsync(0);
    const d1 = useApp.getState().data.citibike;
    expect(d1.rev).toBe(1);
    expect(d1.etag).toBe('W/"abc"');
    expect(d1.features).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(60_000);
    const c2 = callsFor('citibike')[1];
    expect((c2.init.headers as Record<string, string>)['If-None-Match']).toBe('W/"abc"');
    const d2 = useApp.getState().data.citibike;
    expect(d2.features).toBe(d1.features);
    expect(d2.meta).toBe(d1.meta);
    expect(d2.rev).toBe(1);
    expect(d2.fetchedAt).toBe(Date.now());
    expect(d2.fetchedAt).not.toBe(d1.fetchedAt);
    expect(d2.nextAt).toBe(Date.now() + 60_000);
  });

  it('a 200 replaces features and bumps rev', async () => {
    replies.citibike = [ok('citibike', ['a'], 'W/"1"'), ok('citibike', ['a', 'b'], 'W/"2"')];
    dispose = startPolling();
    useApp.getState().setLayerVisible('citibike', true);
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(60_000);
    const d = useApp.getState().data.citibike;
    expect(d.rev).toBe(2);
    expect(d.features.map((f) => f.properties.id)).toEqual(['a', 'b']);
    expect(d.etag).toBe('W/"2"');
  });

  it('an error keeps old data, sets error, and backs off doubling up to 5 min', async () => {
    replies.citibike = [ok('citibike', ['a'], 'W/"1"')];
    dispose = startPolling();
    useApp.getState().setLayerVisible('citibike', true);
    await vi.advanceTimersByTimeAsync(0);
    const features = useApp.getState().data.citibike.features;
    // next tick at 60 s fails (fallback 500)
    await vi.advanceTimersByTimeAsync(60_000);
    let d = useApp.getState().data.citibike;
    expect(d.status).toBe('error');
    expect(d.error).toBe('boom');
    expect(d.features).toBe(features);
    expect(d.rev).toBe(1);
    expect(callsFor('citibike')).toHaveLength(2);
    // backoff 120 s
    await vi.advanceTimersByTimeAsync(119_000);
    expect(callsFor('citibike')).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(callsFor('citibike')).toHaveLength(3);
    // 240 s
    await vi.advanceTimersByTimeAsync(240_000);
    expect(callsFor('citibike')).toHaveLength(4);
    // capped at 300 s
    await vi.advanceTimersByTimeAsync(299_000);
    expect(callsFor('citibike')).toHaveLength(4);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(callsFor('citibike')).toHaveLength(5);
    await vi.advanceTimersByTimeAsync(300_000);
    expect(callsFor('citibike')).toHaveLength(6);
    // recovery resets to the base interval
    replies.citibike = [{ status: 304 }];
    await vi.advanceTimersByTimeAsync(300_000);
    d = useApp.getState().data.citibike;
    expect(d.status).toBe('ready');
    expect(d.error).toBeNull();
    expect(d.nextAt).toBe(Date.now() + 60_000);
  });

  it('network errors are reported too', async () => {
    replies.citibike = [new TypeError('Failed to fetch')];
    dispose = startPolling();
    useApp.getState().setLayerVisible('citibike', true);
    await vi.advanceTimersByTimeAsync(0);
    expect(useApp.getState().data.citibike.status).toBe('error');
    expect(useApp.getState().data.citibike.error).toBe('Failed to fetch');
  });

  it('hiding a layer aborts the request and stops polling, keeping data', async () => {
    replies.citibike = [ok('citibike', ['a'], 'W/"1"'), 'pending'];
    dispose = startPolling();
    useApp.getState().setLayerVisible('citibike', true);
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(60_000); // second request now in flight
    const inflight = callsFor('citibike')[1];
    expect(inflight.aborted()).toBe(false);
    useApp.getState().setLayerVisible('citibike', false);
    await vi.advanceTimersByTimeAsync(0);
    expect(inflight.aborted()).toBe(true);
    const d = useApp.getState().data.citibike;
    expect(d.features).toHaveLength(1);
    expect(d.status).toBe('ready');
    expect(d.error).toBeNull();
    await vi.advanceTimersByTimeAsync(600_000);
    expect(callsFor('citibike')).toHaveLength(2);
  });

  it('pauses while document.hidden and catches up once on return if overdue', async () => {
    fallback = () => ({ status: 304 });
    replies.citibike = [ok('citibike', ['a'], 'W/"1"')];
    dispose = startPolling();
    useApp.getState().setLayerVisible('citibike', true);
    await vi.advanceTimersByTimeAsync(0);
    expect(callsFor('citibike')).toHaveLength(1);
    setHidden(true);
    await vi.advanceTimersByTimeAsync(600_000);
    expect(callsFor('citibike')).toHaveLength(1);
    setHidden(false);
    await vi.advanceTimersByTimeAsync(0);
    expect(callsFor('citibike')).toHaveLength(2); // exactly one catch-up
    await vi.advanceTimersByTimeAsync(59_000);
    expect(callsFor('citibike')).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(callsFor('citibike')).toHaveLength(3);
  });

  it('returning before the next tick is due does not fetch early', async () => {
    fallback = () => ({ status: 304 });
    replies.citibike = [ok('citibike', ['a'], 'W/"1"')];
    dispose = startPolling();
    useApp.getState().setLayerVisible('citibike', true);
    await vi.advanceTimersByTimeAsync(0);
    setHidden(true);
    await vi.advanceTimersByTimeAsync(20_000);
    setHidden(false);
    await vi.advanceTimersByTimeAsync(39_000);
    expect(callsFor('citibike')).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(callsFor('citibike')).toHaveLength(2);
  });

  it('a layer shown while the tab is hidden waits for the tab', async () => {
    fallback = (url) => ok(layerOf(url), ['a'], 'W/"1"');
    dispose = startPolling();
    setHidden(true);
    useApp.getState().setLayerVisible('citibike', true);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(callsFor('citibike')).toHaveLength(0);
    setHidden(false);
    await vi.advanceTimersByTimeAsync(0);
    expect(callsFor('citibike')).toHaveLength(1);
  });

  it('a server-filter change refetches at once with the new param and no stale ETag', async () => {
    fallback = (url) => ok(layerOf(url), ['a'], 'W/"x"');
    dispose = startPolling();
    useApp.getState().setLayerVisible('complaints_311', true);
    await vi.advanceTimersByTimeAsync(0);
    expect(callsFor('complaints_311')[0].url).toContain('f.window=24h');
    // a client filter change does not refetch
    useApp.getState().setFilter('complaints_311', 'status', ['open']);
    await vi.advanceTimersByTimeAsync(0);
    expect(callsFor('complaints_311')).toHaveLength(1);
    useApp.getState().setFilter('complaints_311', 'window', '48h');
    await vi.advanceTimersByTimeAsync(0);
    const c = callsFor('complaints_311');
    expect(c).toHaveLength(2);
    expect(c[1].url).toContain('f.window=48h');
    expect((c[1].init.headers as Record<string, string>)['If-None-Match']).toBeUndefined();
    expect(useApp.getState().data.complaints_311.rev).toBe(2);
  });

  it('a server-filter change aborts the in-flight request', async () => {
    replies.complaints_311 = ['pending', ok('complaints_311', ['b'], 'W/"2"')];
    dispose = startPolling();
    useApp.getState().setLayerVisible('complaints_311', true);
    await vi.advanceTimersByTimeAsync(0);
    useApp.getState().setFilter('complaints_311', 'window', '7d');
    await vi.advanceTimersByTimeAsync(0);
    const c = callsFor('complaints_311');
    expect(c[0].aborted()).toBe(true);
    expect(useApp.getState().data.complaints_311.features.map((f) => f.properties.id)).toEqual(['b']);
  });

  it('poll_s 0 fetches once', async () => {
    fallback = (url) => ok(layerOf(url), ['MN'], 'W/"b"');
    dispose = startPolling();
    useApp.getState().setLayerVisible('boroughs', true);
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(3_600_000);
    expect(callsFor('boroughs')).toHaveLength(1);
    expect(useApp.getState().data.boroughs.nextAt).toBeNull();
    expect(useApp.getState().data.boroughs.status).toBe('ready');
  });

  it('polls every visible layer independently from the URL-initialised state', async () => {
    fallback = (url) => ok(layerOf(url), ['a'], 'W/"1"');
    useApp.setState({ visible: ['citibike', 'subway_alerts', 'road_speeds'] });
    dispose = startPolling();
    await vi.advanceTimersByTimeAsync(0);
    expect(calls.map((c) => layerOf(c.url)).sort()).toEqual(['citibike', 'road_speeds', 'subway_alerts']);
  });

  it('dispose aborts and stops', async () => {
    replies.citibike = ['pending'];
    dispose = startPolling();
    useApp.getState().setLayerVisible('citibike', true);
    await vi.advanceTimersByTimeAsync(0);
    dispose();
    dispose = null;
    expect(callsFor('citibike')[0].aborted()).toBe(true);
    await vi.advanceTimersByTimeAsync(600_000);
    expect(callsFor('citibike')).toHaveLength(1);
  });
});

describe('health polling', () => {
  it('polls every 30 s and records errors without dropping the last health', async () => {
    const health = { now: 'x', collector: { state: 'running', last_attempt: null }, summary: { ok: 1, stale: 0, degraded: 0, never: 0 }, sources: [] };
    replies.health = [{ status: 200, body: health }];
    dispose = startHealthPolling();
    await vi.advanceTimersByTimeAsync(0);
    expect(useApp.getState().health).toEqual(health);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(callsFor('health')).toHaveLength(2);
    expect(useApp.getState().healthError).toBe('boom');
    expect(useApp.getState().health).toEqual(health);
    setHidden(true);
    await vi.advanceTimersByTimeAsync(120_000);
    expect(callsFor('health')).toHaveLength(2); // paused while hidden
    replies.health = [{ status: 200, body: health }];
    setHidden(false);
    await vi.advanceTimersByTimeAsync(0);
    expect(callsFor('health')).toHaveLength(3); // overdue: catch up at once
    expect(useApp.getState().healthError).toBeNull();
  });
});

// Feed polling (ADR-013 item 4): GET /api/changes every 30 s with a manual ETag.
//
// - The first fetch waits for the map: after the first visible layer has loaded (or failed) and
//   at least 2 s after start, whichever is later, so it never competes with first render.
// - A 304 only stamps fetchedAt; a 200 replaces the items (keeping the old array when the rows
//   are the same, so nothing re-renders for a new `now`).
// - Errors keep the old items, set status 'error' and double the interval up to 5 min.
// - Paused while the tab is hidden; one catch-up fetch on return if overdue.
import { api as defaultApi, useApp, type AppState } from '../core';
import type { FeedState } from '../types';
import { sameItems } from './model';

type Api = typeof defaultApi;

export const FEED_INTERVAL_MS = 30_000;
export const FEED_START_DELAY_MS = 2_000;
export const FEED_MAX_BACKOFF_MS = 300_000;

function patchFeed(p: Partial<FeedState>): void {
  useApp.setState((s) => ({ feed: { ...s.feed, ...p } }));
}

const docHidden = () => typeof document !== 'undefined' && document.hidden;

/** The map has had its first answer: some visible data layer is ready or failed (or none is on). */
export function mapSettled(s: AppState): boolean {
  if (!s.catalog) return false;
  const ids = s.visible.filter((id) => s.catalog?.layers.find((l) => l.id === id)?.kind !== 'raster');
  if (!ids.length) return true;
  return ids.some((id) => {
    const st = s.data[id]?.status;
    return st === 'ready' || st === 'error';
  });
}

export interface FeedPollOptions {
  api?: Pick<Api, 'changes'>;
  intervalMs?: number;
  startDelayMs?: number;
}

/** Start the feed poller. Returns dispose (aborts an in-flight request). */
export function startFeedPolling(opts: FeedPollOptions = {}): () => void {
  const client = opts.api ?? defaultApi;
  const every = opts.intervalMs ?? FEED_INTERVAL_MS;
  let disposed = false;
  let started = false;
  let delayDone = false;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let abort: AbortController | null = null;
  let failures = 0;
  let dueAt = 0;
  let unsub: (() => void) | null = null;

  const interval = () => (failures === 0 ? every : Math.min(every * 2 ** failures, FEED_MAX_BACKOFF_MS));

  const schedule = (delay: number) => {
    if (timer) clearTimeout(timer);
    timer = null;
    dueAt = Date.now() + delay;
    if (disposed || docHidden()) return; // resumed by visibilitychange
    timer = setTimeout(() => {
      timer = null;
      void run();
    }, Math.max(0, delay));
  };

  const run = async () => {
    if (disposed || docHidden()) return;
    abort?.abort();
    const ac = new AbortController();
    abort = ac;
    const cur = useApp.getState().feed;
    if (cur.fetchedAt === null && cur.status !== 'loading') patchFeed({ status: 'loading' });
    try {
      const res = await client.changes(cur.etag, ac.signal);
      if (disposed || abort !== ac) return;
      abort = null;
      failures = 0;
      const t = Date.now();
      if (res.status === 304) {
        patchFeed({ status: 'ready', fetchedAt: t, error: null });
      } else {
        const prev = useApp.getState().feed.items;
        const items = sameItems(prev, res.body.items) ? prev : res.body.items;
        patchFeed({ status: 'ready', items, etag: res.etag, fetchedAt: t, error: null });
      }
    } catch (e) {
      if (disposed || abort !== ac || (e as { name?: string } | null)?.name === 'AbortError') return;
      abort = null;
      failures += 1;
      patchFeed({ status: 'error', error: e instanceof Error ? e.message : String(e) });
    }
    schedule(interval());
  };

  const maybeStart = () => {
    if (started || disposed || !delayDone || !mapSettled(useApp.getState())) return;
    started = true;
    unsub?.();
    unsub = null;
    if (docHidden()) dueAt = Date.now(); // fetched on return
    else void run();
  };

  const onVisibility = () => {
    if (disposed || !started) return;
    if (docHidden()) {
      if (timer) clearTimeout(timer);
      timer = null;
      return;
    }
    if (!timer && !abort) schedule(Math.max(0, dueAt - Date.now()));
  };

  const delay = setTimeout(() => {
    delayDone = true;
    maybeStart();
  }, opts.startDelayMs ?? FEED_START_DELAY_MS);
  unsub = useApp.subscribe(maybeStart);
  if (typeof document !== 'undefined') document.addEventListener('visibilitychange', onVisibility);

  return () => {
    disposed = true;
    clearTimeout(delay);
    if (timer) clearTimeout(timer);
    abort?.abort();
    unsub?.();
    if (typeof document !== 'undefined') document.removeEventListener('visibilitychange', onVisibility);
  };
}

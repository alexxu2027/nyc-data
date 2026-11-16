// Layer and health polling (plan §4 "Polling", ADR-006).
//
// - Fetch when a layer becomes visible or its serverParams change, then every max(poll_s, 30) s;
//   poll_s 0 fetches once (retrying with backoff only until the first success).
// - Manual ETag: a 304 updates only fetchedAt / nextAt; a 200 replaces features + meta, bumps rev.
// - An error keeps old data, sets status 'error' and doubles the interval up to 5 min.
// - Paused while document.hidden; one catch-up fetch on return if overdue.
// - Hidden layers keep their data but stop polling (in-flight requests are aborted).
// - Never sends borough or bbox.
import type { LayerData, LayerDef } from '../types';
import { api as defaultApi, type Api } from './api';
import { changedIds } from './changes';
import { effectiveFilters, serverParams } from './filters';
import { type AppState, EMPTY_LAYER_DATA, useApp } from './store';

export const MIN_INTERVAL_MS = 30_000;
export const MAX_BACKOFF_MS = 300_000;
export const HEALTH_INTERVAL_MS = 30_000;

export function baseIntervalMs(def: LayerDef): number {
  return Math.max(def.poll_s, 30) * 1000;
}

interface Ctl {
  def: LayerDef;
  key: string;
  params: Record<string, string>;
  timer: ReturnType<typeof setTimeout> | null;
  abort: AbortController | null;
  failures: number;
  done: boolean; // poll_s 0 and fetched successfully
  dueAt: number; // when the next fetch is due (ms)
  token: number;
}

function patchLayer(id: string, patch: Partial<LayerData>): void {
  useApp.setState((s) => ({ data: { ...s.data, [id]: { ...(s.data[id] ?? EMPTY_LAYER_DATA), ...patch } } }));
}

function isAbort(e: unknown): boolean {
  return (e as { name?: string } | null)?.name === 'AbortError';
}

function docHidden(): boolean {
  return typeof document !== 'undefined' && document.hidden;
}

export interface PollOptions {
  api?: Pick<Api, 'layer'>;
  now?: () => number;
}

/** Start polling every visible layer. Returns dispose (aborts in-flight requests). */
export function startPolling(opts: PollOptions = {}): () => void {
  const client = opts.api ?? defaultApi;
  const now = opts.now ?? (() => Date.now());
  const ctls = new Map<string, Ctl>();
  let disposed = false;

  const intervalFor = (c: Ctl) =>
    c.failures === 0 ? baseIntervalMs(c.def) : Math.min(baseIntervalMs(c.def) * 2 ** c.failures, MAX_BACKOFF_MS);

  const schedule = (c: Ctl, delay: number) => {
    if (c.timer) clearTimeout(c.timer);
    c.timer = null;
    c.dueAt = now() + delay;
    if (docHidden() || disposed) return; // resumed by visibilitychange
    c.timer = setTimeout(() => {
      c.timer = null;
      void run(c);
    }, Math.max(0, delay));
  };

  const run = async (c: Ctl) => {
    if (disposed || docHidden()) return;
    c.abort?.abort();
    const ac = new AbortController();
    c.abort = ac;
    const token = ++c.token;
    const id = c.def.id;
    const cur = useApp.getState().data[id] ?? EMPTY_LAYER_DATA;
    if (cur.status !== 'loading' && (cur.rev === 0 || cur.status === 'idle')) patchLayer(id, { status: 'loading' });
    try {
      const res = await client.layer(id, c.params, cur.etag, ac.signal);
      if (token !== c.token || disposed) return;
      c.abort = null;
      c.failures = 0;
      if (c.def.poll_s === 0) c.done = true;
      const t = now();
      const nextAt = c.done ? null : t + intervalFor(c);
      if (res.status === 304) {
        const p: Partial<LayerData> = { fetchedAt: t, nextAt };
        const d = useApp.getState().data[id];
        if (d && d.status !== 'ready') p.status = 'ready';
        if (d && d.error !== null) p.error = null;
        patchLayer(id, p);
      } else {
        const prev = useApp.getState().data[id] ?? EMPTY_LAYER_DATA;
        patchLayer(id, {
          status: 'ready',
          features: res.body.features,
          meta: res.body.meta,
          etag: res.etag,
          rev: prev.rev + 1,
          fetchedAt: t,
          nextAt,
          error: null,
          changed: changedIds(c.def, prev.features, res.body.features, prev.rev === 0),
          changedAt: t,
        });
      }
      if (!c.done) schedule(c, intervalFor(c));
    } catch (e) {
      if (token !== c.token || disposed || isAbort(e)) return;
      c.abort = null;
      c.failures += 1;
      const delay = intervalFor(c);
      patchLayer(id, {
        status: 'error',
        error: e instanceof Error ? e.message : String(e),
        nextAt: now() + delay,
      });
      schedule(c, delay);
    }
  };

  const stop = (c: Ctl) => {
    if (c.timer) clearTimeout(c.timer);
    c.timer = null;
    c.token += 1;
    if (c.abort) {
      c.abort.abort();
      c.abort = null;
      const d = useApp.getState().data[c.def.id];
      if (d && d.status === 'loading') patchLayer(c.def.id, { status: d.rev > 0 ? 'ready' : 'idle', nextAt: null });
      else if (d) patchLayer(c.def.id, { nextAt: null });
    } else {
      const d = useApp.getState().data[c.def.id];
      if (d && d.nextAt !== null) patchLayer(c.def.id, { nextAt: null });
    }
  };

  const sync = (s: AppState) => {
    if (disposed) return;
    const catalog = s.catalog;
    const want = new Set(catalog ? s.visible : []);
    for (const [id, c] of ctls) {
      if (!want.has(id)) {
        stop(c);
        ctls.delete(id);
      }
    }
    if (!catalog) return;
    for (const id of want) {
      const def = catalog.layers.find((l) => l.id === id);
      if (!def || def.kind === 'raster') continue; // raster layers are client-only (ADR-013)
      const params = serverParams(def, effectiveFilters(def, s.filters[id]));
      const key = JSON.stringify(params);
      const c = ctls.get(id);
      if (c && c.key === key && c.def === def) continue;
      if (c) {
        // Server filter changed: drop the old ETag and refetch at once.
        stop(c);
        c.key = key;
        c.params = params;
        c.def = def;
        c.failures = 0;
        c.done = false;
        patchLayer(id, { etag: null });
        schedule(c, 0);
      } else {
        const n: Ctl = { def, key, params, timer: null, abort: null, failures: 0, done: false, dueAt: 0, token: 0 };
        ctls.set(id, n);
        schedule(n, 0);
      }
    }
  };

  const onVisibility = () => {
    if (disposed) return;
    if (docHidden()) {
      for (const c of ctls.values()) {
        if (c.timer) clearTimeout(c.timer);
        c.timer = null;
      }
      return;
    }
    const t = now();
    for (const c of ctls.values()) {
      if (c.done || c.timer || c.abort) continue;
      schedule(c, Math.max(0, c.dueAt - t)); // overdue: one catch-up fetch now
    }
  };

  const unsub = useApp.subscribe((s, prev) => {
    if (s.catalog !== prev.catalog || s.visible !== prev.visible || s.filters !== prev.filters) sync(s);
  });
  if (typeof document !== 'undefined') document.addEventListener('visibilitychange', onVisibility);
  sync(useApp.getState());

  return () => {
    unsub();
    if (typeof document !== 'undefined') document.removeEventListener('visibilitychange', onVisibility);
    for (const c of ctls.values()) {
      if (c.timer) clearTimeout(c.timer);
      c.abort?.abort();
    }
    ctls.clear();
    disposed = true;
  };
}

/** Poll /api/health every 30 s (paused while hidden). Returns dispose. */
export function startHealthPolling(
  opts: { api?: Pick<Api, 'health'>; intervalMs?: number } = {},
): () => void {
  const client = opts.api ?? defaultApi;
  const every = opts.intervalMs ?? HEALTH_INTERVAL_MS;
  let disposed = false;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let last = 0;
  let inflight = false;

  const tick = async () => {
    timer = null;
    if (disposed || inflight || docHidden()) return;
    last = Date.now();
    inflight = true;
    try {
      const health = await client.health();
      if (!disposed) useApp.setState({ health, healthError: null });
    } catch (e) {
      if (!disposed) useApp.setState({ healthError: e instanceof Error ? e.message : String(e) });
    }
    inflight = false;
    if (!disposed && !docHidden()) timer = setTimeout(() => void tick(), every);
  };
  const onVisibility = () => {
    if (disposed || docHidden() || timer || inflight) return;
    timer = setTimeout(() => void tick(), Math.max(0, last + every - Date.now()));
  };
  if (typeof document !== 'undefined') document.addEventListener('visibilitychange', onVisibility);
  void tick();
  return () => {
    disposed = true;
    if (timer) clearTimeout(timer);
    if (typeof document !== 'undefined') document.removeEventListener('visibilitychange', onVisibility);
  };
}

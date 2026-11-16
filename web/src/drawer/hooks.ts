import { useEffect, useState, useSyncExternalStore } from 'react';
import { ApiError } from '../core';

export interface AsyncResult<T> {
  data: T | undefined;
  /** Set when the latest load failed (old data, if any, is kept). */
  error: ApiError | Error | null;
  /** True until the first result for this key arrives. */
  loading: boolean;
}

interface Held<T> {
  key: string;
  data: T | undefined;
  error: ApiError | Error | null;
}

/**
 * Loads `load()` whenever `key` or `rev` changes. A new key starts blank (loading); a new rev
 * refreshes in place, so a poll tick never flashes the drawer. Late answers for an old key are
 * dropped. `load` must be stable for a given key (useCallback).
 */
export function useAsync<T>(key: string | null, rev: number, load: (() => Promise<T>) | null): AsyncResult<T> {
  const [held, setHeld] = useState<Held<T> | null>(null);
  useEffect(() => {
    if (key === null || !load) return;
    let live = true;
    load().then(
      (data) => {
        if (live) setHeld({ key, data, error: null });
      },
      (e: unknown) => {
        if (!live) return;
        const error = e instanceof Error ? e : new Error(String(e));
        setHeld((h) => (h && h.key === key ? { ...h, error } : { key, data: undefined, error }));
      },
    );
    return () => {
      live = false;
    };
  }, [key, rev, load]);
  const mine = held && held.key === key ? held : null;
  return { data: mine?.data, error: mine?.error ?? null, loading: key !== null && !mine };
}

// One shared 1 s clock for "4 s ago" readouts. It only ticks while something is subscribed.
let clockNow = Date.now();
const clockSubs = new Set<() => void>();
let clockTimer: ReturnType<typeof setInterval> | null = null;

function subscribeClock(cb: () => void): () => void {
  clockSubs.add(cb);
  if (clockTimer === null) {
    clockNow = Date.now();
    clockTimer = setInterval(() => {
      clockNow = Date.now();
      for (const s of clockSubs) s();
    }, 1000);
  }
  return () => {
    clockSubs.delete(cb);
    if (clockSubs.size === 0 && clockTimer !== null) {
      clearInterval(clockTimer);
      clockTimer = null;
    }
  };
}

/** Wall-clock epoch ms, updated once a second. */
export function useClock(): number {
  return useSyncExternalStore(subscribeClock, () => clockNow, () => clockNow);
}

/** A short message for an error state. */
export function errorText(e: ApiError | Error | null): string {
  if (!e) return '';
  if (e instanceof ApiError) {
    if (e.status === 404) return 'This feature is no longer in the feed.';
    if (e.status === 0) return 'The API cannot be reached.';
    if (e.status === 503) return 'The data store is not available yet.';
    return e.message || `HTTP ${e.status}`;
  }
  return e.message;
}

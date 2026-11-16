// Keeps the feed's "seen up to" mark across reloads (known gap after Phase 2.5): without it,
// every reload marked the whole last 12 h as NEW. Stored per browser in localStorage; any
// storage failure (private mode, blocked site data) just falls back to the old behaviour.
import { useApp } from '../core';

export const SEEN_KEY = 'nyclive.feed.seenAt';

type Storage = Pick<globalThis.Storage, 'getItem' | 'setItem'>;

function defaultStorage(): Storage | null {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage;
  } catch {
    return null;
  }
}

/** Restore the saved mark, then save it whenever it moves. Returns dispose. */
export function persistFeedSeen(storage: Storage | null = defaultStorage()): () => void {
  if (!storage) return () => {};
  try {
    const saved = Number(storage.getItem(SEEN_KEY));
    if (Number.isFinite(saved) && saved > useApp.getState().feed.seenAt) {
      useApp.setState((s) => ({ feed: { ...s.feed, seenAt: saved } }));
    }
  } catch {
    /* unreadable: start from 0 */
  }
  return useApp.subscribe((s, prev) => {
    if (s.feed.seenAt === prev.feed.seenAt) return;
    try {
      storage.setItem(SEEN_KEY, String(s.feed.seenAt));
    } catch {
      /* full or blocked: the mark just won't survive a reload */
    }
  });
}

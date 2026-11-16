import { afterEach, describe, expect, it } from 'vitest';
import { useApp } from '../core';
import { persistFeedSeen, SEEN_KEY } from './seen';

function memory(init: Record<string, string> = {}) {
  const m = new Map(Object.entries(init));
  return { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v), m };
}

const setSeen = (n: number) => useApp.setState((s) => ({ feed: { ...s.feed, seenAt: n } }));

describe('persistFeedSeen', () => {
  let dispose = () => {};
  afterEach(() => {
    dispose();
    setSeen(0);
  });

  it('restores the saved mark and saves later moves', () => {
    const st = memory({ [SEEN_KEY]: '1700000000000' });
    dispose = persistFeedSeen(st);
    expect(useApp.getState().feed.seenAt).toBe(1700000000000);
    setSeen(1700000060000);
    expect(st.m.get(SEEN_KEY)).toBe('1700000060000');
  });

  it('ignores junk and an older saved mark', () => {
    setSeen(5);
    dispose = persistFeedSeen(memory({ [SEEN_KEY]: 'nope' }));
    expect(useApp.getState().feed.seenAt).toBe(5);
    dispose();
    dispose = persistFeedSeen(memory({ [SEEN_KEY]: '3' }));
    expect(useApp.getState().feed.seenAt).toBe(5);
  });

  it('survives storage that throws', () => {
    const bad = {
      getItem: () => {
        throw new Error('blocked');
      },
      setItem: () => {
        throw new Error('blocked');
      },
    };
    dispose = persistFeedSeen(bad);
    expect(() => setSeen(9)).not.toThrow();
    expect(useApp.getState().feed.seenAt).toBe(9);
  });

  it('is a no-op without storage', () => {
    dispose = persistFeedSeen(null);
    setSeen(4);
    expect(useApp.getState().feed.seenAt).toBe(4);
  });
});

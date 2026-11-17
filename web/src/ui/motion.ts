// Motion helpers for the "printed transcript" moments (feed rows print, the ticker types, the
// drawer prints its rows, counts deal, the boot log). The CSS lives in styles/motion.css; these
// only decide *when* something moves, so every motion has a cause and never replays on a plain
// re-render. Reduced motion is handled in CSS (every animation stops on its finished frame).
import { useEffect, useLayoutEffect, useState, type RefObject } from 'react';

/** Gap between printed rows. */
export const PRINT_STAGGER_MS = 45;
/** At most this many rows wait their turn; later ones print together with the last. */
export const PRINT_MAX_STAGGER = 10;

/** Typed-line timing: ~14 ms a character, capped so a long line still lands quickly. */
export function typeTiming(text: string): { ms: number; steps: number } {
  const steps = Math.max(1, Math.min(text.length, 48));
  return { ms: Math.min(Math.max(steps * 14, 120), 650), steps };
}

/**
 * Ids that *arrived* after the first render, each with its print order (0, 1, ...). An id keeps
 * its entry while it stays, so its row's class never changes (a changed class would replay the
 * motion); an id that leaves and comes back prints again. `initial` ids print on mount too (for
 * example the rows marked NEW when a panel opens). Pass a memoised `ids` array.
 */
export function useArrivals(ids: readonly string[], initial?: (id: string) => boolean): ReadonlyMap<string, number> {
  const [st, setSt] = useState(() => ({
    ids,
    order: new Map((initial ? ids.filter(initial) : []).map((id, i) => [id, Math.min(i, PRINT_MAX_STAGGER)] as const)),
  }));
  if (st.ids === ids) return st.order;
  // Adjust state while rendering (React's pattern for "state derived from a changed prop").
  const before = new Set(st.ids);
  const order = new Map<string, number>();
  let n = 0;
  for (const id of ids) {
    const had = st.order.get(id);
    if (had !== undefined) order.set(id, had);
    else if (!before.has(id)) order.set(id, Math.min(n++, PRINT_MAX_STAGGER)); // newest (top) first
  }
  setSt({ ids, order });
  return order;
}

/**
 * Print every `.l` row inside `ref` top to bottom, for `windowMs` after mount (so rows that
 * arrive with the first fetch print too). Rows added later, by a live refresh, just appear.
 */
export function usePrintRows(ref: RefObject<HTMLElement | null>, windowMs = 900): void {
  useLayoutEffect(() => {
    const root = ref.current;
    if (!root) return;
    const start = performance.now();
    let n = 0;
    const mark = () => {
      if (performance.now() - start > windowMs) return false;
      for (const row of root.querySelectorAll<HTMLElement>('.l')) {
        if (row.dataset.printed || row.parentElement?.closest('.l')) continue;
        row.dataset.printed = '1';
        row.classList.add('print-row');
        row.style.animationDelay = `${Math.min(n, PRINT_MAX_STAGGER) * PRINT_STAGGER_MS}ms`;
        n += 1;
      }
      return true;
    };
    mark();
    if (typeof MutationObserver === 'undefined') return;
    const mo = new MutationObserver(() => {
      if (!mark()) mo.disconnect();
    });
    mo.observe(root, { childList: true, subtree: true });
    const stop = setTimeout(() => mo.disconnect(), windowMs + 50);
    return () => {
      clearTimeout(stop);
      mo.disconnect();
    };
  }, [ref, windowMs]);
}

/**
 * A key that changes each time `value` changes from one real value to another (not from or to
 * null: the first load and a gap are not "changes"). Use it as a React key to replay a motion.
 */
export function useChangeKey(value: unknown): number {
  const [st, setSt] = useState({ value, key: 0 });
  if (Object.is(st.value, value)) return st.key;
  const key = st.value != null && value != null ? st.key + 1 : st.key;
  setSt({ value, key });
  return key;
}

/** True once `active` has stayed true for `ms` (false again as soon as it isn't). */
export function useAfter(ms: number, active: boolean): boolean {
  const [done, setDone] = useState(false);
  if (!active && done) setDone(false); // adjust during render, not in an effect
  useEffect(() => {
    if (!active) return;
    const t = setTimeout(() => setDone(true), ms);
    return () => clearTimeout(t);
  }, [active, ms]);
  return active && done;
}

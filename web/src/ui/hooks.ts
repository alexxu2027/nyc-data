import { useSyncExternalStore } from 'react';

export const PHONE_QUERY = '(max-width: 680px)';
export const MID_QUERY = '(max-width: 860px)';
export const REDUCED_MOTION_QUERY = '(prefers-reduced-motion: reduce)';

/** Fallback line height in px when the DOM cannot tell us (tests, SSR): 15px × 1.8. */
export const DEFAULT_LINE_PX = 27;

function mq(query: string): MediaQueryList | null {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return null;
  return window.matchMedia(query);
}

function useMedia(query: string): boolean {
  return useSyncExternalStore(
    (onChange) => {
      const m = mq(query);
      if (!m) return () => {};
      m.addEventListener('change', onChange);
      return () => m.removeEventListener('change', onChange);
    },
    () => mq(query)?.matches ?? false,
    () => false,
  );
}

/** True at phone width (≤ 680 px). */
export function useIsPhone(): boolean {
  return useMedia(PHONE_QUERY);
}

/** True when the user asks for reduced motion. Loops should start paused on a still frame. */
export function useReducedMotion(): boolean {
  return useMedia(REDUCED_MOTION_QUERY);
}

/** One printed line in CSS px (27 on desktop, 25.2 on phones). */
export function readLinePx(): number {
  if (typeof document === 'undefined' || typeof getComputedStyle !== 'function') return DEFAULT_LINE_PX;
  const root = document.documentElement;
  const cs = getComputedStyle(root);
  const size = parseFloat(cs.fontSize);
  const lh = parseFloat(cs.getPropertyValue('--lh'));
  if (!Number.isFinite(size) || size <= 0) return DEFAULT_LINE_PX;
  return size * (Number.isFinite(lh) && lh > 0 ? lh : 1.8);
}

function subscribeLine(onChange: () => void): () => void {
  if (typeof window === 'undefined') return () => {};
  const m = mq(PHONE_QUERY);
  window.addEventListener('resize', onChange);
  m?.addEventListener('change', onChange);
  return () => {
    window.removeEventListener('resize', onChange);
    m?.removeEventListener('change', onChange);
  };
}

/** Line height in px, updated when the breakpoint or zoom changes. Round figure heights up to it. */
export function useLineHeight(): number {
  return useSyncExternalStore(subscribeLine, readLinePx, () => DEFAULT_LINE_PX);
}

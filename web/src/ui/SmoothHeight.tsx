// A block whose height glides when its content grows or shrinks (2026-11-17: a layer row's notes
// and colour key snapped in and out, jolting the list below). The outer box follows the inner
// box's measured height with a short CSS transition; it clips vertically only (clip-path with
// wide side insets), so the gutter line numbers that hang off each row stay visible. Reduced
// motion: no transition (styles/motion.css).
import { useLayoutEffect, useRef, type ReactNode } from 'react';

export function SmoothHeight({ children, className }: { children: ReactNode; className?: string }) {
  const outer = useRef<HTMLDivElement>(null);
  const inner = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const o = outer.current;
    const i = inner.current;
    if (!o || !i || typeof ResizeObserver === 'undefined') return;
    // First height without a transition, so the first paint is already right.
    o.style.transition = 'none';
    o.style.height = `${i.offsetHeight}px`;
    void o.offsetHeight; // flush, then let later changes animate
    o.style.transition = '';
    const ro = new ResizeObserver(() => {
      o.style.height = `${i.offsetHeight}px`;
    });
    ro.observe(i);
    return () => ro.disconnect();
  }, []);
  return (
    <div ref={outer} className={className ? `smooth-h ${className}` : 'smooth-h'}>
      <div ref={inner}>{children}</div>
    </div>
  );
}

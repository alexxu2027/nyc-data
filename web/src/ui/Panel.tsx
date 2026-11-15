import { useLayoutEffect, useRef, type ReactNode, type RefObject } from 'react';
import { DEFAULT_LINE_PX } from './hooks';

export interface PanelProps {
  title?: ReactNode;
  /** 'ink' is the inverted `.screen` panel. */
  tone?: 'paper' | 'ink';
  /** Show gutter line numbers. Each panel keeps its own count. */
  numbered?: boolean;
  /** Lines pinned under the scrolling body (numbering continues into them). */
  footer?: ReactNode;
  className?: string;
  children?: ReactNode;
}

/**
 * A sheet of paper (or an inverted `.screen`). It is a flex column: when its parent gives it a
 * height, the body scrolls and the title and footer stay put.
 */
export function Panel({ title, tone = 'paper', numbered = false, footer, className, children }: PanelProps) {
  const ref = useRef<HTMLElement>(null);
  useLineNumbers(ref, numbered);
  const cls = ['panel', tone === 'ink' ? 'screen' : '', numbered ? 'numbered' : '', className ?? '']
    .filter(Boolean)
    .join(' ');
  return (
    <section ref={ref} className={cls}>
      {title != null && (
        <header className="panel-head">
          <div className="l">
            <h2 className="panel-title">{title}</h2>
          </div>
        </header>
      )}
      <div className="panel-body">{children}</div>
      {footer != null && <footer className="panel-foot">{footer}</footer>}
    </section>
  );
}

/**
 * Upgrades the CSS counter (one number per row) to one number per *rendered* line, so a row
 * that wraps reads "6\n7" in the gutter. Reads every row first, then writes, in one frame.
 */
function useLineNumbers(ref: RefObject<HTMLElement | null>, enabled: boolean) {
  useLayoutEffect(() => {
    const panel = ref.current;
    if (!panel || !enabled) return;
    if (typeof ResizeObserver === 'undefined' || typeof MutationObserver === 'undefined') return;

    let frame = 0;
    const owns = (row: HTMLElement) =>
      row.closest('.panel, .bsheet') === panel && !(row.parentElement && row.parentElement.closest('.l'));

    const number = () => {
      frame = 0;
      const rows = Array.from(panel.querySelectorAll<HTMLElement>('.l')).filter(owns);
      const lh = parseFloat(getComputedStyle(panel).lineHeight) || DEFAULT_LINE_PX;
      const plan: Array<[HTMLElement, string | null]> = [];
      let n = 0;
      for (const row of rows) {
        if (!row.getClientRects().length) {
          plan.push([row, null]);
          continue;
        }
        const lines = Math.max(1, Math.round(row.getBoundingClientRect().height / lh));
        const nums: number[] = [];
        for (let i = 0; i < lines; i++) nums.push(++n);
        plan.push([row, nums.join('\n')]);
      }
      for (const [row, text] of plan) {
        if (text === null) delete row.dataset.ln;
        else if (row.dataset.ln !== text) row.dataset.ln = text;
      }
    };
    const schedule = () => {
      if (!frame) frame = requestAnimationFrame(number);
    };

    const ro = new ResizeObserver(schedule);
    const watched = new Set<Element>();
    const watch = () => {
      for (const row of panel.querySelectorAll<HTMLElement>('.l')) {
        if (!watched.has(row)) {
          watched.add(row);
          ro.observe(row);
        }
      }
    };
    const hasRow = (node: Node) =>
      node.nodeType === 1 && ((node as Element).matches('.l') || !!(node as Element).querySelector('.l'));
    const mo = new MutationObserver((records) => {
      for (const m of records) {
        if (m.type === 'attributes' || [...m.addedNodes].some(hasRow) || [...m.removedNodes].some(hasRow)) {
          for (const el of watched) if (!el.isConnected) watched.delete(el);
          watch();
          schedule();
          return;
        }
      }
    });
    mo.observe(panel, { subtree: true, childList: true, attributes: true, attributeFilter: ['hidden', 'class'] });
    watch();
    number();
    void document.fonts?.ready.then(schedule);

    return () => {
      if (frame) cancelAnimationFrame(frame);
      ro.disconnect();
      mo.disconnect();
      for (const row of panel.querySelectorAll<HTMLElement>('.l')) delete row.dataset.ln;
    };
  }, [ref, enabled]);
}

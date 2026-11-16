import { useEffect, useRef, useState, type PointerEvent, type ReactNode } from 'react';
import { TextButton } from './controls';

export type Detent = 'peek' | 'half' | 'full';
export const DETENTS: readonly Detent[] = ['peek', 'half', 'full'];

export type DetentAction =
  | { type: 'up' }
  | { type: 'down' }
  | { type: 'cycle' }
  | { type: 'set'; detent: Detent }
  /** End of a drag: the sheet's height and velocity (px/ms, positive = growing) at release. */
  | { type: 'release'; height: number; velocity: number; heights: Record<Detent, number> };

/** Speed above which a release flicks to the next detent instead of the nearest one. */
export const FLICK_PX_PER_MS = 0.45;

/** Pure detent logic for Sheet (and for anything that wants to drive one from keys). */
export function detentReducer(state: Detent, action: DetentAction): Detent {
  const i = DETENTS.indexOf(state);
  switch (action.type) {
    case 'up':
      return DETENTS[Math.min(DETENTS.length - 1, i + 1)];
    case 'down':
      return DETENTS[Math.max(0, i - 1)];
    case 'cycle':
      return DETENTS[(i + 1) % DETENTS.length];
    case 'set':
      return action.detent;
    case 'release': {
      const { height, velocity, heights } = action;
      if (!Number.isFinite(height)) return state;
      if (Math.abs(velocity) >= FLICK_PX_PER_MS) {
        if (velocity > 0) return DETENTS.find((d) => heights[d] > height + 1) ?? 'full';
        return [...DETENTS].reverse().find((d) => heights[d] < height - 1) ?? 'peek';
      }
      let best: Detent = state;
      let gap = Infinity;
      for (const d of DETENTS) {
        const g = Math.abs(heights[d] - height);
        if (g < gap) {
          gap = g;
          best = d;
        }
      }
      return best;
    }
  }
}

export interface SheetProps {
  open: boolean;
  detent: Detent;
  onDetent: (d: Detent) => void;
  title: ReactNode;
  children?: ReactNode;
  /** Extension: reports the visible height in px (0 when closed), e.g. for map insets. */
  onHeight?: (px: number) => void;
  /** Extra controls on the title line, before [▲] [▼] (e.g. the detail sheet's [CLOSE]). */
  actions?: ReactNode;
}

const DRAG_SLOP = 4;

/**
 * Phone bottom sheet with three detents. It clicks between them in four steps; drag the grip
 * or the title line, or use [▲] / [▼]. Fixed to its containing block (the viewport, or a
 * transformed ancestor). Set --sheet-gap on an ancestor to keep a top bar uncovered.
 */
export function Sheet({ open, detent, onDetent, title, children, onHeight, actions }: SheetProps) {
  const sheetRef = useRef<HTMLElement>(null);
  const probes = useRef<Partial<Record<Detent, HTMLDivElement | null>>>({});
  const drag = useRef<{ y0: number; h0: number; y: number; t: number; v: number; moved: boolean } | null>(null);
  const suppressClick = useRef(false);
  const [dragging, setDragging] = useState(false);

  const onHeightRef = useRef(onHeight);
  useEffect(() => {
    onHeightRef.current = onHeight;
  }, [onHeight]);

  useEffect(() => {
    const el = sheetRef.current;
    if (!el) return;
    const report = () => onHeightRef.current?.(open ? el.getBoundingClientRect().height : 0);
    report();
    if (typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(report);
    ro.observe(el);
    return () => ro.disconnect();
  }, [open]);

  const heights = (): Record<Detent, number> => ({
    peek: probes.current.peek?.offsetHeight ?? 0,
    half: probes.current.half?.offsetHeight ?? 0,
    full: probes.current.full?.offsetHeight ?? 0,
  });

  const onPointerDown = (e: PointerEvent<HTMLElement>) => {
    if (e.button !== 0 || !sheetRef.current) return;
    const target = e.target as Element;
    if (target.closest('button') && !target.closest('.bsheet-grip')) return; // let [▲] [▼] click
    const h0 = sheetRef.current.getBoundingClientRect().height;
    drag.current = { y0: e.clientY, h0, y: e.clientY, t: e.timeStamp, v: 0, moved: false };
    e.currentTarget.setPointerCapture?.(e.pointerId);
  };

  const onPointerMove = (e: PointerEvent<HTMLElement>) => {
    const d = drag.current;
    const el = sheetRef.current;
    if (!d || !el) return;
    if (!d.moved && Math.abs(e.clientY - d.y0) < DRAG_SLOP) return;
    if (!d.moved) {
      d.moved = true;
      setDragging(true);
    }
    const hs = heights();
    const h = Math.min(hs.full, Math.max(hs.peek, d.h0 - (e.clientY - d.y0)));
    const dt = e.timeStamp - d.t;
    if (dt > 0) d.v = 0.7 * ((d.y - e.clientY) / dt) + 0.3 * d.v;
    d.y = e.clientY;
    d.t = e.timeStamp;
    el.style.height = `${h}px`;
  };

  const endDrag = (e: PointerEvent<HTMLElement>) => {
    const d = drag.current;
    const el = sheetRef.current;
    drag.current = null;
    if (!d || !el) return;
    e.currentTarget.releasePointerCapture?.(e.pointerId);
    if (!d.moved) return;
    suppressClick.current = true;
    const next = detentReducer(detent, {
      type: 'release',
      height: el.getBoundingClientRect().height,
      velocity: d.v,
      heights: heights(),
    });
    setDragging(false);
    el.style.height = ''; // hand back to the detent's CSS height; the stepped transition runs
    if (next !== detent) onDetent(next);
  };

  const step = (type: 'up' | 'down' | 'cycle') => {
    const next = detentReducer(detent, { type });
    if (next !== detent) onDetent(next);
  };

  const onGripClick = () => {
    if (suppressClick.current) {
      suppressClick.current = false;
      return;
    }
    step('cycle');
  };

  const dragHandlers = {
    onPointerDown,
    onPointerMove,
    onPointerUp: endDrag,
    onPointerCancel: endDrag,
  };

  return (
    <div className="bsheet-root" data-open={open ? 'true' : 'false'} inert={!open}>
      {DETENTS.map((d) => (
        <div
          key={d}
          aria-hidden="true"
          className="bsheet-probe"
          style={{ height: `var(--sheet-${d})` }}
          ref={(el) => {
            probes.current[d] = el;
          }}
        />
      ))}
      <section
        ref={sheetRef}
        className={dragging ? 'bsheet dragging' : 'bsheet'}
        data-detent={detent}
        aria-label={typeof title === 'string' ? title : undefined}
      >
        <button
          type="button"
          className="bsheet-grip"
          aria-label={`Sheet size: ${detent}. Change size`}
          onClick={onGripClick}
          {...dragHandlers}
        >
          <i aria-hidden="true" />
        </button>
        <div className="l bsheet-head" {...dragHandlers}>
          <span className="l-main">
            <span className="panel-title">{title}</span>
          </span>
          <span className="l-right">
            {actions}
            <TextButton ariaLabel="Expand sheet" disabled={detent === 'full'} onClick={() => step('up')}>
              ▲
            </TextButton>
            <TextButton ariaLabel="Collapse sheet" disabled={detent === 'peek'} onClick={() => step('down')}>
              ▼
            </TextButton>
          </span>
        </div>
        <div className="bsheet-body" inert={detent === 'peek'}>
          {children}
        </div>
      </section>
    </div>
  );
}

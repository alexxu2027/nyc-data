// Phone layers (2026-11-18): a button over the map's top-left corner opens the layer list as a
// drawer from the left edge. It replaced a second bottom sheet: with layers and details both
// sliding up from the bottom, the two stacked and fought (Alex: "janky and confusing"). Now
// the bottom belongs to details alone, and layers live on the left, the same side as on desktop.
//
// Closes on: [CLOSE], a tap on the map behind it, Esc, a swipe to the left, or anything that
// wants the map (picking a row's LIST, opening CHANGES / HEALTH / ABOUT).
import { useEffect, useRef, useState, type PointerEvent, type ReactNode } from 'react';
import { useApp } from '../core';
import { Panel, TextButton } from '../ui';

export interface LayerDrawerProps {
  open: boolean;
  onClose: () => void;
  /** Pinned above the list, under the title: the borough filter and the live status. */
  head?: ReactNode;
  /** Lines pinned under the list (the legend). */
  footer?: ReactNode;
  children: ReactNode;
}

/** How far left (px) a swipe must travel to close the drawer. */
export const SWIPE_CLOSE_PX = 60;

/** The drawer's x offset while a finger drags it: only leftward, never past its own width. */
export function dragOffset(dx: number, width: number): number {
  return Math.max(-width, Math.min(0, dx));
}

export function LayerDrawer({ open, onClose, head, footer, children }: LayerDrawerProps) {
  const ref = useRef<HTMLDivElement>(null);
  const [drag, setDrag] = useState(0);
  const start = useRef<{ x: number; y: number; id: number; horizontal: boolean | null } | null>(null);

  // Focus moves in on open and back to the opener on close (the LAYERS button).
  useEffect(() => {
    if (!open) return;
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    ref.current?.focus({ preventScroll: true });
    return () => {
      if (opener && opener.isConnected) opener.focus({ preventScroll: true });
    };
  }, [open]);

  const end = (e: PointerEvent) => {
    const s = start.current;
    start.current = null;
    if (!s || s.id !== e.pointerId) return;
    const dx = e.clientX - s.x;
    setDrag(0);
    if (s.horizontal && dx <= -SWIPE_CLOSE_PX) onClose();
  };

  return (
    <>
      <div className="sh-scrim" data-open={open} onClick={onClose} aria-hidden="true" />
      <div
        ref={ref}
        className={drag ? 'sh-ldrawer dragging' : 'sh-ldrawer'}
        data-open={open}
        role="dialog"
        aria-label="Layers"
        aria-hidden={!open}
        inert={!open}
        tabIndex={-1}
        style={drag ? { transform: `translateX(${drag}px)` } : undefined}
        onKeyDown={(e) => {
          if (e.key === 'Escape') {
            e.stopPropagation();
            onClose();
          }
        }}
        onPointerDown={(e) => {
          if (e.pointerType === 'mouse') return; // a swipe is a touch gesture
          start.current = { x: e.clientX, y: e.clientY, id: e.pointerId, horizontal: null };
        }}
        onPointerMove={(e) => {
          const s = start.current;
          if (!s || s.id !== e.pointerId) return;
          const dx = e.clientX - s.x;
          const dy = e.clientY - s.y;
          // Decide once, after 8 px: a mostly-sideways move drags the drawer, else the list scrolls.
          if (s.horizontal === null && Math.hypot(dx, dy) > 8) s.horizontal = Math.abs(dx) > Math.abs(dy);
          if (s.horizontal) setDrag(dragOffset(dx, ref.current?.offsetWidth ?? 400) || -0.001);
        }}
        onPointerUp={end}
        onPointerCancel={end}
      >
        <header className="sh-ldrawer-head">
          <div className="l">
            <h2 className="l-main panel-title">
              <DrawerTitle />
            </h2>
            <TextButton onClick={onClose} ariaLabel="Close layers">
              CLOSE
            </TextButton>
          </div>
          {head}
        </header>
        <Panel numbered footer={footer}>
          {children}
        </Panel>
      </div>
    </>
  );
}

function DrawerTitle() {
  const on = useApp((s) => s.visible.length);
  const catalog = useApp((s) => s.catalog);
  return <>LAYERS {catalog ? `${on} ON` : ''}</>;
}

/** The button that opens the drawer: "≡ LAYERS 11", plus the borough filter when one is set. */
export function LayersButton({ open, onOpen }: { open: boolean; onOpen: () => void }) {
  const on = useApp((s) => s.visible.length);
  const catalog = useApp((s) => s.catalog);
  const boroughs = useApp((s) => s.boroughs);
  return (
    <button
      type="button"
      className="sh-layers-btn"
      aria-expanded={open}
      aria-label={`Layers: ${on} on${boroughs.length ? `, showing ${boroughs.join(', ')}` : ''}`}
      onClick={onOpen}
    >
      <span className="sh-layers-ico" aria-hidden="true">
        <i />
        <i />
        <i />
      </span>
      LAYERS{catalog ? <span className="sh-layers-n"> {on}</span> : null}
      {boroughs.length > 0 && <span className="sh-layers-boro"> · {boroughs.join(' ')}</span>}
    </button>
  );
}

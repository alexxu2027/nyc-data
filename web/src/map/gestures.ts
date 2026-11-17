// Rotate and tilt from a trackpad (2026-11-17). MapLibre already does touch (twist rotates, two
// fingers up or down tilt, pinch zooms), mouse (right- or Ctrl-drag rotates and tilts) and
// keys (Shift + arrows). Browsers don't hand a trackpad's rotate gesture to pages, except
// Safari. So:
// - Shift + two-finger scroll (or wheel) rotates. Windows turns Shift + vertical scroll into
//   horizontal scroll, so either axis rotates. (A plain sideways swipe rotated for a while on
//   2026-11-17; it made ordinary scrolling feel janky, so it was removed. Chrome, Edge and
//   Firefox don't report a trackpad twist at all.)
// - Ctrl + two-finger scroll tilts (2026-11-17), as does Alt / Option + scroll. A trackpad
//   pinch also arrives as a wheel event with ctrlKey set, so Ctrl counts only while the key is
//   physically down (a keydown was seen); a pinch has no keydown and stays zoom.
// - Safari's trackpad rotate gesture rotates.
// - Option / Alt + ← → rotates and + ↑ ↓ tilts (Apple Maps rotates with Option + arrows;
//   MapLibre's own keys are Shift + arrows).
// Plain scroll and pinch still zoom (MapLibre). Listeners sit on the map's outer container in
// the capture phase, so a modified wheel never reaches MapLibre's scroll-zoom.
import type { Map as MlMap } from 'maplibre-gl';

/** Degrees of bearing per pixel of scroll. A long swipe (~400 px) turns ~80°. */
export const ROTATE_PER_PX = 0.2;
/** Degrees of pitch per pixel of scroll. */
export const TILT_PER_PX = 0.15;
const LINE_PX = 16; // deltaMode 1 (lines), e.g. Firefox with a mouse wheel
const PAGE_PX = 400;

export type WheelAction = { kind: 'rotate'; degrees: number } | { kind: 'tilt'; degrees: number } | null;

type WheelLike = Pick<WheelEvent, 'deltaX' | 'deltaY' | 'deltaMode' | 'shiftKey' | 'altKey' | 'ctrlKey' | 'metaKey'>;

/**
 * What a wheel event means for rotation or tilt (null: leave it to MapLibre's zoom).
 * `ctrlHeld`: the Ctrl key is physically down (a pinch sets ctrlKey without it).
 */
export function wheelAction(e: WheelLike, ctrlHeld = false): WheelAction {
  if (e.metaKey) return null; // browser zoom
  const unit = e.deltaMode === 1 ? LINE_PX : e.deltaMode === 2 ? PAGE_PX : 1;
  const dx = e.deltaX * unit;
  const dy = e.deltaY * unit;
  if (e.ctrlKey) {
    if (!ctrlHeld) return null; // a pinch: MapLibre zooms
    return dy ? { kind: 'tilt', degrees: -dy * TILT_PER_PX } : null;
  }
  if (e.shiftKey) {
    const d = Math.abs(dx) > Math.abs(dy) ? dx : dy;
    return d ? { kind: 'rotate', degrees: d * ROTATE_PER_PX } : null;
  }
  if (e.altKey) {
    return dy ? { kind: 'tilt', degrees: -dy * TILT_PER_PX } : null; // swipe up: tilt toward the horizon
  }
  return null;
}

/** Degrees per Option/Alt + arrow press. */
export const KEY_ROTATE = 15;
export const KEY_TILT = 10;

/** What an Option/Alt + arrow key does (null: not ours). */
export function keyAction(e: Pick<KeyboardEvent, 'key' | 'altKey' | 'ctrlKey' | 'metaKey' | 'shiftKey'>): WheelAction {
  if (!e.altKey || e.ctrlKey || e.metaKey || e.shiftKey) return null;
  if (e.key === 'ArrowLeft') return { kind: 'rotate', degrees: -KEY_ROTATE };
  if (e.key === 'ArrowRight') return { kind: 'rotate', degrees: KEY_ROTATE };
  if (e.key === 'ArrowUp') return { kind: 'tilt', degrees: KEY_TILT };
  if (e.key === 'ArrowDown') return { kind: 'tilt', degrees: -KEY_TILT };
  return null;
}

/** Safari's GestureEvent (not in the DOM typings). */
interface GestureEventLike extends UIEvent {
  rotation: number;
  scale: number;
}

export class TrackpadGestures {
  private readonly map: MlMap;
  private readonly el: HTMLElement;
  private startBearing = 0;
  /** The Ctrl key is physically down (keydown seen, no keyup or blur since). */
  private ctrlHeld = false;

  constructor(map: MlMap) {
    this.map = map;
    this.el = map.getContainer();
    this.el.addEventListener('wheel', this.onWheel, { capture: true, passive: false });
    this.el.addEventListener('keydown', this.onKey, { capture: true });
    window.addEventListener('keydown', this.onCtrl, true);
    window.addEventListener('keyup', this.onCtrl, true);
    window.addEventListener('blur', this.onBlur);
    this.el.addEventListener('gesturestart', this.onGestureStart as EventListener, { capture: true, passive: false } as AddEventListenerOptions);
    this.el.addEventListener('gesturechange', this.onGestureChange as EventListener, { capture: true, passive: false } as AddEventListenerOptions);
  }

  private readonly onCtrl = (e: KeyboardEvent): void => {
    if (e.key === 'Control') this.ctrlHeld = e.type === 'keydown';
  };

  private readonly onBlur = (): void => {
    this.ctrlHeld = false;
  };

  private readonly onWheel = (e: WheelEvent): void => {
    if (!e.ctrlKey) this.ctrlHeld = false; // a keyup we missed
    const a = wheelAction(e, this.ctrlHeld);
    if (!a) return;
    e.preventDefault();
    e.stopPropagation();
    const map = this.map;
    if (a.kind === 'rotate') map.setBearing(map.getBearing() + a.degrees);
    else map.setPitch(Math.min(map.getMaxPitch(), Math.max(0, map.getPitch() + a.degrees)));
  };

  private readonly onKey = (e: KeyboardEvent): void => {
    const a = keyAction(e);
    if (!a) return;
    e.preventDefault();
    e.stopPropagation();
    const map = this.map;
    if (a.kind === 'rotate') map.easeTo({ bearing: map.getBearing() + a.degrees, duration: 250 });
    else map.easeTo({ pitch: Math.min(map.getMaxPitch(), Math.max(0, map.getPitch() + a.degrees)), duration: 250 });
  };

  private readonly onGestureStart = (e: GestureEventLike): void => {
    e.preventDefault(); // stop Safari zooming the page
    this.startBearing = this.map.getBearing();
  };

  private readonly onGestureChange = (e: GestureEventLike): void => {
    e.preventDefault();
    if (Math.abs(e.rotation) > 2) this.map.setBearing(this.startBearing - e.rotation);
  };

  destroy(): void {
    this.el.removeEventListener('wheel', this.onWheel, { capture: true });
    this.el.removeEventListener('keydown', this.onKey, { capture: true });
    window.removeEventListener('keydown', this.onCtrl, true);
    window.removeEventListener('keyup', this.onCtrl, true);
    window.removeEventListener('blur', this.onBlur);
    this.el.removeEventListener('gesturestart', this.onGestureStart as EventListener, { capture: true });
    this.el.removeEventListener('gesturechange', this.onGestureChange as EventListener, { capture: true });
  }
}

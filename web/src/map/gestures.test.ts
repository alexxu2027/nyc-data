import { describe, expect, it } from 'vitest';
import { rotateHint } from './Controls';
import { KEY_ROTATE, keyAction, ROTATE_PER_PX, TILT_PER_PX, wheelAction } from './gestures';
import { buildingOpacity, BUILDING_OPACITY, TILT_3D_FROM, TILT_3D_FULL } from './scene';
import { parseUrl } from '../core/url';
import { catalog } from '../core/test/fixtures';

const ev = (o: Partial<Parameters<typeof wheelAction>[0]>) => ({ deltaX: 0, deltaY: 0, deltaMode: 0, shiftKey: false, altKey: false, ctrlKey: false, metaKey: false, ...o });

describe('trackpad rotate and tilt', () => {
  it('plain scroll and pinch stay with MapLibre (zoom)', () => {
    expect(wheelAction(ev({ deltaY: 40 }))).toBeNull();
    expect(wheelAction(ev({ deltaY: 40, ctrlKey: true }))).toBeNull(); // a pinch: ctrlKey, no key down
  });

  it('Ctrl held + two-finger scroll tilts: scrolling up tilts toward the horizon', () => {
    expect(wheelAction(ev({ deltaY: -100, ctrlKey: true }), true)).toEqual({ kind: 'tilt', degrees: 100 * TILT_PER_PX });
    expect(wheelAction(ev({ deltaY: 100, ctrlKey: true }), true)).toEqual({ kind: 'tilt', degrees: -100 * TILT_PER_PX });
    expect(wheelAction(ev({ deltaY: -100, metaKey: true }), true)).toBeNull(); // Cmd: browser zoom
  });

  it('Shift + scroll rotates, on either axis (Windows swaps Shift + vertical to horizontal)', () => {
    expect(wheelAction(ev({ shiftKey: true, deltaY: 100 }))).toEqual({ kind: 'rotate', degrees: 100 * ROTATE_PER_PX });
    expect(wheelAction(ev({ shiftKey: true, deltaX: -50, deltaY: 5 }))).toEqual({ kind: 'rotate', degrees: -50 * ROTATE_PER_PX });
  });

  it('Alt + scroll tilts: swiping up tilts toward the horizon', () => {
    expect(wheelAction(ev({ altKey: true, deltaY: -100 }))).toEqual({ kind: 'tilt', degrees: 100 * TILT_PER_PX });
  });

  it('line-mode wheels (Firefox mouse) scale up to pixels', () => {
    expect(wheelAction(ev({ shiftKey: true, deltaY: 3, deltaMode: 1 }))).toEqual({ kind: 'rotate', degrees: 48 * ROTATE_PER_PX });
  });

  it('the hint speaks the device: touch vs trackpad / mouse', () => {
    expect(rotateHint(true).join(' ')).toMatch(/2 FINGERS UP: 3D.*TWIST/);
    expect(rotateHint(false)[0]).toBe('CTRL + SCROLL: TILT INTO 3D');
  });

  it('a plain sideways swipe is left alone (no rotate without Shift)', () => {
    expect(wheelAction(ev({ deltaX: 40 }))).toBeNull();
  });

  it('Option / Alt + arrows rotate and tilt, like Apple Maps; plain arrows stay with MapLibre', () => {
    const k = (key: string, o = {}) => ({ key, altKey: true, ctrlKey: false, metaKey: false, shiftKey: false, ...o });
    expect(keyAction(k('ArrowLeft'))).toEqual({ kind: 'rotate', degrees: -KEY_ROTATE });
    expect(keyAction(k('ArrowUp'))).toMatchObject({ kind: 'tilt' });
    expect(keyAction(k('ArrowLeft', { altKey: false }))).toBeNull();
    expect(keyAction(k('a'))).toBeNull();
  });
});

describe('3D follows the tilt (no button)', () => {
  it('buildings are hidden flat, fade in as the map tilts, solid by TILT_3D_FULL', () => {
    expect(buildingOpacity(0)).toBe(0);
    expect(buildingOpacity(TILT_3D_FROM)).toBe(0);
    const mid = buildingOpacity((TILT_3D_FROM + TILT_3D_FULL) / 2);
    expect(mid).toBeGreaterThan(0.3);
    expect(mid).toBeLessThan(0.6);
    expect(buildingOpacity(TILT_3D_FULL)).toBe(BUILDING_OPACITY);
    expect(buildingOpacity(60)).toBe(BUILDING_OPACITY);
  });

  it('every link opens top-down, even an old 3d=1 or tilted one', () => {
    expect(parseUrl('?3d=1', catalog).view.pitch).toBe(0);
    expect(parseUrl('?3d=1&p=20', catalog).view.pitch).toBe(0);
    expect(parseUrl('?sun=1', catalog).scene).toEqual({ sun: true });
  });
});

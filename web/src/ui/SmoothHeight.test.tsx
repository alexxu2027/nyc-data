import { act, cleanup, render, renderHook } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { useAfter } from './motion';
import { SmoothHeight } from './SmoothHeight';

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('useAfter (a quick load never flashes LOADING)', () => {
  it('turns true only after the delay, and false again at once', () => {
    vi.useFakeTimers();
    const { result, rerender } = renderHook(({ on }) => useAfter(400, on), { initialProps: { on: true } });
    expect(result.current).toBe(false);
    act(() => vi.advanceTimersByTime(399));
    expect(result.current).toBe(false);
    act(() => vi.advanceTimersByTime(1));
    expect(result.current).toBe(true);
    rerender({ on: false });
    expect(result.current).toBe(false);
  });

  it('a load that finishes inside the delay never shows', () => {
    vi.useFakeTimers();
    const { result, rerender } = renderHook(({ on }) => useAfter(400, on), { initialProps: { on: true } });
    act(() => vi.advanceTimersByTime(200));
    rerender({ on: false });
    act(() => vi.advanceTimersByTime(1000));
    expect(result.current).toBe(false);
  });
});

describe('SmoothHeight', () => {
  it("follows its content's height (the CSS transition does the gliding)", () => {
    let fire: () => void = () => {};
    vi.stubGlobal(
      'ResizeObserver',
      class {
        constructor(cb: () => void) {
          fire = cb;
        }
        observe() {}
        disconnect() {}
      },
    );
    const { container } = render(
      <SmoothHeight>
        <div>row</div>
      </SmoothHeight>,
    );
    const outer = container.firstElementChild as HTMLElement;
    const inner = outer.firstElementChild as HTMLElement;
    expect(outer.className).toBe('smooth-h');
    Object.defineProperty(inner, 'offsetHeight', { configurable: true, value: 54 });
    fire();
    expect(outer.style.height).toBe('54px');
  });
});

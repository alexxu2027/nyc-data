import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { resetStore, useApp } from '../core/store';
import { catalog } from '../core/test/fixtures';
import { LayerDrawer, LayersButton, SWIPE_CLOSE_PX, dragOffset } from './LayerDrawer';

beforeEach(() => {
  resetStore();
  useApp.setState({ catalog, visible: ['citibike', 'trains'] });
});
afterEach(cleanup);

function drawer(open: boolean, onClose = vi.fn()) {
  render(
    <LayerDrawer open={open} onClose={onClose} head={<p>HEAD</p>} footer={<p>FOOT</p>}>
      <p>LIST</p>
    </LayerDrawer>,
  );
  return { onClose, el: screen.getByRole('dialog', { hidden: true }) };
}

describe('LayerDrawer', () => {
  it('closed: out of the tab order and hidden from screen readers', () => {
    const { el } = drawer(false);
    expect(el.dataset.open).toBe('false');
    expect(el.getAttribute('aria-hidden')).toBe('true');
    expect(el.hasAttribute('inert')).toBe(true);
  });

  it('open: titled with the layer count, focus moves in', () => {
    const { el } = drawer(true);
    expect(el.dataset.open).toBe('true');
    expect(el.hasAttribute('inert')).toBe(false);
    expect(el.textContent).toContain('LAYERS 2 ON');
    expect(document.activeElement).toBe(el);
  });

  it('closes on CLOSE, Esc and a tap on the map behind it', () => {
    const { el, onClose } = drawer(true);
    fireEvent.click(screen.getByRole('button', { name: 'Close layers' }));
    fireEvent.keyDown(el, { key: 'Escape' });
    fireEvent.click(document.querySelector('.sh-scrim')!);
    expect(onClose).toHaveBeenCalledTimes(3);
  });

  it('a leftward swipe closes; a short or vertical one does not', () => {
    const { el, onClose } = drawer(true);
    const swipe = (dx: number, dy: number) => {
      fireEvent.pointerDown(el, { pointerId: 1, pointerType: 'touch', clientX: 200, clientY: 300 });
      fireEvent.pointerMove(el, { pointerId: 1, pointerType: 'touch', clientX: 200 + dx, clientY: 300 + dy });
      fireEvent.pointerUp(el, { pointerId: 1, pointerType: 'touch', clientX: 200 + dx, clientY: 300 + dy });
    };
    swipe(-20, 0); // too short
    swipe(-10, -150); // a scroll
    expect(onClose).not.toHaveBeenCalled();
    swipe(-SWIPE_CLOSE_PX - 10, 5);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('dragOffset follows the finger left only, never past the width', () => {
    expect(dragOffset(40, 300)).toBe(0);
    expect(dragOffset(-50, 300)).toBe(-50);
    expect(dragOffset(-500, 300)).toBe(-300);
  });
});

describe('LayersButton', () => {
  it('shows the count, and the borough filter when one is set', () => {
    const onOpen = vi.fn();
    const { rerender } = render(<LayersButton open={false} onOpen={onOpen} />);
    const btn = screen.getByRole('button');
    expect(btn.textContent).toContain('LAYERS 2');
    expect(btn.getAttribute('aria-expanded')).toBe('false');
    fireEvent.click(btn);
    expect(onOpen).toHaveBeenCalled();
    useApp.setState({ boroughs: ['BK', 'QN'] });
    rerender(<LayersButton open={false} onOpen={onOpen} />);
    expect(btn.textContent).toContain('· BK QN');
    expect(btn.getAttribute('aria-label')).toBe('Layers: 2 on, showing BK, QN');
  });
});

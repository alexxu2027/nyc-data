import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { detentReducer, FLICK_PX_PER_MS, Sheet, type Detent } from './Sheet';

afterEach(cleanup);

const heights: Record<Detent, number> = { peek: 51, half: 406, full: 758 };
const release = (height: number, velocity = 0) => ({ type: 'release' as const, height, velocity, heights });

describe('detentReducer', () => {
  it('steps up and down and clamps at the ends', () => {
    expect(detentReducer('peek', { type: 'up' })).toBe('half');
    expect(detentReducer('half', { type: 'up' })).toBe('full');
    expect(detentReducer('full', { type: 'up' })).toBe('full');
    expect(detentReducer('full', { type: 'down' })).toBe('half');
    expect(detentReducer('peek', { type: 'down' })).toBe('peek');
  });

  it('cycles and sets', () => {
    expect(detentReducer('peek', { type: 'cycle' })).toBe('half');
    expect(detentReducer('full', { type: 'cycle' })).toBe('peek');
    expect(detentReducer('peek', { type: 'set', detent: 'full' })).toBe('full');
  });

  it('snaps a slow release to the nearest detent', () => {
    expect(detentReducer('half', release(120))).toBe('peek');
    expect(detentReducer('half', release(500))).toBe('half');
    expect(detentReducer('peek', release(640))).toBe('full');
  });

  it('flicks a fast release one detent in the direction of travel', () => {
    const fast = FLICK_PX_PER_MS + 0.1;
    expect(detentReducer('peek', release(80, fast))).toBe('half'); // nearest is peek, flick wins
    expect(detentReducer('half', release(420, fast))).toBe('full');
    expect(detentReducer('full', release(700, -fast))).toBe('half');
    expect(detentReducer('half', release(390, -fast))).toBe('peek');
    expect(detentReducer('full', release(758, fast))).toBe('full');
    expect(detentReducer('peek', release(51, -fast))).toBe('peek');
  });

  it('ignores a release without a height', () => {
    expect(detentReducer('half', release(Number.NaN))).toBe('half');
  });
});

describe('Sheet', () => {
  it('moves between detents with its buttons and grip', () => {
    const onDetent = vi.fn();
    const { container } = render(
      <Sheet open detent="half" onDetent={onDetent} title="LAYERS">
        <p>BODY</p>
      </Sheet>,
    );
    expect(container.querySelector('.bsheet')?.getAttribute('data-detent')).toBe('half');
    fireEvent.click(screen.getByRole('button', { name: 'Expand sheet' }));
    expect(onDetent).toHaveBeenLastCalledWith('full');
    fireEvent.click(screen.getByRole('button', { name: 'Collapse sheet' }));
    expect(onDetent).toHaveBeenLastCalledWith('peek');
    fireEvent.click(screen.getByRole('button', { name: /Change size/ }));
    expect(onDetent).toHaveBeenLastCalledWith('full');
  });

  it('makes the body inert at peek and the whole sheet inert when closed', () => {
    const { container, rerender } = render(
      <Sheet open detent="peek" onDetent={() => {}} title="LAYERS">
        <p>BODY</p>
      </Sheet>,
    );
    expect(container.querySelector('.bsheet-body')?.hasAttribute('inert')).toBe(true);
    rerender(
      <Sheet open={false} detent="half" onDetent={() => {}} title="LAYERS">
        <p>BODY</p>
      </Sheet>,
    );
    const root = container.querySelector('.bsheet-root');
    expect(root?.getAttribute('data-open')).toBe('false');
    expect(root?.hasAttribute('inert')).toBe(true);
  });
});

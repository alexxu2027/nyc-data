import { act, cleanup, render } from '@testing-library/react';
import { useRef } from 'react';
import { afterEach, describe, expect, it } from 'vitest';
import { Num } from './readout';
import { PRINT_MAX_STAGGER, PRINT_STAGGER_MS, typeTiming, useArrivals, useChangeKey, usePrintRows } from './motion';

afterEach(cleanup);

function Arrivals({ ids, initial }: { ids: string[]; initial?: (id: string) => boolean }) {
  const order = useArrivals(ids, initial);
  return <span data-testid="o">{ids.map((id) => `${id}:${order.get(id) ?? '-'}`).join(' ')}</span>;
}

describe('useArrivals', () => {
  it('first render prints nothing (or only `initial`); later arrivals print newest first', () => {
    const a = ['a', 'b'];
    const { getByTestId, rerender } = render(<Arrivals ids={a} />);
    expect(getByTestId('o').textContent).toBe('a:- b:-');
    rerender(<Arrivals ids={['x', 'y', ...a]} />);
    expect(getByTestId('o').textContent).toBe('x:0 y:1 a:- b:-');
    // Same ids again (a new array): the entries stay, nothing new prints.
    rerender(<Arrivals ids={['x', 'y', 'a', 'b']} />);
    expect(getByTestId('o').textContent).toBe('x:0 y:1 a:- b:-');
    // An id that left and came back prints again.
    rerender(<Arrivals ids={['x', 'y']} />);
    rerender(<Arrivals ids={['a', 'x', 'y']} />);
    expect(getByTestId('o').textContent).toBe('a:0 x:0 y:1');
  });

  it('`initial` ids print on mount; the stagger is capped', () => {
    const ids = Array.from({ length: PRINT_MAX_STAGGER + 3 }, (_, i) => `i${i}`);
    const { getByTestId } = render(<Arrivals ids={ids} initial={() => true} />);
    const last = getByTestId('o').textContent!.split(' ').at(-1);
    expect(last).toBe(`i${ids.length - 1}:${PRINT_MAX_STAGGER}`);
  });
});

function Key({ v }: { v: unknown }) {
  return <span data-testid="k">{useChangeKey(v)}</span>;
}

describe('useChangeKey', () => {
  it('counts real changes only (not the first load, a gap, or the same value)', () => {
    const { getByTestId, rerender } = render(<Key v={null} />);
    rerender(<Key v={5} />); // first load
    expect(getByTestId('k').textContent).toBe('0');
    rerender(<Key v={5} />);
    expect(getByTestId('k').textContent).toBe('0');
    rerender(<Key v={6} />);
    expect(getByTestId('k').textContent).toBe('1');
    rerender(<Key v={null} />);
    rerender(<Key v={7} />);
    expect(getByTestId('k').textContent).toBe('1');
  });
});

describe('Num deal', () => {
  it('drops the digits in only after a real change', () => {
    const { container, rerender } = render(<Num value={2519} deal />);
    expect(container.querySelector('.num-deal')).toBeNull();
    rerender(<Num value={2519} deal />);
    expect(container.querySelector('.num-deal')).toBeNull();
    rerender(<Num value={2518} deal />);
    expect(container.querySelector('.num-deal')?.textContent).toBe('2,518');
    rerender(<Num value={2517} />); // without `deal`, never
    expect(container.querySelector('.num-deal')).toBeNull();
  });
});

function Rows({ n }: { n: number }) {
  const ref = useRef<HTMLDivElement>(null);
  usePrintRows(ref);
  return (
    <div ref={ref}>
      {Array.from({ length: n }, (_, i) => (
        <div key={i} className="l">
          row {i}
          <span className="l">nested</span>
        </div>
      ))}
    </div>
  );
}

describe('usePrintRows', () => {
  it('staggers top-level rows on mount, and rows that arrive during the window', async () => {
    const { container, rerender } = render(<Rows n={2} />);
    rerender(<Rows n={3} />);
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0)); // let the MutationObserver run
    });
    const rows = [...container.querySelectorAll<HTMLElement>('div.l')];
    expect(rows.map((r) => r.classList.contains('print-row'))).toEqual([true, true, true]);
    expect(rows.map((r) => r.style.animationDelay)).toEqual(['0ms', `${PRINT_STAGGER_MS}ms`, `${2 * PRINT_STAGGER_MS}ms`]);
    expect(container.querySelector('span.l')?.classList.contains('print-row')).toBe(false);
  });
});

describe('typeTiming', () => {
  it('paces by length, within bounds', () => {
    expect(typeTiming('ab')).toEqual({ ms: 120, steps: 2 });
    expect(typeTiming('x'.repeat(30))).toEqual({ ms: 420, steps: 30 });
    expect(typeTiming('x'.repeat(200))).toEqual({ ms: 650, steps: 48 });
  });
});

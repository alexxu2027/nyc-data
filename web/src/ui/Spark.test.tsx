import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { Spark, SPARK_H, SPARK_W, sparkPath } from './Spark';

afterEach(cleanup);

describe('Spark', () => {
  it('renders an empty baseline with 0 points', () => {
    const { container } = render(<Spark points={[]} />);
    const svg = screen.getByRole('img', { name: 'No data' });
    expect(svg.getAttribute('data-points')).toBe('0');
    expect(container.querySelector('.sp-empty')).not.toBeNull();
    expect(container.querySelector('.sp-line')).toBeNull();
  });

  it('renders a flat line and an end dot with 1 point', () => {
    const { container } = render(<Spark points={[[100, 7]]} />);
    expect(screen.getByRole('img', { name: '1 point' })).toBeTruthy();
    expect(container.querySelector('.sp-line')?.getAttribute('d')).toBe(`M0 ${SPARK_H / 2}H${SPARK_W}`);
    expect(container.querySelector('.sp-dot')).not.toBeNull();
  });

  it('renders N points, scaled into the box, with a label and width in ch', () => {
    const pts: Array<[number, number]> = [
      [0, 1],
      [10, 5],
      [20, 3],
    ];
    const { container } = render(<Spark points={pts} width={8} label="Bikes" />);
    const svg = screen.getByRole('img', { name: 'Bikes' });
    expect(svg.style.width).toBe('8ch');
    const d = container.querySelector('.sp-line')?.getAttribute('d') ?? '';
    expect(d.startsWith('M0 ')).toBe(true);
    expect(d.match(/L/g)?.length).toBe(2);
    expect(container.querySelector('.sp-dot')?.getAttribute('d')).toMatch(/^M100 /);
  });
});

describe('sparkPath', () => {
  it('maps min to the bottom and max to the top', () => {
    expect(sparkPath([
      [0, 0],
      [1, 10],
    ], false, 100, 13)).toBe('M0 11.5L100 1.5');
  });

  it('draws steps as H then V', () => {
    expect(sparkPath([
      [0, 0],
      [1, 10],
      [2, 0],
    ], true, 100, 13)).toBe('M0 11.5H50V1.5H100V11.5');
  });

  it('centres a flat series and skips non-finite values', () => {
    expect(sparkPath([
      [0, 4],
      [1, Number.NaN],
      [2, 4],
    ], false, 100, 13)).toBe('M0 6.5L100 6.5');
    expect(sparkPath([])).toBe('');
  });
});

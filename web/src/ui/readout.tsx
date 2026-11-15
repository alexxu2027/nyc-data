import type { CSSProperties, ReactNode } from 'react';

export interface ReadoutProps {
  /** Key, set in a fixed column (min 10ch; override with the --ro-k CSS variable). */
  k: ReactNode;
  /** Value: one line, clipped with an ellipsis. */
  v: ReactNode;
  /** Right-aligned extra. */
  r?: ReactNode;
}

/** A ledger row: KEY  value ……… extra. Never wraps, so live values never move the page. */
export function Readout({ k, v, r }: ReadoutProps) {
  return (
    <div className="l ro">
      <span className="ro-k">{k}</span>
      <span className="ro-v">{v ?? '--'}</span>
      {r != null && r !== false && <span className="ro-r">{r}</span>}
    </div>
  );
}

export interface NumProps {
  /** Numbers get en-US thousands separators; null / undefined / NaN show "--". */
  value: number | string | null | undefined;
  /** Minimum width in ch (default 6). */
  width?: number;
  align?: 'left' | 'right';
}

export function fmtNum(value: NumProps['value']): string {
  if (value == null) return '--';
  if (typeof value === 'number') return Number.isFinite(value) ? value.toLocaleString('en-US') : '--';
  return value === '' ? '--' : value;
}

/** A live number in a fixed-width box, so ticking digits never re-wrap the line. */
export function Num({ value, width = 6, align = 'right' }: NumProps) {
  const style: CSSProperties = { minWidth: `${width}ch` };
  return (
    <span className={align === 'right' ? 'num right' : 'num'} style={style}>
      {fmtNum(value)}
    </span>
  );
}

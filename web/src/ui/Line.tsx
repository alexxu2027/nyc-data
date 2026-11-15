import type { CSSProperties, KeyboardEvent, ReactNode } from 'react';

export interface LineProps {
  children?: ReactNode;
  /** Set flush right on the same line. */
  right?: ReactNode;
  center?: boolean;
  /** true = one step (2ch); a number = that many steps. */
  indent?: boolean | number;
  muted?: boolean;
  /** Keep to one line and clip the left part with an ellipsis. */
  nowrap?: boolean;
  /** Tooltip text (the title attribute). */
  title?: string;
  /** Makes the whole row a button (Enter / Space work). Avoid putting other buttons inside. */
  onClick?: () => void;
}

/** One printed line (`.l`): children set left, `right` flush right. */
export function Line({ children, right, center, indent, muted, nowrap, title, onClick }: LineProps) {
  const steps = indent === true ? 1 : typeof indent === 'number' ? indent : 0;
  const cls = ['l', center ? 'c' : '', steps > 0 ? 'indent' : '', muted ? 'muted' : '', nowrap ? 'nowrap' : '',
    onClick ? 'clickable' : ''].filter(Boolean).join(' ');
  const style = steps > 1 ? ({ '--indent': steps } as CSSProperties) : undefined;
  const onKeyDown = onClick
    ? (e: KeyboardEvent<HTMLDivElement>) => {
        if (e.target !== e.currentTarget) return;
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          onClick();
        }
      }
    : undefined;
  return (
    <div
      className={cls}
      style={style}
      title={title}
      onClick={onClick}
      onKeyDown={onKeyDown}
      role={onClick ? 'button' : undefined}
      tabIndex={onClick ? 0 : undefined}
    >
      <span className="l-main">{children}</span>
      {right != null && right !== false && <span className="l-right">{right}</span>}
    </div>
  );
}

/** An empty line: the spacing system. */
export function Blank() {
  return <div className="l" aria-hidden="true" />;
}

const RULE = '='.repeat(240);

/** A ===== divider, clipped to the column. Put a Blank above and below it. */
export function Rule() {
  return (
    <div className="l divider" aria-hidden="true">
      <span>{RULE}</span>
    </div>
  );
}

export interface HeadingProps {
  children?: ReactNode;
  /** Exhibit letter or number: renders "EXHIBIT B: …". */
  exhibit?: string | number;
}

/** A centred uppercase heading line. */
export function Heading({ children, exhibit }: HeadingProps) {
  return (
    <h2 className="l heading">
      <span className="l-main">
        {exhibit != null && exhibit !== '' ? <>EXHIBIT {exhibit}: </> : null}
        {children}
      </span>
    </h2>
  );
}

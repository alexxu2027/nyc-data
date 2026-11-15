import type { ReactNode } from 'react';

export interface ChipProps {
  children?: ReactNode;
  /** Pre-inverted (primary / title). */
  inverted?: boolean;
  /** Toggle state; sets aria-pressed (buttons only). */
  pressed?: boolean;
  onClick?: () => void;
  href?: string;
  ariaLabel?: string;
}

/** A bordered chip that stays on the line grid. A link with `href`, a button with `onClick`. */
export function Chip({ children, inverted, pressed, onClick, href, ariaLabel }: ChipProps) {
  const cls = inverted ? 'chip inv' : 'chip';
  if (href != null) {
    const external = /^https?:/.test(href);
    return (
      <a
        className={cls}
        href={href}
        aria-label={ariaLabel}
        onClick={onClick}
        target={external ? '_blank' : undefined}
        rel={external ? 'noreferrer' : undefined}
      >
        {children}
      </a>
    );
  }
  if (onClick) {
    return (
      <button type="button" className={cls} aria-pressed={pressed} aria-label={ariaLabel} onClick={onClick}>
        {children}
      </button>
    );
  }
  return (
    <span className={pressed ? `${cls} inv` : cls} aria-label={ariaLabel}>
      {children}
    </span>
  );
}

export interface TextButtonProps {
  /** The label. Brackets are added unless a string label already has them: "CLOSE" → [CLOSE]. */
  children?: ReactNode;
  /** Toggle state: sets aria-pressed and inverts. Omit for a plain action. */
  pressed?: boolean;
  /** Uses aria-disabled, so the button stays focusable and explains itself. */
  disabled?: boolean;
  onClick: () => void;
  ariaLabel: string;
}

function bracketed(children: ReactNode): ReactNode {
  if (typeof children === 'string' && children.startsWith('[') && children.endsWith(']')) return children;
  return <>[{children}]</>;
}

/** A typed control: [LIKE THIS]. */
export function TextButton({ children, pressed, disabled, onClick, ariaLabel }: TextButtonProps) {
  return (
    <button
      type="button"
      className="t"
      aria-pressed={pressed}
      aria-disabled={disabled ? true : undefined}
      aria-label={ariaLabel}
      onClick={disabled ? undefined : onClick}
    >
      {bracketed(children)}
    </button>
  );
}

export interface CheckProps {
  checked: boolean;
  onChange: (checked: boolean) => void;
  label: ReactNode;
  /** Set flush right on the row (counts, a [+] button). Kept outside the <label>. */
  right?: ReactNode;
  disabled?: boolean;
}

/**
 * [ ] / [X] on its own line, a real checkbox underneath. Inside another Line it flows inline.
 */
export function Check({ checked, onChange, label, right, disabled }: CheckProps) {
  return (
    <div className={disabled ? 'l opt cb disabled' : 'l opt cb'}>
      <label>
        <input
          type="checkbox"
          checked={checked}
          disabled={disabled}
          aria-checked={checked}
          onChange={(e) => {
            if (!disabled) onChange(e.currentTarget.checked);
          }}
        />
        <span className="box" aria-hidden="true" />
        <span className="txt">{label}</span>
      </label>
      {right != null && right !== false && <span className="l-right">{right}</span>}
    </div>
  );
}

export interface RadioProps {
  checked: boolean;
  /** Called with true when this option is chosen. */
  onChange: (checked: boolean) => void;
  label: ReactNode;
  /** Group name: radios sharing it are one arrow-key group. */
  name: string;
}

/** ( ) / (X), a real radio underneath. Its own line, or inline when placed inside a Line. */
export function Radio({ checked, onChange, label, name }: RadioProps) {
  return (
    <div className="l opt">
      <label>
        <input
          type="radio"
          name={name}
          checked={checked}
          aria-checked={checked}
          onChange={(e) => onChange(e.currentTarget.checked)}
        />
        <span className="box" aria-hidden="true" />
        <span className="txt">{label}</span>
      </label>
    </div>
  );
}

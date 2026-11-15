import type { ReactNode } from 'react';

export interface BannerProps {
  /** warn = yellow highlighter, amber and green = section bands. Text colour comes with the band. */
  tone: 'warn' | 'amber' | 'green';
  children?: ReactNode;
}

/** A band behind words (inline). Never a text colour, never a large fill. */
export function Banner({ tone, children }: BannerProps) {
  return <span className={`banner ${tone}`}>{children}</span>;
}

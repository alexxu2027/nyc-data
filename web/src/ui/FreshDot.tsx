import type { SourceState } from '../types';

export type FreshState = SourceState | 'loading' | 'off' | 'unknown';

export interface FreshDotProps {
  state: FreshState;
  /** Tooltip and accessible name; defaults to the state's label. */
  title?: string;
}

/** Plain-language names, also used by legends ("● OK  ◐ STALE …"). */
export const FRESH_LABELS: Record<FreshState, string> = {
  ok: 'Fresh',
  stale: 'Stale',
  degraded: 'Failing',
  never: 'No data yet',
  loading: 'Loading',
  off: 'Off',
  unknown: 'Unknown',
};

export const FRESH_ORDER: FreshState[] = ['ok', 'stale', 'degraded', 'never', 'loading', 'unknown', 'off'];

/**
 * Source freshness coded by shape, never by colour: ● ok, ◐ stale, ✕ failing, dashed ○ never,
 * a stepping arc while loading, a bar for unknown, a faint dot when off.
 */
export function FreshDot({ state, title }: FreshDotProps) {
  const label = title ?? FRESH_LABELS[state];
  return (
    <svg
      className={state === 'off' ? 'fresh off' : 'fresh'}
      viewBox="0 0 12 12"
      role="img"
      aria-label={label}
      data-state={state}
    >
      <title>{label}</title>
      {shape(state)}
    </svg>
  );
}

function shape(state: FreshState) {
  switch (state) {
    case 'ok':
      return <circle cx={6} cy={6} r={4.75} fill="currentColor" />;
    case 'stale':
      return (
        <>
          <circle cx={6} cy={6} r={4.25} fill="none" stroke="currentColor" strokeWidth={1.5} />
          <path d="M6 1.75A4.25 4.25 0 0 0 6 10.25Z" fill="currentColor" />
        </>
      );
    case 'degraded':
      return (
        <path d="M2 2L10 10M10 2L2 10" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="square" />
      );
    case 'never':
      return <circle cx={6} cy={6} r={4.25} fill="none" stroke="currentColor" strokeWidth={1.25} strokeDasharray="1.6 1.4" />;
    case 'loading':
      return (
        <>
          <circle cx={6} cy={6} r={4.25} fill="none" stroke="currentColor" strokeOpacity={0.35} strokeWidth={1.5} />
          <path className="fd-spin" d="M6 1.75A4.25 4.25 0 0 1 10.25 6" fill="none" stroke="currentColor" strokeWidth={2} />
        </>
      );
    case 'unknown':
      return <path d="M2 6H10" fill="none" stroke="currentColor" strokeWidth={1.75} />;
    case 'off':
    default:
      return <circle cx={6} cy={6} r={2} fill="currentColor" />;
  }
}

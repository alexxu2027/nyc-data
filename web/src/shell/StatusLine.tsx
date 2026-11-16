// Bottom status line: LIVE pill, ET clock, visible layer and feature totals, next refresh.
// This is the Phase 3 time-bar slot: replay will swap the pill and clock for a scrubber here.
// The newest change rides at the end (desktop) or on a second line (compact, phone sheet).
import { useApp } from '../core';
import { FeedTicker } from '../feed';
import { FreshDot, Num } from '../ui';
import { fmtClock, fmtCountdown, worstState } from './helpers';
import { useNow, useVisibleTotals } from './hooks';

export function StatusLine({ compact = false }: { compact?: boolean }) {
  const now = useNow();
  const { layers, features, nextAt } = useVisibleTotals();
  const health = useApp((s) => s.health);
  const healthError = useApp((s) => s.healthError);
  const catalog = useApp((s) => s.catalog);
  const stalled = health?.collector.state === 'stalled';
  const total = health ? health.sources.length : null;
  const ok = health ? health.summary.ok : null;
  const ticker = useApp((s) => s.feed.items.length > 0 || s.feed.fetchedAt !== null || s.feed.status === 'error');

  return (
    <div className="sh-status screen" data-slot="timebar" role="status" aria-live="off">
      <div className="l">
        <span className="l-main sh-status-main">
          <span className={stalled ? 'sh-pill stalled' : 'sh-pill'} title={stalled ? 'The collector has not run for 3 minutes' : 'Live data'}>
            <i aria-hidden="true" className="sh-blink" />
            {stalled ? 'STALLED' : 'LIVE'}
          </span>
          <span className="sh-clock" aria-label="New York time">
            {fmtClock(now)}
          </span>
          <span className="sh-sep" aria-hidden="true">
            |
          </span>
          <span>
            <Num value={catalog ? layers : null} width={2} /> LAYERS{' '}
            <Num value={catalog ? features : null} width={6} /> <span className="full">FEATURES</span>
            <span className="short">FEAT.</span>
          </span>
          {!compact && (
            <>
              <span className="sh-sep" aria-hidden="true">
                |
              </span>
              <span>
                NEXT UPDATE <span className="num sh-cd">{fmtCountdown(nextAt === null ? null : nextAt - now)}</span>
              </span>
              {ticker && (
                <>
                  <span className="sh-sep" aria-hidden="true">
                    |
                  </span>
                  <FeedTicker />
                </>
              )}
            </>
          )}
        </span>
        {!compact && (
          <span className="l-right hide-mid">
            <FreshDot state={healthError && !health ? 'degraded' : worstState(health)} />{' '}
            {health ? (
              <>
                <Num value={ok} width={2} /> OF {total} FEEDS OK
              </>
            ) : healthError ? (
              'HEALTH UNAVAILABLE'
            ) : (
              'CHECKING FEEDS'
            )}
          </span>
        )}
      </div>
      {compact && ticker && (
        <div className="l nowrap sh-status-tick">
          <span className="l-main">
            <FeedTicker />
          </span>
        </div>
      )}
    </div>
  );
}

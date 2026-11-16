// Feed health from /api/health (polled every 30 s by core), with a symbol legend.
import { useState } from 'react';
import { fmtAgo, fmtTime, useApp } from '../core';
import type { SourceHealth } from '../types';
import { Banner, Blank, FRESH_LABELS, FreshDot, Line, Readout, Rule } from '../ui';
import { fmtDuration, sortSources } from './helpers';
import { useNow } from './hooks';

export function HealthBody() {
  const health = useApp((s) => s.health);
  const healthError = useApp((s) => s.healthError);
  const catalog = useApp((s) => s.catalog);
  const now = useNow();
  const [open, setOpen] = useState<string | null>(null);

  if (!health) {
    return healthError ? (
      <>
        <Line>
          <Banner tone="warn">HEALTH UNAVAILABLE</Banner>
        </Line>
        <Line muted>{healthError}</Line>
      </>
    ) : (
      <Line right={<FreshDot state="loading" />}>CHECKING EVERY FEED</Line>
    );
  }

  const s = health.summary;
  const layerLabel = (id: string) => catalog?.layers.find((l) => l.id === id)?.short ?? id;
  return (
    <>
      <Readout
        k="DATA COLLECTOR"
        v={`${health.collector.state.toUpperCase()}${
          health.collector.last_attempt ? `, LAST RUN ${fmtAgo(health.collector.last_attempt, now).toUpperCase()}` : ''
        }`}
      />
      <Readout k="FEEDS" v={`${s.ok} OK, ${s.stale} STALE, ${s.degraded} FAILING, ${s.never} NO DATA`} />
      <Readout k="CHECKED" v={fmtTime(health.now).toUpperCase()} />
      {healthError && (
        <Line>
          <Banner tone="warn">LAST CHECK FAILED, SHOWING THE ONE BEFORE</Banner>
        </Line>
      )}
      <Blank />
      <div className="l sh-src sh-src-head" aria-hidden="true">
        <span className="sh-src-name muted">FEED ({health.sources.length}): LAYER · DATASET</span>
        <span className="sh-src-age muted">AGE</span>
        <span className="sh-src-runs muted">24 H</span>
      </div>
      {sortSources(health.sources).map((src) => (
        <SourceRow
          key={src.id}
          src={src}
          open={open === src.id}
          onToggle={() => setOpen(open === src.id ? null : src.id)}
          layerLabel={layerLabel}
          now={now}
        />
      ))}
      <Blank />
      <Rule />
      <Blank />
      <Line muted>SYMBOLS</Line>
      <Line>
        <FreshDot state="ok" /> {FRESH_LABELS.ok.toUpperCase()}: LAST GOOD RUN WITHIN 3 × ITS CADENCE
      </Line>
      <Line>
        <FreshDot state="stale" /> {FRESH_LABELS.stale.toUpperCase()}: OLDER THAN THAT (OR THAN THE FEED'S USUAL LAG)
      </Line>
      <Line>
        <FreshDot state="degraded" /> {FRESH_LABELS.degraded.toUpperCase()}: 3 OR MORE FAILURES IN A ROW
      </Line>
      <Line>
        <FreshDot state="never" /> {FRESH_LABELS.never.toUpperCase()}: NEVER SUCCEEDED
      </Line>
      <Line muted>AGE: TIME SINCE THE LAST SUCCESSFUL RUN. 24 H: GOOD RUNS / ALL RUNS.</Line>
    </>
  );
}

function SourceRow({
  src,
  open,
  onToggle,
  layerLabel,
  now,
}: {
  src: SourceHealth;
  open: boolean;
  onToggle: () => void;
  layerLabel: (id: string) => string;
  now: number;
}) {
  const age = src.last_success ? (now - Date.parse(src.last_success)) / 1000 : src.age_s;
  // Lead with the layer names the user sees in the panel, not the dataset title (UX review B12).
  const shown = src.layers.length ? src.layers.map(layerLabel).join(', ').toUpperCase() : null;
  const dataset = src.name.replace(/\s*\(.*$/, '').toUpperCase();
  return (
    <>
      <button
        type="button"
        className="l sh-src"
        aria-expanded={open}
        aria-label={`${src.name}: ${FRESH_LABELS[src.state]}`}
        onClick={onToggle}
        data-state={src.state}
      >
        <span className="sh-src-name" title={src.name}>
          <FreshDot state={src.state} /> {shown ?? dataset}
          {shown && <span className="muted"> · {dataset}</span>}
        </span>
        <span className="sh-src-age num">{fmtDuration(age)}</span>
        <span className="sh-src-runs num">
          {src.ok_24h}/{src.runs_24h}
        </span>
      </button>
      {open && (
        <div className="sh-ind">
          <Readout k="DATASET" v={src.name} />
          <Readout k="ID" v={src.id} />
          <Readout k="CADENCE" v={`EVERY ${fmtDuration(src.cadence_s)}`} />
          <Readout k="LAST OK" v={src.last_success ? fmtTime(src.last_success, 'datetime').toUpperCase() : 'NEVER'} />
          <Readout k="LAST TRY" v={src.last_attempt ? fmtAgo(src.last_attempt, now).toUpperCase() : '--'} />
          <Readout k="DATA LAG" v={src.lag_s == null ? '--' : `${fmtDuration(src.lag_s)} BEHIND THE CLOCK`} />
          <Readout k="ROWS" v={src.rows_last_run == null ? '--' : `${src.rows_last_run.toLocaleString('en-US')} LAST RUN`} />
          <Readout k="FAILURES" v={`${src.consecutive_failures} IN A ROW`} />
          {src.last_error && (
            <Line>
              <Banner tone="warn">LAST ERROR</Banner> {src.last_error}
            </Line>
          )}
        </div>
      )}
    </>
  );
}

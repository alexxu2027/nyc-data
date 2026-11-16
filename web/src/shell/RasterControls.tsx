// Raster layer controls (Phase 2.5 U3): printed under a raster layer's row while it is on.
// A stepped opacity bar (0-100 % in 10 % steps), the frame time and age, and a highlighter
// banner when the frame is stale or the frame index is unavailable.
import type { KeyboardEvent } from 'react';
import { fmtAgo, fmtTime, useApp } from '../core';
import { opacityFor } from '../map/layers/radar';
import type { LayerData, LayerDef } from '../types';
import { Banner, Line, Readout, TextButton } from '../ui';
import { useNow } from './hooks';
import './RasterControls.css';

export const OPACITY_STEP = 0.1;
const CELLS = 10;

/** One 10 % step up or down, snapped to the step grid and clamped to 0..1. */
export function stepOpacity(v: number, dir: -1 | 1): number {
  const next = dir > 0 ? Math.floor(v * 10 + 1e-6) + 1 : Math.ceil(v * 10 - 1e-6) - 1;
  return Math.min(10, Math.max(0, next)) / 10;
}

export type RasterStatus = 'off' | 'loading' | 'ok' | 'stale' | 'empty' | 'error';

/** What the controls (and the row dot) say about a raster layer right now. */
export function rasterStatus(d: LayerData | undefined, def: LayerDef, visible: boolean, now: number): RasterStatus {
  if (!visible) return 'off';
  if (!d || d.rev === 0) return d?.status === 'error' ? 'error' : 'loading';
  const asOf = d.meta?.data_as_of ? Date.parse(d.meta.data_as_of) : NaN;
  if (d.status === 'error') return 'error';
  if (!Number.isFinite(asOf)) return 'empty';
  const staleS = def.raster?.stale_s ?? 1800;
  return now - asOf > staleS * 1000 || d.meta?.note === 'STALE' ? 'stale' : 'ok';
}

export function RasterControls({ def }: { def: LayerDef }) {
  const d = useApp((s) => s.data[def.id]);
  const overrides = useApp((s) => s.opacity);
  const setOpacity = useApp((s) => s.setOpacity);
  const now = useNow();
  const op = opacityFor(def, overrides);
  const pct = Math.round(op * 100);
  const status = rasterStatus(d, def, true, now);
  const asOf = d?.meta?.data_as_of ?? null;
  const name = def.short.toLowerCase();

  const set = (v: number) => setOpacity(def.id, Math.min(1, Math.max(0, v)));
  const onKey = (e: KeyboardEvent<HTMLSpanElement>) => {
    const k = e.key;
    let v: number | null = null;
    if (k === 'ArrowRight' || k === 'ArrowUp' || k === 'PageUp') v = stepOpacity(op, 1);
    else if (k === 'ArrowLeft' || k === 'ArrowDown' || k === 'PageDown') v = stepOpacity(op, -1);
    else if (k === 'Home') v = 0;
    else if (k === 'End') v = 1;
    if (v === null) return;
    e.preventDefault();
    set(v);
  };
  const filled = Math.round(op * CELLS);

  return (
    <div className="sh-ind rc" data-status={status}>
      <div className="l ro rc-op">
        <span className="ro-k">OPACITY</span>
        <TextButton onClick={() => set(stepOpacity(op, -1))} disabled={pct <= 0} ariaLabel={`Less ${name} opacity`}>
          -
        </TextButton>
        <span
          className="rc-bar"
          role="slider"
          tabIndex={0}
          aria-label={`${def.label} opacity`}
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={pct}
          aria-valuetext={`${pct}%`}
          onKeyDown={onKey}
        >
          {Array.from({ length: CELLS }, (_, i) => (
            <span
              key={i}
              className={i < filled ? 'rc-cell on' : 'rc-cell'}
              aria-hidden="true"
              // Click a cell: that many tenths; click the top filled cell again to clear it.
              onClick={() => set(i + 1 === filled ? i / CELLS : (i + 1) / CELLS)}
            />
          ))}
        </span>
        <span className="rc-pct num">{`${pct}%`.padStart(4, ' ')}</span>
        <TextButton onClick={() => set(stepOpacity(op, 1))} disabled={pct >= 100} ariaLabel={`More ${name} opacity`}>
          +
        </TextButton>
      </div>
      <Readout
        k="FRAME"
        v={asOf ? `${fmtTime(asOf, 'time').toUpperCase()} · ${fmtAgo(asOf, now).toUpperCase()}` : '--'}
      />
      <StatusLine status={status} def={def} d={d} now={now} />
    </div>
  );
}

function StatusLine({ status, def, d, now }: { status: RasterStatus; def: LayerDef; d: LayerData | undefined; now: number }) {
  if (status === 'loading') {
    return (
      <Line muted>
        <span className="sh-dots">LOADING RADAR FRAMES</span>
      </Line>
    );
  }
  if (status === 'error') {
    const retry = d?.nextAt ? `, RETRYING ${fmtAgo(d.nextAt, now).toUpperCase()}` : '';
    const what = d?.meta?.data_as_of ? `RADAR UNAVAILABLE, SHOWING THE LAST FRAME${retry}` : `RADAR UNAVAILABLE${retry}`;
    return (
      <Line>
        <Banner tone="warn">{what}</Banner>
      </Line>
    );
  }
  if (status === 'stale') {
    const age = d?.meta?.data_as_of ? fmtAgo(d.meta.data_as_of, now).replace(/ ago$/, '').toUpperCase() : '';
    return (
      <Line>
        <Banner tone="warn">{`STALE: NEWEST FRAME IS ${age} OLD`}</Banner>
      </Line>
    );
  }
  if (status === 'empty') return <Line muted>{(def.empty_text ?? 'NO RECENT RADAR FRAME').toUpperCase()}</Line>;
  return null;
}

// A hand-drawn SVG time chart on the line grid: its height is a whole number of lines (so the
// gutter keeps counting), strokes read --ink / --muted / --faint, and nothing here hard-codes a
// colour. No chart library.
import { useLayoutEffect, useRef, useState, type PointerEvent } from 'react';
import { useHoverless } from '../../ui/hooks';
import { fmtTime } from '../../core';
import { niceExtent, seriesPath, xScale, yScale, type Point, type Tick } from './path';

export interface ChartSeries {
  key: string;
  label: string;
  /** A shorter label for the hover readout when the full one does not fit (OBSERVED -> OBS). */
  short?: string;
  points: Point[];
  /** solid = primary, dash = reference (prediction, docks), dot = subset (e-bikes). */
  style?: 'solid' | 'dash' | 'dot';
  step?: boolean;
  /** Break the line across gaps longer than this many seconds. */
  gap?: number;
}

export interface SeriesChartProps {
  series: ChartSeries[];
  /** x range in epoch seconds. */
  from: number;
  to: number;
  /** Draws a NOW marker when it falls inside the range (not on its right edge). */
  now?: number | null;
  /** Height in lines (default 5). */
  lines?: number;
  zero?: boolean;
  minSpan?: number;
  ticks?: Tick[];
  fmtY?: (v: number) => string;
  /** Accessible description of the whole figure. */
  label: string;
  /** Hover readout: the x label (default: ET time) and each series' value. */
  fmtX?: (t: number) => string;
  fmtV?: (key: string, v: number) => string;
}

/** The value in effect at x: the last point at or before it (null before the first). */
function valueAtX(points: Point[], x: number): number | null {
  let lo = 0;
  let hi = points.length - 1;
  let v: number | null = null;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (points[mid][0] <= x) {
      v = points[mid][1];
      lo = mid + 1;
    } else hi = mid - 1;
  }
  return v;
}

const GLYPH: Record<string, string> = { solid: '──', dash: '╌╌', dot: '··' };

/** Width of one axis-label character (.sc-axis is 11 px mono). */
const AXIS_CH_PX = 6.6;
const FALLBACK_W = 360;
const FALLBACK_LINE = 27;
const PAD_T = 7;
const PAD_B = 4;

const defaultFmt = (v: number) => (Math.abs(v) >= 100 ? v.toFixed(0) : String(Number(v.toFixed(2))));

export function SeriesChart({
  series,
  from,
  to,
  now,
  lines = 5,
  zero,
  minSpan,
  ticks,
  fmtY = defaultFmt,
  label,
  fmtX = (t) => fmtTime(t, 'time'),
  fmtV = (_k, v) => defaultFmt(v),
}: SeriesChartProps) {
  const ref = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState({ w: 0, h: 0 });
  const [hx, setHx] = useState<number | null>(null);
  const onMove = (e: PointerEvent<HTMLDivElement>) => {
    const r = e.currentTarget.getBoundingClientRect();
    setHx(Math.min(Math.max(0, e.clientX - r.left), r.width));
  };

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el || typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(([entry]) => {
      const r = entry.contentRect;
      setSize((s) => (s.w === r.width && s.h === r.height ? s : { w: r.width, h: r.height }));
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const w = Math.max(40, size.w || FALLBACK_W);
  const h = Math.max(20, size.h || lines * FALLBACK_LINE);
  const ph = h - PAD_T - PAD_B;
  const values = series.flatMap((s) => s.points.map((p) => p[1]));
  const [y0, y1] = niceExtent(values, { zero, minSpan });
  const d = { x0: from, x1: to, y0, y1 };
  const sx = xScale(d, w);
  const sy = yScale(d, ph);
  const showNow = now != null && now > from && now < to - 60;
  const empty = values.length === 0;
  const ht = hx != null && !empty && to > from ? from + (hx / w) * (to - from) : null;
  const hv = ht == null ? [] : series.map((s) => ({ s, v: valueAtX(s.points, ht) }));

  return (
    <>
      <div className="l sc-row">
        <div
          ref={ref}
          className="sc"
          style={{ height: `calc(var(--line) * ${lines})` }}
          role="img"
          aria-label={label}
          data-points={values.length}
          onPointerMove={onMove}
          onPointerDown={onMove}
          onPointerLeave={() => setHx(null)}
        >
          <svg width={w} height={h} viewBox={`0 0 ${w} ${h}`} aria-hidden="true">
            <g transform={`translate(0 ${PAD_T})`}>
              <line className="sc-grid" x1={0} x2={w} y1={0.5} y2={0.5} />
              <line className="sc-grid" x1={0} x2={w} y1={Math.round(ph / 2) + 0.5} y2={Math.round(ph / 2) + 0.5} />
              {ticks?.map((t) => {
                const x = Math.round(sx(t.at)) + 0.5;
                return <line key={t.at} className="sc-tick" x1={x} x2={x} y1={ph - 4} y2={ph} />;
              })}
              {showNow && (
                <line className="sc-now" x1={Math.round(sx(now)) + 0.5} x2={Math.round(sx(now)) + 0.5} y1={0} y2={ph} />
              )}
              {series.map((s) => (
                <path
                  key={s.key}
                  className={`sc-line ${s.style ?? 'solid'}`}
                  d={seriesPath(s.points, d, w, ph, { step: s.step, gap: s.gap })}
                  data-series={s.key}
                />
              ))}
              {series
                .filter((s) => (s.style ?? 'solid') === 'solid' && s.points.length > 0)
                .map((s) => {
                  const [x, y] = s.points[s.points.length - 1];
                  return <circle key={s.key} className="sc-end" cx={sx(x)} cy={sy(y)} r={2.5} />;
                })}
              <line className="sc-base" x1={0} x2={w} y1={ph + 0.5} y2={ph + 0.5} />
              {ht != null && hx != null && (
                <>
                  <line className="sc-hover" x1={Math.round(hx) + 0.5} x2={Math.round(hx) + 0.5} y1={0} y2={ph} />
                  {hv.map(({ s, v }) =>
                    v == null ? null : <circle key={s.key} className="sc-hdot" cx={hx} cy={sy(v)} r={3} />,
                  )}
                </>
              )}
              {!empty && (
                <>
                  <text className="sc-y" x={2} y={10}>
                    {fmtY(y1)}
                  </text>
                  <text className="sc-y" x={2} y={ph - 3}>
                    {fmtY(y0)}
                  </text>
                </>
              )}
              {empty && (
                <text className="sc-y" x={w / 2} y={ph / 2 + 3} textAnchor="middle">
                  NO READINGS IN RANGE
                </text>
              )}
            </g>
          </svg>
        </div>
      </div>
      {ticks && ticks.length > 0 && (
        <div className="l sc-axis" aria-hidden="true">
          {ticks.map((t, i) => {
            const pct = to === from ? 0 : ((t.at - from) / (to - from)) * 100;
            // A centred label that would cross either edge is pinned to it instead (2026-11-18:
            // "60 MIN" near the right edge was cut by a few px). 11 px mono is ~6.6 px a char.
            const half = (t.label.length * AXIS_CH_PX) / 2;
            const left = (pct / 100) * w;
            const edge = left - half < 0 || (i === 0 && pct < 8) ? 'start' : left + half > w ? 'end' : 'mid';
            return (
              <span key={t.at} className={`sc-t ${edge}`} style={{ left: `${pct}%` }}>
                {t.label}
              </span>
            );
          })}
        </div>
      )}
      {!empty && <HoverReadout ht={ht} hv={hv} fmtX={fmtX} fmtV={fmtV} width={w} />}
    </>
  );
}

/**
 * How compact the hover readout is. It stays ONE line (it is a single reading: wrapping it would
 * push the page, and cutting it hid the last value, e.g. the tide's PREDICTED). When the full
 * line does not fit, it steps down until it does:
 *   0  1:45 AM ET   ── OBSERVED 3.81 FT   ╌╌ PREDICTED 3.72 FT
 *   1  1:45 AM  ── OBSERVED 3.81 FT  ╌╌ PREDICTED 3.72 FT      (no zone, tighter gaps)
 *   2  1:45 AM  ── OBS 3.81 FT  ╌╌ PRED 3.72 FT                (short labels)
 *   3  1:45 AM  OBS 3.81 FT  PRED 3.72 FT                      (no line glyphs)
 *   4  1:45 AM  ── 3.81 FT  ╌╌ 3.72 FT                         (glyphs only: the ledger below
 *                                                               says which line is which)
 *   5  ── 3.81 ╌╌ 3.72                                         (values only)
 */
export const READOUT_LEVELS = 6;

export function readoutParts(
  level: number,
  time: string,
  items: Array<{ glyph: string; label: string; short?: string; value: string }>,
): { time: string | null; items: string[] } {
  const t = level >= 5 ? null : level >= 1 ? time.replace(/ ET$/, '') : time;
  return {
    time: t,
    items: items.map(({ glyph, label, short, value }) => {
      const name = level >= 2 ? (short ?? label) : label;
      const v = level >= 5 ? value.replace(/ [^\d\s]+$/, '') : value;
      if (level >= 4) return `${glyph} ${v}`;
      if (level === 3) return `${name} ${v}`;
      return `${glyph} ${name} ${v}`;
    }),
  };
}

function HoverReadout({
  ht,
  hv,
  fmtX,
  fmtV,
  width,
}: {
  ht: number | null;
  hv: Array<{ s: ChartSeries; v: number | null }>;
  fmtX: (t: number) => string;
  fmtV: (key: string, v: number) => string;
  width: number;
}) {
  const ref = useRef<HTMLSpanElement>(null);
  const hoverless = useHoverless();
  // The level only steps down while a reading shows (so the line doesn't jump as the numbers
  // change width); it starts over for a new hover or a new chart width.
  const [fit, setFit] = useState({ level: 0, width, hovering: false });
  const hovering = ht != null;
  if (fit.width !== width || fit.hovering !== hovering) setFit({ level: 0, width, hovering });
  const level = fit.width === width && fit.hovering === hovering ? fit.level : 0;

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el || level >= READOUT_LEVELS - 1) return;
    if (el.scrollWidth > el.clientWidth + 1) setFit((f) => ({ ...f, level: f.level + 1 }));
  }, [level, ht, width]); // bounded: at most READOUT_LEVELS - 1 steps

  if (ht == null) {
    return (
      <div className="l" aria-live="off">
        <span className="sc-read muted">{hoverless ? 'TOUCH THE CHART FOR VALUES' : 'HOVER THE CHART FOR VALUES'}</span>
      </div>
    );
  }
  const parts = readoutParts(
    level,
    fmtX(ht),
    hv.map(({ s, v }) => ({
      glyph: GLYPH[s.style ?? 'solid'],
      label: s.label,
      short: s.short,
      value: v == null ? '--' : fmtV(s.key, v),
    })),
  );
  const gap = level >= 1 ? 'tight' : '';
  return (
    <div className="l" aria-live="off">
      <span ref={ref} className={`sc-read ${gap}`} data-level={level}>
        {parts.time && <span className="sc-rx">{parts.time}</span>}
        {parts.items.map((t, i) => (
          <span key={hv[i].s.key} className="sc-rv">
            {t}
          </span>
        ))}
      </span>
    </div>
  );
}

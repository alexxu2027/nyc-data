// A hand-drawn SVG time chart on the line grid: its height is a whole number of lines (so the
// gutter keeps counting), strokes read --ink / --muted / --faint, and nothing here hard-codes a
// colour. No chart library.
import { useLayoutEffect, useRef, useState, type PointerEvent } from "react";
import { fmtTime } from "../../core";
import {
  niceExtent,
  seriesPath,
  xScale,
  yScale,
  type Point,
  type Tick,
} from "./path";

export interface ChartSeries {
  key: string;
  label: string;
  points: Point[];
  /** solid = primary, dash = reference (prediction, docks), dot = subset (e-bikes). */
  style?: "solid" | "dash" | "dot";
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

const GLYPH: Record<string, string> = { solid: "━", dash: "┅", dot: "┈" };

const FALLBACK_W = 360;
const FALLBACK_LINE = 27;
const PAD_T = 7;
const PAD_B = 4;

const defaultFmt = (v: number) =>
  Math.abs(v) >= 100 ? v.toFixed(0) : String(Number(v.toFixed(2)));

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
  fmtX = (t) => fmtTime(t, "time"),
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
    if (!el || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(([entry]) => {
      const r = entry.contentRect;
      setSize((s) =>
        s.w === r.width && s.h === r.height ? s : { w: r.width, h: r.height },
      );
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
  const ht =
    hx != null && !empty && to > from ? from + (hx / w) * (to - from) : null;
  const hv =
    ht == null ? [] : series.map((s) => ({ s, v: valueAtX(s.points, ht) }));

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
          onPointerLeave={() => setHx(null)}
        >
          <svg
            width={w}
            height={h}
            viewBox={`0 0 ${w} ${h}`}
            aria-hidden="true"
          >
            <g transform={`translate(0 ${PAD_T})`}>
              <line className="sc-grid" x1={0} x2={w} y1={0.5} y2={0.5} />
              <line
                className="sc-grid"
                x1={0}
                x2={w}
                y1={Math.round(ph / 2) + 0.5}
                y2={Math.round(ph / 2) + 0.5}
              />
              {ticks?.map((t) => {
                const x = Math.round(sx(t.at)) + 0.5;
                return (
                  <line
                    key={t.at}
                    className="sc-tick"
                    x1={x}
                    x2={x}
                    y1={ph - 4}
                    y2={ph}
                  />
                );
              })}
              {showNow && (
                <line
                  className="sc-now"
                  x1={Math.round(sx(now)) + 0.5}
                  x2={Math.round(sx(now)) + 0.5}
                  y1={0}
                  y2={ph}
                />
              )}
              {series.map((s) => (
                <path
                  key={s.key}
                  className={`sc-line ${s.style ?? "solid"}`}
                  d={seriesPath(s.points, d, w, ph, {
                    step: s.step,
                    gap: s.gap,
                  })}
                  data-series={s.key}
                />
              ))}
              {series
                .filter(
                  (s) =>
                    (s.style ?? "solid") === "solid" && s.points.length > 0,
                )
                .map((s) => {
                  const [x, y] = s.points[s.points.length - 1];
                  return (
                    <circle
                      key={s.key}
                      className="sc-end"
                      cx={sx(x)}
                      cy={sy(y)}
                      r={2.5}
                    />
                  );
                })}
              <line
                className="sc-base"
                x1={0}
                x2={w}
                y1={ph + 0.5}
                y2={ph + 0.5}
              />
              {ht != null && hx != null && (
                <>
                  <line
                    className="sc-hover"
                    x1={Math.round(hx) + 0.5}
                    x2={Math.round(hx) + 0.5}
                    y1={0}
                    y2={ph}
                  />
                  {hv.map(({ s, v }) =>
                    v == null ? null : (
                      <circle
                        key={s.key}
                        className="sc-hdot"
                        cx={hx}
                        cy={sy(v)}
                        r={3}
                      />
                    ),
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
                <text
                  className="sc-y"
                  x={w / 2}
                  y={ph / 2 + 3}
                  textAnchor="middle"
                >
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
            const edge =
              pct <= 2
                ? "start"
                : pct >= 98
                  ? "end"
                  : i === 0 && pct < 8
                    ? "start"
                    : "mid";
            return (
              <span
                key={t.at}
                className={`sc-t ${edge}`}
                style={{ left: `${pct}%` }}
              >
                {t.label}
              </span>
            );
          })}
        </div>
      )}
      {!empty && (
        <div className="l" aria-live="off">
          <span className="sc-read">
            {ht == null ? (
              <span className="muted">HOVER THE CHART FOR VALUES</span>
            ) : (
              <>
                <span className="sc-rx">{fmtX(ht)}</span>
                {hv.map(({ s, v }) => (
                  <span key={s.key} className="sc-rv">
                    {GLYPH[s.style ?? "solid"]} {s.label}{" "}
                    {v == null ? "--" : fmtV(s.key, v)}
                  </span>
                ))}
              </>
            )}
          </span>
        </div>
      )}
    </>
  );
}

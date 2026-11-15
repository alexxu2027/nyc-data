export interface SparkProps {
  /** [x, y] pairs, x ascending (epoch seconds work). */
  points: Array<[number, number]>;
  /** Draw as a step chart (hold each value until the next point). */
  step?: boolean;
  /** Width in ch (default 12). */
  width?: number;
  /** Accessible name; defaults to a short summary. */
  label?: string;
}

export const SPARK_W = 100;
export const SPARK_H = 13;
const PAD = 1.5;

const f = (n: number) => (Math.round(n * 100) / 100).toString();

/** Scaled points in a `w × h` box (y up = larger value). One point sits mid-height. */
function scaled(points: Array<[number, number]>, w: number, h: number): Array<[number, number]> {
  const pts = points.filter(([x, y]) => Number.isFinite(x) && Number.isFinite(y));
  if (pts.length === 0) return [];
  if (pts.length === 1) return [[w, h / 2]];
  const x0 = pts[0][0];
  const x1 = pts[pts.length - 1][0];
  let lo = Infinity;
  let hi = -Infinity;
  for (const [, y] of pts) {
    if (y < lo) lo = y;
    if (y > hi) hi = y;
  }
  return pts.map(([x, y]) => [
    x1 === x0 ? 0 : ((x - x0) / (x1 - x0)) * w,
    hi === lo ? h / 2 : h - PAD - ((y - lo) / (hi - lo)) * (h - 2 * PAD),
  ]);
}

/**
 * Path data for a sparkline in a `w × h` box. One point gives a flat line through the middle;
 * none gives "".
 */
export function sparkPath(points: Array<[number, number]>, step = false, w = SPARK_W, h = SPARK_H): string {
  const pts = scaled(points, w, h);
  if (pts.length === 0) return '';
  if (pts.length === 1) return `M0 ${f(h / 2)}H${f(w)}`;
  let d = `M${f(pts[0][0])} ${f(pts[0][1])}`;
  for (let i = 1; i < pts.length; i++) {
    const [x, y] = pts[i];
    d += step ? `H${f(x)}V${f(y)}` : `L${f(x)} ${f(y)}`;
  }
  return d;
}

/** An inline 13 px sparkline in ink. Fits inside one line of text. */
export function Spark({ points, step = false, width = 12, label }: SparkProps) {
  const n = points.length;
  const name = label ?? (n === 0 ? 'No data' : `${n} point${n === 1 ? '' : 's'}`);
  const d = sparkPath(points, step);
  const sc = scaled(points, SPARK_W, SPARK_H);
  const end = sc.length ? sc[sc.length - 1] : null;
  return (
    <svg
      className="spark"
      viewBox={`0 0 ${SPARK_W} ${SPARK_H}`}
      preserveAspectRatio="none"
      style={{ width: `${width}ch` }}
      role="img"
      aria-label={name}
      data-points={n}
    >
      {d === '' ? (
        <path className="sp-empty" d={`M0 ${SPARK_H / 2}H${SPARK_W}`} />
      ) : (
        <>
          <path className="sp-line" d={d} />
          {end && <path className="sp-dot" d={`M${f(end[0])} ${f(end[1])}h0`} />}
        </>
      )}
    </svg>
  );
}

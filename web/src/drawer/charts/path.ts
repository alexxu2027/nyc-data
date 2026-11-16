// Series → SVG path helpers for SeriesChart. Pure, so they are unit tested without a DOM.

export type Point = [number, number]; // [epoch seconds, value]

export interface Domain {
  x0: number;
  x1: number;
  y0: number;
  y1: number;
}

export interface PathOptions {
  /** Hold each value until the next point (counts). */
  step?: boolean;
  /** Break the line where two points are further apart than this (x units). */
  gap?: number;
}

const r1 = (n: number) => (Math.round(n * 10) / 10).toString();

export function xScale(d: Domain, w: number): (x: number) => number {
  const span = d.x1 - d.x0;
  return (x) => (span === 0 ? 0 : ((x - d.x0) / span) * w);
}

/** y grows upward: the domain's y0 sits at the bottom (h), y1 at the top (0). */
export function yScale(d: Domain, h: number): (y: number) => number {
  const span = d.y1 - d.y0;
  return (y) => (span === 0 ? h / 2 : h - ((y - d.y0) / span) * h);
}

/** Path data for one series in a `w × h` plot. Non-finite points are skipped (they break the line). */
export function seriesPath(points: Point[], d: Domain, w: number, h: number, o: PathOptions = {}): string {
  const sx = xScale(d, w);
  const sy = yScale(d, h);
  let out = '';
  let prev: Point | null = null;
  let prevY = 0;
  let lone = false; // the current segment is a single point so far
  // A lone point would draw nothing: give it a short tick.
  const endSegment = () => {
    if (lone) out += 'h0.1';
    lone = false;
  };
  for (const p of points) {
    const [x, y] = p;
    if (!Number.isFinite(x) || !Number.isFinite(y)) {
      endSegment();
      prev = null;
      continue;
    }
    const px = sx(x);
    const py = sy(y);
    const broken = prev === null || (o.gap != null && x - prev[0] > o.gap);
    if (broken) {
      endSegment();
      out += `${out ? ' ' : ''}M${r1(px)} ${r1(py)}`;
      lone = true;
    } else {
      out += o.step ? `H${r1(px)}${py === prevY ? '' : `V${r1(py)}`}` : `L${r1(px)} ${r1(py)}`;
      lone = false;
    }
    prev = p;
    prevY = py;
  }
  endSegment();
  return out;
}

/** Extends a step series so its last value holds until `x` (the right edge or now). */
export function holdTo(points: Point[], x: number): Point[] {
  if (points.length === 0) return points;
  const last = points[points.length - 1];
  return last[0] >= x ? points : [...points, [x, last[1]]];
}

/** Keeps points inside [x0, x1] (the API already clamps the first one to `from`). */
export function clip(points: Point[], x0: number, x1: number): Point[] {
  return points.filter(([x]) => x >= x0 && x <= x1);
}

function niceStep(span: number): number {
  if (!(span > 0)) return 1;
  const raw = span / 4;
  const mag = 10 ** Math.floor(Math.log10(raw));
  const f = raw / mag;
  return (f <= 1 ? 1 : f <= 2 ? 2 : f <= 2.5 ? 2.5 : f <= 5 ? 5 : 10) * mag;
}

/**
 * A rounded [lo, hi] covering every finite value. `zero` pins 0 into the range (counts, speeds);
 * `minSpan` stops a flat series from blowing noise up to full height.
 */
export function niceExtent(values: number[], o: { zero?: boolean; minSpan?: number } = {}): [number, number] {
  let lo = Infinity;
  let hi = -Infinity;
  for (const v of values) {
    if (!Number.isFinite(v)) continue;
    if (v < lo) lo = v;
    if (v > hi) hi = v;
  }
  if (lo === Infinity) return [0, 1];
  if (o.zero) {
    lo = Math.min(0, lo);
    hi = Math.max(0, hi);
  }
  const minSpan = o.minSpan ?? 1;
  if (hi - lo < minSpan) {
    const mid = (hi + lo) / 2;
    lo = o.zero && lo >= 0 ? Math.max(0, mid - minSpan / 2) : mid - minSpan / 2;
    hi = lo + minSpan;
  }
  const step = niceStep(hi - lo);
  const nlo = Math.floor(lo / step + 1e-9) * step;
  const nhi = Math.ceil(hi / step - 1e-9) * step;
  return [Number(nlo.toPrecision(12)), Number(nhi.toPrecision(12))];
}

export interface Tick {
  at: number;
  label: string;
}

/** Relative hour ticks: "−24 H", "−12 H", "NOW", "+12 H" (every 12 h, or 6 h on short ranges). */
export function hourTicks(from: number, to: number, now: number): Tick[] {
  const hours = (to - from) / 3600;
  const every = hours > 18 ? 12 : hours > 6 ? 6 : 1;
  const ticks: Tick[] = [];
  const first = Math.ceil((from - now) / 3600 / every - 1e-9) * every;
  for (let h = first; now + h * 3600 <= to + 1; h += every) {
    const at = now + h * 3600;
    if (at < from - 1) continue;
    ticks.push({ at, label: h === 0 ? 'NOW' : `${h > 0 ? '+' : '−'}${Math.abs(h)} H` });
  }
  return ticks;
}

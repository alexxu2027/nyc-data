// Building shadows on the ground (ADR-017), drawn on one canvas so overlapping shadows merge.
//
// A building part is a prism: footprint P up to `height` (metres). With the sun at altitude α and
// azimuth θ, its ground shadow is P swept from 0 to height·k, where k is cot α metres per metre of
// height, pointing away from the sun (θ + 180°). The sweep is P at both ends plus one quad per
// edge. Parts are swept from the ground even when they start higher (`base`): OSM maps towers as
// stacks of slabs, and sweeping each slab only over its own band left anti-aliased seams where
// the bands met. The parts below cover those bands anyway; only floating structures (sky
// bridges) over-shade a little. Every piece is wound the same way, so a single `nonzero` fill
// unions them. The canvas is one colour at full alpha, and the map shows it as a raster at a
// fixed opacity, so where shadows overlap they don't darken.
//
// Roofs: parts are drawn shortest first, and each erases its own footprint after drawing its
// shadow. So a roof keeps only the shadows of taller buildings, which are drawn later.
import type { Position } from 'geojson';
import type { SunPosition } from '../core/sun';

const RAD = Math.PI / 180;
const M_PER_DEG = 111_320;
/** Below this the shadows run for blocks; clamp the length there. */
export const MIN_SUN_ALTITUDE = 3;

export interface BuildingPart {
  /** Outer ring first, then holes; [lng, lat]. */
  rings: Position[][];
  height: number;
  base: number;
}

/** The canvas's ground area (degrees) and size (px). Rows run north to south in Web Mercator. */
export interface Frame {
  west: number;
  south: number;
  east: number;
  north: number;
  width: number;
  height: number;
}

/** The parts of CanvasRenderingContext2D we use (a fake in tests). */
export interface Ctx2D {
  fillStyle: string | CanvasGradient | CanvasPattern;
  globalCompositeOperation: GlobalCompositeOperation;
  clearRect(x: number, y: number, w: number, h: number): void;
  beginPath(): void;
  moveTo(x: number, y: number): void;
  lineTo(x: number, y: number): void;
  closePath(): void;
  fill(rule?: CanvasFillRule): void;
}

const mercY = (lat: number) => Math.log(Math.tan(Math.PI / 4 + (lat * RAD) / 2));

/** lng/lat to canvas pixels. */
export function projector(f: Frame): (p: Position) => [number, number] {
  const yN = mercY(f.north);
  const yS = mercY(f.south);
  const sx = f.width / (f.east - f.west);
  const sy = f.height / (yN - yS);
  return (p) => [(p[0] - f.west) * sx, (yN - mercY(p[1])) * sy];
}

/** Canvas pixels per metre on the ground at `lat` (Mercator is conformal: same in x and y). */
export function pxPerMetre(f: Frame, lat: number): number {
  return f.width / ((f.east - f.west) * M_PER_DEG * Math.cos(lat * RAD));
}

/**
 * Shadow offset in canvas px per metre of height: away from the sun, length cot(altitude).
 * Null when the sun is down.
 */
export function shadowStep(sun: SunPosition, pxPerM: number): [number, number] | null {
  if (sun.altitude <= 0) return null;
  const k = 1 / Math.tan(Math.max(MIN_SUN_ALTITUDE, sun.altitude) * RAD);
  const away = (sun.azimuth + 180) * RAD;
  // East is +x; north is −y on the canvas.
  return [Math.sin(away) * k * pxPerM, -Math.cos(away) * k * pxPerM];
}

function area2(pts: Array<[number, number]>): number {
  let a = 0;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) a += (pts[j][0] - pts[i][0]) * (pts[j][1] + pts[i][1]);
  return a;
}

/** Add one closed sub-path, wound positive (so `nonzero` unions it with the others). */
function addPositive(ctx: Ctx2D, pts: Array<[number, number]>): void {
  if (pts.length < 3) return;
  const seq = area2(pts) < 0 ? [...pts].reverse() : pts;
  ctx.moveTo(seq[0][0], seq[0][1]);
  for (let i = 1; i < seq.length; i++) ctx.lineTo(seq[i][0], seq[i][1]);
  ctx.closePath();
}

function openRing(ring: Position[], project: (p: Position) => [number, number]): Array<[number, number]> {
  const pts = ring.map(project);
  const a = pts[0];
  const b = pts[pts.length - 1];
  if (pts.length > 1 && a[0] === b[0] && a[1] === b[1]) pts.pop();
  return pts;
}

/** The parts of the 2D context `invert` needs as well. */
interface CtxRect {
  fillRect?(x: number, y: number, w: number, h: number): void;
}

/**
 * Draw every part's ground shadow onto `ctx` (cleared first) in `color`. With `invert`, draw the
 * sunlit ground instead (everything but the shadows), for dark mode, where a shadow darker than
 * the dark map doesn't show. Returns the number of parts drawn (0 when the sun is down).
 */
export function drawShadows(ctx: Ctx2D & CtxRect, parts: BuildingPart[], sun: SunPosition, f: Frame, color: string, invert = false): number {
  ctx.clearRect(0, 0, f.width, f.height);
  if (sun.altitude <= 0) return 0;
  const project = projector(f);
  const midLat = (f.north + f.south) / 2;
  const step = shadowStep(sun, pxPerMetre(f, midLat));
  if (!step) return 0;
  const order = parts.filter((p) => p.height > 0 && p.rings.length && p.rings[0].length >= 3).sort((a, b) => a.height - b.height);
  ctx.fillStyle = color;
  for (const part of order) {
    const outer = openRing(part.rings[0], project);
    if (outer.length < 3) continue;
    const t0: [number, number] = [0, 0];
    const t1: [number, number] = [step[0] * part.height, step[1] * part.height];
    const at = (p: [number, number], t: [number, number]): [number, number] => [p[0] + t[0], p[1] + t[1]];
    // The sweep: the ring at both ends, and a quad per edge.
    ctx.globalCompositeOperation = 'source-over';
    ctx.beginPath();
    addPositive(ctx, outer.map((p) => at(p, t1)));
    addPositive(ctx, outer);
    for (let i = 0; i < outer.length; i++) {
      const a = outer[i];
      const b = outer[(i + 1) % outer.length];
      addPositive(ctx, [at(a, t0), at(b, t0), at(b, t1), at(a, t1)]);
    }
    ctx.fill('nonzero');
    // Its roof is lit (taller parts drawn later can shade it again). Holes stay: a courtyard
    // can be in shadow.
    ctx.globalCompositeOperation = 'destination-out';
    ctx.beginPath();
    for (const ring of part.rings) {
      const pts = openRing(ring, project);
      if (pts.length < 3) continue;
      ctx.moveTo(pts[0][0], pts[0][1]);
      for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i][0], pts[i][1]);
      ctx.closePath();
    }
    ctx.fill('evenodd');
  }
  if (invert && ctx.fillRect) {
    // Keep the colour only where there was no shadow: the sunlit ground (and sunlit roofs).
    ctx.globalCompositeOperation = 'source-out';
    ctx.fillStyle = color;
    ctx.fillRect(0, 0, f.width, f.height);
  }
  ctx.globalCompositeOperation = 'source-over';
  return order.length;
}

/** Building parts from MapLibre source features (Polygon / MultiPolygon, OpenMapTiles props). */
export function partsFrom(features: Array<{ geometry: GeoJSON.Geometry; properties: Record<string, unknown> | null }>): BuildingPart[] {
  const out: BuildingPart[] = [];
  for (const f of features) {
    const p = f.properties ?? {};
    if (p.hide_3d === true) continue;
    const height = typeof p.render_height === 'number' ? p.render_height : 0;
    if (height <= 0) continue;
    const base = typeof p.render_min_height === 'number' ? p.render_min_height : 0;
    const g = f.geometry;
    if (g.type === 'Polygon') out.push({ rings: g.coordinates, height, base });
    else if (g.type === 'MultiPolygon') for (const poly of g.coordinates) out.push({ rings: poly, height, base });
  }
  return out;
}

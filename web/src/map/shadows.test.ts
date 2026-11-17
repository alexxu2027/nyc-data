import { describe, expect, it } from 'vitest';
import { drawShadows, MIN_SUN_ALTITUDE, partsFrom, projector, pxPerMetre, shadowStep, type Ctx2D, type Frame } from './shadows';

// A 1 km box around Midtown, 1000 px wide.
const F: Frame = { west: -73.99, south: 40.75, east: -73.99 + 1000 / (111_320 * Math.cos(40.755 * (Math.PI / 180))), north: 40.76, width: 1000, height: 1000 };

type Op = [string, ...unknown[]];
function fakeCtx() {
  const ops: Op[] = [];
  const paths: Array<Array<[number, number]>> = [];
  let cur: Array<[number, number]> = [];
  const ctx: Ctx2D & { ops: Op[]; paths: typeof paths } = {
    ops,
    paths,
    fillStyle: '',
    globalCompositeOperation: 'source-over',
    clearRect: () => ops.push(['clear']),
    beginPath: () => ops.push(['begin']),
    moveTo: (x, y) => {
      cur = [[x, y]];
    },
    lineTo: (x, y) => {
      cur.push([x, y]);
    },
    closePath: () => {
      paths.push(cur);
    },
    fill: (rule) => ops.push(['fill', rule, ctx.globalCompositeOperation]),
  };
  return ctx;
}

const square = (lng: number, lat: number, dDeg = 0.0002) => [
  [
    [lng, lat],
    [lng + dDeg, lat],
    [lng + dDeg, lat + dDeg],
    [lng, lat + dDeg],
    [lng, lat],
  ],
];

const signedArea = (pts: Array<[number, number]>) => {
  let a = 0;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) a += (pts[j][0] - pts[i][0]) * (pts[j][1] + pts[i][1]);
  return a;
};

describe('shadow geometry', () => {
  it('falls away from the sun, cot(altitude) long', () => {
    const ppm = pxPerMetre(F, 40.755);
    expect(ppm).toBeCloseTo(1, 1); // the frame is ~1 px per metre
    // Sun due south at 45°: a 1 m height casts 1 m north (up the canvas).
    const [dx, dy] = shadowStep({ azimuth: 180, altitude: 45 }, ppm)!;
    expect(dx).toBeCloseTo(0, 6);
    expect(dy).toBeCloseTo(-ppm, 6);
    // Sun in the west at 30°: shadows run east, √3 per metre.
    const [ex, ey] = shadowStep({ azimuth: 270, altitude: 30 }, ppm)!;
    expect(ex).toBeCloseTo(Math.sqrt(3) * ppm, 6);
    expect(ey).toBeCloseTo(0, 6);
  });

  it('is clamped for a very low sun and absent when it is down', () => {
    const low = shadowStep({ azimuth: 180, altitude: 0.5 }, 1)!;
    expect(Math.abs(low[1])).toBeCloseTo(1 / Math.tan(MIN_SUN_ALTITUDE * (Math.PI / 180)), 6);
    expect(shadowStep({ azimuth: 180, altitude: -2 }, 1)).toBeNull();
  });

  it('projects north up and west left', () => {
    const p = projector(F);
    expect(p([F.west, F.north])).toEqual([0, 0]);
    const [x, y] = p([F.east, F.south]);
    expect(x).toBeCloseTo(1000, 6);
    expect(y).toBeCloseTo(1000, 6);
  });
});

describe('drawShadows', () => {
  it('draws shortest first, each shadow then erases its own roof', () => {
    const ctx = fakeCtx();
    const parts = [
      { rings: square(-73.985, 40.755), height: 100, base: 0 },
      { rings: square(-73.986, 40.755), height: 10, base: 0 },
    ];
    expect(drawShadows(ctx, parts, { azimuth: 180, altitude: 40 }, F, '#000')).toBe(2);
    const fills = ctx.ops.filter((o) => o[0] === 'fill');
    expect(fills).toEqual([
      ['fill', 'nonzero', 'source-over'],
      ['fill', 'evenodd', 'destination-out'],
      ['fill', 'nonzero', 'source-over'],
      ['fill', 'evenodd', 'destination-out'],
    ]);
    // The first sweep drawn is the 10 m building's (the shorter one): its far end is ~12 m north.
    const firstTop = ctx.paths[0];
    const y0 = projector(F)([-73.986, 40.755])[1];
    expect(Math.max(...firstTop.map((p) => y0 - p[1]))).toBeGreaterThan(10);
    expect(Math.max(...firstTop.map((p) => y0 - p[1]))).toBeLessThan(40);
  });

  it('winds every sweep piece the same way, so nonzero fill unions them', () => {
    const ctx = fakeCtx();
    drawShadows(ctx, [{ rings: square(-73.985, 40.755), height: 50, base: 20 }], { azimuth: 135, altitude: 35 }, F, '#000');
    // The far ring + the footprint + 4 edge quads (swept from the ground even with a base), then the erase.
    const sweep = ctx.paths.slice(0, 6);
    expect(sweep).toHaveLength(6);
    for (const p of sweep) expect(signedArea(p)).toBeGreaterThanOrEqual(0);
  });

  it('draws nothing at night', () => {
    const ctx = fakeCtx();
    expect(drawShadows(ctx, [{ rings: square(-73.985, 40.755), height: 50, base: 0 }], { azimuth: 0, altitude: -10 }, F, '#000')).toBe(0);
    expect(ctx.ops).toEqual([['clear']]);
  });
});

describe('partsFrom', () => {
  it('keeps extrudable parts, splits multipolygons, skips hide_3d and zero heights', () => {
    const parts = partsFrom([
      { geometry: { type: 'Polygon', coordinates: square(0, 0) }, properties: { render_height: 30, render_min_height: 5 } },
      { geometry: { type: 'MultiPolygon', coordinates: [square(0, 0), square(1, 1)] }, properties: { render_height: 12 } },
      { geometry: { type: 'Polygon', coordinates: square(0, 0) }, properties: { render_height: 40, hide_3d: true } },
      { geometry: { type: 'Polygon', coordinates: square(0, 0) }, properties: { render_height: 0 } },
      { geometry: { type: 'Point', coordinates: [0, 0] }, properties: { render_height: 9 } },
    ]);
    expect(parts.map((p) => [p.height, p.base])).toEqual([
      [30, 5],
      [12, 0],
      [12, 0],
    ]);
  });
});

describe('dark mode draws the sunlit ground', () => {
  it('invert: after the shadows, fill the rest in the glow colour (source-out)', () => {
    const ops: unknown[] = [];
    const ctx = {
      fillStyle: '',
      globalCompositeOperation: 'source-over' as GlobalCompositeOperation,
      clearRect: () => {},
      beginPath: () => {},
      moveTo: () => {},
      lineTo: () => {},
      closePath: () => {},
      fill: () => {},
      fillRect: (...a: number[]) => ops.push(['rect', ctx.globalCompositeOperation, ctx.fillStyle, ...a]),
    };
    drawShadows(ctx, [{ rings: square(-73.985, 40.755), height: 50, base: 0 }], { azimuth: 180, altitude: 30 }, F, '#ffe2b0', true);
    expect(ops).toEqual([['rect', 'source-out', '#ffe2b0', 0, 0, F.width, F.height]]);
    expect(ctx.globalCompositeOperation).toBe('source-over');
  });
});

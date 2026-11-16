// SDF marker glyphs drawn on a canvas from the UI kit's glyph paths (16 × 16 box), so one image
// can be tinted per theme and per feature with icon-color. Re-added after every style change.
import type { Map as MlMap } from 'maplibre-gl';
import { GLYPHS, type GlyphName } from '../ui';

/** Image ids on the map: `nl-g-<glyph>` plus the square camera badge `nl-badge`. */
export const glyphImageId = (name: GlyphName | 'badge'): string => (name === 'badge' ? 'nl-badge' : `nl-g-${name}`);

/** CSS px of transparent padding around the 16 px box: room for an SDF halo up to ~4 px. */
const PAD = 5;
const BOX = 16;
const INF = 1e20;

// Square badge with a 1.5 px corner ("square-ish"), as a path in the same 16 × 16 box.
const BADGE = 'M1.5 0H14.5Q16 0 16 1.5V14.5Q16 16 14.5 16H1.5Q0 16 0 14.5V1.5Q0 0 1.5 0Z';

/** 1D squared Euclidean distance transform (Felzenszwalb & Huttenlocher), in place on `grid`. */
function edt1d(grid: Float64Array, offset: number, stride: number, length: number, f: Float64Array, v: Uint16Array, z: Float64Array) {
  v[0] = 0;
  z[0] = -INF;
  z[1] = INF;
  f[0] = grid[offset];
  for (let q = 1, k = 0, s = 0; q < length; q++) {
    f[q] = grid[offset + q * stride];
    const q2 = q * q;
    do {
      const r = v[k];
      s = (f[q] - f[r] + q2 - r * r) / (q - r) / 2;
    } while (s <= z[k] && --k > -1);
    k++;
    v[k] = q;
    z[k] = s;
    z[k + 1] = INF;
  }
  for (let q = 0, k = 0; q < length; q++) {
    while (z[k + 1] < q) k++;
    const r = v[k];
    const qr = q - r;
    grid[offset + q * stride] = f[r] + qr * qr;
  }
}

function edt(grid: Float64Array, w: number, h: number) {
  const n = Math.max(w, h);
  const f = new Float64Array(n);
  const v = new Uint16Array(n);
  const z = new Float64Array(n + 1);
  for (let x = 0; x < w; x++) edt1d(grid, x, w, h, f, v, z);
  for (let y = 0; y < h; y++) edt1d(grid, y * w, 1, w, f, v, z);
}

/**
 * Coverage (0..255 per pixel) to an RGBA SDF in MapLibre's convention: the edge sits at alpha
 * 192 and one texel of distance is 255 / radius. `radius` = 8 × pixelRatio keeps halo widths in
 * screen px (the shader assumes 8 SDF px per glyph px).
 */
export function alphaToSdf(alpha: Uint8ClampedArray | Uint8Array, w: number, h: number, radius: number): Uint8ClampedArray {
  const size = w * h;
  const outer = new Float64Array(size);
  const inner = new Float64Array(size);
  for (let i = 0; i < size; i++) {
    const a = alpha[i] / 255;
    if (a >= 1) {
      outer[i] = 0;
      inner[i] = INF;
    } else if (a <= 0) {
      outer[i] = INF;
      inner[i] = 0;
    } else {
      const d = 0.5 - a;
      outer[i] = d > 0 ? d * d : 0;
      inner[i] = d < 0 ? d * d : 0;
    }
  }
  edt(outer, w, h);
  edt(inner, w, h);
  const out = new Uint8ClampedArray(size * 4);
  const cutoff = 0.25;
  for (let i = 0; i < size; i++) {
    const d = Math.sqrt(outer[i]) - Math.sqrt(inner[i]);
    out[i * 4] = 255;
    out[i * 4 + 1] = 255;
    out[i * 4 + 2] = 255;
    out[i * 4 + 3] = Math.round(255 - 255 * (d / radius + cutoff));
  }
  return out;
}

interface Built {
  width: number;
  height: number;
  data: Uint8ClampedArray;
}

const cache = new Map<string, Built>();

function build(path: string, ratio: number): Built | null {
  const key = `${path}@${ratio}`;
  const hit = cache.get(key);
  if (hit) return hit;
  if (typeof document === 'undefined' || typeof Path2D === 'undefined') return null;
  const size = Math.round((BOX + PAD * 2) * ratio);
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  if (!ctx) return null;
  ctx.setTransform(ratio, 0, 0, ratio, PAD * ratio, PAD * ratio);
  ctx.fillStyle = '#000';
  ctx.fill(new Path2D(path), 'evenodd');
  const rgba = ctx.getImageData(0, 0, size, size).data;
  const alpha = new Uint8ClampedArray(size * size);
  for (let i = 0; i < alpha.length; i++) alpha[i] = rgba[i * 4 + 3];
  const built = { width: size, height: size, data: alphaToSdf(alpha, size, size, 8 * ratio) };
  cache.set(key, built);
  return built;
}

/** Add (or replace) every glyph image on the current style. Safe to call after each style.load. */
export function installIcons(map: MlMap): void {
  const ratio = Math.min(3, Math.max(1, Math.ceil(typeof devicePixelRatio === 'number' ? devicePixelRatio : 1)));
  const all: Array<[GlyphName | 'badge', string]> = [
    ...(Object.entries(GLYPHS) as Array<[GlyphName, string]>),
    ['badge', BADGE],
  ];
  for (const [name, path] of all) {
    const img = build(path, ratio);
    if (!img) continue;
    const id = glyphImageId(name);
    if (map.hasImage(id)) map.removeImage(id);
    map.addImage(id, { width: img.width, height: img.height, data: img.data }, { sdf: true, pixelRatio: ratio });
  }
}

/** icon-size that draws the 16 px glyph box at `px` CSS px. */
export const iconSizeFor = (px: number): number => px / BOX;

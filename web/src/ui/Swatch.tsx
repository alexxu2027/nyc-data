import type { ColorValue, LegendItem } from '../types';
import { glyphPath, isGlyph } from './glyphs';

export interface SwatchProps {
  shape: LegendItem['shape'];
  /** '#rrggbb' or a token: ink | paper | muted. Default ink. */
  color?: ColorValue;
  /** For shape 'glyph': camera | elevator | alert | wave | drop. */
  glyph?: string;
}

/** Catalog colour to a paint value: tokens follow the theme, hex passes through. */
export function swatchColor(color: ColorValue | undefined): string {
  if (!color || color === 'ink') return 'var(--ink)';
  if (color === 'paper') return 'var(--paper)';
  if (color === 'muted') return 'var(--muted)';
  return color;
}

// The box is 27 × 15 user units drawn at 4ch wide (about 36 × 20 px on desktop).
const W = 27;
const H = 15;
const CX = W / 2;
const CY = H / 2;

/**
 * A legend key drawn the way the map draws the feature: circles and rings with the map's 1 px
 * ink stroke, cased road lines, dashed outlines, translucent fills, a stepped pulse, glyph
 * markers and a three-step size scale. The only component that shows data colour.
 */
export function Swatch({ shape, color, glyph }: SwatchProps) {
  const c = swatchColor(color);
  return (
    <svg className="swatch" viewBox={`0 0 ${W} ${H}`} aria-hidden="true" focusable="false" data-shape={shape}>
      {draw(shape, c, glyph, color === undefined)}
    </svg>
  );
}

function draw(shape: LegendItem['shape'], c: string, glyph: string | undefined, noColor: boolean) {
  switch (shape) {
    case 'circle':
      return <circle cx={CX} cy={CY} r={4.5} fill={c} className="sw-ink" strokeWidth={1} />;
    case 'ring':
      return <circle cx={CX} cy={CY} r={4.25} className="sw-paper" stroke={c} strokeWidth={1.5} />;
    case 'square':
      return <rect x={CX - 4.5} y={CY - 4.5} width={9} height={9} fill={c} className="sw-ink" strokeWidth={1} />;
    case 'line':
      // Data lines (roads) get the map's ink casing; token lines (borough outline) are plain.
      if (c.startsWith('var(')) {
        return <line x1={2} y1={CY} x2={W - 2} y2={CY} stroke={c} strokeWidth={1.5} />;
      }
      return (
        <>
          <line x1={3} y1={CY} x2={W - 3} y2={CY} className="sw-ink" strokeWidth={6} strokeLinecap="round" />
          <line x1={3} y1={CY} x2={W - 3} y2={CY} stroke={c} strokeWidth={4} strokeLinecap="round" />
        </>
      );
    case 'dash':
      return <line x1={1.5} y1={CY} x2={W - 1.5} y2={CY} stroke={c} strokeWidth={2.5} strokeDasharray="4 2.5" />;
    case 'fill':
      return (
        <rect x={2.5} y={2.5} width={W - 5} height={H - 5} fill={c} fillOpacity={0.35} stroke={c} strokeWidth={1.5} />
      );
    case 'pulse':
      return (
        <>
          <circle cx={CX} cy={CY} r={3} fill="none" stroke={c} strokeWidth={1.25} className="sw-pulse" />
          <circle cx={CX} cy={CY} r={3} fill={c} className="sw-ink" strokeWidth={1} />
        </>
      );
    case 'glyph': {
      if (!isGlyph(glyph)) return <circle cx={CX} cy={CY} r={4.5} fill={c} className="sw-ink" strokeWidth={1} />;
      // An ink (or data-colour) marker tile with the glyph knocked out in paper, as on the map.
      const s = 6.5; // half the tile
      return (
        <>
          <rect x={CX - s} y={CY - s} width={2 * s} height={2 * s} rx={1.5} fill={c} className="sw-ink" strokeWidth={1} />
          <path d={glyphPath(glyph)} className="sw-paper" transform={`translate(${CX - 4.5} ${CY - 4.5}) scale(0.5625)`} />
        </>
      );
    }
    case 'size': {
      // Three graduated circles sitting on one baseline.
      const base = 13.5;
      const marks: Array<[number, number]> = [
        [3, 2],
        [10, 3.5],
        [20.5, 5.5],
      ];
      return (
        <>
          {marks.map(([x, r]) =>
            noColor ? (
              <circle key={x} cx={x} cy={base - r} r={r} fill="none" className="sw-ink" strokeWidth={1} />
            ) : (
              <circle key={x} cx={x} cy={base - r} r={r} fill={c} className="sw-ink" strokeWidth={1} />
            ),
          )}
        </>
      );
    }
    case 'text':
    default:
      return null; // keeps the column so text-only legend rows line up with the rest
  }
}

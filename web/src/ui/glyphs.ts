/**
 * Marker glyphs as filled SVG paths in a 16 × 16 box. Outer shapes wind clockwise and holes
 * counter-clockwise, so they render the same with the nonzero and evenodd fill rules
 * (`new Path2D(glyphPath('camera'))` + `ctx.fill(p)` works for SDF icons on the map).
 */
export const GLYPHS = {
  // Video camera: body with a lens hole, plus the viewfinder wedge.
  camera: 'M1 4H11V12H1Z M7.5 8a2 2 0 1 0 -4 0a2 2 0 1 0 4 0Z M11.5 7L15 4.5V11.5L11.5 9Z',
  // Lift car: a frame with up and down arrows inside.
  elevator: 'M2 1H14V15H2Z M3.5 2.5V13.5H12.5V2.5Z M8 3.5L11 7H5Z M5 9H11L8 12.5Z',
  // Warning triangle with an exclamation knocked out.
  alert: 'M8 1L15.5 14.5H0.5Z M7 5V10H9V5Z M7 11.25V13.25H9V11.25Z',
  // Two bands of water.
  wave: 'M0 4q2-3 4 0t4 0t4 0t4 0v2.5q-2 3-4 0t-4 0t-4 0t-4 0Z M0 10q2-3 4 0t4 0t4 0t4 0v2.5q-2 3-4 0t-4 0t-4 0t-4 0Z',
  // Rain drop.
  drop: 'M8 1C8 1 3 7 3 10.5A5 5 0 0 0 13 10.5C13 7 8 1 8 1Z',
} as const;

export type GlyphName = keyof typeof GLYPHS;

export function isGlyph(name: string | undefined): name is GlyphName {
  return name != null && Object.prototype.hasOwnProperty.call(GLYPHS, name);
}

/** SVG path data for camera | elevator | alert | wave | drop (16 × 16). Unknown names give "". */
export function glyphPath(name: string): string {
  return isGlyph(name) ? GLYPHS[name] : '';
}

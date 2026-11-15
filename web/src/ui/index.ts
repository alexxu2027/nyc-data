// UI kit (U2): the transcript design system. Plan §6. Never imports maplibre-gl or core.
//
// Layout rules for users of the kit:
// - Every visible row is one `.l` line: Line, Blank, Rule, Heading, Check, Radio, Readout.
//   A Check / Radio / Readout placed inside another Line flows inline (no number of its own).
// - Panel numbers its own lines; give it a height and its body scrolls.
// - Colour: only Swatch shows data colour. Everything else reads the theme tokens.
// - CSS utilities from styles/base.css: .muted .upper .boxed .float .hscroll .full/.short
//   .hide-phone .hide-mid .sr-only .no-print; motion: .print-in .type-in .deal .pulse-ring.
//   Put .hscroll on a span inside the row, never on the .l itself (it would clip the gutter).
export { Panel, type PanelProps } from './Panel';
export { Line, Blank, Rule, Heading, type LineProps, type HeadingProps } from './Line';
export {
  Chip,
  TextButton,
  Check,
  Radio,
  type ChipProps,
  type TextButtonProps,
  type CheckProps,
  type RadioProps,
} from './controls';
export { Readout, Num, fmtNum, type ReadoutProps, type NumProps } from './readout';
export { Swatch, swatchColor, type SwatchProps } from './Swatch';
export { FreshDot, FRESH_LABELS, FRESH_ORDER, type FreshDotProps, type FreshState } from './FreshDot';
export { Spark, sparkPath, type SparkProps } from './Spark';
export { Banner, type BannerProps } from './Banner';
export { Sheet, detentReducer, DETENTS, type Detent, type DetentAction, type SheetProps } from './Sheet';
export { glyphPath, GLYPHS, isGlyph, type GlyphName } from './glyphs';
export { useIsPhone, useReducedMotion, useLineHeight, readLinePx, PHONE_QUERY, MID_QUERY } from './hooks';

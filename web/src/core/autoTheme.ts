// AUTO lighting (2026-11-17): light by day, dark by night, from the real sun at the map centre.
// The switch happens around dusk and dawn with a little hysteresis, so a sun hovering at the
// threshold (or a small pan) never flickers the theme: dark once the sun is DARK_BELOW below the
// horizon (well into civil twilight, when it really gets dark), light again above LIGHT_ABOVE.
// The page tokens fade (styles/tokens.css) and the map crossfades (map/xfade.ts). Entering AUTO
// also turns the sun on, so the light and the shadows follow it through the day. The pure rule
// is here; core/autoThemeSync.ts keeps the store in step.
import { sunPosition } from './sun';
import type { Theme } from '../types';

export const DARK_BELOW = -4;
export const LIGHT_ABOVE = -2;

/** The theme for a sun altitude, given the current one (inside the band, keep it). */
export function themeForSun(altitude: number, current: Theme): Theme {
  if (altitude < DARK_BELOW) return 'dark';
  if (altitude > LIGHT_ABOVE) return 'light';
  return current;
}

/** The theme AUTO picks for a moment and place. */
export function autoTheme(ms: number, lat: number, lng: number, current: Theme): Theme {
  return themeForSun(sunPosition(ms, lat, lng).altitude, current);
}

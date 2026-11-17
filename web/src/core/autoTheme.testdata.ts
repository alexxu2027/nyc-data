import type { Theme } from '../types';

/** UTC instants and the theme AUTO should pick for Midtown (EST = UTC-5, 2026-11-17). */
export const DARK_LIGHT_CHECK: Array<[string, Theme]> = [
  ['2026-11-17T19:00:00Z', 'light'], // 2 PM
  ['2026-11-18T04:00:00Z', 'dark'], // 11 PM
  ['2026-11-17T10:00:00Z', 'dark'], // 5 AM
  ['2026-11-17T21:20:00Z', 'light'], // 4:20 PM, before sunset
];

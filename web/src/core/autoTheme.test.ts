import { describe, expect, it } from 'vitest';
import { DARK_LIGHT_CHECK } from './autoTheme.testdata';
import { autoTheme, DARK_BELOW, LIGHT_ABOVE, themeForSun } from './autoTheme';
import { parseUrl, serializeUrl } from './url';
import { catalog } from './test/fixtures';
import { nextThemeMode, themeLabel } from '../shell/TopBar';

describe('AUTO lighting follows the sun (2026-11-17)', () => {
  it('dark once the sun is well below the horizon, light again after dawn, steady in between', () => {
    expect(themeForSun(30, 'dark')).toBe('light');
    expect(themeForSun(DARK_BELOW - 0.1, 'light')).toBe('dark');
    expect(themeForSun(LIGHT_ABOVE + 0.1, 'dark')).toBe('light');
    // Inside the band the theme holds, so a sun at the threshold never flickers it.
    expect(themeForSun(-3, 'light')).toBe('light');
    expect(themeForSun(-3, 'dark')).toBe('dark');
  });

  it('NYC: day at 2 PM, night at 11 PM and at 5 AM, in November', () => {
    for (const [iso, want] of DARK_LIGHT_CHECK) expect(autoTheme(Date.parse(iso), 40.75, -73.98, 'light')).toBe(want);
  });

  it('theme=auto round-trips in the URL and turns the sun on', () => {
    const u = parseUrl('?theme=auto', catalog);
    expect(u.theme).toBe('auto');
    expect(serializeUrl(u, catalog)).toMatch(/theme=auto/);
    expect(parseUrl('?theme=neon', catalog).theme).toBe('light');
  });

  it('the control cycles LIGHT → DARK → AUTO and says what AUTO shows', () => {
    expect(nextThemeMode('light')).toBe('dark');
    expect(nextThemeMode('dark')).toBe('auto');
    expect(nextThemeMode('auto')).toBe('light');
    expect(themeLabel('auto', 'dark')).toBe('AUTO: NIGHT');
    expect(themeLabel('auto', 'light')).toBe('AUTO: DAY');
    expect(themeLabel('dark', 'dark')).toBe('DARK');
  });
});

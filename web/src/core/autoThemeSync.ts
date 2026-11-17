// Keeps the theme in step with the sun while the theme mode is AUTO (rule: core/autoTheme.ts).
import { autoTheme } from './autoTheme';
import { useApp } from './store';
import { SUN_CLOCK_EVENT, sunClock } from './sun';

const TICK_MS = 60_000;

/** Keep the theme in step with the sun while the mode is AUTO. Returns dispose. */
export function startAutoTheme(): () => void {
  const check = () => {
    const s = useApp.getState();
    if (s.themeMode !== 'auto') return;
    const next = autoTheme(sunClock(), s.view.lat, s.view.lng, s.theme);
    if (next !== s.theme) s.setTheme(next);
  };
  const timer = setInterval(check, TICK_MS);
  const unsub = useApp.subscribe((s, prev) => {
    if (s.themeMode !== prev.themeMode || s.view !== prev.view) check();
  });
  window.addEventListener(SUN_CLOCK_EVENT, check);
  check();
  return () => {
    clearInterval(timer);
    unsub();
    window.removeEventListener(SUN_CLOCK_EVENT, check);
  };
}

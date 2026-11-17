// boot(): load the catalog, parse the URL, init the store, start layer polling, health polling
// (30 s) and URL sync. Returns dispose (safe to call before the catalog arrives, e.g. under
// React StrictMode's double effect).
import { api, ApiError } from './api';
import { startHealthPolling, startPolling } from './poll';
import { useApp } from './store';
import { startAutoTheme } from './autoThemeSync';
import { installSunSim } from './sunSim';
import { applyUrlState, parseUrl, serializeUrl, startUrlSync } from './url';

export function boot(): () => void {
  let disposed = false;
  const disposers: Array<() => void> = [];

  disposers.push(startHealthPolling());

  api
    .catalog()
    .then((catalog) => {
      if (disposed) return;
      const u = parseUrl(location.search, catalog);
      useApp.setState({ catalog, bootError: null });
      applyUrlState(u);
      // Canonicalise the address bar right away (drops unknown params, fills layers/c/z).
      const canonical = serializeUrl(u, catalog);
      if (location.search !== canonical) {
        history.replaceState(history.state, '', `${location.pathname}${canonical}${location.hash}`);
      }
      disposers.push(startPolling());
      disposers.push(startUrlSync(catalog, u.t));
      disposers.push(startAutoTheme());
      disposers.push(installSunSim()); // `nlSun` in the console: simulate the sun (core/sunSim.ts)
      // Theme colours fade only after the first paint, so opening a dark link doesn't fade in
      // from light (styles/tokens.css, :root[data-fade]).
      requestAnimationFrame(() => requestAnimationFrame(() => (document.documentElement.dataset.fade = '1')));
    })
    .catch((e: unknown) => {
      if (disposed) return;
      const msg =
        e instanceof ApiError
          ? `${e.status ? `HTTP ${e.status} ` : ''}${e.code}: ${e.message}`
          : e instanceof Error
            ? e.message
            : String(e);
      useApp.setState({ bootError: msg });
    });

  return () => {
    disposed = true;
    while (disposers.length) disposers.pop()?.();
  };
}

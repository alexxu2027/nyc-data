// Live camera frames for the selected camera only (ADR-007: images load straight from DOT, and
// only for the one camera in the drawer). A fresh frame is preloaded off-DOM every 3 s and handed
// over only once it has loaded, so the visible picture never blanks. The loop stops while the
// tab is hidden or the browser is offline, and for good when the returned stop() is called.

export const FRAME_MS = 3000;
/** Consecutive failures before the drawer reads NO SIGNAL. */
export const MAX_ERRORS = 3;
/** After MAX_ERRORS failures, retry this much slower (be polite to the DOT server). */
export const BACKOFF_FACTOR = 5;
/** A frame that has not loaded by now counts as a failure. */
export const FRAME_TIMEOUT_MS = 10_000;

/** Cache-busted frame URL: `image_url + '?t=' + time` (or `&t=` if it already has a query). */
export function frameUrl(url: string, t: number): string {
  return `${url}${url.includes('?') ? '&' : '?'}t=${t}`;
}

export interface FrameState {
  /** Consecutive failed loads (0 after any success). */
  errors: number;
  offline: boolean;
  /** True while the tab is hidden. */
  paused: boolean;
}

export interface FrameLoopOptions {
  url: string;
  /** A frame finished loading; show `img` (it is not in the DOM yet). */
  onFrame(img: HTMLImageElement, at: number): void;
  onState?(s: FrameState): void;
  intervalMs?: number;
  createImage?: () => HTMLImageElement;
  now?: () => number;
}

/** True when the loop should read NO SIGNAL. */
export function noSignal(s: FrameState): boolean {
  return s.offline || s.errors >= MAX_ERRORS;
}

/** Starts the refresher at once. Returns stop(): no timer, listener or request outlives it. */
export function startFrameLoop(o: FrameLoopOptions): () => void {
  const interval = o.intervalMs ?? FRAME_MS;
  const now = o.now ?? Date.now;
  const make = o.createImage ?? (() => new Image());
  let timer: ReturnType<typeof setTimeout> | null = null;
  let timeout: ReturnType<typeof setTimeout> | null = null;
  let inflight: HTMLImageElement | null = null;
  let errors = 0;
  let stopped = false;

  const hidden = () => typeof document !== 'undefined' && document.visibilityState === 'hidden';
  const offline = () => typeof navigator !== 'undefined' && navigator.onLine === false;
  const emit = () => o.onState?.({ errors, offline: offline(), paused: hidden() });

  const clearTimer = () => {
    if (timer !== null) clearTimeout(timer);
    timer = null;
  };
  const abandon = () => {
    if (timeout !== null) clearTimeout(timeout);
    timeout = null;
    if (inflight) {
      inflight.onload = null;
      inflight.onerror = null;
      inflight.removeAttribute('src'); // cancels the download
      inflight = null;
    }
  };

  const tick = () => {
    timer = null;
    if (stopped || hidden() || inflight) return; // visibilitychange restarts it
    if (offline()) {
      emit(); // the 'online' event restarts it
      return;
    }
    const img = make();
    const startedAt = now();
    inflight = img;
    const done = (ok: boolean) => {
      if (inflight !== img || stopped) return;
      inflight = null;
      if (timeout !== null) clearTimeout(timeout);
      timeout = null;
      img.onload = null;
      img.onerror = null;
      if (ok) {
        errors = 0;
        o.onFrame(img, now());
      } else {
        errors += 1;
        img.removeAttribute('src');
      }
      emit();
      const wait = errors >= MAX_ERRORS ? interval * BACKOFF_FACTOR : interval;
      timer = setTimeout(tick, Math.max(0, startedAt + wait - now()));
    };
    img.onload = () => done(true);
    img.onerror = () => done(false);
    timeout = setTimeout(() => done(false), FRAME_TIMEOUT_MS);
    img.src = frameUrl(o.url, startedAt);
  };

  const onVisibility = () => {
    if (hidden()) {
      clearTimer();
      abandon();
      emit();
    } else if (!stopped && timer === null && !inflight) {
      emit();
      tick(); // catch up at once on return
    }
  };
  const onOnline = () => {
    emit();
    if (!stopped && timer === null && !inflight) tick();
  };
  const onOffline = () => emit();

  document.addEventListener('visibilitychange', onVisibility);
  window.addEventListener('online', onOnline);
  window.addEventListener('offline', onOffline);
  emit();
  tick();

  return () => {
    stopped = true;
    clearTimer();
    abandon();
    document.removeEventListener('visibilitychange', onVisibility);
    window.removeEventListener('online', onOnline);
    window.removeEventListener('offline', onOffline);
  };
}

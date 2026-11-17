// A crossfade for theme switches (2026-11-17). Swapping the basemap style is instant and
// jarring, worst when AUTO flips the theme at dusk. So: draw the old map into a canvas laid over
// the map (a synchronous redraw makes the WebGL buffer readable), swap the style underneath,
// then fade the snapshot out once the new style is in and its tiles have loaded (or after
// MAX_WAIT_MS). Reduced motion: no fade, a plain swap.
import type { Map as MlMap } from 'maplibre-gl';

export const FADE_MS = 1200;
/** Fade even if tiles are still coming in after this long. */
export const MAX_WAIT_MS = 2500;

const reduced = () => typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;

export class ThemeCrossFade {
  private readonly map: MlMap;
  private el: HTMLCanvasElement | null = null;
  private raf = 0;
  private waiting = false;
  private since = 0;

  constructor(map: MlMap) {
    this.map = map;
  }

  /** Before the style swap: lay a snapshot of the current map over it. */
  begin(): void {
    this.clear();
    if (reduced()) return;
    const src = this.map.getCanvas();
    if (!src.width || !src.height) return;
    try {
      this.map.redraw(); // synchronous: the drawing buffer is valid for the copy below
      const c = document.createElement('canvas');
      c.width = src.width;
      c.height = src.height;
      c.getContext('2d')?.drawImage(src, 0, 0);
      c.className = 'nl-xfade';
      this.map.getContainer().appendChild(c);
      this.el = c;
    } catch {
      this.clear(); // a lost context or tainted canvas: just swap without the fade
    }
  }

  /** The new style has loaded: fade once its tiles are in. */
  ready(): void {
    if (!this.el || this.waiting) return;
    this.waiting = true;
    this.since = performance.now();
    const check = () => {
      if (!this.el) return;
      if (this.map.areTilesLoaded() || performance.now() - this.since > MAX_WAIT_MS) {
        this.waiting = false;
        this.fadeOut();
      } else this.raf = requestAnimationFrame(check);
    };
    this.raf = requestAnimationFrame(check);
  }

  private fadeOut(): void {
    const el = this.el;
    if (!el) return;
    el.classList.add('out');
    setTimeout(() => {
      if (this.el === el) this.clear();
      else el.remove();
    }, FADE_MS + 100);
  }

  clear(): void {
    cancelAnimationFrame(this.raf);
    this.waiting = false;
    this.el?.remove();
    this.el = null;
  }
}

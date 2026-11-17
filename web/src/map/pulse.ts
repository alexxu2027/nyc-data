// Pulse: a ring that eases out from the marker and fades, once per 2.4 s (2026-11-17: it was 8
// stepped frames per cycle, about 3 a second, which read as jittery). It's redrawn continuously at
// up to 30 fps with an ease-out, quick at first and slowing as it spreads, faded to nothing before
// it restarts. Only zoom-or-constant paint values change, so MapLibre never re-tiles a source.
// Paused while the tab is hidden; reduced motion shows the rest frame (a still ring).
import type { Map as MlMap } from 'maplibre-gl';

type PaintKey = Parameters<MlMap['setPaintProperty']>[1];
type PaintValue = Parameters<MlMap['setPaintProperty']>[2];
import { zoomRadius } from './styleToPaint';

export const PULSE_PERIOD_MS = 2400;
/** Paint updates per second at most (the ring is smooth well below the display's 60). */
export const PULSE_FPS = 30;
/** The still frame for reduced motion: a ring part-way out, like the CSS `.pulse-ring` rest. */
export const PULSE_REST = 0.4;

export interface PulseTarget {
  /** MapLibre layer id. */
  id: string;
  kind: 'circle' | 'line';
}

/** Ring radius base in px (before the zoom factor) at phase p in [0, 1). */
export function ringRadius(p: number): number {
  return 5 + 20 * p;
}

/** Ease-out cubic: fast start, gentle stop. */
export function easeOut(p: number): number {
  const x = Math.min(1, Math.max(0, p));
  return 1 - (1 - x) ** 3;
}

/** Paint values for one phase: the ring eases out, thins a little and fades to 0 by the end. */
export function pulsePaint(kind: 'circle' | 'line', p: number): Record<string, unknown> {
  const e = easeOut(p);
  const o = Math.round(0.8 * (1 - p) ** 2 * 100) / 100;
  if (kind === 'circle') {
    return {
      'circle-radius': zoomRadius(Math.round(ringRadius(e) * 10) / 10),
      'circle-stroke-opacity': o,
      'circle-stroke-width': Math.round((2 - e) * 10) / 10 + 0.5,
    };
  }
  return { 'line-width': Math.round((2 + 7 * e) * 10) / 10, 'line-opacity': o };
}

/** Phase in [0, 1) for a timestamp (continuous). */
export function phaseAt(ms: number): number {
  return (((ms % PULSE_PERIOD_MS) + PULSE_PERIOD_MS) % PULSE_PERIOD_MS) / PULSE_PERIOD_MS;
}

export function reducedMotion(): boolean {
  return typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;
}

export class Pulse {
  private targets: PulseTarget[] = [];
  private raf = 0;
  private last = -1;
  private disposed = false;
  private readonly mq: MediaQueryList | null;
  private readonly map: MlMap;

  constructor(map: MlMap) {
    this.map = map;
    this.mq = typeof matchMedia === 'function' ? matchMedia('(prefers-reduced-motion: reduce)') : null;
    this.mq?.addEventListener('change', this.kick);
    document.addEventListener('visibilitychange', this.kick);
  }

  /** Replace the pulse layers (after a style install). */
  setTargets(t: PulseTarget[]): void {
    this.targets = t;
    this.last = -1;
    this.kick();
  }

  private visibleTargets(): PulseTarget[] {
    return this.targets.filter((t) => {
      if (!this.map.getLayer(t.id)) return false;
      return this.map.getLayoutProperty(t.id, 'visibility') !== 'none';
    });
  }

  private apply(p: number, targets: PulseTarget[]): void {
    for (const t of targets) {
      for (const [k, v] of Object.entries(pulsePaint(t.kind, p))) {
        // Values come from pulsePaint, not users: skip the style validator on every frame.
        this.map.setPaintProperty(t.id, k as PaintKey, v as PaintValue, { validate: false });
      }
    }
  }

  /** Re-evaluate whether to run (visibility, reduced motion, layer visibility changes). */
  readonly kick = (): void => {
    if (this.disposed) return;
    cancelAnimationFrame(this.raf);
    this.raf = 0;
    const targets = this.visibleTargets();
    if (!targets.length) return;
    if (reducedMotion()) {
      this.apply(PULSE_REST, targets);
      this.last = -1;
      return;
    }
    if (document.hidden) return;
    const loop = (now: number) => {
      if (this.disposed) return;
      if (this.last < 0 || now - this.last >= 1000 / PULSE_FPS - 2) {
        this.last = now;
        this.apply(phaseAt(now), this.visibleTargets());
      }
      this.raf = requestAnimationFrame(loop);
    };
    this.raf = requestAnimationFrame(loop);
  };

  destroy(): void {
    this.disposed = true;
    cancelAnimationFrame(this.raf);
    this.mq?.removeEventListener('change', this.kick);
    document.removeEventListener('visibilitychange', this.kick);
  }
}

// Stepped pulse: an expanding ring redrawn in 8 steps per 2.4 s (about 3 paint updates a
// second). Only zoom-or-constant paint values change per step, so MapLibre never re-tiles a
// source. Paused while the tab is hidden; reduced motion shows the rest frame (a still ring).
import type { Map as MlMap } from 'maplibre-gl';

type PaintKey = Parameters<MlMap['setPaintProperty']>[1];
type PaintValue = Parameters<MlMap['setPaintProperty']>[2];
import { zoomRadius } from './styleToPaint';

export const PULSE_STEPS = 8;
export const PULSE_PERIOD_MS = 2400;
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

/** Paint values for one phase. */
export function pulsePaint(kind: 'circle' | 'line', p: number): Record<string, unknown> {
  const o = Math.round(0.85 * (1 - p) * 100) / 100;
  if (kind === 'circle') return { 'circle-radius': zoomRadius(ringRadius(p)), 'circle-stroke-opacity': o };
  return { 'line-width': Math.round((2 + 7 * p) * 10) / 10, 'line-opacity': o };
}

/** Phase for a timestamp, quantised to the step grid. */
export function phaseAt(ms: number): number {
  const step = Math.floor((ms % PULSE_PERIOD_MS) / (PULSE_PERIOD_MS / PULSE_STEPS));
  return step / PULSE_STEPS;
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
        this.map.setPaintProperty(t.id, k as PaintKey, v as PaintValue);
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
      const p = phaseAt(now);
      if (p !== this.last) {
        this.last = p;
        this.apply(p, this.visibleTargets());
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

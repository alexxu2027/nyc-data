// Change pulse (ADR-013 item 4): an ink ring expands twice around each dot that changed on the
// last poll, then goes away. One extra circle layer per `changes` layer, on the layer's own
// source, filtered to the changed ids. Stepped like pulse.ts (6 steps per ring, 200 ms each),
// so MapLibre only gets a paint update five times a second and never re-tiles the source.
// Reduced motion: one still ring for 3 s instead. A hidden tab skips the flash.
import type { FilterSpecification, LayerSpecification, Map as MlMap } from 'maplibre-gl';
import { reducedMotion } from './pulse';
import { zoomRadius } from './styleToPaint';

type PaintKey = Parameters<MlMap['setPaintProperty']>[1];
type PaintValue = Parameters<MlMap['setPaintProperty']>[2];

export const FLASH_STEPS = 6;
export const FLASH_STEP_MS = 200;
export const FLASH_RINGS = 2;
/** Reduced motion: how long the still ring stays. */
export const FLASH_STILL_MS = 3000;
/** The still ring's phase (part-way out, like the pulse rest frame). */
export const FLASH_REST = 0.5;
/** More ids than this in one poll flash only the first ones (a filter, not a source, holds them). */
export const FLASH_MAX_IDS = 500;

export interface FlashFrame {
  /** ms after the flash starts. */
  at: number;
  /** Ring phase in [0, 1), or null = hide. */
  p: number | null;
}

/** When to draw what. The last frame always hides the ring. */
export function flashFrames(reduced: boolean): FlashFrame[] {
  if (reduced) {
    return [
      { at: 0, p: FLASH_REST },
      { at: FLASH_STILL_MS, p: null },
    ];
  }
  const out: FlashFrame[] = [];
  for (let r = 0; r < FLASH_RINGS; r++) {
    for (let s = 0; s < FLASH_STEPS; s++) out.push({ at: (r * FLASH_STEPS + s) * FLASH_STEP_MS, p: s / FLASH_STEPS });
  }
  out.push({ at: FLASH_RINGS * FLASH_STEPS * FLASH_STEP_MS, p: null });
  return out;
}

/** Paint for one phase: the ring grows from the marker edge outwards and fades. */
export function flashPaint(p: number): Record<string, unknown> {
  return {
    'circle-radius': zoomRadius(Math.round((6 + 16 * p) * 10) / 10),
    'circle-stroke-opacity': Math.round(0.9 * (1 - p) * 100) / 100,
  };
}

const NONE: FilterSpecification = ['in', ['get', 'id'], ['literal', []]] as unknown as FilterSpecification;

export function idFilter(ids: string[]): FilterSpecification {
  return ['in', ['to-string', ['get', 'id']], ['literal', ids]] as unknown as FilterSpecification;
}

export const flashLayerId = (layer: string): string => `nl-${layer}-flash`;

/** The flash layer for a catalog layer, drawn over its markers (nothing matches until a flash). */
export function flashLayer(layer: string, source: string, ink: string): LayerSpecification {
  return {
    id: flashLayerId(layer),
    type: 'circle',
    source,
    filter: NONE,
    paint: {
      ...flashPaint(0),
      'circle-color': 'rgba(0,0,0,0)',
      'circle-opacity': 0,
      'circle-stroke-color': ink,
      'circle-stroke-width': 2,
      'circle-pitch-alignment': 'map',
    },
  } as unknown as LayerSpecification;
}

interface Run {
  id: string;
  timer: ReturnType<typeof setTimeout> | null;
}

export class ChangeFlash {
  private readonly map: MlMap;
  /** catalog layer id -> MapLibre flash layer id */
  private targets = new Map<string, string>();
  private runs = new Map<string, Run>();
  private disposed = false;

  constructor(map: MlMap) {
    this.map = map;
    if (typeof document !== 'undefined') document.addEventListener('visibilitychange', this.onVisibility);
  }

  /** Replace the flash layers (after a style install; [] when the style is gone). */
  setTargets(targets: Array<{ layer: string; id: string }>): void {
    for (const layer of [...this.runs.keys()]) this.stop(layer);
    this.targets = new Map(targets.map((t) => [t.layer, t.id]));
  }

  /** Ring the given feature ids of a catalog layer. A new flash on the same layer restarts it. */
  flash(layer: string, ids: string[]): void {
    if (this.disposed || !ids.length) return;
    if (typeof document !== 'undefined' && document.hidden) return;
    const id = this.targets.get(layer);
    if (!id || !this.map.getLayer(id)) return;
    this.stop(layer);
    this.map.setFilter(id, idFilter(ids.slice(0, FLASH_MAX_IDS)));
    const frames = flashFrames(reducedMotion());
    const run: Run = { id, timer: null };
    this.runs.set(layer, run);
    const start = Date.now();
    const step = (i: number) => {
      run.timer = null;
      if (this.runs.get(layer) !== run) return;
      const f = frames[i];
      if (f.p === null) {
        this.stop(layer);
        return;
      }
      this.paint(id, f.p);
      const next = frames[i + 1];
      run.timer = setTimeout(() => step(i + 1), Math.max(0, start + next.at - Date.now()));
    };
    step(0);
  }

  /** Layers with a flash running (for tests and debugging). */
  active(): string[] {
    return [...this.runs.keys()];
  }

  private paint(id: string, p: number): void {
    if (!this.map.getLayer(id)) return;
    for (const [k, v] of Object.entries(flashPaint(p))) this.map.setPaintProperty(id, k as PaintKey, v as PaintValue);
  }

  private stop(layer: string): void {
    const run = this.runs.get(layer);
    if (!run) return;
    if (run.timer) clearTimeout(run.timer);
    this.runs.delete(layer);
    try {
      if (this.map.getLayer(run.id)) this.map.setFilter(run.id, NONE);
    } catch {
      // the style may already be gone
    }
  }

  private readonly onVisibility = (): void => {
    if (typeof document !== 'undefined' && document.hidden) for (const layer of [...this.runs.keys()]) this.stop(layer);
  };

  destroy(): void {
    this.disposed = true;
    for (const layer of [...this.runs.keys()]) this.stop(layer);
    if (typeof document !== 'undefined') document.removeEventListener('visibilitychange', this.onVisibility);
  }
}
